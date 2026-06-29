import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppKit, useAppKitAccount, useAppKitProvider } from '@reown/appkit/react'
import { useAccount, useReadContract } from 'wagmi'
import { erc20Abi, isAddress, parseUnits } from 'viem'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  CHAIN_LIST,
  DEFAULT_DEST_KEY,
  DEFAULT_SOURCE_KEY,
  FINALITY_THRESHOLD,
  USDC_DECIMALS,
  getChain,
  type ChainInfo,
  type TransferMode,
} from './config/cctp'
import { projectId } from './config/appkit'
import { getTransferFees, type FeeOption } from './lib/circle'
import { isSolanaAddress, solanaUsdcBalance, type SolanaWallet } from './lib/solana'
import { formatUsdc, shortAddr } from './lib/format'
import { useBridge } from './hooks/useBridge'
import { OrderProgress } from './components/OrderProgress'

const MODE_INFO: Record<TransferMode, { label: string; time: string; desc: string }> = {
  fast: {
    label: '快速 Fast',
    time: '约 8–30 秒',
    desc: '软最终性即可铸造，速度快，按费率收取少量手续费',
  },
  standard: {
    label: '标准 Standard',
    time: '约 13–19 分钟',
    desc: '等待源链硬最终性，通常零手续费',
  },
}

// minimumFee 可能为小数 bps（如 1.3），放大 1000 倍做整数运算后向上取整
function ceilDivBps(amount: bigint, bps: number): bigint {
  const scaled = BigInt(Math.round(bps * 1000))
  return (amount * scaled + 9_999_999n) / 10_000_000n
}

