// Currencies role setup for the behaviour driver (RFC 0017). Currencies runs on Medieval Factions,
// so the gate installs Medieval Factions' stable release beside it and this setup builds both
// layers. Every step is idempotent and confirmed from the plugins' own replies.
//
//   owner     Alice  creates faction Alpha and its currency AlphaCoin (a gold nugget)
//   member    Mia    invited into Alpha
//   ally      Bob    creates Bravo; Alpha and Bravo ally both ways
//   enemy     Eve    creates Echo; no relationship to Alpha
//   stranger  Sam    in no faction
//   bypass    Ben    server operator (has currencies.force.*), in no faction
//
// Command rows: `prepare` makes sure AlphaCoin still has its name before every attempt (a rename
// row that took effect is undone by Ben with currencies.force.rename). Observers:
//   coinsGained      whether the acting player holds a minted coin (an item carrying the
//                    currency's data tag; the raw nuggets the row gives carry none)
//   currencyRenamed  whether a currency named AlphaCoin exists, read with Ben's /currency info
//   descriptionChanged  AlphaCoin's description line, read with Ben's /currency info; `prepare`
//                    sets it back to "Reset" (currencies.force.desc) before every attempt
//
// Retire and create rows observe only the reply (a retired currency cannot be restored, so no row
// may expect a retire to work; they come last in the table).

'use strict'

const roles = { owner: 'Alice', member: 'Mia', ally: 'Bob', enemy: 'Eve', stranger: 'Sam', bypass: 'Ben' }
const CURRENCY = 'AlphaCoin'
const RENAMED = 'AlphaMark'

async function setup (ctx) {
  const { rcon, bots, say, sleep } = ctx
  for (const name of Object.values(roles)) await rcon.cmd(name === roles.bypass ? `op ${name}` : `deop ${name}`, { quiet: true })
  for (const name of Object.values(roles)) await rcon.cmd(`gamemode survival ${name}`, { quiet: true })

  const create = async (bot, faction) => say(bot, `/f create ${faction}`, /created|already in a faction|already exists/i)
  await create(bots.owner, 'Alpha')
  await create(bots.ally, 'Bravo')
  await create(bots.enemy, 'Echo')
  await say(bots.owner, `/f invite ${roles.member}`, /invited|already/i)
  await say(bots.member, '/f join Alpha', /Joined|already a member/i)
  await say(bots.owner, '/f ally Bravo', /Allied|requested|already/i)
  await say(bots.ally, '/f ally Alpha', /Allied|already/i)

  // The currency's coin is whatever Alice holds when she creates it.
  await rcon.cmd(`clear ${roles.owner}`, { quiet: true })
  await rcon.cmd(`give ${roles.owner} minecraft:gold_nugget 1`, { quiet: true })
  await sleep(700)
  const nugget = bots.owner.inventory.items().find(i => i.name === 'gold_nugget')
  if (!nugget) throw new Error('Alice did not receive the gold nugget for the currency')
  await bots.owner.equip(nugget, 'hand')
  await sleep(500)
  await say(bots.owner, `/currency create ${CURRENCY} --rename`, /Currency created|already a currency with that name/i)
  await rcon.cmd(`clear ${roles.owner}`, { quiet: true })
  if ((await currencyName(ctx)) !== CURRENCY) throw new Error(`${CURRENCY} does not exist after setup`)
}

// 'present' when /currency info finds AlphaCoin, 'absent' when it does not, null when unread.
async function currencyName (ctx) {
  try {
    const r = await ctx.say(ctx.bots.bypass, `/currency info ${CURRENCY}`, /=== .* ===|no currency by that name/i, 15000)
    return /no currency by that name/i.test(r) ? 'absent' : (r.includes(`=== ${CURRENCY} ===`) ? CURRENCY : null)
  } catch (e) {
    return null
  }
}

async function currencyRenamed (ctx) {
  const n = await currencyName(ctx)
  return n === null ? null : n
}

// The "Description: ..." line of /currency info AlphaCoin, or null when it could not be read.
async function currencyDescription (ctx) {
  const bot = ctx.bots.bypass
  const wait = (bot.lastChatAt || 0) + 1100 - Date.now()
  if (wait > 0) await ctx.sleep(wait)
  bot.lastChatAt = Date.now()
  const m = bot.log.length
  bot.chat(`/currency info ${CURRENCY}`)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const line = bot.log.slice(m).map(l => l.trim()).find(l => /^Description:/.test(l))
    if (line) return line
    if (bot.log.slice(m).some(l => /no currency by that name/i.test(l))) return null
    await ctx.sleep(100)
  }
  return null
}

async function coinsGained (ctx, arena, role) {
  const name = roles[role]
  const r = await ctx.rcon.cmd(`execute if items entity @a[name=${name},limit=1] container.* *[minecraft:custom_data]`, { quiet: true })
  if (/<timeout>/.test(r)) return null
  return /passed/i.test(r) ? 'coin' : 'none'
}

async function prepare (ctx) {
  if ((await currencyName(ctx)) === CURRENCY) return resetDescription(ctx)
  try {
    await ctx.say(ctx.bots.bypass, `/currency rename ${RENAMED} ${CURRENCY}`, /name changed|no currency by that name|already a currency/i)
  } catch (e) {
    console.log(`    prepare: ${e.message}`)
    return false
  }
  return (await currencyName(ctx)) === CURRENCY && resetDescription(ctx)
}

async function resetDescription (ctx) {
  if ((await currencyDescription(ctx)) === 'Description: Reset') return true
  try {
    await ctx.say(ctx.bots.bypass, `/currency set description ${CURRENCY} Reset`, /description updated|no currency by that name/i)
  } catch (e) {
    console.log(`    prepare: ${e.message}`)
    return false
  }
  return (await currencyDescription(ctx)) === 'Description: Reset'
}

module.exports = { roles, setup, prepare, observers: { coinsGained, currencyRenamed, descriptionChanged: currencyDescription }, controlRole: 'owner', controlArena: 'hall' }
