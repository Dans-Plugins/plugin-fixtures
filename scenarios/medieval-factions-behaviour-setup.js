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

  // Bypass: read the toggle's reply and toggle again if it switched it off.
  const b = await say(bots.bypass, '/f bypass', /Bypass (enabled|disabled)/i)
  if (/disabled/i.test(b)) await say(bots.bypass, '/f bypass', /Bypass enabled/i)
  await sleep(500)
}

async function waitReply (bot, mark, re, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (bot.log.slice(mark).some(l => re.test(l))) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

module.exports = { roles, setup, controlRole: 'owner', controlArena: 'ownerClaim' }
