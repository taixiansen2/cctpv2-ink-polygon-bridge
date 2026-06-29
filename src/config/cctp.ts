import { parseAbi } from 'viem'

/**
 * CCTP v2 常量。
 * 合约地址在所有受支持的 EVM 链上一致（EDGE 链除外）。
 * 域 ID (domain) 与 Circle 文档保持一致：
 *   https://developers.circle.com/cctp/evm-smart-contracts
 */
export const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const
export const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as const

export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

/** depositForBurn 的 minFinalityThreshold 取值 */
export const FINALITY_THRESHOLD = {
  fast: 1000,
  standard: 2000,
} as const

export type TransferMode = keyof typeof FINALITY_THRESHOLD

export interface ChainInfo {
  key: 'ink' | 'polygon'
  name: string
  chainId: number
  /** CCTP 域 ID */
  domain: number
  usdc: `0x${string}`
  explorer: string
  /** 区块浏览器交易前缀 */
  txUrl: (hash: string) => string
}

export const INK: ChainInfo = {
  key: 'ink',
  name: 'Ink',
  chainId: 57073,
  domain: 21,
  usdc: '0x2D270e6886d130D724215A266106e6832161EAEd',
  explorer: 'https://explorer.inkonchain.com',
  txUrl: (h) => `https://explorer.inkonchain.com/tx/${h}`,
}

export const POLYGON: ChainInfo = {
  key: 'polygon',
  name: 'Polygon PoS',
  chainId: 137,
  domain: 7,
  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  explorer: 'https://polygonscan.com',
  txUrl: (h) => `https://polygonscan.com/tx/${h}`,
}

/** 本应用固定方向：源链 Ink → 目标链 Polygon */
export const SOURCE = INK
export const DEST = POLYGON

/** USDC 精度（两条链均为 6） */
export const USDC_DECIMALS = 6

export const tokenMessengerV2Abi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)',
])

export const messageTransmitterV2Abi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
])
