#!/usr/bin/env node
// Medieval Factions fixture scenario: two mineflayer bots on a fresh server.
//
// Console commands can only create leaderless factions; claims, alliances, locks and
// gates all need a Player in the world. Two bots (Alice, Bob) join an offline-mode
// server and play the scenario below, and every step is verified by reading state back
// (chat replies, /f info, /f who, /f claim check, /accessors list, RCON `execute if
// block`) rather than by trusting the client. The process exits 0 only when every step
// verified; on the first failure it prints what was received and exits 1.
//
//   Alice  /f create Alpha; claims 3 chunks by walking; /f set description
//   Bob    /f create Bravo; claims 2 chunks by walking; /f set description
//   Alice  /f ally Bravo  ->  Bob /f ally Alpha        (2 relationship rows, one per direction)
//   Alice  places a chest, /lock, clicks it; Bob is refused at the chest
//   Alice  /gate create over a 1x4 column, lever-triggered; the gate is opened and closed
//
// The last line of stdout is `SCENARIO_EXPECTED {json}`: the count per persisted entity
// type, keyed by the label the plugin prints in its `<n> <label> loaded` startup lines,
// so a harness can compare them against the counts the next boot reports.
//
// Usage:
//   node medieval-factions.js --host localhost --port 25565 --rcon-port 25575 \
//        --rcon-password <pw> --bots 2 [--server-log docker:<container>|<file>] \
//        [--mc-version 26.1] [--json-out expected.json]
//
// Requires `mineflayer` (and its `minecraft-data`) resolvable from this file's directory.
// --mc-version defaults to auto-detection (mineflayer `version: false`); a server whose
// protocol the installed mineflayer does not know is reported as such and fails the run.

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

// ---- RCON (the owner's mfbot harness, unchanged in substance) ---------------------------

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
      // MF writes to its database on the server thread and can stall RCON for seconds;
      // a short timeout would turn that stall into a silent "nothing happened".
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
  for (const l of got.filter(l => l.trim() && !/^(Wilderness|Alpha|Bravo)$/.test(l.trim()))) console.log(`      < ${l}`)
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

const chunkOf = (pos) => ({ x: Math.floor(pos.x / 16), z: Math.floor(pos.z / 16) })

