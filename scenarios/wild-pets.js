#!/usr/bin/env node
// Wild Pets fixture scenario: two mineflayer bots on a fresh server.
//
// Taming needs a Player: `/wp tame`, then a right-click on the mob with the taming item in
// the main hand (default config: a cow takes 32 wheat, a chicken 8 wheat seeds, each with a
// 50% chance, retried with fresh items until it takes). Two bots (Alice, Bob) join an
// offline-mode server and play the scenario below; every step is read back from chat
// (`/wp list`, `/wp info`) rather than trusted. The process exits 0 only when every step
// verified; on the first failure it prints what was received and exits 1.
//
//   Alice  tames a cow; /wp rename Biscuit; /wp stay; /wp lock + right-click
//   Bob    tames a chicken and keeps its default name (Bob's_Pet)
//   both   /wp list shows exactly their own pet; Alice's /wp info shows Biscuit, Staying, locked
//
// Pets are written to plugins/WildPets/pets.json and petRecords.json when the server stops
// (and on the hourly autosave), so the harness's stop after this script is what records them.
//
// The last line of stdout is `SCENARIO_EXPECTED {json}`: the count per persisted entity type,
// keyed by the label Wild Pets prints in its `<n> <label> loaded` startup lines (from the
// release after 1.11.9: "2 pets loaded", "2 pet records loaded").
//
// Usage:
//   node wild-pets.js --host localhost --port 25565 --rcon-port 25575 \
//        --rcon-password <pw> --bots 2 [--server-log docker:<container>|<file>] \
//        [--mc-version 26.1] [--json-out expected.json]
//
// Requires `mineflayer` (which brings `minecraft-data`, `minecraft-protocol` and `vec3`)
// resolvable from this file's directory.

'use strict'

const net = require('net')
const fs = require('fs')
const { execFileSync } = require('child_process')
const mineflayer = require('mineflayer')
const mcProtocol = require('minecraft-protocol')
const mcData = require('minecraft-data')
const { Vec3 } = require('vec3')

// ---- arguments ------------------------------------------------------------------------

function parseArgs (argv) {
  const out = {
    host: 'localhost', port: 25565, rconPort: 25575, rconPassword: 'minecraft', bots: 2,
    serverLog: null, mcVersion: false, jsonOut: null
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => argv[++i]
    if (a === '--host') out.host = v()
    else if (a === '--port') out.port = Number(v())
    else if (a === '--rcon-port') out.rconPort = Number(v())
    else if (a === '--rcon-password') out.rconPassword = v()
    else if (a === '--bots') out.bots = Number(v())
    else if (a === '--server-log') out.serverLog = v()
    else if (a === '--mc-version') { const s = v(); out.mcVersion = (s === 'auto' || s === 'false') ? false : s }
    else if (a === '--json-out') out.jsonOut = v()
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(0) }
    else throw new Error(`unknown argument ${a}`)
  }
  if (out.bots < 2) throw new Error('--bots must be at least 2 (Alice and Bob)')
  return out
}

const ARGS = parseArgs(process.argv.slice(2))
const STARTED_AT = new Date()

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const plain = (s) => s.replace(/§./g, '')

// ---- RCON (as in medieval-factions.js) --------------------------------------------------

class Rcon {
  constructor (host, port, password) {
    this.host = host; this.port = port; this.password = password
    this.sock = null; this.id = 0; this.pending = new Map(); this.buf = Buffer.alloc(0)
  }

