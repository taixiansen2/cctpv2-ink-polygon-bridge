# CCTP v2 跨链桥 · Ink → Polygon

一个纯前端网页程序：用 **Circle CCTP v2**（支持 **标准 Standard / 快速 Fast** 两种模式）把原生 **USDC** 从 **Ink** 跨链到 **Polygon PoS**。

- 📱 通过 **WalletConnect 扫码** 连接手机钱包（也支持浏览器插件钱包）
- 🧾 实时展示 **跨链订单信息** 与 **四步进度**（授权 → 销毁 → Circle 证明 → 铸造）
- 🔁 刷新页面后订单状态自动恢复，可「继续 / 重试」
- 🛜 无后端：证明由 Circle Iris API 提供，交易由用户钱包直接签名

---

## CCTP v2 工作原理（本应用实现的流程）

| 步骤 | 链 | 操作 | 合约 |
| --- | --- | --- | --- |
| ① 授权 | Ink | `approve` USDC 给 TokenMessengerV2 | USDC |
| ② 销毁 | Ink | `depositForBurn(...)` 销毁 USDC 并发出跨链消息 | TokenMessengerV2 |
| ③ 证明 | — | 轮询 Circle Iris API 拿到 attestation | `iris-api.circle.com` |
| ④ 铸造 | Polygon | `receiveMessage(message, attestation)` 铸造 USDC | MessageTransmitterV2 |

**模式区别**（`depositForBurn` 的 `minFinalityThreshold`）：

- **快速 Fast** = `1000`：达到软最终性即铸造，约 8–30 秒，按费率收取少量手续费
- **标准 Standard** = `2000`：等待源链硬最终性，约 13–19 分钟，通常零手续费

手续费率通过 `GET /v2/burn/USDC/fees/{srcDomain}/{dstDomain}` 实时获取，`maxFee = ceil(amount × bps / 10000)`。

---

## 关键常量

| 项 | Ink | Polygon PoS |
| --- | --- | --- |
| Chain ID | 57073 | 137 |
| CCTP Domain | **21** | **7** |
| USDC | `0x2D270e6886d130D724215A266106e6832161EAEd` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |

两条链上合约地址一致：

- TokenMessengerV2：`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`
- MessageTransmitterV2：`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`

> 来源：[Circle CCTP EVM 合约文档](https://developers.circle.com/cctp/evm-smart-contracts)、[USDC 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)

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
2. 输入金额、选择模式（Fast / Standard）、确认接收地址（默认与发送地址相同）。
3. 点击「开始跨链」，依次在钱包里确认：
   - （如额度不足）授权交易 → 销毁交易 → 切换到 Polygon → 铸造交易。
4. 在「跨链订单」卡片里查看订单信息与四步进度、各笔交易的区块浏览器链接。
5. 若中途关闭页面，重新打开后会自动恢复订单，点「继续」即可补完后续步骤。

---

## ⚠️ 注意

- 这是 **主网真实资金** 操作，请先用 **小额** 测试。
- 跨链方向固定为 **Ink → Polygon**（在 `src/config/cctp.ts` 中可调整 `SOURCE` / `DEST`）。
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
│   └── cctp.ts       # 链、域、合约地址、ABI 等常量
├── lib/
│   ├── circle.ts     # Iris API：费率 + 证明轮询
│   └── format.ts     # 金额/地址/时间格式化
├── hooks/
│   └── useBridge.ts  # 跨链状态机（授权→销毁→证明→铸造，含持久化与恢复）
├── components/
│   └── OrderProgress.tsx  # 订单信息 + 进度展示
└── App.tsx           # 跨链表单 + 钱包连接
```
