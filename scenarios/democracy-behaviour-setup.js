// Democracy role setup for the behaviour driver (RFC 0017). Democracy runs on Medieval Factions,
// so the gate installs Medieval Factions' stable release beside it and this setup builds both
// layers. Every step is idempotent and confirmed from the plugins' own replies.
//
//   owner     Alice  creates faction Alpha, starts its election and runs in it
//   member    Mia    invited into Alpha
//   ally      Bob    creates Bravo; Alpha and Bravo ally both ways (Bravo holds no election)
//   enemy     Eve    creates Echo; no relationship to Alpha (no election)
//   stranger  Sam    in no faction
//
// An election cannot be ended (there is no command for it), so every row plays against the one
// Alice starts here, on fresh plugin data per pass. Rows run in table order: a vote row comes
// before the row that repeats it.
//
// Observer `voteTally`: Alpha's candidates and their votes, as Alice reads them with /d info.

'use strict'

const roles = { owner: 'Alice', member: 'Mia', ally: 'Bob', enemy: 'Eve', stranger: 'Sam' }

async function setup (ctx) {
  const { rcon, bots, say } = ctx
  for (const name of Object.values(roles)) {
    await rcon.cmd(`deop ${name}`, { quiet: true })
    await rcon.cmd(`gamemode survival ${name}`, { quiet: true })
  }
  const create = async (bot, faction) => say(bot, `/f create ${faction}`, /created|already in a faction|already exists/i)
  await create(bots.owner, 'Alpha')
  await create(bots.ally, 'Bravo')
  await create(bots.enemy, 'Echo')
  await say(bots.owner, `/f invite ${roles.member}`, /invited|already/i)
  await say(bots.member, '/f join Alpha', /Joined|already a member/i)
  await say(bots.owner, '/f ally Bravo', /Allied|requested|already/i)
  await say(bots.ally, '/f ally Alpha', /Allied|already/i)
  await say(bots.owner, '/d start', /Election has been started|already in progress/i)
  await say(bots.owner, '/d run', /now a candidate|already a candidate/i)
  if (!(await voteTally(ctx))) throw new Error("Alpha's election has no candidates after setup")
}

// "Alice: 0 vote(s)|..." sorted, or null when it could not be read.
async function voteTally (ctx) {
  const bot = ctx.bots.owner
  const wait = (bot.lastChatAt || 0) + 1100 - Date.now()
  if (wait > 0) await ctx.sleep(wait)
  bot.lastChatAt = Date.now()
  const m = bot.log.length
  bot.chat('/d info')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !bot.log.slice(m).some(l => /=== Election Info ===|no election/i.test(l))) await ctx.sleep(100)
  await ctx.sleep(800)
  const lines = bot.log.slice(m).map(l => l.trim()).filter(l => /: \d+ vote\(s\)$/.test(l)).sort()
  return lines.length ? lines.join('|') : null
}

module.exports = { roles, setup, observers: { voteTally }, controlRole: 'owner', controlArena: 'hall' }