  connect () {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => {
        this._send(3, this.password).then((r) => {
          if (r === '<auth-failed>') reject(new Error('RCON authentication failed'))
          else resolve()
        }).catch(reject)
      })
      this.sock.on('error', reject)
      this.sock.on('data', (d) => this._onData(d))
    })
  }

  _onData (d) {
    this.buf = Buffer.concat([this.buf, d])
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0)
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      const id = body.readInt32LE(0)
      const text = body.subarray(8, body.length - 2).toString('utf8')
      if (id === -1) {
        for (const p of this.pending.values()) p.resolve('<auth-failed>')
        this.pending.clear()
        continue
      }
      const p = this.pending.get(id)
      if (p) { this.pending.delete(id); p.resolve(text) }
    }
  }

  _send (type, body) {
    const id = ++this.id
    const payload = Buffer.concat([Buffer.alloc(8), Buffer.from(body, 'utf8'), Buffer.from([0, 0])])
    payload.writeInt32LE(id, 0)
    payload.writeInt32LE(type, 4)
    const packet = Buffer.concat([Buffer.alloc(4), payload])
    packet.writeInt32LE(payload.length, 0)
    return new Promise((resolve) => {
      this.pending.set(id, { resolve })
      this.sock.write(packet)
      // A server busy generating far-off terrain can stall RCON for seconds; a short
      // timeout would turn that stall into a silent "nothing happened".
      setTimeout(() => { if (this.pending.delete(id)) resolve('<timeout>') }, 20000)
    })
  }

  async cmd (c) {
    const r = plain(await this._send(2, c))
    console.log(`    rcon> ${c}` + (r.trim() ? `  => ${r.trim().split('\n')[0].slice(0, 160)}` : ''))
    return r
  }

  close () { if (this.sock) this.sock.destroy() }
}

// ---- bots ------------------------------------------------------------------------------

function makeBot (username) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({
      host: ARGS.host, port: ARGS.port, username, auth: 'offline', version: ARGS.mcVersion,
      checkTimeoutInterval: 120000
    })
    bot.log = []
    bot.on('message', (m) => { bot.log.push({ t: Date.now(), text: plain(m.toString()) }) })
    bot.on('error', (e) => reject(new Error(`${username}: ${e.message}`)))
    bot.on('kicked', (r) => reject(new Error(`${username} kicked: ${JSON.stringify(r)}`)))
    bot.once('spawn', () => resolve(bot))
    setTimeout(() => reject(new Error(`${username} did not spawn within 90s`)), 90000)
  })
}

const mark = (bot) => bot.log.length
const since = (bot, m) => bot.log.slice(m).map(e => e.text)

async function waitFor (fn, ms, step = 100) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(step)
  }
  return false
}

// Send a chat line (command or text) and wait for a reply matching `expect`.
async function say (bot, line, expect, timeoutMs = 60000) {
  const m = mark(bot)
  bot.chat(line)
  const ok = await waitFor(() => since(bot, m).some(l => expect.test(l)), timeoutMs)
  const got = since(bot, m)
  console.log(`    ${bot.username}> ${line}`)
  for (const l of got.filter(l => l.trim() && !/^[-=]+$/.test(l.trim()))) console.log(`      < ${l}`)
  if (!ok) throw new Error(`${bot.username}: no reply matching ${expect} to ${JSON.stringify(line)}; received ${JSON.stringify(got)}`)
  return got.find(l => expect.test(l))
}

// Console teleport, then confirm the client saw it land.
async function tp (rcon, bot, x, y, z, yaw = null) {
  await rcon.cmd(`tp ${bot.username} ${x} ${y} ${z}` + (yaw === null ? '' : ` ${yaw} 0`))
  const ok = await waitFor(() => bot.entity && bot.entity.position.distanceTo(new Vec3(x, y, z)) < 1.5, 60000)
  if (!ok) throw new Error(`${bot.username} did not arrive at ${x} ${y} ${z} (at ${bot.entity && bot.entity.position})`)
  await sleep(400)
}

// A stalled server is indistinguishable from "nothing happened": wait until three
// consecutive RCON round-trips come back quickly before relying on reply timeouts.
async function settle (rcon, limitMs = 120000) {
  const t0 = Date.now()
  let quick = 0
  while (Date.now() - t0 < limitMs) {
    const t = Date.now()
    await rcon._send(2, 'list')
    const dt = Date.now() - t
    quick = dt < 300 ? quick + 1 : 0
    if (quick >= 3) return `${Date.now() - t0}ms`
    await sleep(1000)
  }
  throw new Error(`server did not settle within ${limitMs / 1000}s (RCON round-trips still slow)`)
}

// ---- steps -----------------------------------------------------------------------------

