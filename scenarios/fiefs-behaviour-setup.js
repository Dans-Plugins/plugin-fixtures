// Fiefs role setup for the behaviour driver (RFC 0017). Fiefs runs on Medieval Factions, so the
// gate installs Medieval Factions' stable release beside it and this setup builds both layers.
// Every step is idempotent and confirmed from the plugins' own replies.
//
//   owner          Alice  creates faction Alpha and fief "North"; claims both arenas for Alpha
//                         and the fiefArena for North
//   fiefMember     Finn   in Alpha, invited into North
//   factionMember  Mia    in Alpha, in no fief
//   otherFief      Fay    in Alpha, owns fief "South" (claimedLandProtected: true, the default)
//   enemy          Eve    creates faction Echo; no relationship to Alpha
//
// No role is an operator.

'use strict'

const roles = { owner: 'Alice', fiefMember: 'Finn', factionMember: 'Mia', otherFief: 'Fay', enemy: 'Eve' }

async function setup (ctx) {
  const { rcon, bots, arenas, say, tp, Y, targetPoint, sleep } = ctx
  for (const name of Object.values(roles)) {
    await rcon.cmd(`deop ${name}`, { quiet: true })
    await rcon.cmd(`gamemode survival ${name}`, { quiet: true })
  }

  await say(bots.owner, '/f create Alpha', /created|already in a faction|already exists/i)
  await say(bots.enemy, '/f create Echo', /created|already in a faction|already exists/i)
  for (const role of ['fiefMember', 'factionMember', 'otherFief']) {
    await say(bots.owner, `/f invite ${roles[role]}`, /invited|already/i)
    await say(bots[role], '/f join Alpha', /Joined|already a member/i)
  }

  for (const name of ['factionArena', 'fiefArena']) {
    const T = targetPoint(arenas[name])
    if (!(await tp(rcon, bots.owner, T.x + 0.5, Y, T.z - 3.5))) throw new Error(`owner could not reach ${name}`)
    await say(bots.owner, '/f claim', /Claimed|aren't any claimable|already/i)
    const owner = await say(bots.owner, '/f claim check', /Alpha|Wilderness|claim/i)
    if (!/Alpha/.test(owner)) throw new Error(`${name} is not Alpha's: ${owner}`)
  }

  await say(bots.owner, '/fi create "North"', /Fief created|already in a fief|name is taken/i)
  await say(bots.otherFief, '/fi create "South"', /Fief created|already in a fief|name is taken/i)
  await say(bots.owner, `/fi invite ${roles.fiefMember}`, /invited|already in/i)
  await say(bots.fiefMember, '/fi join North', /Joined|already in a fief/i)

  // The owner is still standing in the fiefArena from the claim loop above.
  await say(bots.owner, '/fi claim', /Claimed|already claimed/i)
  const fief = await say(bots.owner, '/fi checkclaim', /claimed by|not claimed/i)
  if (!/North/.test(fief)) throw new Error(`fiefArena is not North's: ${fief}`)
  const F = targetPoint(arenas.factionArena)
  if (!(await tp(rcon, bots.owner, F.x + 0.5, Y, F.z - 3.5))) throw new Error('owner could not reach factionArena')
  const none = await say(bots.owner, '/fi checkclaim', /claimed by|not claimed/i)
  if (!/not claimed by a fief/i.test(none)) throw new Error(`factionArena should belong to no fief: ${none}`)
  await sleep(500)
}

module.exports = { roles, setup, controlRole: 'owner', controlArena: 'fiefArena' }
