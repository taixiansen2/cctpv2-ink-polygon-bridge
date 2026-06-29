/**
 * 与 Circle Iris API (CCTP v2) 的交互。
 * 文档：https://developers.circle.com/api-reference/cctp/all/get-messages-v2
 */

const IRIS_BASE: string =
  (import.meta.env.VITE_IRIS_BASE as string | undefined) ?? 'https://iris-api.circle.com'

export interface FeeOption {
  /** 1000 = fast, 2000 = standard */
  finalityThreshold: number
  /** 费率，单位为基点 bps（1 bps = 0.01%） */
  minimumFee: number
}

/**
 * 查询某条路由（源域 → 目标域）的 fast / standard 费率。
 * GET /v2/burn/USDC/fees/{srcDomain}/{dstDomain}
 */
export async function getTransferFees(srcDomain: number, dstDomain: number): Promise<FeeOption[]> {
  const res = await fetch(`${IRIS_BASE}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`)
  if (!res.ok) throw new Error(`获取费率失败（HTTP ${res.status}）`)
  const json = await res.json()
  // 响应通常是数组；做一次容错归一化
  if (Array.isArray(json)) return json as FeeOption[]
  if (Array.isArray(json?.data)) return json.data as FeeOption[]
  return [json as FeeOption]
}

export interface IrisMessage {
  message: `0x${string}`
  attestation: `0x${string}` | 'PENDING'
  eventNonce: string
  /** "pending_confirmations" | "complete" */
  status: string
  delayReason?: string | null
  decodedMessage?: unknown
}

/**
 * 用源链交易哈希查询消息与证明（attestation）。
 * GET /v2/messages/{srcDomain}?transactionHash={txHash}
 *
 * 销毁交易刚上链时 Iris 尚未索引，会返回 404 —— 此时返回 null，调用方应继续轮询。
 */
export async function fetchMessages(
  srcDomain: number,
  txHash: string,
): Promise<IrisMessage[] | null> {
  const res = await fetch(`${IRIS_BASE}/v2/messages/${srcDomain}?transactionHash=${txHash}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`查询跨链消息失败（HTTP ${res.status}）`)
  const json = await res.json()
  const messages = json?.messages as IrisMessage[] | undefined
  return messages && messages.length > 0 ? messages : null
}

/** 一条消息是否已拿到可用证明 */
export function isAttested(m: IrisMessage | undefined | null): m is IrisMessage {
  return !!m && m.status === 'complete' && m.attestation !== 'PENDING' && !!m.attestation
}
