import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { ink, polygon, type AppKitNetwork } from '@reown/appkit/networks'

/**
 * Reown AppKit（WalletConnect v2）+ wagmi 配置。
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

// 仅需 Ink（源）与 Polygon（目标）两条链
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [ink, polygon]

export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

const metadata = {
  name: 'CCTP v2 跨链桥',
  description: '用 Circle CCTP v2 把 USDC 从 Ink 跨链到 Polygon',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
  icons: ['https://cryptologos.cc/logos/usd-coin-usdc-logo.svg'],
}

// 副作用：初始化全局弹窗 / 注册 <appkit-*> 组件
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  metadata,
  themeMode: 'dark',
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
})
