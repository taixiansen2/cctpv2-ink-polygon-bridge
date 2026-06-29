# CCTP v2 跨链桥 · 全 EVM 链 + Solana

一个纯前端网页程序：用 **Circle CCTP v2**（支持 **标准 Standard / 快速 Fast** 两种模式）在 **CCTP v2 支持的 EVM 链与 Solana**之间互转原生 **USDC**，支持任意「源链 → 目标链」组合（含 EVM↔Solana 跨生态）。

- 🌐 **13 条 EVM 链 + Solana**任意互转（下拉选择源/目标链 + 一键交换方向）
- 📱 通过 **WalletConnect 扫码** 连接手机钱包（EVM 与 Solana 均支持，也支持浏览器插件钱包）
- 🧾 实时展示 **跨链订单信息** 与 **四步进度**（授权 → 销毁 → Circle 证明 → 铸造）
- 🔁 刷新页面后订单状态自动恢复，可「继续 / 重试」
- 🛜 无后端：证明由 Circle Iris API 提供，交易由用户钱包直接签名

---

## 支持的链

> 域 ID 与原生 USDC 地址来自 [Circle 官方文档](https://developers.circle.com/cctp/evm-smart-contracts)，具体地址见 [`src/config/cctp.ts`](src/config/cctp.ts)。

| 链 | Chain ID | CCTP 域 | 链 | Chain ID | CCTP 域 |
| --- | --- | --- | --- | --- | --- |
| Ethereum | 1 | 0 | Unichain | 130 | 10 |
| Avalanche | 43114 | 1 | Linea | 59144 | 11 |
| Optimism | 10 | 2 | Codex | 81224 | 12 |
| Arbitrum | 42161 | 3 | Sonic | 146 | 13 |
| Base | 8453 | 6 | World Chain | 480 | 14 |
| Polygon PoS | 137 | 7 | Sei | 1329 | 16 |
| Ink | 57073 | 21 | **Solana** | mainnet-beta | **5** |

EVM 各链上的 CCTP v2 合约地址一致（EDGE 链除外）：

- TokenMessengerV2：`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`
- MessageTransmitterV2：`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`

Solana（CCTP v2 程序，来自 [Circle 文档](https://developers.circle.com/cctp/solana-programs)）：

- USDC mint：`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- MessageTransmitterV2：`CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`
- TokenMessengerMinterV2：`CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`

> **Solana 实现说明**：销毁 / 铸造指令严格对照 Circle 官方 v2 示例（`examples/v2/solana.ts`）实现，
> 用 Anchor + 官方 IDL 构造。**EVM↔Solana 跨生态需同时连接 EVM 与 Solana 两个钱包**
> （源链销毁用一端，目标链铸造用另一端）。目标为 Solana 时，收款方的 USDC 关联账户（ATA）
> 会在 `receiveMessage` 时按需自动创建。
>
> ⚠️ Solana 链上交易未在本仓库环境实跑，**上主网前请先在 devnet 或用极小额验证**。

> 想增删链：编辑 [`src/config/cctp.ts`](src/config/cctp.ts) 里的 `META` 表（链对象来自 `@reown/appkit/networks`，附上 Circle 的域 ID 与 USDC 地址即可）。

---

## CCTP v2 工作原理（本应用实现的流程）

| 步骤 | 链 | 操作 | 合约 |
| --- | --- | --- | --- |
| ① 授权 | 源链 | `approve` USDC 给 TokenMessengerV2 | USDC |
| ② 销毁 | 源链 | `depositForBurn(...)` 销毁 USDC 并发出跨链消息 | TokenMessengerV2 |
| ③ 证明 | — | 轮询 Circle Iris API 拿到 attestation | `iris-api.circle.com` |
| ④ 铸造 | 目标链 | `receiveMessage(message, attestation)` 铸造 USDC | MessageTransmitterV2 |

**模式区别**（`depositForBurn` 的 `minFinalityThreshold`）：

- **快速 Fast** = `1000`：达到软最终性即铸造，约 8–30 秒，按费率收取少量手续费
- **标准 Standard** = `2000`：等待源链硬最终性，约 13–19 分钟，通常零手续费

手续费率通过 `GET /v2/burn/USDC/fees/{srcDomain}/{dstDomain}` 实时获取（部分路由为小数 bps，如 1.3），`maxFee = ceil(amount × bps / 10000)` 自动计算。

---

## 快速开始

### 1. 配置环境变量

复制 `.env.example` 为 `.env`，填入 **Reown(WalletConnect) Project ID**（免费）：

```bash
cp .env.example .env
```

```ini
VITE_REOWN_PROJECT_ID=你的_project_id   # 到 https://cloud.reown.com 创建
VITE_IRIS_BASE=https://iris-api.circle.com
```

> 没有 Project ID 将无法弹出扫码二维码。

### 2. 安装并运行

```bash
npm install
npm run dev
```

打开终端提示的地址（默认 http://localhost:5173）。手机用钱包扫码即可连接。

### 3. 构建生产版本

```bash
npm run build
npm run preview
```

---

## 使用步骤

1. 点击「连接钱包（扫码）」，用手机钱包扫描二维码完成连接。
2. 选择 **源链 / 目标链**（中间 ⇅ 可一键交换），输入金额、选择模式、确认接收地址。
3. 点击「开始跨链」，依次在钱包里确认：
   - （如额度不足）授权交易 → 销毁交易 → 切换到目标链 → 铸造交易。
4. 在「跨链订单」卡片里查看订单信息与四步进度、各笔交易的区块浏览器链接。
5. 若中途关闭页面，重新打开后会自动恢复订单，点「继续」即可补完后续步骤。

---

## ⚠️ 注意

- 这是 **主网真实资金** 操作，请先用 **小额** 测试，并在大额转账前自行核对 USDC 合约地址。
- 默认路由为 Ink → Polygon，可在界面上任意切换。
- 切换到测试网时，把 `VITE_IRIS_BASE` 改为 `https://iris-api-sandbox.circle.com`，并相应替换链与合约配置。
- 标准模式耗时较长，请耐心等待 Circle 证明生成。

---

## 技术栈

- [Vite](https://vite.dev) + React + TypeScript
- [Reown AppKit](https://reown.com)（WalletConnect v2）+ [wagmi](https://wagmi.sh) + [viem](https://viem.sh)
- Circle CCTP v2 合约 + Iris API

## 目录结构

```
src/
├── config/
│   ├── appkit.ts     # WalletConnect / wagmi 初始化（扫码连接）
│   └── cctp.ts       # 链注册表（域/合约/USDC/ABI）—— 增删链改这里
├── idl/              # Solana CCTP v2 程序 Anchor IDL（来自 Circle 官方）
├── lib/
│   ├── circle.ts     # Iris API：费率 + 证明轮询
│   ├── solana.ts     # Solana 侧 depositForBurn / receiveMessage（Anchor）
│   └── format.ts     # 金额/地址/时间格式化
├── hooks/
│   └── useBridge.ts  # 跨链状态机（授权→销毁→证明→铸造，含持久化与恢复）
├── components/
│   └── OrderProgress.tsx  # 订单信息 + 进度展示
└── App.tsx           # 链选择 + 跨链表单 + 钱包连接
```