const STEPS = []
async function step (name, fn) {
  console.log(`\n[${name}]`)
  try {
    const detail = await fn()
    STEPS.push({ name, passed: true, detail: detail || '' })
    console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`)
  } catch (e) {
    STEPS.push({ name, passed: false, detail: e.message })
    console.log(`  FAIL: ${name} — ${e.message}`)
    throw e
  }
}

// ---- arena -----------------------------------------------------------------------------
// A walled stone pad far from spawn (spawn protection is 16 blocks and the bots are not ops),
// split in two pens so each bot's mob stays beside it.
const Y = 150
const X0 = 2000
const Z0 = 2000
const X1 = X0 + 15
const Z1 = Z0 + 7
const ALICE_PEN = { x: X0 + 3, z: Z0 + 3 }
const BOB_PEN = { x: X0 + 12, z: Z0 + 3 }

const EXPECTED = {
  pets: 2,
  'pet records': 2
}

const COMMANDS_ISSUED = []     // [username, command] for the server-log assertion
function chatCmd (bot, line, expect, timeoutMs) {
  COMMANDS_ISSUED.push([bot.username, line])
  return say(bot, line, expect, timeoutMs)
}

async function assertBlock (rcon, pos, block) {
  const r = await rcon.cmd(`execute if block ${pos.x} ${pos.y} ${pos.z} minecraft:${block}`)
  if (!/Test passed/.test(r)) throw new Error(`expected minecraft:${block} at ${pos.x} ${pos.y} ${pos.z}; server said ${JSON.stringify(r.trim())}`)
}

function readServerLog () {
  if (!ARGS.serverLog) return null
  if (ARGS.serverLog.startsWith('docker:')) {
    const container = ARGS.serverLog.slice('docker:'.length)
    const since = new Date(STARTED_AT.getTime() - 1000).toISOString()
    return execFileSync('docker', ['logs', '--since', since, container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
  return fs.readFileSync(ARGS.serverLog, 'utf8')
}

// The mob of `type` nearest the bot, within 6 blocks.
function nearestMob (bot, type) {
  return bot.nearestEntity(e => e.name === type && e.position.distanceTo(bot.entity.position) < 6)
}

// Summon a mob in the bot's pen, put the taming item in its main hand, and right-click the
// mob until Wild Pets says "Tamed." (each attempt is a fresh roll of chanceToSucceed).
async function tame (rcon, bot, pen, type, item, amount) {
  await rcon.cmd(`summon minecraft:${type} ${pen.x + 0.5} ${Y} ${pen.z + 2.5}`)
  const appeared = await waitFor(() => nearestMob(bot, type), 10000)
  if (!appeared) throw new Error(`${bot.username} sees no ${type} after summoning one in its pen`)
  await chatCmd(bot, '/wp tame', /Right click on an entity to tame it/)
  for (let attempt = 1; attempt <= 20; attempt++) {
    await rcon.cmd(`item replace entity ${bot.username} weapon.mainhand with minecraft:${item} ${amount}`)
    await sleep(600)
    const mob = nearestMob(bot, type)
    if (!mob) throw new Error(`the ${type} left ${bot.username}'s reach`)
    await bot.lookAt(mob.position.offset(0, mob.height / 2, 0), true)
    const m = mark(bot)
    COMMANDS_ISSUED.push([bot.username, `<right-click ${type}>`])
    await bot.activateEntity(mob)
    const replied = await waitFor(() => since(bot, m).some(l => /Tamed\.|Taming failed\.|You need to use/.test(l)), 10000)
    const got = since(bot, m)
    if (got.some(l => /Tamed\./.test(l))) return `${type} tamed on attempt ${attempt}`
    if (got.some(l => /You need to use/.test(l))) throw new Error(`wrong taming item for a ${type}: ${JSON.stringify(got)}`)
    if (!replied) throw new Error(`no reply to right-clicking the ${type}; received ${JSON.stringify(got)}`)
    await sleep(1200)   // the plugin's one-second right-click cooldown
  }
  throw new Error(`the ${type} was not tamed in 20 attempts`)
}

// ---- main ------------------------------------------------------------------------------

