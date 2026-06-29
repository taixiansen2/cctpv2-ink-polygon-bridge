import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { SolanaAdapter } from '@reown/appkit-adapter-solana'
import { APPKIT_NETWORKS, EVM_NETWORKS } from './cctp'

/**
 * Reown AppKit（WalletConnect v2）多链配置：EVM（wagmi）+ Solana。
 * 注入 `<appkit-*>` 按钮 / 弹窗，未安装插件钱包时会显示二维码，手机钱包扫码即可连接。
 */

export const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ?? ''

if (!projectId) {
  // 没有 projectId 时 WalletConnect 无法初始化，给出明确提示而不是静默失败
  console.warn(
    '[CCTP] 缺少 VITE_REOWN_PROJECT_ID。请到 https://cloud.reown.com 创建项目，' +
      '并在 .env 中填入，否则无法弹出扫码二维码。',
  )
}

// WagmiAdapter 只接受 EVM 网络
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: EVM_NETWORKS,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

// Solana 适配器（Solana 网络由 createAppKit 的 networks 提供）
const solanaAdapter = new SolanaAdapter()

const metadata = {
  name: 'CCTP v2 跨链桥',
  description: '用 Circle CCTP v2 在多条链之间跨链原生 USDC',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
  icons: ['https://cryptologos.cc/logos/usd-coin-usdc-logo.svg'],
}

// 副作用：初始化全局弹窗 / 注册 <appkit-*> 组件
createAppKit({
  adapters: [wagmiAdapter, solanaAdapter],
  networks: APPKIT_NETWORKS,
  projectId,
  metadata,
  themeMode: 'light',
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
})
