/**
 * Solana 侧的 CCTP v2 交互（销毁 / 铸造）。
 * 严格对照 Circle 官方示例：
 *   https://github.com/circlefin/solana-cctp-contracts/blob/master/examples/v2/solana.ts
 *
 * ⚠️ 主网真实资金：本模块按官方示例实现，但 Solana 链上交易未在本环境实跑，
 *    上主网前请先在 devnet 或用极小额验证。
 */
import { Buffer } from 'buffer'
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import MT_IDL from '../idl/message_transmitter_v2.json'
import TMM_IDL from '../idl/token_messenger_minter_v2.json'
import { SOLANA_CCTP } from '../config/cctp'

export const USDC_MINT = new PublicKey(SOLANA_CCTP.usdcMint)

/** AppKit Solana provider 满足的最小钱包接口 */
export interface SolanaWallet {
  publicKey: PublicKey
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>
  signAllTransactions?: <T extends Transaction>(txs: T[]) => Promise<T[]>
  sendTransaction?: (tx: Transaction, connection: Connection, options?: unknown) => Promise<string>
}

export interface SolanaContext {
  connection: Connection
  wallet: SolanaWallet
}

/** 轮询确认（不依赖 websocket，兼容公共 RPC） */
async function confirmSignature(connection: Connection, sig: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0]
    if (st?.err) throw new Error(`Solana 交易失败：${JSON.stringify(st.err)}`)
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('Solana 交易确认超时')
}

/**
 * 组装、签名并发送交易。
 * 用 signTransaction + sendRawTransaction：blockhash 由我们固定，额外签名者（如 MessageSent 事件账户）
 * 的签名才不会因 blockhash 变化而失效；对手机 WalletConnect 钱包兼容性也最好。
 */
async function signAndSend(
  ctx: SolanaContext,
  instructions: TransactionInstruction[],
  signers: Keypair[] = [],
): Promise<string> {
  const { connection, wallet } = ctx
  const { blockhash } = await connection.getLatestBlockhash('finalized')
  const tx = new Transaction()
  tx.feePayer = wallet.publicKey
  tx.recentBlockhash = blockhash
  tx.add(...instructions)
  if (signers.length) tx.partialSign(...signers)
  const signed = await wallet.signTransaction(tx)
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false })
  await confirmSignature(connection, sig)
  return sig
}

function hexToBuffer(hex: string, pad32 = false): Buffer {
  let h = hex.replace(/^0x/, '')
  if (pad32) h = h.padStart(64, '0')
  return Buffer.from(h, 'hex')
}

/** 把 EVM 地址左补零成 32 字节，作为 Solana 这边表示的 PublicKey */
export function evmAddressToPubkey(evmAddress: string): PublicKey {
  return new PublicKey(hexToBuffer(evmAddress, true))
}

/** 从 v2 消息里取 32 字节 nonce（偏移 12，长度 32） */
export function decodeNonceV2(messageHex: string): Buffer {
  return hexToBuffer(messageHex).subarray(12, 44)
}

export function isSolanaAddress(value: string): boolean {
  try {
    // 仅做格式校验
    // eslint-disable-next-line no-new
    new PublicKey(value)
    return true
  } catch {
    return false
  }
}

/** 某 owner 的 USDC 关联代币账户（ATA） */
export function usdcAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_MINT, owner, true)
}

/** 目标为 Solana 时，EVM 端 depositForBurn 的 mintRecipient = 收款 ATA 的 32 字节 hex */
export function solanaAtaAsBytes32(ownerBase58: string): `0x${string}` {
  const ata = usdcAta(new PublicKey(ownerBase58))
  return `0x${ata.toBuffer().toString('hex')}`
}

