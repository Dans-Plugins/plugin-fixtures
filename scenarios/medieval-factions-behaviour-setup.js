// Medieval Factions role setup for the behaviour driver (RFC 0017).
//
// Seven bots, one per role. Every step is idempotent - a second run against the same plugin
// data accepts "already" replies - and is confirmed from the plugin's own reply.
//
//   owner       Alice  creates Alpha and claims the ownerClaim arena
//   member      Mia    invited into Alpha
//   ally        Bob    creates Bravo; Alpha and Bravo ally both ways
//   enemy       Eve    creates Echo; no relationship to Alpha
//   enemyAtWar  Wes    creates Whiskey; Alpha declares war on Whiskey
//   stranger    Sam    in no faction
//   bypass      Ben    server operator with /f bypass enabled
//
// The lockArena (a second Alpha chunk) holds a chest Alice locks, with Bob (the ally) added as
// an accessor. The lock record is kept by position, so the driver re-placing the chest for each
// row leaves it locked; no row may break that chest as a player who is allowed to, which would
// delete the lock.
//
// Only Ben is an operator: every other role proves what a player can do with the plugin's
// default permissions.
//
// Command rows (claiming): an arena's `claimedBy` (a faction name, or null for wilderness) is the
// state `prepare` restores before every attempt: the owner of whichever faction holds the chunk
// unclaims it, then the wanted faction's owner claims it. The `claimChanged` observer reads the
// chunk's owner with Ben's `/f claim check`.

'use strict'

const roles = {
  owner: 'Alice', member: 'Mia', ally: 'Bob', enemy: 'Eve', enemyAtWar: 'Wes', stranger: 'Sam', bypass: 'Ben'
}