// Walk along +x until the bot stands well inside chunk `cx`. A real walk, not a teleport:
// the claim is made from wherever the server thinks the player is.
async function walkToChunkX (bot, cx) {
  const start = bot.entity.position.clone()
  await bot.lookAt(start.offset(64, 1.62, 0), true)
  await sleep(200)
  bot.setControlState('forward', true)
  const ok = await waitFor(() => {
    const p = bot.entity.position
    return Math.floor(p.x / 16) === cx && (p.x - cx * 16) >= 6
  }, 30000, 50)
  bot.setControlState('forward', false)
  await sleep(700)
  const p = bot.entity.position
  if (!ok) throw new Error(`${bot.username} did not reach chunk x=${cx}; at ${p}`)
  console.log(`    ${bot.username} walked ${start.x.toFixed(1)} -> ${p.x.toFixed(1)} (chunk ${chunkOf(p).x},${chunkOf(p).z})`)
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
// One 5-chunk strip, far from spawn (spawn protection is 16 blocks and the bots are not
// ops). Alice takes chunks 125..127, Bob 128..129, all at chunk z=125.
const Y = 150
const CZ = 125
const ALICE_CHUNKS = [125, 126, 127]
const BOB_CHUNKS = [128, 129]
const X0 = ALICE_CHUNKS[0] * 16
const X1 = BOB_CHUNKS[1] * 16 + 15
const Z0 = CZ * 16
const Z1 = Z0 + 15
const mid = (cx) => cx * 16 + 8.5

// Alice's builds, all inside chunk 126.
const CHEST = new Vec3(126 * 16 + 12, Y, Z0 + 10)
const GATE_X = 126 * 16 + 4
const GATE_Z = Z0 + 4
// gates.minHeight is 3, and the plugin measures height as maxY - minY: four blocks.
const GATE_TOP = Y + 3
const TRIGGER = new Vec3(126 * 16 + 8, Y, Z0 + 4)          // stone block the lever sits on
const LEVER = TRIGGER.offset(0, 1, 0)

const EXPECTED = {
  factions: 2,
  claims: ALICE_CHUNKS.length + BOB_CHUNKS.length,
  'faction relationships': 2,   // a mutual alliance is one row per direction
  'locked blocks': 1,
  gates: 1,
  players: 2,
  duels: 0,
  'duel invites': 0
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

// ---- main ------------------------------------------------------------------------------

async function main () {
  console.log(`=== Medieval Factions bot scenario ===\nserver ${ARGS.host}:${ARGS.port}, rcon :${ARGS.rconPort}, mineflayer ${require('mineflayer/package.json').version}, minecraft-data ${require('minecraft-data/package.json').version}, version ${ARGS.mcVersion === false ? 'auto' : ARGS.mcVersion}`)
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
    await rcon.cmd(`fill ${X0} ${Y - 1} ${Z0} ${X1} ${Y - 1} ${Z1} minecraft:stone`)
    await rcon.cmd(`fill ${X0} ${Y} ${Z0} ${X1} ${Y + 4} ${Z1} minecraft:air`)
    await rcon.cmd('time set day')
    await rcon.cmd('weather clear 1000000')
    await assertBlock(rcon, new Vec3(X0, Y - 1, Z0), 'stone')
    // Generating the terrain around a far-off arena stalls the server thread for tens of
    // seconds on a small runner; waiting here keeps that stall out of every later step.
    const settled = await settle(rcon)
    return `stone strip x ${X0}..${X1}, z ${Z0}..${Z1}, y ${Y - 1}; server settled (${settled})`
  })

  await step('server-version', async () => {
    // A server whose protocol the installed client stack does not know cannot be joined;
    // say so in one line instead of failing somewhere inside the handshake.
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
      throw new Error(`server "${name}" speaks protocol ${protocol}, which this mineflayer/minecraft-data (${require('mineflayer/package.json').version}/${require('minecraft-data/package.json').version}) cannot join — newest supported is ${newest}; run the gate with minecraft_version=${newest} until the client stack supports ${name}`)
    }
    return `"${name}" protocol ${protocol}${usable.length ? `, joinable as ${usable[0]}` : ''}`
  })

  await step('join', async () => {
    alice = await makeBot('Alice')
    // Both bots arrive from one address. Spigot's connection-throttle (bukkit.yml, 4000 ms by
    // default) kicks a second join from the same IP inside that window with "Connection
    // throttled! Please wait before reconnecting." — so the second bot waits it out.
    await sleep(5000)
    bob = await makeBot('Bob')
    await sleep(1500)
    const r = await rcon.cmd('list')
    if (!/Alice/.test(r) || !/Bob/.test(r)) throw new Error(`server does not list both bots: ${JSON.stringify(r.trim())}`)
    await rcon.cmd('gamemode creative Alice')
    await rcon.cmd('gamemode creative Bob')
    return `Alice and Bob online; protocol version ${alice.version}`
  })

  // ---- Alice: faction + 3 claims by walking ----
  await step('alice-create', async () => {
    await tp(rcon, alice, mid(ALICE_CHUNKS[0]), Y, Z0 + 8.5, -90)
    await tp(rcon, bob, mid(BOB_CHUNKS[0]), Y, Z0 + 8.5, -90)
    await settle(rcon)
    await chatCmd(alice, '/f create Alpha', /Faction Alpha created/)
    return 'Faction Alpha created.'
  })

  await step('alice-claims', async () => {
    for (let i = 0; i < ALICE_CHUNKS.length; i++) {
      if (i > 0) await walkToChunkX(alice, ALICE_CHUNKS[i])
      const c = chunkOf(alice.entity.position)
      if (c.x !== ALICE_CHUNKS[i] || c.z !== CZ) throw new Error(`Alice is in chunk ${c.x},${c.z}, expected ${ALICE_CHUNKS[i]},${CZ}`)
      await chatCmd(alice, '/f claim', /Claimed 1 chunks/)
    }
    return `Alice claimed chunks ${ALICE_CHUNKS.join(',')} (z ${CZ})`
  })

  // ---- Bob: faction + 2 claims by walking ----
  await step('bob-create', async () => {
    await tp(rcon, bob, mid(BOB_CHUNKS[0]), Y, Z0 + 8.5, -90)
    await chatCmd(bob, '/f create Bravo', /Faction Bravo created/)
    return 'Faction Bravo created.'
  })

  await step('bob-claims', async () => {
    for (let i = 0; i < BOB_CHUNKS.length; i++) {
      if (i > 0) await walkToChunkX(bob, BOB_CHUNKS[i])
      const c = chunkOf(bob.entity.position)
      if (c.x !== BOB_CHUNKS[i] || c.z !== CZ) throw new Error(`Bob is in chunk ${c.x},${c.z}, expected ${BOB_CHUNKS[i]},${CZ}`)
      await chatCmd(bob, '/f claim', /Claimed 1 chunks/)
    }
    return `Bob claimed chunks ${BOB_CHUNKS.join(',')} (z ${CZ})`
  })

  // ---- claims read back from the other faction's member ----
  await step('claims-readback', async () => {
    const seen = []
    for (const cx of ALICE_CHUNKS) {
      await tp(rcon, bob, mid(cx), Y, Z0 + 8.5)
      seen.push(await chatCmd(bob, '/f claim check', /claimed by Alpha/))
    }
    for (const cx of BOB_CHUNKS) {
      await tp(rcon, alice, mid(cx), Y, Z0 + 8.5)
      seen.push(await chatCmd(alice, '/f claim check', /claimed by Bravo/))
    }
    return `${seen.length} chunks answered /f claim check with the right owner`
  })

  // ---- alliance: request + acceptance ----
  await step('alliance', async () => {
    await chatCmd(alice, '/f ally Bravo', /Requested to ally with faction Bravo/)
    await chatCmd(bob, '/f ally Alpha', /Allied with faction Alpha/)
    const m = mark(alice)
    await chatCmd(alice, '/f info', /=== Alpha ===/)
    await sleep(800)
    const lines = since(alice, m)
    const i = lines.findIndex(l => /^Allies:/.test(l.trim()))
    if (i < 0 || !/Bravo/.test(lines[i + 1] || '')) throw new Error(`/f info for Alpha does not list Bravo as an ally: ${JSON.stringify(lines)}`)
    return 'Alpha <-> Bravo allied; /f info lists Bravo under Allies'
  })

  // ---- descriptions + who ----
  await step('descriptions', async () => {
    await chatCmd(alice, '/f set description Alpha holds the western marches', /description set to 'Alpha holds the western marches'/)
    await chatCmd(bob, '/f set description Bravo keeps the eastern road', /description set to 'Bravo keeps the eastern road'/)
    const m = mark(bob)
    await chatCmd(bob, '/f info', /=== Bravo ===/)
    await sleep(800)
    if (!since(bob, m).some(l => /Description: Bravo keeps the eastern road/.test(l))) throw new Error(`/f info for Bravo lacks the description: ${JSON.stringify(since(bob, m))}`)
    await chatCmd(alice, '/f who Bob', /Bob is in the faction Bravo/)
    await chatCmd(bob, '/f who Alice', /Alice is in the faction Alpha/)
    return 'both descriptions read back through /f info; /f who agrees both ways'
  })

  // ---- Alice places a chest and locks it; Bob is refused ----
  await step('chest-place', async () => {
    await tp(rcon, alice, CHEST.x - 1.5, Y, CHEST.z + 0.5, -90)
    await rcon.cmd('clear Alice')
    await rcon.cmd('give Alice minecraft:chest 1')
    const ok = await waitFor(() => alice.inventory.items().some(i => i.name === 'chest'), 8000)
    if (!ok) throw new Error('chest never reached Alice\'s inventory')
    await alice.equip(alice.inventory.items().find(i => i.name === 'chest'), 'hand')
    const floor = alice.blockAt(CHEST.offset(0, -1, 0))
    if (!floor || floor.name !== 'stone') throw new Error(`floor under the chest spot is ${floor && floor.name}, not stone`)
    await alice.placeBlock(floor, new Vec3(0, 1, 0))
    await sleep(800)
    await assertBlock(rcon, CHEST, 'chest')
    return `Alice placed a chest at ${CHEST.x} ${CHEST.y} ${CHEST.z} (verified over RCON)`
  })

  await step('chest-lock', async () => {
    await chatCmd(alice, '/lock', /select the block you would like to lock/)
    const m = mark(alice)
    COMMANDS_ISSUED.push(['Alice', '<right-click chest>'])
    await alice.activateBlock(alice.blockAt(CHEST))
    const ok = await waitFor(() => since(alice, m).some(l => /Block locked/.test(l)), 20000)
    if (!ok) throw new Error(`no "Block locked." after clicking the chest; received ${JSON.stringify(since(alice, m))}`)
    await chatCmd(alice, `/accessors list ${CHEST.x} ${CHEST.y} ${CHEST.z}`, /=== Accessors ===/)
    // Locking one block does not leave lock mode; every later click would lock too.
    await chatCmd(alice, '/lock cancel', /Cancelled locking/)
    return 'Block locked.; /accessors list finds the lock; lock mode left'
  })

  await step('chest-lock-enforced', async () => {
    await tp(rcon, bob, CHEST.x + 2.5, Y, CHEST.z + 0.5, 90)
    let windows = 0
    const onWindow = () => { windows++ }
    bob.on('windowOpen', onWindow)
    const m = mark(bob)
    await bob.activateBlock(bob.blockAt(CHEST))
    const refused = await waitFor(() => since(bob, m).some(l => /locked by Alice/.test(l)), 15000)
    await sleep(500)
    bob.removeListener('windowOpen', onWindow)
    if (!refused) throw new Error(`Bob was not told the chest is locked; received ${JSON.stringify(since(bob, m))}`)
    if (windows > 0) throw new Error('the chest opened for Bob despite the lock')
    return 'Bob: "That block is locked by Alice."; no container opened'
  })

  // ---- gate ----
  await step('gate-build', async () => {
    await rcon.cmd(`fill ${GATE_X} ${Y} ${GATE_Z} ${GATE_X} ${GATE_TOP} ${GATE_Z} minecraft:oak_planks`)
    await rcon.cmd(`setblock ${TRIGGER.x} ${TRIGGER.y} ${TRIGGER.z} minecraft:stone`)
    await rcon.cmd(`setblock ${LEVER.x} ${LEVER.y} ${LEVER.z} minecraft:lever[face=floor,facing=south,powered=false]`)
    await assertBlock(rcon, new Vec3(GATE_X, GATE_TOP, GATE_Z), 'oak_planks')
    await assertBlock(rcon, LEVER, 'lever')
    return `1x4 oak_planks column at ${GATE_X},${Y}..${GATE_TOP},${GATE_Z}; lever on stone at ${TRIGGER}`
  })

  await step('gate-create', async () => {
    // Stand south of the column, close enough to click both corners and the trigger block.
    await tp(rcon, alice, GATE_X + 2.5, Y, GATE_Z + 3.5, 180)
    await chatCmd(alice, '/gate create', /select the first corner/)
    const click = async (pos, expect, label) => {
      const m = mark(alice)
      COMMANDS_ISSUED.push(['Alice', `<right-click ${label}>`])
      await alice.activateBlock(alice.blockAt(pos))
      const ok = await waitFor(() => since(alice, m).some(l => expect.test(l)), 20000)
      if (!ok) throw new Error(`clicking ${label} at ${pos} did not produce ${expect}; received ${JSON.stringify(since(alice, m))}`)
    }
    await click(new Vec3(GATE_X, Y, GATE_Z), /select the second corner/, 'gate corner 1')
    await click(new Vec3(GATE_X, GATE_TOP, GATE_Z), /select the trigger/, 'gate corner 2')
    await click(TRIGGER, /Gate created/, 'gate trigger')
    return 'Gate created.'
  })

  await step('gate-operates', async () => {
    // The lever powers the stone it sits on; the plugin polls trigger power once a second
    // and removes one row per second while opening. Toggle it on, expect the column to
    // vanish; toggle it off, expect it back.
    COMMANDS_ISSUED.push(['Alice', '<toggle lever>'])
    await alice.activateBlock(alice.blockAt(LEVER))
    let open = false
    for (let i = 0; i < 15 && !open; i++) {
      await sleep(1000)
      open = /Test passed/.test(await rcon.cmd(`execute if block ${GATE_X} ${GATE_TOP} ${GATE_Z} minecraft:air`))
    }
    if (!open) throw new Error('the gate did not open within 15s of powering the trigger')
    await alice.activateBlock(alice.blockAt(LEVER))
    let closed = false
    for (let i = 0; i < 15 && !closed; i++) {
      await sleep(1000)
      closed = /Test passed/.test(await rcon.cmd(`execute if block ${GATE_X} ${GATE_TOP} ${GATE_Z} minecraft:oak_planks`)) &&
               /Test passed/.test(await rcon.cmd(`execute if block ${GATE_X} ${Y} ${GATE_Z} minecraft:oak_planks`))
    }
    if (!closed) throw new Error('the gate did not close within 15s of unpowering the trigger')
    await sleep(2000)   // let the CLOSED status write land before the harness stops the server
    return 'gate opened on lever, closed again; blocks restored'
  })

  await step('server-log', async () => {
    const log = readServerLog()
    if (log === null) return 'not checked (no --server-log)'
    const missing = COMMANDS_ISSUED.filter(([who, cmd]) => !cmd.startsWith('<'))
      .filter(([who, cmd]) => !log.includes(`${who} issued server command: ${cmd}`))
    if (missing.length) throw new Error(`server log lacks ${missing.length} "issued server command" line(s): ${JSON.stringify(missing.slice(0, 5))}`)
    const errors = log.split('\n').filter(l => /\/(ERROR|SEVERE)\]/.test(l) && /MedievalFactions|factionsystem/.test(l))
    if (errors.length) throw new Error(`server log has ${errors.length} plugin error line(s): ${errors.slice(0, 3).join(' | ')}`)
    return `${COMMANDS_ISSUED.filter(([, c]) => !c.startsWith('<')).length} commands echoed by the server; no plugin ERROR/SEVERE lines`
  })

  // Leave the world quietly: quitting makes the plugin write each player's record.
  alice.quit(); bob.quit()
  await sleep(2000)
  rcon.close()
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
