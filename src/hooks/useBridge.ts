import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAccount,
  readContract,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from '@wagmi/core'
import { erc20Abi, pad, parseUnits } from 'viem'
import { PublicKey } from '@solana/web3.js'
import { wagmiConfig } from '../config/appkit'
import {
  FINALITY_THRESHOLD,
  MESSAGE_TRANSMITTER_V2,
  TOKEN_MESSENGER_V2,
  USDC_DECIMALS,
  ZERO_BYTES32,
  getChain,
  messageTransmitterV2Abi,
  tokenMessengerV2Abi,
  type TransferMode,
} from '../config/cctp'
import { fetchMessages, getTransferFees, isAttested } from '../lib/circle'
import {
  evmAddressToPubkey,
  solanaAtaAsBytes32,
  solanaDepositForBurn,
  solanaReceiveMessage,
  solanaReclaimEventAccount,
  type SolanaContext,
} from '../lib/solana'

export type OrderPhase =
  | 'created'
  | 'approving'
  | 'burning'
  | 'attesting'
  | 'switching'
  | 'minting'
  | 'completed'
  | 'error'

export interface Order {
  id: string // 用销毁交易哈希；销毁前用临时 id
  sourceKey: string // 源链 key（见 config/cctp 的 CHAINS）
  destKey: string // 目标链 key
  amountRaw: string // bigint 序列化为字符串以便存 localStorage
  mode: TransferMode
  recipient: string // EVM 为 0x 地址；Solana 为 base58 地址
  maxFeeRaw?: string
  phase: OrderPhase
  createdAt: number
  completedAt?: number
  approveTxHash?: string
  approveSkipped?: boolean
  burnTxHash?: string // EVM 为 0x；Solana 为 base58 签名
  attestationStatus?: string
  message?: `0x${string}`
  attestation?: `0x${string}`
  mintTxHash?: string
  /** Solana 作为源链时，depositForBurn 生成的 MessageSent 事件账户（base58），用于回收租金 */
  solanaEventAccount?: string
  reclaimTxHash?: string
  error?: string
}

const STORAGE_KEY = 'cctpv2-order'

function load(): Order | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Order) : null
  } catch {
    return null
  }
}

