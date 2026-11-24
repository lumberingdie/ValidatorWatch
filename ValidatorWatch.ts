import { Bot } from 'grammy'
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher'
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types'
import * as fs from 'fs'
import { randomInt } from 'node:crypto'

const bot = new Bot(process.env.BOT_TOKEN!)
const connection = new Connection(process.env.RPC_URL!, 'confirmed')
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR_PATH!, 'utf-8')))
)
const client = searcherClient(process.env.BLOCK_ENGINE_URL!, keypair)
const TIP = 150_000

const counters = {
  sent: 0,
  landed: 0,
  rejected: 0,
  dropped: 0,
}
const bundles = new Map<string, 'waiting' | 'ok' | 'bad'>()

client.onBundleResult(
  (result) => {
    if (!bundles.has(result.bundleId)) return
    if (result.processed || result.finalized) {
      if (bundles.get(result.bundleId) !== 'ok') {
        bundles.set(result.bundleId, 'ok')
        counters.landed++
        console.log('landed!! ' + result.bundleId)
      }
    }
    if (result.rejected) {
      bundles.set(result.bundleId, 'bad')
      counters.rejected++
      console.log('rejected ' + result.bundleId)
    }
    if (result.dropped) {
      bundles.set(result.bundleId, 'bad')
      counters.dropped++
      console.log('dropped ' + result.bundleId)
    }
  },
  (err) => {
    console.log('listener broke', err)
  }
)

bot.command('buy', async (ctx) => {
  const txBase64 = ctx.match.trim()
  if (!txBase64) {
    await ctx.reply('usage: /buy <base64 tx>')
    return
  }

  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'))
  } catch (e) {
    await ctx.reply('that tx is not valid base64 / not a versioned tx')
    return
  }

  const tipAccounts = await client.getTipAccounts()
  if (!tipAccounts.ok) {
    console.log(tipAccounts.error)
    await ctx.reply('jito unreachable, try later')
    return
  }
  const tipAccount = new PublicKey(tipAccounts.value[randomInt(tipAccounts.value.length)])

  const { blockhash } = await connection.getLatestBlockhash()

  const bundle = new Bundle([tx], 5)
  const signedBundle = bundle.addTipTx(keypair, TIP, tipAccount, blockhash)
  if (signedBundle instanceof Error) {
    console.log(signedBundle)
    await ctx.reply('failed adding tip: ' + signedBundle.message)
    return
  }

  const res = await client.sendBundle(signedBundle)
  if (!res.ok) {
    console.log(res.error)
    await ctx.reply('oops ' + res.error.message)
    return
  }

  bundles.set(res.value, 'waiting')
  counters.sent++
  console.log('bundle away ' + res.value)
  await ctx.reply('bundle sent 🚀 id: ' + res.value)
})

bot.command('rate', async (ctx) => {
  if (counters.sent == 0) {
    await ctx.reply('no bundles sent yet')
    return
  }
  const pct = ((counters.landed / counters.sent) * 100).toFixed(1)
  await ctx.reply(
    'landed ' + counters.landed + '/' + counters.sent + ' (' + pct + '%)\n' +
    'rejected: ' + counters.rejected + ' dropped: ' + counters.dropped
  )
})

bot.catch((err) => {
  console.log('bot error', err)
})

console.log('bot starting...')
bot.start()