async function main () {
  console.log(`=== Wild Pets bot scenario ===\nserver ${ARGS.host}:${ARGS.port}, rcon :${ARGS.rconPort}, mineflayer ${require('mineflayer/package.json').version}, minecraft-data ${require('minecraft-data/package.json').version}, version ${ARGS.mcVersion === false ? 'auto' : ARGS.mcVersion}`)
  const rcon = new Rcon(ARGS.host, ARGS.rconPort, ARGS.rconPassword)
  let alice, bob

  await step('rcon', async () => {
    await rcon.connect()
    const r = await rcon.cmd('list')
    if (!/players online/.test(r)) throw new Error(`unexpected reply to list: ${JSON.stringify(r)}`)
    return r.trim()
  })

  await step('arena', async () => {
    await rcon.cmd(`forceload add ${X0} ${Z0} ${X1} ${Z1}`)
    await rcon.cmd(`fill ${X0 - 1} ${Y - 1} ${Z0 - 1} ${X1 + 1} ${Y - 1} ${Z1 + 1} minecraft:stone`)
    await rcon.cmd(`fill ${X0} ${Y} ${Z0} ${X1} ${Y + 4} ${Z1} minecraft:air`)
    // walls around the pad and between the two pens, so neither mob wanders off or over
    await rcon.cmd(`fill ${X0 - 1} ${Y} ${Z0 - 1} ${X1 + 1} ${Y + 2} ${Z0 - 1} minecraft:glass`)
    await rcon.cmd(`fill ${X0 - 1} ${Y} ${Z1 + 1} ${X1 + 1} ${Y + 2} ${Z1 + 1} minecraft:glass`)
    await rcon.cmd(`fill ${X0 - 1} ${Y} ${Z0 - 1} ${X0 - 1} ${Y + 2} ${Z1 + 1} minecraft:glass`)
    await rcon.cmd(`fill ${X1 + 1} ${Y} ${Z0 - 1} ${X1 + 1} ${Y + 2} ${Z1 + 1} minecraft:glass`)
    await rcon.cmd(`fill ${X0 + 8} ${Y} ${Z0} ${X0 + 8} ${Y + 2} ${Z1} minecraft:glass`)
    await rcon.cmd('time set day')
    await rcon.cmd('weather clear 1000000')
    await rcon.cmd('gamerule doMobSpawning false')
    await assertBlock(rcon, new Vec3(X0, Y - 1, Z0), 'stone')
    const settled = await settle(rcon)
    return `walled stone pad x ${X0}..${X1}, z ${Z0}..${Z1}, y ${Y - 1}, two pens; server settled (${settled})`
  })

  await step('server-version', async () => {
    const status = await new Promise((resolve, reject) => {
      mcProtocol.ping({ host: ARGS.host, port: ARGS.port }, (err, r) => err ? reject(err) : resolve(r))
    })
    const name = status.version.name
    const protocol = status.version.protocol
    const known = (mcData.postNettyVersionsByProtocolVersion.pc[protocol] || []).map(v => v.minecraftVersion)
    const supported = mcProtocol.supportedVersions
    const usable = known.filter(v => supported.includes(v))
    const newest = supported[supported.length - 1]
    console.log(`    server reports "${name}" (protocol ${protocol}); minecraft-data names it ${JSON.stringify(known)}; mineflayer supports up to ${newest}`)
    if (ARGS.mcVersion === false && !usable.length) {
      throw new Error(`server "${name}" speaks protocol ${protocol}, which this mineflayer/minecraft-data cannot join — newest supported is ${newest}; run the gate with minecraft_version=${newest}`)
    }
    return `"${name}" protocol ${protocol}${usable.length ? `, joinable as ${usable[0]}` : ''}`
  })

  await step('join', async () => {
    alice = await makeBot('Alice')
    // Spigot's connection-throttle kicks a second join from the same IP within 4 s.
    await sleep(5000)
    bob = await makeBot('Bob')
    await sleep(1500)
    const r = await rcon.cmd('list')
    if (!/Alice/.test(r) || !/Bob/.test(r)) throw new Error(`server does not list both bots: ${JSON.stringify(r.trim())}`)
    await tp(rcon, alice, ALICE_PEN.x + 0.5, Y, ALICE_PEN.z + 0.5, 0)
    await tp(rcon, bob, BOB_PEN.x + 0.5, Y, BOB_PEN.z + 0.5, 0)
    await settle(rcon)
    return `Alice and Bob online in their pens; protocol version ${alice.version}`
  })

  await step('alice-tames-a-cow', async () => tame(rcon, alice, ALICE_PEN, 'cow', 'wheat', 32))

  await step('alice-renames', async () => {
    await chatCmd(alice, '/wp rename Biscuit', /Renamed\./)
    return 'Renamed.'
  })

  await step('alice-stay', async () => {
    await chatCmd(alice, '/wp stay', /Biscuit is now staying\./)
    return 'Biscuit is now staying.'
  })

  await step('alice-lock', async () => {
    await chatCmd(alice, '/wp lock', /Right click one of your pets to lock it/)
    await sleep(1200)
    const cow = nearestMob(alice, 'cow')
    if (!cow) throw new Error('Alice no longer sees her cow')
    await bot_lookAndClick(alice, cow, /This pet has been locked\./)
    return 'This pet has been locked.'
  })

  await step('bob-tames-a-chicken', async () => tame(rcon, bob, BOB_PEN, 'chicken', 'wheat_seeds', 8))

  await step('lists-readback', async () => {
    const aliceList = await chatCmd(alice, '/wp list', /Biscuit/)
    const bobList = await chatCmd(bob, '/wp list', /Bob's_Pet/)
    return `Alice: ${aliceList.trim()}; Bob: ${bobList.trim()}`
  })

  await step('info-readback', async () => {
    const m = mark(alice)
    await chatCmd(alice, '/wp info', /Biscuit/)
    await sleep(1500)
    const lines = since(alice, m).join('\n')
    if (!/State:\s+Staying/.test(lines)) throw new Error(`/wp info does not show Staying: ${JSON.stringify(lines)}`)
    if (!/Locked:\s+true/.test(lines)) throw new Error(`/wp info does not show the lock: ${JSON.stringify(lines)}`)
    return 'Biscuit, Staying, locked'
  })

  await step('server-log', async () => {
    const log = readServerLog()
    if (log === null) return 'not checked (no --server-log)'
    const missing = COMMANDS_ISSUED.filter(([who, cmd]) => !cmd.startsWith('<'))
      .filter(([who, cmd]) => !log.includes(`${who} issued server command: ${cmd}`))
    if (missing.length) throw new Error(`server log lacks ${missing.length} "issued server command" line(s): ${JSON.stringify(missing.slice(0, 5))}`)
    const errors = log.split('\n').filter(l => /\/(ERROR|SEVERE)\]/.test(l) && /WildPets|wildpets/.test(l))
    if (errors.length) throw new Error(`server log has ${errors.length} plugin error line(s): ${errors.slice(0, 3).join(' | ')}`)
    return `${COMMANDS_ISSUED.filter(([, c]) => !c.startsWith('<')).length} commands echoed by the server; no plugin ERROR/SEVERE lines`
  })

  alice.quit(); bob.quit()
  await sleep(2000)
  rcon.close()
}