async function setup (ctx) {
  const { rcon, bots, arenas, say, tp, Y, targetPoint, sleep } = ctx
  for (const name of Object.values(roles)) await rcon.cmd(name === roles.bypass ? `op ${name}` : `deop ${name}`, { quiet: true })
  for (const name of Object.values(roles)) await rcon.cmd(`gamemode survival ${name}`, { quiet: true })

  const create = async (bot, faction) => say(bot, `/f create ${faction}`, /created|already in a faction|already exists/i)
  await create(bots.owner, 'Alpha')
  await create(bots.ally, 'Bravo')
  await create(bots.enemy, 'Echo')
  await create(bots.enemyAtWar, 'Whiskey')

  // Claim the owner's arena from inside it.
  const T = targetPoint(arenas.ownerClaim)
  if (!(await tp(rcon, bots.owner, T.x + 0.5, Y, T.z + 0.5))) throw new Error('owner could not reach the claim arena')
  await say(bots.owner, '/f claim', /Claimed|aren't any claimable|already/i)
  const owner = await say(bots.owner, '/f claim check', /Alpha|Wilderness|claim/i)
  if (!/Alpha/.test(owner)) throw new Error(`ownerClaim arena is not Alpha's: ${owner}`)
  // Alpha's home, in its claim. Set here, not by a row: the gate cuts a group into shards of up
  // to 15 rows, each on its own server with its own setup, so no row may rely on an earlier row.
  await say(bots.owner, '/f sethome', /Faction home set|home/i)

  // The wilderness arena must really be unclaimed (harness rule 3).
  const W = targetPoint(arenas.wilderness)
  if (!(await tp(rcon, bots.stranger, W.x + 0.5, Y, W.z + 0.5))) throw new Error('stranger could not reach the wilderness arena')
  const wild = await say(bots.stranger, '/f claim check', /Wilderness|not claimed|claimed by|Alpha|Bravo|Echo|Whiskey/i)
  if (/Alpha|Bravo|Echo|Whiskey/.test(wild)) throw new Error(`wilderness arena is claimed: ${wild}`)

  await say(bots.owner, `/f invite ${roles.member}`, /invited|already/i)
  await say(bots.member, '/f join Alpha', /Joined|already a member/i)

  await say(bots.owner, '/f ally Bravo', /Allied|requested|already/i)
  await say(bots.ally, '/f ally Alpha', /Allied|already/i)

  await say(bots.owner, '/f declarewar Whiskey', /at war/i)

  if (arenas.lockArena) {
    const { Vec3 } = require('vec3')
    const L = targetPoint(arenas.lockArena)
    if (!(await tp(rcon, bots.owner, L.x + 0.5, Y, L.z - 3.5))) throw new Error('owner could not reach the lock arena')
    await say(bots.owner, '/f claim', /Claimed|aren't any claimable|already/i)
    const lockOwner = await say(bots.owner, '/f claim check', /Alpha|Wilderness|claim/i)
    if (!/Alpha/.test(lockOwner)) throw new Error(`lockArena is not Alpha's: ${lockOwner}`)
    await rcon.cmd(`setblock ${L.x} ${L.y} ${L.z} minecraft:chest`, { quiet: true })
    if (!(await tp(rcon, bots.owner, L.x + 2.5, Y, L.z + 0.5, 90))) throw new Error('owner could not reach the chest')
    await sleep(600)
    await say(bots.owner, '/lock', /select the block|already/i)
    await bots.owner.lookAt(new Vec3(L.x + 0.5, L.y + 0.5, L.z + 0.5), true)
    await sleep(300)
    const m = bots.owner.log.length
    bots.owner.activateBlock(bots.owner.blockAt(new Vec3(L.x, L.y, L.z))).catch(() => {})
    const locked = await waitReply(bots.owner, m, /Block locked|already locked/i, 15000)
    await say(bots.owner, '/lock cancel', /Cancelled locking|not attempting/i)
    if (!locked) throw new Error('the lock arena chest could not be locked')
    await say(bots.owner, `/accessors add ${L.x} ${L.y} ${L.z} ${roles.ally}`, /Allowed|already|access/i)
  }

  // Vassal groups: Echo (the enemy role's faction) swears fealty to Alpha, so Alice is the liege's
  // owner and Eve the vassal's. In `liegeLand` Eve also claims the vassalClaim arena for Echo, so
  // the liege can be tried on the vassal's land.
  if (['vassal', 'vassalLand', 'liegeLand'].includes(ctx.group)) {
    await say(bots.owner, '/f vassalize Echo', /Successfully sent vassalization request|already requested|already pending/i)
    await say(bots.enemy, '/f swearfealty Alpha', /Successfully swore fealty|already a vassal of that faction/i)
    const V = targetPoint(arenas.vassalClaim)
    if (!(await tp(rcon, bots.enemy, V.x + 0.5, Y, V.z - 3.5))) throw new Error('enemy could not reach vassalClaim')
    await say(bots.enemy, '/f claim', /Claimed|aren't any claimable|already/i)
    const held = await say(bots.enemy, '/f claim check', /Echo|Wilderness|claim/i)
    if (!/Echo/.test(held)) throw new Error(`vassalClaim is not Echo's: ${held}`)
  }

  // The `duel` group: Alice (owner) and Mia (member, same faction) are in a duel for the whole pass
  // (the group sets duels.duration to 30 minutes).
  if (ctx.group === 'duel') {
    await say(bots.owner, `/duel challenge ${roles.member}`, /You have challenged|already invited|already in an active duel/i)
    await say(bots.member, `/duel accept ${roles.owner}`, /the duel has begun|already in an active duel/i)
  }

  // The `gate` group: Alice claims gateArena and makes a gate of a 1x4 oak-plank column (4 tall: MF measures height as maxY - minY, see Medieval-Factions issue on gate height), three
  // blocks north of the target point, with a floor lever on the target point as its trigger. Gate
  // rows flip that lever; `gateOpened` reads whether the column starts to open.
  if (ctx.group === 'gate') await buildGate(ctx)

  // Bypass: read the toggle's reply and toggle again if it switched it off.
  const b = await say(bots.bypass, '/f bypass', /Bypass (enabled|disabled)/i)
  if (/disabled/i.test(b)) await say(bots.bypass, '/f bypass', /Bypass enabled/i)
  await sleep(500)
}

// Who owns the arena's chunk, as Ben reads it from inside: a faction name, 'wilderness', or null
// when it could not be read (the row is then not checked).
async function claimOwner (ctx, arena) {
  const { rcon, bots, say, tp, Y, targetPoint } = ctx
  const T = targetPoint(arena)
  if (!(await tp(rcon, bots.bypass, T.x + 4.5, Y, T.z + 4.5))) return null
  try {
    const r = await say(bots.bypass, '/f claim check', /currently claimed by|not currently claimed/i, 15000)
    const m = r.match(/claimed by (.+?)\.?$/i)
    return /not currently claimed/i.test(r) ? 'wilderness' : (m ? m[1].trim() : null)
  } catch (e) {
    return null
  }
}

function gateBlocks (ctx, arena) {
  const T = ctx.targetPoint(arena)
  return { lever: T, bottom: T.offset(0, 0, 3), top: T.offset(0, 3, 3) }
}

async function buildGate (ctx) {
  const { rcon, bots, arenas, say, tp, Y, targetPoint, sleep } = ctx
  const arena = arenas.gateArena
  const T = targetPoint(arena)
  const g = gateBlocks(ctx, arena)
  if (!(await tp(rcon, bots.owner, T.x + 0.5, Y, T.z - 3.5))) throw new Error('owner could not reach gateArena')
  await say(bots.owner, '/f claim', /Claimed|aren't any claimable|already/i)
  const held = await say(bots.owner, '/f claim check', /Alpha|Wilderness|claim/i)
  if (!/Alpha/.test(held)) throw new Error(`gateArena is not Alpha's: ${held}`)
  await rcon.cmd(`fill ${g.bottom.x} ${g.bottom.y} ${g.bottom.z} ${g.top.x} ${g.top.y} ${g.top.z} minecraft:oak_planks`, { quiet: true })
  await rcon.cmd(`setblock ${g.lever.x} ${g.lever.y} ${g.lever.z} minecraft:lever[face=floor,powered=false]`, { quiet: true })
  if (!(await tp(rcon, bots.owner, T.x + 2.5, Y, T.z + 1.5, 90))) throw new Error('owner could not reach the gate')
  await sleep(600)
  const click = async (pos, re, what) => {
    await bots.owner.lookAt(pos.offset(0.5, 0.5, 0.5), true)
    await sleep(300)
    const m = bots.owner.log.length
    bots.owner.activateBlock(bots.owner.blockAt(pos)).catch(() => {})
    if (!(await waitReply(bots.owner, m, re, 15000))) {
      throw new Error(`gate creation: no ${re} after selecting the ${what}; received ${JSON.stringify(bots.owner.log.slice(m))}`)
    }
    await sleep(1200)
  }
  await say(bots.owner, '/gate create', /select the first corner|already creating a gate/i)
  await click(g.bottom, /select the second corner/i, 'first corner')
  await click(g.top, /select the trigger/i, 'second corner')
  await click(g.lever, /Gate created/i, 'trigger')
  if ((await gateOpened(ctx, arena)) !== 'closed') throw new Error('the gate is not closed after creation')
}

// 'open' when the gate's bottom block turns to air within 4 s (a powered trigger opens a gate on
// the next one-second poll, lowest layer first), 'closed' when it stays, null when unreadable.
async function gateOpened (ctx, arena) {
  if (!arena.keepBlocks) return null
  const b = gateBlocks(ctx, arena).bottom
  for (let i = 0; i < 16; i++) {
    const r = await ctx.rcon.cmd(`execute if block ${b.x} ${b.y} ${b.z} minecraft:oak_planks`, { quiet: true })
    if (/<timeout>/.test(r)) return null
    if (!/passed/i.test(r)) return 'open'
    await ctx.sleep(250)
  }
  return 'closed'
}

// Each faction's owner, who can always claim and unclaim its land (no force permission needed:
// `/f claim <faction>` does not exist in 7.0.0).
const factionOwners = { Alpha: 'owner', Bravo: 'ally', Echo: 'enemy', Whiskey: 'enemyAtWar' }

async function prepare (ctx, arena) {
  // A gate arena: switch the lever off and wait for the gate to close again (all three blocks).
  if (arena.keepBlocks && ctx.group === 'gate') {
    const g = gateBlocks(ctx, arena)
    await ctx.rcon.cmd(`setblock ${g.lever.x} ${g.lever.y} ${g.lever.z} minecraft:lever[face=floor,powered=false]`, { quiet: true })
    for (let i = 0; i < 40; i++) {
      const top = await ctx.rcon.cmd(`execute if block ${g.top.x} ${g.top.y} ${g.top.z} minecraft:oak_planks`, { quiet: true })
      const low = await ctx.rcon.cmd(`execute if block ${g.bottom.x} ${g.bottom.y} ${g.bottom.z} minecraft:oak_planks`, { quiet: true })
      if (/passed/i.test(top) && /passed/i.test(low)) return true
      await ctx.sleep(500)
    }
    console.log('    prepare gateArena: the gate did not close')
    return false
  }
  if (!('claimedBy' in arena)) return true
  const want = arena.claimedBy || 'wilderness'
  let now = await claimOwner(ctx, arena)
  if (now === want) return true
  const { rcon, bots, say, tp, Y, targetPoint } = ctx
  const T = targetPoint(arena)
  const as = async (faction, line, re) => {
    const bot = bots[factionOwners[faction]]
    if (!bot) throw new Error(`no owner bot for faction ${faction}`)
    if (!(await tp(rcon, bot, T.x + 0.5, Y, T.z - 3.5))) throw new Error(`${bot.username} could not reach ${arena.name}`)
    await say(bot, line, re)
  }
  try {
    if (now !== 'wilderness') await as(now, '/f unclaim', /Unclaimed|no chunks here/i)
    if (arena.claimedBy) await as(arena.claimedBy, '/f claim', /Claimed|aren't any claimable|may not currently claim/i)
  } catch (e) {
    console.log(`    prepare ${arena.name}: ${e.message}`)
    return false
  }
  now = await claimOwner(ctx, arena)
  if (now !== want) console.log(`    prepare ${arena.name}: wanted ${want}, chunk is ${now}`)
  return now === want
}

async function waitReply (bot, mark, re, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (bot.log.slice(mark).some(l => re.test(l))) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

module.exports = { roles, setup, prepare, observers: { claimChanged: claimOwner, gateOpened }, controlRole: 'owner', controlArena: 'ownerClaim' }