function save(order: Order | null) {
  try {
    if (order) localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 忽略持久化错误 */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * maxFee = ceil(amount * minimumFeeBps / 10000)
 * minimumFee 可能是小数（如某些路由为 1.3 bps），放大 1000 倍后用整数运算，最终向上取整。
 */
function computeMaxFee(amount: bigint, bps: number): bigint {
  const scaled = BigInt(Math.round(bps * 1000))
  return (amount * scaled + 9_999_999n) / 10_000_000n
}

export interface StartParams {
  sourceKey: string
  destKey: string
  amount: string
  mode: TransferMode
  recipient: string
}

export function useBridge() {
  const [order, setOrderState] = useState<Order | null>(() => load())
  const [busy, setBusy] = useState(false)
  // 用 ref 持有最新 order，避免异步流程里闭包过期
  const orderRef = useRef<Order | null>(order)
  // Solana 钱包上下文（由 App 在连接状态变化时注入）
  const solanaCtxRef = useRef<SolanaContext | null>(null)

  const setSolanaContext = useCallback((ctx: SolanaContext | null) => {
    solanaCtxRef.current = ctx
  }, [])

  const replaceOrder = useCallback((next: Order | null) => {
    orderRef.current = next
    save(next)
    setOrderState(next)
  }, [])

  useEffect(() => {
    orderRef.current = order
  }, [order])

  /** 从订单当前状态继续执行（销毁 → 证明 → 切链 → 铸造），可重复调用以重试 / 恢复 */
  const run = useCallback(async (start: Order) => {
    setBusy(true)
    let o = start
    const update = (patch: Partial<Order>) => {
      o = { ...o, ...patch }
      orderRef.current = o
      save(o)
      setOrderState(o)
    }
    update({ error: undefined })

    const requireSolana = (): SolanaContext => {
      const c = solanaCtxRef.current
      if (!c) throw new Error('请先连接 Solana 钱包')
      return c
    }

    try {
      const source = getChain(o.sourceKey)
      const dest = getChain(o.destKey)
      const amount = BigInt(o.amountRaw)

      // ───────────────── 阶段 1：在源链上销毁 ─────────────────
      if (!o.burnTxHash) {
        update({ phase: 'approving' })

        // 计算 maxFee（两种生态通用）
        let maxFee = o.maxFeeRaw ? BigInt(o.maxFeeRaw) : 0n
        if (!o.maxFeeRaw) {
          const fees = await getTransferFees(source.domain, dest.domain)
          const wanted = FINALITY_THRESHOLD[o.mode]
          const opt =
            fees.find((f) => f.finalityThreshold === wanted) ??
            fees.sort((a, b) => a.finalityThreshold - b.finalityThreshold)[0]
          maxFee = computeMaxFee(amount, opt?.minimumFee ?? 0)
          update({ maxFeeRaw: maxFee.toString() })
        }

        if (source.kind === 'evm') {
          const account = getAccount(wagmiConfig).address
          if (!account) throw new Error('请先连接 EVM 钱包')
          await switchChain(wagmiConfig, { chainId: source.chainId! })

          // 授权检查
          const allowance = (await readContract(wagmiConfig, {
            address: source.usdc as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, TOKEN_MESSENGER_V2],
            chainId: source.chainId!,
          })) as bigint

          if (allowance < amount) {
            const approveTx = await writeContract(wagmiConfig, {
              address: source.usdc as `0x${string}`,
              abi: erc20Abi,
              functionName: 'approve',
              args: [TOKEN_MESSENGER_V2, amount],
              chainId: source.chainId!,
            })
            update({ approveTxHash: approveTx })
            await waitForTransactionReceipt(wagmiConfig, {
              hash: approveTx,
              chainId: source.chainId!,
            })
          } else {
            update({ approveSkipped: true })
          }

          // depositForBurn（目标为 Solana 时 mintRecipient = 收款 ATA 的 32 字节）
          update({ phase: 'burning' })
          const mintRecipient =
            dest.kind === 'solana'
              ? solanaAtaAsBytes32(o.recipient)
              : pad(o.recipient as `0x${string}`, { size: 32 })
          const burnTx = await writeContract(wagmiConfig, {
            address: TOKEN_MESSENGER_V2,
            abi: tokenMessengerV2Abi,
            functionName: 'depositForBurn',
            args: [
              amount,
              dest.domain,
              mintRecipient,
              source.usdc as `0x${string}`,
              ZERO_BYTES32,
              maxFee,
              FINALITY_THRESHOLD[o.mode],
            ],
            chainId: source.chainId!,
          })
          update({ burnTxHash: burnTx, id: burnTx })
          await waitForTransactionReceipt(wagmiConfig, { hash: burnTx, chainId: source.chainId! })
        } else {
          // 源链是 Solana：无需 approve，直接销毁（目标必为 EVM）
          const ctx = requireSolana()
          update({ phase: 'burning', approveSkipped: true })
          const { signature, eventAccount } = await solanaDepositForBurn({
            ctx,
            amount,
            destinationDomain: dest.domain,
            mintRecipient: evmAddressToPubkey(o.recipient),
            maxFee,
            minFinalityThreshold: FINALITY_THRESHOLD[o.mode],
          })
          update({ burnTxHash: signature, id: signature, solanaEventAccount: eventAccount })
        }
      }

      // ───────────────── 阶段 2：轮询 Circle 证明 ─────────────────
      if (!o.attestation) {
        update({ phase: 'attesting' })
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const messages = await fetchMessages(source.domain, o.burnTxHash!)
          const msg = messages?.[0]
          update({ attestationStatus: msg?.status ?? 'pending_confirmations' })
          if (isAttested(msg)) {
            update({ message: msg.message, attestation: msg.attestation as `0x${string}` })
            break
          }
          await sleep(6000)
        }
      }

      // ───────────────── 阶段 3：在目标链上铸造 ─────────────────
      if (!o.mintTxHash) {
        if (dest.kind === 'evm') {
          update({ phase: 'switching' })
          await switchChain(wagmiConfig, { chainId: dest.chainId! })

          update({ phase: 'minting' })
          const mintTx = await writeContract(wagmiConfig, {
            address: MESSAGE_TRANSMITTER_V2,
            abi: messageTransmitterV2Abi,
            functionName: 'receiveMessage',
            args: [o.message!, o.attestation!],
            chainId: dest.chainId!,
          })
          update({ mintTxHash: mintTx })
          await waitForTransactionReceipt(wagmiConfig, { hash: mintTx, chainId: dest.chainId! })
        } else {
          // 目标是 Solana：调用 receiveMessage 铸造
          const ctx = requireSolana()
          update({ phase: 'minting' })
          const sig = await solanaReceiveMessage({
            ctx,
            messageHex: o.message!,
            attestationHex: o.attestation!,
            remoteDomain: source.domain,
            remoteUsdcHex: source.usdc,
            recipientOwner: new PublicKey(o.recipient),
          })
          update({ mintTxHash: sig })
        }
      }

      update({ phase: 'completed', completedAt: Date.now() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 保留当前 phase（标明卡在哪一步），仅记录错误信息，便于“重试 / 继续”
      update({ error: message })
    } finally {
      setBusy(false)
    }
  }, [])

  const start = useCallback(
    async (params: StartParams) => {
      const amountRaw = parseUnits(params.amount, USDC_DECIMALS).toString()
      const fresh: Order = {
        id: `pending-${Date.now()}`,
        sourceKey: params.sourceKey,
        destKey: params.destKey,
        amountRaw,
        mode: params.mode,
        recipient: params.recipient,
        phase: 'created',
        createdAt: Date.now(),
      }
      replaceOrder(fresh)
      await run(fresh)
    },
    [replaceOrder, run],
  )

  /** 重试 / 恢复当前订单 */
  const resume = useCallback(async () => {
    const cur = orderRef.current
    if (cur && cur.phase !== 'completed') await run(cur)
  }, [run])

  const reset = useCallback(() => {
    replaceOrder(null)
  }, [replaceOrder])

  // ── 回收发送端（Solana 源链）MessageSent 事件账户租金 ──
  const [reclaiming, setReclaiming] = useState(false)
  const [reclaimError, setReclaimError] = useState<string | null>(null)
  const reclaim = useCallback(async () => {
    const cur = orderRef.current
    if (!cur?.solanaEventAccount || !cur.message || !cur.attestation || cur.reclaimTxHash) return
    const ctx = solanaCtxRef.current
    if (!ctx) {
      setReclaimError('请先连接 Solana 钱包')
      return
    }
    setReclaiming(true)
    setReclaimError(null)
    try {
      const sig = await solanaReclaimEventAccount({
        ctx,
        messageHex: cur.message,
        attestationHex: cur.attestation,
        eventAccount: cur.solanaEventAccount,
      })
      const next = { ...orderRef.current!, reclaimTxHash: sig }
      orderRef.current = next
      save(next)
      setOrderState(next)
    } catch (err) {
      setReclaimError(err instanceof Error ? err.message : String(err))
    } finally {
      setReclaiming(false)
    }
  }, [])

  return { order, busy, start, resume, reset, setSolanaContext, reclaim, reclaiming, reclaimError }
}
