import { useEffect, useState, type ReactNode } from 'react'
import { DEST, SOURCE, type ChainInfo } from '../config/cctp'
import type { Order, OrderPhase } from '../hooks/useBridge'
import { elapsed, formatTime, formatUsdc, shortAddr, shortHash } from '../lib/format'

/** 各阶段在流程中的序号（用于判断某步骤是否已完成） */
const PHASE_RANK: Record<OrderPhase, number> = {
  created: 0,
  approving: 1,
  burning: 2,
  attesting: 3,
  switching: 4,
  minting: 4,
  completed: 5,
  error: 0,
}

type StepState = 'pending' | 'active' | 'done' | 'error'

interface StepDef {
  key: string
  activePhases: OrderPhase[]
  /** 达到此 rank 即视为该步骤完成 */
  doneRank: number
  title: string
  render: (o: Order) => ReactNode
}

function txLink(chain: ChainInfo, hash?: string) {
  if (!hash) return null
  return (
    <a className="txlink" href={chain.txUrl(hash)} target="_blank" rel="noreferrer">
      {shortHash(hash)} ↗
    </a>
  )
}

const STEPS: StepDef[] = [
  {
    key: 'approve',
    activePhases: ['approving'],
    doneRank: 2,
    title: `① 授权 USDC（${SOURCE.name}）`,
    render: (o) =>
      o.approveSkipped ? (
        <span className="muted">额度充足，已跳过</span>
      ) : (
        txLink(SOURCE, o.approveTxHash) ?? <span className="muted">等待钱包确认授权…</span>
      ),
  },
  {
    key: 'burn',
    activePhases: ['burning'],
    doneRank: 3,
    title: `② 销毁 USDC（${SOURCE.name}）`,
    render: (o) => txLink(SOURCE, o.burnTxHash) ?? <span className="muted">等待销毁交易…</span>,
  },
  {
    key: 'attest',
    activePhases: ['attesting'],
    doneRank: 4,
    title: '③ 等待 Circle 证明 (attestation)',
    render: (o) => {
      if (o.attestation) return <span className="ok">证明已就绪 ✓</span>
      const label =
        o.attestationStatus === 'pending_confirmations' ? '等待区块确认中…' : '已提交，排队生成证明…'
      return <span className="muted">{label}</span>
    },
  },
  {
    key: 'mint',
    activePhases: ['switching', 'minting'],
    doneRank: 5,
    title: `④ 铸造 USDC（${DEST.name}）`,
    render: (o) => {
      if (o.phase === 'switching' && !o.error)
        return <span className="muted">请在钱包中切换到 {DEST.name}…</span>
      return txLink(DEST, o.mintTxHash) ?? <span className="muted">等待铸造交易…</span>
    },
  },
]

function isErrorState(o: Order): boolean {
  return !!o.error && o.phase !== 'completed'
}

function stepState(o: Order, step: StepDef): StepState {
  const rank = PHASE_RANK[o.phase]
  if (rank >= step.doneRank) return 'done'
  if (step.activePhases.includes(o.phase)) return isErrorState(o) ? 'error' : 'active'
  return 'pending'
}

const ICON: Record<StepState, string> = {
  pending: '○',
  active: '◐',
  done: '●',
  error: '✕',
}

export function OrderProgress({
  order,
  busy,
  onResume,
  onReset,
}: {
  order: Order
  busy: boolean
  onResume: () => void
  onReset: () => void
}) {
  // 让“用时”每秒刷新
  const [, tick] = useState(0)
  useEffect(() => {
    if (order.phase === 'completed' || isErrorState(order)) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [order.phase, order.error])

  const done = order.phase === 'completed'
  const error = isErrorState(order)

  return (
    <section className="card order">
      <div className="order-head">
        <div>
          <div className="order-title">跨链订单</div>
          <div className="order-id" title={order.id}>
            #{shortHash(order.id, 8, 6)}
          </div>
        </div>
        <span className={`badge ${error ? 'phase-error' : `phase-${order.phase}`}`}>
          {error ? '出错' : phaseLabel(order.phase)}
        </span>
      </div>

      <div className="order-grid">
        <Info label="金额">{formatUsdc(BigInt(order.amountRaw))} USDC</Info>
        <Info label="路由">
          {SOURCE.name} → {DEST.name}
        </Info>
        <Info label="模式">{order.mode === 'fast' ? '快速 (Fast)' : '标准 (Standard)'}</Info>
        <Info label="最大手续费">
          {order.maxFeeRaw ? `${formatUsdc(BigInt(order.maxFeeRaw))} USDC` : '—'}
        </Info>
        <Info label="接收地址">
          <span title={order.recipient}>{shortAddr(order.recipient)}</span>
        </Info>
        <Info label="创建时间">{formatTime(order.createdAt)}</Info>
        <Info label="用时">
          {elapsed(order.createdAt, order.completedAt)}
          {done ? '（已完成）' : ''}
        </Info>
      </div>

      <ol className="steps">
        {STEPS.map((s) => {
          const st = stepState(order, s)
          return (
            <li key={s.key} className={`step step-${st}`}>
              <span className="step-icon">{st === 'active' ? <Spinner /> : ICON[st]}</span>
              <div className="step-body">
                <div className="step-title">{s.title}</div>
                <div className="step-detail">{s.render(order)}</div>
              </div>
            </li>
          )
        })}
      </ol>

      {error && (
        <div className="error-box">
          <strong>出错：</strong>
          <span>{order.error}</span>
        </div>
      )}

      {done && (
        <div className="success-box">🎉 跨链完成！USDC 已在 {DEST.name} 上铸造给接收地址。</div>
      )}

      <div className="order-actions">
        {!busy && !done && (
          <button className="btn btn-primary" onClick={onResume}>
            {error ? '重试 / 继续' : '继续执行'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={onReset} disabled={busy}>
          {done ? '发起新订单' : '清除订单'}
        </button>
      </div>
    </section>
  )
}

function phaseLabel(p: OrderPhase): string {
  return {
    created: '已创建',
    approving: '授权中',
    burning: '销毁中',
    attesting: '等待证明',
    switching: '切换网络',
    minting: '铸造中',
    completed: '已完成',
    error: '出错',
  }[p]
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info">
      <div className="info-label">{label}</div>
      <div className="info-value">{children}</div>
    </div>
  )
}

function Spinner() {
  return <span className="spinner" aria-label="进行中" />
}