export default function App() {
  const { open } = useAppKit()
  const evm = useAccount()
  const sol = useAppKitAccount({ namespace: 'solana' })
  const { walletProvider: solanaProvider } = useAppKitProvider<SolanaWallet>('solana')
  // 自备 Solana RPC 连接（不依赖 AppKit 的 connection —— WalletConnect 下它常为空）
  const solanaConnection = useMemo(
    () =>
      new Connection(
        (import.meta.env.VITE_SOLANA_RPC as string | undefined) ||
          'https://solana-rpc.publicnode.com',
        'confirmed',
      ),
    [],
  )
  const { order, busy, start, resume, reset, setSolanaContext, reclaim, reclaiming, reclaimError } =
    useBridge()

  const [sourceKey, setSourceKey] = useState(DEFAULT_SOURCE_KEY)
  const [destKey, setDestKey] = useState(DEFAULT_DEST_KEY)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<TransferMode>('fast')
  const [recipient, setRecipient] = useState('')
  const [fees, setFees] = useState<FeeOption[] | null>(null)
  const [solBalance, setSolBalance] = useState<bigint>()
  const [formError, setFormError] = useState<string | null>(null)

  const source = getChain(sourceKey)
  const dest = getChain(destKey)

  const needEvm = source.kind === 'evm' || dest.kind === 'evm'
  const needSol = source.kind === 'solana' || dest.kind === 'solana'
  const walletsReady = (!needEvm || evm.isConnected) && (!needSol || sol.isConnected)

  // 把 Solana 钱包上下文注入跨链状态机
  useEffect(() => {
    if (sol.isConnected && sol.address && solanaProvider) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = solanaProvider as any
      const wallet: SolanaWallet = {
        publicKey: new PublicKey(sol.address),
        signTransaction: (tx) => p.signTransaction(tx),
        signAllTransactions: p.signAllTransactions ? (txs: unknown[]) => p.signAllTransactions(txs) : undefined,
        sendTransaction: p.sendTransaction ? (tx, c, o) => p.sendTransaction(tx, c, o) : undefined,
      }
      setSolanaContext({ connection: solanaConnection, wallet })
    } else {
      setSolanaContext(null)
    }
  }, [sol.isConnected, sol.address, solanaProvider, solanaConnection, setSolanaContext])

  // 目标生态变化时，重置接收地址为该生态的默认地址
  useEffect(() => {
    setRecipient(dest.kind === 'evm' ? (evm.address ?? '') : (sol.address ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destKey])

  // 地址可用且字段为空时自动填入
  useEffect(() => {
    if (!recipient) setRecipient(dest.kind === 'evm' ? (evm.address ?? '') : (sol.address ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evm.address, sol.address, dest.kind])

  // 拉取当前路由的费率
  useEffect(() => {
    let alive = true
    setFees(null)
    getTransferFees(source.domain, dest.domain)
      .then((f) => alive && setFees(f))
      .catch(() => alive && setFees(null))
    return () => {
      alive = false
    }
  }, [source.domain, dest.domain])

  // 源链为 EVM 时读取 USDC 余额
  const evmUsdc = source.kind === 'evm' ? (source.usdc as `0x${string}`) : undefined
  const { data: evmBalance } = useReadContract({
    address: evmUsdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: evm.address ? [evm.address] : undefined,
    chainId: source.chainId,
    query: { enabled: !!evmUsdc && !!evm.address, refetchInterval: 15_000 },
  })

  // 源链为 Solana 时读取 USDC 余额
  useEffect(() => {
    if (source.kind !== 'solana' || !solanaConnection || !sol.address) {
      setSolBalance(undefined)
      return
    }
    let alive = true
    solanaUsdcBalance(solanaConnection, new PublicKey(sol.address))
      .then((b) => alive && setSolBalance(b))
      .catch(() => alive && setSolBalance(undefined))
    return () => {
      alive = false
    }
  }, [source.kind, solanaConnection, sol.address])

  const balance: bigint | undefined = source.kind === 'evm' ? (evmBalance as bigint | undefined) : solBalance

  const feeBps = useMemo(() => {
    const wanted = FINALITY_THRESHOLD[mode]
    return fees?.find((f) => f.finalityThreshold === wanted)?.minimumFee ?? 0
  }, [fees, mode])

  const estFee = useMemo(() => {
    if (!amount || Number(amount) <= 0) return undefined
    try {
      return ceilDivBps(parseUnits(amount, USDC_DECIMALS), feeBps)
    } catch {
      return undefined
    }
  }, [amount, feeBps])

  const hasActiveOrder = !!order && order.phase !== 'completed'
  const crossEcosystem = source.kind !== dest.kind

  function selectSource(k: string) {
    if (k === destKey) setDestKey(sourceKey)
    setSourceKey(k)
  }
  function selectDest(k: string) {
    if (k === sourceKey) setSourceKey(destKey)
    setDestKey(k)
  }
  function swap() {
    setSourceKey(destKey)
    setDestKey(sourceKey)
  }

  function validate(): string | null {
    if (sourceKey === destKey) return '源链与目标链不能相同'
    if (needEvm && !evm.isConnected) return '请连接 EVM 钱包'
    if (needSol && !sol.isConnected) return '请连接 Solana 钱包'
    if (!amount || Number(amount) <= 0) return '请输入有效金额'
    let amountRaw: bigint
    try {
      amountRaw = parseUnits(amount, USDC_DECIMALS)
    } catch {
      return '金额格式不正确（最多 6 位小数）'
    }
    if (balance !== undefined && amountRaw > balance) return 'USDC 余额不足'
    const okRecipient = dest.kind === 'evm' ? isAddress(recipient) : isSolanaAddress(recipient)
    if (!okRecipient) return `接收地址不是有效的 ${dest.kind === 'evm' ? 'EVM' : 'Solana'} 地址`
    return null
  }

  async function onSubmit() {
    const err = validate()
    setFormError(err)
    if (err) return
    await start({ sourceKey, destKey, amount, mode, recipient })
  }

  function setMax() {
    if (balance !== undefined) setAmount(formatUsdc(balance))
  }

  const primaryAddr = source.kind === 'evm' ? evm.address : sol.address
  const anyConnected = evm.isConnected || sol.isConnected

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true">
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <div className="brand-title">CCTP v2 跨链桥</div>
            <div className="brand-sub">EVM + Solana · 原生 USDC</div>
          </div>
        </div>
        <div className="wallet">
          {anyConnected ? (
            <button className="btn btn-wallet" onClick={() => open({ view: 'Account' })}>
              {shortAddr(primaryAddr ?? evm.address ?? sol.address)}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => open()}>
              连接钱包（扫码）
            </button>
          )}
        </div>
      </header>

      {!projectId && (
        <div className="warn-banner">
          ⚠️ 未配置 <code>VITE_REOWN_PROJECT_ID</code>，无法弹出 WalletConnect 扫码二维码。请到{' '}
          <a href="https://cloud.reown.com" target="_blank" rel="noreferrer">
            cloud.reown.com
          </a>{' '}
          创建项目并写入 <code>.env</code>。
        </div>
      )}

      <main className="container">
        <section className="card form">
          <div className="route">
            <ChainSelect role="源链 From" value={source} exclude={destKey} onChange={selectSource} />
            <button className="swap-btn" type="button" onClick={swap} title="交换源链 / 目标链">
              ⇅
            </button>
            <ChainSelect role="目标链 To" value={dest} exclude={sourceKey} onChange={selectDest} />
          </div>

          {crossEcosystem && (
            <div className="hint-row">跨生态转账：需同时连接 EVM 与 Solana 两端钱包</div>
          )}

          <label className="field">
            <div className="field-head">
              <span>转账金额</span>
              <span className="balance">
                余额：{`${formatUsdc(balance)} USDC`}
                <button className="link-btn" onClick={setMax} type="button">
                  最大
                </button>
              </span>
            </div>
            <div className="amount-input">
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              <span className="suffix">USDC</span>
            </div>
          </label>

          <div className="field">
            <div className="field-head">
              <span>转账模式</span>
            </div>
            <div className="modes">
              {(Object.keys(MODE_INFO) as TransferMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`mode ${mode === m ? 'mode-active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  <div className="mode-label">{MODE_INFO[m].label}</div>
                  <div className="mode-time">{MODE_INFO[m].time}</div>
                  <div className="mode-desc">{MODE_INFO[m].desc}</div>
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <div className="field-head">
              <span>接收地址（{dest.name}）</span>
            </div>
            <input
              className="text-input"
              placeholder={dest.kind === 'evm' ? '0x...' : 'Solana 地址 (base58)'}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
            />
          </label>

          <div className="summary">
            <div>
              <span>预估手续费</span>
              <strong>{estFee !== undefined ? `${formatUsdc(estFee)} USDC` : '—'}</strong>
            </div>
            <div>
              <span>预计到账</span>
              <strong>
                {estFee !== undefined && amount
                  ? `${formatUsdc(parseUnits(amount || '0', USDC_DECIMALS) - estFee)} USDC`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>预计耗时</span>
              <strong>{MODE_INFO[mode].time}</strong>
            </div>
          </div>

          {formError && <div className="form-error">{formError}</div>}

          {!walletsReady ? (
            <button className="btn btn-primary btn-block" onClick={() => open()}>
              连接钱包（扫码）
            </button>
          ) : (
            <button
              className="btn btn-primary btn-block"
              onClick={onSubmit}
              disabled={busy || hasActiveOrder}
            >
              {busy ? '处理中…' : hasActiveOrder ? '请先完成或清除下方订单' : '开始跨链'}
            </button>
          )}
        </section>

        {order && (
          <OrderProgress
            order={order}
            busy={busy}
            onResume={resume}
            onReset={reset}
            onReclaim={reclaim}
            reclaiming={reclaiming}
            reclaimError={reclaimError}
          />
        )}

        <footer className="foot">
          <p>
            基于 Circle CCTP v2 原生 USDC 跨链：在 {source.name}（域 {source.domain}）销毁 → Circle
            出具证明 → 在 {dest.name}（域 {dest.domain}）铸造。
          </p>
          <p className="muted">
            ⚠️ 主网真实资金操作，请先用小额测试。流程不依赖后端，证明由 Circle Iris API 提供。
          </p>
        </footer>
      </main>
    </div>
  )
}

function ChainBadge({ chain }: { chain: ChainInfo }) {
  return (
    <span className="chain-coin" style={{ background: chain.color }}>
      {chain.name.charAt(0)}
    </span>
  )
}

function ChainSelect({
  role,
  value,
  exclude,
  onChange,
}: {
  role: string
  value: ChainInfo
  exclude?: string
  onChange: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="chain-select" ref={ref}>
      <button
        type="button"
        className={`chain-pill chain-pill-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ChainBadge chain={value} />
        <div className="chain-meta">
          <div className="chain-role">{role}</div>
          <div className="chain-name">{value.name}</div>
        </div>
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="chain-menu">
          {CHAIN_LIST.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`chain-option ${c.key === value.key ? 'is-active' : ''}`}
              disabled={c.key === exclude}
              onClick={() => {
                onChange(c.key)
                setOpen(false)
              }}
            >
              <ChainBadge chain={c} />
              <span className="chain-option-name">{c.name}</span>
              {c.key === value.key && <span className="chain-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