async function bot_lookAndClick (bot, mob, expect) {
  await bot.lookAt(mob.position.offset(0, mob.height / 2, 0), true)
  const m = mark(bot)
  COMMANDS_ISSUED.push([bot.username, `<right-click ${mob.name}>`])
  await bot.activateEntity(mob)
  const ok = await waitFor(() => since(bot, m).some(l => expect.test(l)), 10000)
  if (!ok) throw new Error(`${bot.username}: right-clicking the ${mob.name} did not produce ${expect}; received ${JSON.stringify(since(bot, m))}`)
}

function summarize (passed) {
  console.log('\n=== scenario summary ===')
  for (const s of STEPS) console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name}${s.detail ? ' — ' + s.detail : ''}`)
  console.log(`\n${passed ? 'ALL STEPS VERIFIED' : 'SCENARIO FAILED'} (${STEPS.filter(s => s.passed).length}/${STEPS.length} steps)`)
  const out = { passed, steps: STEPS, expected: passed ? EXPECTED : null, mineflayer: require('mineflayer/package.json').version }
  if (ARGS.jsonOut) fs.writeFileSync(ARGS.jsonOut, JSON.stringify(out, null, 2))
  if (passed) console.log('SCENARIO_EXPECTED ' + JSON.stringify(EXPECTED))
}

process.on('uncaughtException', (e) => {
  STEPS.push({ name: 'uncaught', passed: false, detail: e.message })
  console.log(`  FAIL: uncaught exception — ${e.stack || e.message}`)
  summarize(false)
  process.exit(1)
})

main().then(() => { summarize(true); process.exit(0) })
  .catch((e) => {
    if (!STEPS.length || STEPS[STEPS.length - 1].passed) {
      // Failure outside a step (e.g. an unsupported protocol version while joining).
      STEPS.push({ name: 'unexpected', passed: false, detail: e.message })
      console.log(`  FAIL: ${e.message}`)
    }
    summarize(false)
    process.exit(1)
  })
