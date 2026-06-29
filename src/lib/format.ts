import { formatUnits } from 'viem'
import { USDC_DECIMALS } from '../config/cctp'

export function shortHash(hash?: string, head = 6, tail = 4): string {
  if (!hash) return ''
  if (hash.length <= head + tail + 2) return hash
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`
}

export function shortAddr(addr?: string): string {
  return shortHash(addr, 6, 4)
}

/** 把 6 位精度的原始 USDC 数额格式化为最多 6 位小数的可读字符串 */
export function formatUsdc(raw?: bigint): string {
  if (raw === undefined) return '—'
  const s = formatUnits(raw, USDC_DECIMALS)
  // 去掉多余的尾零
  return s.replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m))
}

export function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 经过的相对时长，如 "1分23秒" */
export function elapsed(fromTs?: number, toTs?: number): string {
  if (!fromTs) return '—'
  const ms = (toTs ?? Date.now()) - fromTs
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}
