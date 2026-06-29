import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAccount,
  readContract,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from '@wagmi/core'
import { erc20Abi, pad, parseUnits } from 'viem'
import { wagmiConfig } from '../config/appkit'
import {
  DEST,
  FINALITY_THRESHOLD,
  MESSAGE_TRANSMITTER_V2,
  SOURCE,
  TOKEN_MESSENGER_V2,
  USDC_DECIMALS,
  ZERO_BYTES32,
  messageTransmitterV2Abi,
  tokenMessengerV2Abi,
  type TransferMode,
} from '../config/cctp'
import { fetchMessages, getTransferFees, isAttested } from '../lib/circle'

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
  amountRaw: string // bigint 序列化为字符串以便存 localStorage
  mode: TransferMode
  recipient: `0x${string}`
  maxFeeRaw?: string
  phase: OrderPhase
  createdAt: number
  completedAt?: number
  approveTxHash?: `0x${string}`
  approveSkipped?: boolean
  burnTxHash?: `0x${string}`
  attestationStatus?: string
  message?: `0x${string}`
  attestation?: `0x${string}`
  mintTxHash?: `0x${string}`
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

/** maxFee = ceil(amount * minimumFeeBps / 10000) */
function computeMaxFee(amount: bigint, bps: number): bigint {
  const fee = (amount * BigInt(bps) + 9999n) / 10000n
  return fee
}

export interface StartParams {
  amount: string
  mode: TransferMode
  recipient: `0x${string}`
}

export function useBridge() {
  const [order, setOrderState] = useState<Order | null>(() => load())
  const [busy, setBusy] = useState(false)
  // 用 ref 持有最新 order，避免异步流程里闭包过期
  const orderRef = useRef<Order | null>(order)

  const replaceOrder = useCallback((next: Order | null) => {
    orderRef.current = next
    save(next)
    setOrderState(next)
  }, [])

  useEffect(() => {
    orderRef.current = order
  }, [order])

  /** 从订单当前状态继续执行（销毁 → 证明 → 切链 → 铸造），可重复调用以重试 / 恢复 */
  const run = useCallback(
    async (start: Order) => {
      setBusy(true)
      let o = start
      const update = (patch: Partial<Order>) => {
        o = { ...o, ...patch }
        orderRef.current = o
        save(o)
        setOrderState(o)
      }
      update({ error: undefined })

      try {
        const amount = BigInt(o.amountRaw)
        const account = getAccount(wagmiConfig).address
        if (!account) throw new Error('请先连接钱包')

        // ───────────────── 阶段 1：在 Ink 上销毁（含授权）─────────────────
        if (!o.burnTxHash) {
          update({ phase: 'approving' })
          // 确保在源链
          await switchChain(wagmiConfig, { chainId: SOURCE.chainId })

          // 计算 maxFee
          let maxFee = o.maxFeeRaw ? BigInt(o.maxFeeRaw) : 0n
          if (!o.maxFeeRaw) {
            const fees = await getTransferFees(SOURCE.domain, DEST.domain)
            const wanted = FINALITY_THRESHOLD[o.mode]
            const opt =
              fees.find((f) => f.finalityThreshold === wanted) ??
              fees.sort((a, b) => a.finalityThreshold - b.finalityThreshold)[0]
            const bps = opt?.minimumFee ?? 0
            maxFee = computeMaxFee(amount, bps)
            update({ maxFeeRaw: maxFee.toString() })
          }

          // 授权检查
          const allowance = (await readContract(wagmiConfig, {
            address: SOURCE.usdc,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, TOKEN_MESSENGER_V2],
            chainId: SOURCE.chainId,
          })) as bigint

          if (allowance < amount) {
            const approveTx = await writeContract(wagmiConfig, {
              address: SOURCE.usdc,
              abi: erc20Abi,
              functionName: 'approve',
              args: [TOKEN_MESSENGER_V2, amount],
              chainId: SOURCE.chainId,
            })
            update({ approveTxHash: approveTx })
            await waitForTransactionReceipt(wagmiConfig, {
              hash: approveTx,
              chainId: SOURCE.chainId,
            })
          } else {
            update({ approveSkipped: true })
          }

          // depositForBurn
          update({ phase: 'burning' })
          const mintRecipient = pad(o.recipient, { size: 32 })
          const burnTx = await writeContract(wagmiConfig, {
            address: TOKEN_MESSENGER_V2,
            abi: tokenMessengerV2Abi,
            functionName: 'depositForBurn',
            args: [
              amount,
              DEST.domain,
              mintRecipient,
              SOURCE.usdc,
              ZERO_BYTES32,
              maxFee,
              FINALITY_THRESHOLD[o.mode],
            ],
            chainId: SOURCE.chainId,
          })
          update({ burnTxHash: burnTx, id: burnTx })
          await waitForTransactionReceipt(wagmiConfig, { hash: burnTx, chainId: SOURCE.chainId })
        }

        // ───────────────── 阶段 2：轮询 Circle 证明 ─────────────────
        if (!o.attestation) {
          update({ phase: 'attesting' })
          // 一直轮询直到拿到证明（fast 通常数十秒，standard 约 13–19 分钟）
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const messages = await fetchMessages(SOURCE.domain, o.burnTxHash!)
            const msg = messages?.[0]
            update({ attestationStatus: msg?.status ?? 'pending_confirmations' })
            if (isAttested(msg)) {
              update({ message: msg.message, attestation: msg.attestation as `0x${string}` })
              break
            }
            await sleep(6000)
          }
        }

        // ───────────────── 阶段 3：在 Polygon 上铸造 ─────────────────
        if (!o.mintTxHash) {
          update({ phase: 'switching' })
          await switchChain(wagmiConfig, { chainId: DEST.chainId })

          update({ phase: 'minting' })
          const mintTx = await writeContract(wagmiConfig, {
            address: MESSAGE_TRANSMITTER_V2,
            abi: messageTransmitterV2Abi,
            functionName: 'receiveMessage',
            args: [o.message!, o.attestation!],
            chainId: DEST.chainId,
          })
          update({ mintTxHash: mintTx })
          await waitForTransactionReceipt(wagmiConfig, { hash: mintTx, chainId: DEST.chainId })
        }

        update({ phase: 'completed', completedAt: Date.now() })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 保留当前 phase（标明卡在哪一步），仅记录错误信息，便于“重试 / 继续”
        update({ error: message })
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const start = useCallback(
    async (params: StartParams) => {
      const amountRaw = parseUnits(params.amount, USDC_DECIMALS).toString()
      const fresh: Order = {
        id: `pending-${Date.now()}`,
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

  return { order, busy, start, resume, reset }
}
