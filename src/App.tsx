import { useEffect, useMemo, useState } from 'react'
import { useAppKit } from '@reown/appkit/react'
import { useAccount, useReadContract } from 'wagmi'
import { erc20Abi, isAddress, parseUnits } from 'viem'
import { DEST, SOURCE, FINALITY_THRESHOLD, USDC_DECIMALS, type TransferMode } from './config/cctp'
import { projectId } from './config/appkit'
import { getTransferFees, type FeeOption } from './lib/circle'
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

function ceilDivBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps) + 9999n) / 10000n
}

export default function App() {
  const { open } = useAppKit()
  const { address, isConnected, chainId } = useAccount()
  const { order, busy, start, resume, reset } = useBridge()

  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<TransferMode>('fast')
  const [recipient, setRecipient] = useState('')
  const [fees, setFees] = useState<FeeOption[] | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // 连接后默认接收地址 = 当前地址（同一钱包）
  useEffect(() => {
    if (address && !recipient) setRecipient(address)
  }, [address, recipient])

  // 拉取 Ink→Polygon 的费率（用于展示预估手续费）
  useEffect(() => {
    let alive = true
    getTransferFees(SOURCE.domain, DEST.domain)
      .then((f) => alive && setFees(f))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 源链 USDC 余额
  const { data: balance } = useReadContract({
    address: SOURCE.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: SOURCE.chainId,
    query: { enabled: !!address, refetchInterval: 15_000 },
  })

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

  function validate(): string | null {
    if (!isConnected) return '请先连接钱包'
    if (!amount || Number(amount) <= 0) return '请输入有效金额'
    let amountRaw: bigint
    try {
      amountRaw = parseUnits(amount, USDC_DECIMALS)
    } catch {
      return '金额格式不正确（最多 6 位小数）'
    }
    if (balance !== undefined && amountRaw > (balance as bigint)) return 'USDC 余额不足'
    if (!isAddress(recipient)) return '接收地址不是有效的 EVM 地址'
    return null
  }

  async function onSubmit() {
    const err = validate()
    setFormError(err)
    if (err) return
    await start({ amount, mode, recipient: recipient as `0x${string}` })
  }

  function setMax() {
    if (balance !== undefined) setAmount(formatUsdc(balance as bigint))
  }

  const networkName =
    chainId === SOURCE.chainId ? SOURCE.name : chainId === DEST.chainId ? DEST.name : chainId ? '其他网络' : ''

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <div className="brand-title">CCTP v2 跨链桥</div>
            <div className="brand-sub">
              {SOURCE.name} → {DEST.name} · 原生 USDC
            </div>
          </div>
        </div>
        <div className="wallet">
          {isConnected && networkName && <span className="netchip">{networkName}</span>}
          {isConnected ? (
            <button className="btn btn-wallet" onClick={() => open({ view: 'Account' })}>
              {shortAddr(address)}
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
            <ChainPill name={SOURCE.name} role="源链 From" />
            <span className="route-arrow">→</span>
            <ChainPill name={DEST.name} role="目标链 To" />
          </div>

          <label className="field">
            <div className="field-head">
              <span>转账金额</span>
              <span className="balance">
                余额：{address ? `${formatUsdc(balance as bigint | undefined)} USDC` : '— '}
                {address && (
                  <button className="link-btn" onClick={setMax} type="button">
                    最大
                  </button>
                )}
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
              <span>接收地址（{DEST.name}）</span>
            </div>
            <input
              className="text-input"
              placeholder="0x..."
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

          {!isConnected ? (
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
          <OrderProgress order={order} busy={busy} onResume={resume} onReset={reset} />
        )}

        <footer className="foot">
          <p>
            基于 Circle CCTP v2 原生 USDC 跨链：在 {SOURCE.name}（域 {SOURCE.domain}）销毁 →
            Circle 出具证明 → 在 {DEST.name}（域 {DEST.domain}）铸造。
          </p>
          <p className="muted">
            ⚠️ 这是主网真实资金操作，请先用小额测试。流程不依赖后端，证明由 Circle Iris API 提供。
          </p>
        </footer>
      </main>
    </div>
  )
}

function ChainPill({ name, role }: { name: string; role: string }) {
  return (
    <div className="chain-pill">
      <div className="chain-role">{role}</div>
      <div className="chain-name">{name}</div>
    </div>
  )
}
