import { parseAbi } from 'viem'
import {
  arbitrum,
  avalanche,
  base,
  codex,
  ink,
  linea,
  mainnet,
  optimism,
  polygon,
  sei,
  sonic,
  unichain,
  worldchain,
  type AppKitNetwork,
} from '@reown/appkit/networks'

/**
 * CCTP v2 常量。
 * 合约地址在所有受支持的 EVM 链上一致（EDGE 链除外）。
 * 域 ID 与原生 USDC 地址来自 Circle 官方文档：
 *   https://developers.circle.com/cctp/evm-smart-contracts
 *   https://developers.circle.com/stablecoins/usdc-contract-addresses
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

/** USDC 精度（所有支持链均为 6） */
export const USDC_DECIMALS = 6

export interface ChainInfo {
  key: string
  name: string
  chainId: number
  /** CCTP 域 ID */
  domain: number
  usdc: `0x${string}`
  /** 徽标主色 */
  color: string
  network: AppKitNetwork
  txUrl: (hash: string) => string
}

interface ChainMeta {
  name: string
  domain: number
  usdc: `0x${string}`
  color: string
  network: AppKitNetwork
}

/** CCTP v2 支持的 EVM 主网链（域 ID + 原生 USDC 地址，数据来自 Circle 官方） */
const META: Record<string, ChainMeta> = {
  ethereum: {
    name: 'Ethereum',
    domain: 0,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    color: '#627eea',
    network: mainnet,
  },
  avalanche: {
    name: 'Avalanche',
    domain: 1,
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    color: '#e84142',
    network: avalanche,
  },
  optimism: {
    name: 'Optimism',
    domain: 2,
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    color: '#ff0420',
    network: optimism,
  },
  arbitrum: {
    name: 'Arbitrum',
    domain: 3,
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    color: '#2f6fed',
    network: arbitrum,
  },
  base: {
    name: 'Base',
    domain: 6,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    color: '#0052ff',
    network: base,
  },
  polygon: {
    name: 'Polygon PoS',
    domain: 7,
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    color: '#8247e5',
    network: polygon,
  },
  unichain: {
    name: 'Unichain',
    domain: 10,
    usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    color: '#f50db4',
    network: unichain,
  },
  linea: {
    name: 'Linea',
    domain: 11,
    usdc: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
    color: '#1f2430',
    network: linea,
  },
  codex: {
    name: 'Codex',
    domain: 12,
    usdc: '0xd996633a415985DBd7D6D12f4A4343E31f5037cf',
    color: '#4f46e5',
    network: codex,
  },
  sonic: {
    name: 'Sonic',
    domain: 13,
    usdc: '0x29219dd400f2Bf60E5a23d13be72B486D4038894',
    color: '#ff7a1a',
    network: sonic,
  },
  worldchain: {
    name: 'World Chain',
    domain: 14,
    usdc: '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1',
    color: '#2b2f36',
    network: worldchain,
  },
  sei: {
    name: 'Sei',
    domain: 16,
    usdc: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    color: '#b21f1f',
    network: sei,
  },
  ink: {
    name: 'Ink',
    domain: 21,
    usdc: '0x2D270e6886d130D724215A266106e6832161EAEd',
    color: '#7c5cff',
    network: ink,
  },
}

function explorerTxUrl(network: AppKitNetwork): (hash: string) => string {
  const url = network.blockExplorers?.default?.url?.replace(/\/$/, '')
  return (hash) => (url ? `${url}/tx/${hash}` : '#')
}

export const CHAINS: Record<string, ChainInfo> = Object.fromEntries(
  Object.entries(META).map(([key, m]) => [
    key,
    {
      key,
      name: m.name,
      chainId: Number(m.network.id),
      domain: m.domain,
      usdc: m.usdc,
      color: m.color,
      network: m.network,
      txUrl: explorerTxUrl(m.network),
    } satisfies ChainInfo,
  ]),
)

export const CHAIN_LIST: ChainInfo[] = Object.values(CHAINS)

/** 提供给 Reown AppKit / wagmi 的网络列表 */
export const APPKIT_NETWORKS = CHAIN_LIST.map((c) => c.network) as [
  AppKitNetwork,
  ...AppKitNetwork[],
]

export function getChain(key: string): ChainInfo {
  const c = CHAINS[key]
  if (!c) throw new Error(`未知链：${key}`)
  return c
}

/** 默认路由：Ink → Polygon */
export const DEFAULT_SOURCE_KEY = 'ink'
export const DEFAULT_DEST_KEY = 'polygon'

export const tokenMessengerV2Abi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)',
])

export const messageTransmitterV2Abi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
])