function pda(label: string, programId: PublicKey, extra: (Buffer | PublicKey | string)[] = []): PublicKey {
  const seeds: (Buffer | Uint8Array)[] = [Buffer.from(label)]
  for (const s of extra) {
    if (typeof s === 'string') seeds.push(Buffer.from(s))
    else if (s instanceof PublicKey) seeds.push(s.toBuffer())
    else seeds.push(s)
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function getPrograms(ctx: SolanaContext) {
  const provider = new AnchorProvider(ctx.connection, ctx.wallet as any, { commitment: 'confirmed' })
  const mt = new Program(MT_IDL as Idl, provider) as any
  const tmm = new Program(TMM_IDL as Idl, provider) as any
  return { provider, mt, tmm }
}

/**
 * 在 Solana 上销毁 USDC（Solana 作为源链）。
 * @param mintRecipient 目标链收款方的 32 字节表示（EVM 目标 = 左补零后的 EVM 地址）
 */
export async function solanaDepositForBurn(args: {
  ctx: SolanaContext
  amount: bigint
  destinationDomain: number
  mintRecipient: PublicKey
  maxFee: bigint
  minFinalityThreshold: number
  destinationCaller?: PublicKey
}): Promise<{ signature: string; eventAccount: string }> {
  const { ctx } = args
  const { mt, tmm } = getPrograms(ctx)
  const owner = ctx.wallet.publicKey
  const burnTokenAccount = usdcAta(owner)

  const messageTransmitter = pda('message_transmitter', mt.programId)
  const tokenMessenger = pda('token_messenger', tmm.programId)
  const tokenMinter = pda('token_minter', tmm.programId)
  const localToken = pda('local_token', tmm.programId, [USDC_MINT])
  const remoteTokenMessenger = pda('remote_token_messenger', tmm.programId, [
    String(args.destinationDomain),
  ])
  const senderAuthorityPda = pda('sender_authority', tmm.programId)

  // 每次销毁要为 MessageSent 事件账户新建一个 keypair，并作为额外签名者
  const messageSentEventData = Keypair.generate()

  const burnIx = await tmm.methods
    .depositForBurn({
      amount: new BN(args.amount.toString()),
      destinationDomain: args.destinationDomain,
      mintRecipient: args.mintRecipient,
      maxFee: new BN(args.maxFee.toString()),
      minFinalityThreshold: args.minFinalityThreshold,
      destinationCaller: args.destinationCaller ?? PublicKey.default,
    })
    .accounts({
      owner,
      eventRentPayer: owner,
      senderAuthorityPda,
      burnTokenAccount,
      messageTransmitter,
      tokenMessenger,
      remoteTokenMessenger,
      tokenMinter,
      localToken,
      burnTokenMint: USDC_MINT,
      messageSentEventData: messageSentEventData.publicKey,
      messageTransmitterProgram: mt.programId,
      tokenMessengerMinterProgram: tmm.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const signature = await signAndSend(ctx, [burnIx], [messageSentEventData])
  return { signature, eventAccount: messageSentEventData.publicKey.toBase58() }
}

/**
 * 回收发送端 MessageSent 事件账户的租金（Solana 作为源链时）。
 * 转账完成后该账户不再需要，关闭即可把租金退回 payee（钱包）。
 */
export async function solanaReclaimEventAccount(args: {
  ctx: SolanaContext
  messageHex: string
  attestationHex: string
  eventAccount: string
}): Promise<string> {
  const { ctx } = args
  const { mt } = getPrograms(ctx)
  const messageTransmitter = pda('message_transmitter', mt.programId)

  const ix = await mt.methods
    .reclaimEventAccount({
      attestation: hexToBuffer(args.attestationHex),
      destinationMessage: hexToBuffer(args.messageHex),
    })
    .accounts({
      payee: ctx.wallet.publicKey,
      messageTransmitter,
      messageSentEventData: new PublicKey(args.eventAccount),
    })
    .instruction()

  return signAndSend(ctx, [ix])
}

/**
 * 在 Solana 上铸造 USDC（Solana 作为目标链）。
 * @param remoteUsdcHex 源链 USDC 地址（hex），内部会补足到 32 字节
 * @param recipientOwner 收款钱包；其 USDC ATA 不存在时会顺带创建
 */
export async function solanaReceiveMessage(args: {
  ctx: SolanaContext
  messageHex: string
  attestationHex: string
  remoteDomain: number
  remoteUsdcHex: string
  recipientOwner: PublicKey
}): Promise<string> {
  const { ctx } = args
  const { mt, tmm } = getPrograms(ctx)
  const remoteDomainStr = String(args.remoteDomain)
  const nonce = decodeNonceV2(args.messageHex)

  const tokenMessenger = pda('token_messenger', tmm.programId)
  const messageTransmitter = pda('message_transmitter', mt.programId)
  const tokenMinter = pda('token_minter', tmm.programId)
  const localToken = pda('local_token', tmm.programId, [USDC_MINT])
  const remoteTokenMessenger = pda('remote_token_messenger', tmm.programId, [remoteDomainStr])
  const remoteTokenKey = new PublicKey(hexToBuffer(args.remoteUsdcHex, true))
  const tokenPair = pda('token_pair', tmm.programId, [remoteDomainStr, remoteTokenKey])
  const custodyTokenAccount = pda('custody', tmm.programId, [USDC_MINT])
  const authorityPda = pda('message_transmitter_authority', mt.programId, [tmm.programId])
  const tokenMessengerEventAuthority = pda('__event_authority', tmm.programId)
  const usedNonce = pda('used_nonce', mt.programId, [nonce])

  const recipientTokenAccount = usdcAta(args.recipientOwner)
  const tokenMessengerAccount = await tmm.account.tokenMessenger.fetch(tokenMessenger)
  const feeRecipientTokenAccount = getAssociatedTokenAddressSync(
    USDC_MINT,
    tokenMessengerAccount.feeRecipient,
    true,
  )

  // CCTP 要求收款 ATA 在 receiveMessage 前已存在，否则会回滚 —— 不存在则先幂等创建
  const preInstructions: TransactionInstruction[] = []
  const ataInfo = await ctx.connection.getAccountInfo(recipientTokenAccount)
  if (!ataInfo) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.wallet.publicKey,
        recipientTokenAccount,
        args.recipientOwner,
        USDC_MINT,
      ),
    )
  }

  const remainingAccounts = [
    { isSigner: false, isWritable: false, pubkey: tokenMessenger },
    { isSigner: false, isWritable: false, pubkey: remoteTokenMessenger },
    { isSigner: false, isWritable: true, pubkey: tokenMinter },
    { isSigner: false, isWritable: true, pubkey: localToken },
    { isSigner: false, isWritable: false, pubkey: tokenPair },
    { isSigner: false, isWritable: true, pubkey: feeRecipientTokenAccount },
    { isSigner: false, isWritable: true, pubkey: recipientTokenAccount },
    { isSigner: false, isWritable: true, pubkey: custodyTokenAccount },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: tokenMessengerEventAuthority },
    { isSigner: false, isWritable: false, pubkey: tmm.programId },
  ]

  const receiveIx = await mt.methods
    .receiveMessage({
      message: hexToBuffer(args.messageHex),
      attestation: hexToBuffer(args.attestationHex),
    })
    .accounts({
      payer: ctx.wallet.publicKey,
      caller: ctx.wallet.publicKey,
      authorityPda,
      messageTransmitter,
      usedNonce,
      receiver: tmm.programId,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction()

  return signAndSend(ctx, [...preInstructions, receiveIx])
}

/** 查询某地址的 USDC 余额（最小单位 bigint）；账户不存在返回 0 */
export async function solanaUsdcBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<bigint> {
  try {
    const ata = usdcAta(owner)
    const bal = await connection.getTokenAccountBalance(ata)
    return BigInt(bal.value.amount)
  } catch {
    return 0n
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
