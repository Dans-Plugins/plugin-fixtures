#!/usr/bin/env node
// Behaviour driver (Stephenson-Software RFC 0017, T4 gameplay behaviour gate).
//
// Plays a table of rows - who does what to which target, where - with mineflayer bots on a
// running server, and writes one outcome per row, read back from the world. Run it on the
// current stable jar and on a candidate (each on fresh plugin data), then `--compare` the two
// outcome files: every row whose outcome differs is reported. No expected values are needed.
//
// Every row is paired with a control: the same action by the arena's owner in their own claim.
// When the control does not change the world either, a bot cannot decide the row and it is
// recorded as not-checked - never as a pass, a fail or a difference. So is a row whose bot was
// not aiming at the target, did not stand where it was sent, or whose server stopped answering.
//
// Usage:
//   node behaviour-driver.js --rows <table.json> --setup <setup.js> --group <config group> \
//        --host localhost --port 25565 --rcon-port 25575 --rcon-password <pw> \
//        [--lang lang_en_US.properties] [--only id,id] [--label stable] [--json-out out.json]
//   node behaviour-driver.js --compare stable.json candidate.json
//
// The server must already run the jar under test with the group's config applied: the driver
// never restarts it. The group's config is listed in the table (`configGroups`) for the harness.
// Requires `mineflayer` (and `minecraft-data`, `vec3`) resolvable from this file or NODE_PATH.

'use strict'

const net = require('net')
const fs = require('fs')
const path = require('path')

// ---- arguments ------------------------------------------------------------------------

function parseArgs (argv) {
  const out = {
    rows: null, setup: null, group: 'default', host: 'localhost', port: 25565, rconPort: 25575,
    rconPassword: 'minecraft', mcVersion: false, lang: null, only: null, label: 'run', jsonOut: null, compare: null
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => argv[++i]
    if (a === '--rows') out.rows = v()
    else if (a === '--setup') out.setup = v()
    else if (a === '--group') out.group = v()
    else if (a === '--host') out.host = v()
    else if (a === '--port') out.port = Number(v())
    else if (a === '--rcon-port') out.rconPort = Number(v())
    else if (a === '--rcon-password') out.rconPassword = v()
    else if (a === '--mc-version') { const s = v(); out.mcVersion = (s === 'auto' || s === 'false') ? false : s }
    else if (a === '--lang') out.lang = v()
    else if (a === '--only') out.only = new Set(v().split(','))
    else if (a === '--label') out.label = v()
    else if (a === '--json-out') out.jsonOut = v()
    else if (a === '--compare') out.compare = [v(), v()]
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(0) }
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const plain = (s) => s.replace(/§./g, '')

// ---- compare mode ---------------------------------------------------------------------

function refusalOf (outcome) { return (outcome && outcome.refusal) || [] }
function withoutRefusal (outcome) { const o = { ...outcome }; delete o.refusal; return JSON.stringify(o) }

// Returns rows of { id, result, a, b } where result is same | changed | message-changed | not-compared.
function compare (a, b) {
  const byId = new Map(b.rows.map(r => [r.id, r]))
  const out = []
  for (const ra of a.rows) {
    const rb = byId.get(ra.id)
    if (!rb || ra.status !== 'observed' || rb.status !== 'observed') {
      out.push({ id: ra.id, result: 'not-compared', a: ra, b: rb || null }); continue
    }
    const fa = refusalOf(ra.outcome); const fb = refusalOf(rb.outcome)
    let result = 'same'
    if (withoutRefusal(ra.outcome) !== withoutRefusal(rb.outcome)) result = 'changed'
    else if ((fa.length === 0) !== (fb.length === 0)) result = 'changed' // a refusal appeared or went away
    else if (JSON.stringify(fa) !== JSON.stringify(fb)) result = 'message-changed'
    out.push({ id: ra.id, result, a: ra, b: rb })
  }
  return out
}

function printComparison (a, b, rows) {
  const fmt = (r) => r ? (r.status === 'observed' ? JSON.stringify(r.outcome) : `not-checked (${r.why})`) : 'missing'
  console.log(`| row | result | ${a.label} | ${b.label} |\n|---|---|---|---|`)
  for (const r of rows) console.log(`| ${r.id} | ${r.result} | ${fmt(r.a)} | ${fmt(r.b)} |`)
  const n = (k) => rows.filter(r => r.result === k).length
  console.log(`\n${rows.length} rows: ${n('same')} same, ${n('changed')} changed, ${n('message-changed')} message-changed, ${n('not-compared')} not compared`)
  return n('changed')
}

// ---- RCON ------------------------------------------------------------------------------

class Rcon {
  constructor (host, port, password) {
    this.host = host; this.port = port; this.password = password
    this.sock = null; this.id = 0; this.pending = new Map(); this.buf = Buffer.alloc(0)
  }

  connect () {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => {
        this._send(3, this.password).then((r) => r === '<auth-failed>' ? reject(new Error('RCON authentication failed')) : resolve()).catch(reject)
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
      if (id === -1) { for (const p of this.pending.values()) p.resolve('<auth-failed>'); this.pending.clear(); continue }
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
      // MF saves on the server thread and can stall RCON for seconds; a short timeout would
      // turn that stall into a silent "nothing happened".
      setTimeout(() => { if (this.pending.delete(id)) resolve('<timeout>') }, 20000)
    })
  }

  async cmd (c, { quiet = false } = {}) {
    const r = plain(await this._send(2, c))
    if (!quiet) console.log(`    rcon> ${c}` + (r.trim() ? `  => ${r.trim().split('\n')[0].slice(0, 140)}` : ''))
    return r
  }

  close () { if (this.sock) this.sock.destroy() }
}

// ---- bots ------------------------------------------------------------------------------

let mineflayer, Vec3
function loadMineflayer () {
  mineflayer = require('mineflayer')
  Vec3 = require('vec3').Vec3
}

function makeBot (args, username) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: args.host, port: args.port, username, auth: 'offline', version: args.mcVersion, checkTimeoutInterval: 120000 })
    bot.log = []
    bot.on('message', (m) => { bot.log.push(plain(m.toString())) })
    bot.on('error', (e) => reject(new Error(`${username}: ${e.message}`)))
    bot.on('kicked', (r) => reject(new Error(`${username} kicked: ${JSON.stringify(r)}`)))
    bot.once('spawn', () => resolve(bot))
    setTimeout(() => reject(new Error(`${username} did not spawn within 90s`)), 90000)
  })
}

const mark = (bot) => bot.log.length
const since = (bot, m) => bot.log.slice(m)

async function waitFor (fn, ms, step = 100) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (fn()) return true; await sleep(step) }
  return false
}

// Harness rule 2: a bot that died in an earlier run rejoins dead and ignores teleports.
async function alive (bot) {
  await sleep(1500)
  if (bot.health <= 0 || bot.isAlive === false) { bot.respawn(); await sleep(2500) }
  return bot
}

// Harness rule 2: re-teleport until the bot's own position confirms it.
async function tp (rcon, bot, x, y, z, yaw) {
  for (let i = 0; i < 4; i++) {
    await rcon.cmd(`tp ${bot.username} ${x} ${y} ${z}` + (yaw === undefined ? '' : ` ${yaw} 0`), { quiet: true })
    if (await waitFor(() => bot.entity && bot.entity.position.distanceTo(new Vec3(x, y, z)) < 0.7, 3000)) { await sleep(300); return true }
  }
  return false
}

// Send a chat line and wait for any reply matching one of `expect`.
async function say (bot, line, expect, timeoutMs = 30000) {
  const m = mark(bot)
  bot.chat(line)
  const ok = await waitFor(() => since(bot, m).some(l => expect.test(l)), timeoutMs)
  const got = since(bot, m)
  console.log(`    ${bot.username}> ${line}  => ${got.filter(l => l.trim()).slice(0, 3).join(' | ')}`)
  if (!ok) throw new Error(`${bot.username}: no reply matching ${expect} to ${JSON.stringify(line)}; received ${JSON.stringify(got)}`)
  return got.find(l => expect.test(l))
}

// ---- lang ------------------------------------------------------------------------------

// Map a chat line to the plugin's lang key, so a reworded message is a message change, not a
// behaviour change. Properties files are Latin-1.
function loadLang (file) {
  if (!file) return []
  const out = []
  for (const line of fs.readFileSync(file, 'latin1').split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.]+)=(.*)$/)
    if (!m || !m[2].trim()) continue
    const esc = m[2].trim().replace(/''/g, "'").replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d+\\\}/g, '.*')
    out.push({ key: m[1], re: new RegExp('^' + esc + '$'), len: m[2].length })
  }
  return out.sort((a, b) => b.len - a.len) // most specific first
}

function classify (lang, text) {
  const t = text.trim()
  const hit = lang.find(e => e.re.test(t))
  return hit ? hit.key : 'text:' + t
}

// ---- world -----------------------------------------------------------------------------

const Y = 150

function arenaBox (arena) {
  const [cx, cz] = arena.chunk
  return { x0: cx * 16, z0: cz * 16, x1: cx * 16 + 15, z1: cz * 16 + 15 }
}
function targetPoint (arena) { const b = arenaBox(arena); return new Vec3(b.x0 + 8, Y, b.z0 + 8) }

// Harness rules 1 and 3: force-load first (a fill into an unloaded chunk silently does nothing,
// the bots fall and every row reads "not refused"), and check each fill really placed blocks.
async function buildArena (rcon, arena) {
  const b = arenaBox(arena)
  await rcon.cmd(`forceload add ${b.x0} ${b.z0} ${b.x1} ${b.z1}`)
  await sleep(500)
  await resetArena(rcon, arena, { verbose: true })
}

async function resetArena (rcon, arena, { verbose = false } = {}) {
  const b = arenaBox(arena)
  const q = { quiet: !verbose }
  const floor = await rcon.cmd(`fill ${b.x0} ${Y - 1} ${b.z0} ${b.x1} ${Y - 1} ${b.z1} minecraft:stone`, q)
  if (/not loaded|No blocks|<timeout>/i.test(floor) && !/filled/i.test(floor) && verbose) throw new Error(`arena ${arena.name} floor fill failed: ${floor.trim()}`)
  await rcon.cmd(`fill ${b.x0} ${Y} ${b.z0} ${b.x1} ${Y + 5} ${b.z1} minecraft:air`, q)
  await rcon.cmd(`kill @e[type=!player,x=${b.x0},y=${Y - 2},z=${b.z0},dx=15,dy=10,dz=15]`, q)
  const check = await rcon.cmd(`execute if block ${b.x0 + 3} ${Y - 1} ${b.z0 + 3} minecraft:stone`, q)
  if (!/passed/i.test(check)) throw new Error(`arena ${arena.name} has no floor after reset (${check.trim()})`)
}

async function serverHolds (rcon, username, item) {
  for (let i = 0; i < 20; i++) {
    // `execute if items` (1.20.5+) rather than player NBT: the `SelectedItem` field is not stable
    // across Minecraft versions, and this gate runs on 26.x as well as 1.21.
    const r = await rcon.cmd(`execute if items entity @a[name=${username},limit=1] weapon.mainhand minecraft:${item}`, { quiet: true })
    if (/passed/i.test(r)) return true
    await sleep(150)
  }
  return false
}

const blockIs = async (rcon, p, id) => /passed/i.test(await rcon.cmd(`execute if block ${p.x} ${p.y} ${p.z} ${id}`, { quiet: true }))

// Place the row's target and return how to aim at it.
async function placeTarget (rcon, arena, target) {
  const T = targetPoint(arena)
  if (target.block) {
    const id = target.block
    if (/door$/.test(id)) {
      await rcon.cmd(`setblock ${T.x} ${T.y} ${T.z} minecraft:${id}[half=lower,facing=east]`, { quiet: true })
      await rcon.cmd(`setblock ${T.x} ${T.y + 1} ${T.z} minecraft:${id}[half=upper,facing=east]`, { quiet: true })
      return { kind: 'block', pos: T, id: `minecraft:${id}`, aim: T.offset(0.5, 0.5, 0.5), face: new Vec3(1, 0, 0), isDoor: true }
    }
    await rcon.cmd(`setblock ${T.x} ${T.y} ${T.z} minecraft:${id}`, { quiet: true })
    const full = !/chest|lever|button/.test(id)
    return { kind: 'block', pos: T, id: `minecraft:${id}`, aim: full ? T.offset(1, 0.5, 0.5) : T.offset(0.5, 0.5, 0.5), face: new Vec3(1, 0, 0) }
  }
  if (target.floor) {
    const F = T.offset(0, -1, 0)
    if (target.floor === 'grass_patch') await rcon.cmd(`fill ${F.x - 1} ${F.y} ${F.z - 1} ${F.x + 1} ${F.y} ${F.z + 1} minecraft:grass_block`, { quiet: true })
    else await rcon.cmd(`setblock ${F.x} ${F.y} ${F.z} minecraft:${target.floor}`, { quiet: true })
    return { kind: 'block', pos: F, id: `minecraft:${target.floor === 'grass_patch' ? 'grass_block' : target.floor}`, aim: F.offset(0.5, 1, 0.5), face: new Vec3(0, 1, 0), floor: target.floor }
  }
  if (target.entity) {
    const type = target.entity
    let at = T
    if (type === 'item_frame') {
      await rcon.cmd(`setblock ${T.x} ${T.y} ${T.z} minecraft:stone`, { quiet: true })
      at = T.offset(1, 0, 0)
      await rcon.cmd(`summon minecraft:item_frame ${at.x} ${at.y} ${at.z} {Facing:5b,Tags:["t4"]}`, { quiet: true })
    } else {
      await rcon.cmd(`summon minecraft:${type} ${T.x + 0.5} ${T.y} ${T.z + 0.5} {Tags:["t4"]}`, { quiet: true })
    }
    return { kind: 'entity', type, pos: at }
  }
  throw new Error(`unknown target ${JSON.stringify(target)}`)
}

async function entityData (rcon, t) {
  return rcon.cmd(`data get entity @e[type=minecraft:${t.type},tag=t4,limit=1,sort=nearest,x=${t.pos.x},y=${t.pos.y},z=${t.pos.z}]`, { quiet: true })
}

// ---- one attempt -------------------------------------------------------------------------

async function attempt (ctx, row, roleName, arenaName) {
  const { rcon, bots, arenas, lang } = ctx
  const bot = bots[roleName]
  const arena = arenas[arenaName]
  const checks = { aimed: false, inPlace: false, serverAlive: false }
  await resetArena(rcon, arena)
  const t = await placeTarget(rcon, arena, row.target)
  const T = targetPoint(arena)

  // Harness rule 3: the target's chunk must belong to whoever the arena says.
  // (Checked once per arena in setup; the target never leaves the arena's chunk by construction.)

  await rcon.cmd(`clear ${bot.username}`, { quiet: true })
  if (row.item) await rcon.cmd(`give ${bot.username} minecraft:${row.item} ${row.count || 1}`, { quiet: true })
  checks.inPlace = await tp(rcon, bot, T.x + 2.5, Y, T.z + 0.5, 90)
  await sleep(700)
  if (row.item) {
    const it = bot.inventory.items().find(i => i.name === row.item)
    if (it) await bot.equip(it, 'hand').catch(() => {})
    // Harness rule 7: the client's equip and its click race. A click that reaches the server before
    // the equip arrives empty-handed and is refused as a bare-hand click, while the throw that follows
    // still succeeds - a false refusal that depended on row order (found 2026-10-04). Act only once the
    // server itself sees the item in the selected slot.
    checks.itemHeld = await serverHolds(rcon, bot.username, row.item)
  }
  bot.setControlState('sneak', !!row.sneak)
  await sleep(250)

  let entity = null
  if (t.kind === 'block') {
    await bot.lookAt(t.aim, true)
    await sleep(300)
    const c = bot.blockAtCursor(5)
    checks.aimed = !!c && (c.position.equals(t.pos) || (t.isDoor && c.position.equals(t.pos.offset(0, 1, 0))))
  } else {
    entity = bot.nearestEntity(e => e.name === t.type && e.position.distanceTo(t.pos) < 2)
    if (entity) { await bot.lookAt(entity.position.offset(0, entity.height / 2, 0), true); await sleep(300) }
    checks.aimed = !!entity
  }

  // Two snapshots before acting: a field that drifts on its own (a tick counter) would otherwise
  // read as "the entity changed". Drift that survives stripping makes the row not-checked.
  const before = t.kind === 'entity' ? await entityData(rcon, t) : null
  if (t.kind === 'entity') { await sleep(300); checks.entityStable = stripNbt(before) === stripNbt(await entityData(rcon, t)) }
  let plantsBefore = 0
  if (t.floor === 'grass_patch') plantsBefore = await countPlants(rcon, t.pos)
  const spawned = new Set()
  const onSpawn = (e) => { const n = e.name || ''; if (n && !['item', 'experience_orb', 'player'].includes(n)) spawned.add(n) }
  let windows = 0
  const onWin = () => { windows++; try { bot.closeWindow(bot.currentWindow) } catch (e) {} }
  bot.on('entitySpawn', onSpawn)
  bot.on('windowOpen', onWin)
  const m = mark(bot)

  const block = t.kind === 'block' ? bot.blockAt(t.pos) : null
  if (row.action === 'useOnBlock') {
    bot.activateBlock(block, t.face).catch(() => {})
    if (row.alsoUseItem) bot.activateItem()
  } else if (row.action === 'breakBlock') {
    await Promise.race([bot.dig(block, true).catch(() => {}), sleep(6000)])
    try { bot.stopDigging() } catch (e) {}
  } else if (row.action === 'useOnEntity') {
    // An armour stand takes gear from an "interact at" click on the slot's position (the head for
    // a helmet); a plain entity click does nothing to it.
    if (entity && t.type === 'armor_stand' && bot.activateEntityAt) bot.activateEntityAt(entity, entity.position.offset(0, 1.7, 0)).catch(() => {})
    else if (entity) bot.activateEntity(entity).catch(() => {})
  } else throw new Error(`unknown action ${row.action}`)

  await sleep(1500)
  try { bot.deactivateItem() } catch (e) {}
  bot.setControlState('sneak', false)
  bot.removeListener('entitySpawn', onSpawn)
  bot.removeListener('windowOpen', onWin)
  checks.serverAlive = !/<timeout>/.test(await rcon.cmd('list', { quiet: true }))

  // Observations - all reduced to booleans so run-to-run noise (orb and plant counts) cannot differ.
  const obs = {}
  const want = new Set(row.observe)
  if (want.has('targetChanged') && t.kind === 'block') obs.targetChanged = !(await blockIs(rcon, t.pos, t.id))
  if (want.has('doorOpened')) obs.doorOpened = await blockIs(rcon, t.pos, `${t.id}[open=true]`)
  if (want.has('adjacentChanged')) obs.adjacentChanged = !(await blockIs(rcon, t.pos.offset(t.face.x, t.face.y, t.face.z), 'minecraft:air'))
  if (want.has('fireAdjacent')) {
    obs.fireAdjacent = false
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [0, 2, 0]]) {
      if (await blockIs(rcon, t.pos.offset(dx, dy, dz), 'minecraft:fire')) { obs.fireAdjacent = true; break }
    }
  }
  if (want.has('plantsGrown')) obs.plantsGrown = (await countPlants(rcon, t.pos)) > plantsBefore
  // `ignoreEntities` lists by-products vanilla spawns at random (a thrown egg hatches a chicken one
  // time in eight), which would otherwise differ between identical runs.
  if (want.has('entitySpawned')) obs.entitySpawned = [...spawned].filter(n => !(row.ignoreEntities || []).includes(n)).sort()
  if (want.has('containerOpened')) obs.containerOpened = windows > 0
  if (want.has('entityChanged') && t.kind === 'entity') {
    const after = await entityData(rcon, t)
    obs.entityChanged = stripNbt(before) !== stripNbt(after)
  }
  const ignore = new Set(Object.values(arenas).map(a => a.owner).filter(Boolean).concat(['Wilderness']))
  const messages = since(bot, m).map(l => l.trim()).filter(l => l && !ignore.has(l))
  obs.refusal = [...new Set(messages.map(l => classify(lang, l)))].sort()
  return { checks, outcome: obs, messages }
}

// Entity data minus the fields that move without anyone touching the entity.
function stripNbt (s) {
  return (s || '').replace(/(Spigot\.ticksLived|Paper\.[A-Za-z]+|Motion|Rotation|Pos|UUID|OnGround|FallDistance|Fire|Air|PortalCooldown|TicksFrozen|HurtTime|HurtByTimestamp|DeathTime|AbsorptionAmount|Health|Brain|attributes)\s*:\s*(\[[^\]]*\]|\{[^}]*\}|[^,}]+)/g, '')
}

async function countPlants (rcon, F) {
  let n = 0
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!(await blockIs(rcon, F.offset(dx, 1, dz), 'minecraft:air'))) n++
  return n
}

// A control "changed the world" when any observation other than the messages is positive.
function changedWorld (outcome) {
  return Object.entries(outcome).some(([k, v]) => k !== 'refusal' && (Array.isArray(v) ? v.length > 0 : v === true))
}

// ---- main ------------------------------------------------------------------------------

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.compare) {
    const [a, b] = args.compare.map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
    const changed = printComparison(a, b, compare(a, b))
    process.exit(changed ? 1 : 0)
  }
  if (!args.rows || !args.setup) throw new Error('--rows and --setup are required (or --compare a b)')
  loadMineflayer()
  const table = JSON.parse(fs.readFileSync(args.rows, 'utf8'))
  const setup = require(path.resolve(args.setup))
  const ACTIONS = new Set(['useOnBlock', 'breakBlock', 'useOnEntity'])
  for (const r of table.rows) {
    if (!ACTIONS.has(r.action)) throw new Error(`row ${r.id}: unknown action ${r.action}`)
    if (!table.arenas[r.arena]) throw new Error(`row ${r.id}: unknown arena ${r.arena}`)
    if (!setup.roles[r.role]) throw new Error(`row ${r.id}: unknown role ${r.role}`)
    if (!table.configGroups[r.group]) throw new Error(`row ${r.id}: unknown config group ${r.group}`)
  }
  const rows = table.rows.filter(r => r.group === args.group && (!args.only || args.only.has(r.id)))
  console.log(`=== behaviour driver: ${table.plugin}, group ${args.group}, ${rows.length} rows, label ${args.label}, mineflayer ${require('mineflayer/package.json').version} ===`)

  const lang = loadLang(args.lang)
  const rcon = new Rcon(args.host, args.rconPort, args.rconPassword)
  await rcon.connect()
  const arenas = {}
  for (const [name, a] of Object.entries(table.arenas)) arenas[name] = { name, ...a }
  for (const a of Object.values(arenas)) await buildArena(rcon, a)

  const bots = {}
  for (const [role, username] of Object.entries(setup.roles)) {
    bots[role] = await alive(await makeBot(args, username))
    await sleep(500)
  }
  const ctx = { rcon, bots, arenas, lang, say, tp, Y, targetPoint, sleep }
  await setup.setup(ctx)

  const controls = new Map()
  const results = []
  for (const row of rows) {
    const controlKey = JSON.stringify([row.action, row.item, row.count, row.sneak, row.alsoUseItem, row.target, row.observe])
    let control = null
    if (row.control !== false) {
      if (!controls.has(controlKey)) {
        const c = await attempt(ctx, row, setup.controlRole, setup.controlArena)
        controls.set(controlKey, c)
        console.log(`  [control ${row.action}/${row.item || 'hand'}] ${JSON.stringify(c.outcome)}`)
      }
      control = controls.get(controlKey)
    }
    const r = await attempt(ctx, row, row.role, row.arena)
    const why = []
    for (const [k, v] of Object.entries(r.checks)) if (!v) why.push(k)
    if (control) {
      if (!Object.values(control.checks).every(Boolean)) why.push('controlHarness')
      else if (!changedWorld(control.outcome)) why.push('controlNoEffect')
    }
    const rec = { id: row.id, role: row.role, arena: row.arena, status: why.length ? 'not-checked' : 'observed', why: why.join(',') || undefined, checks: r.checks, outcome: r.outcome, messages: r.messages }
    results.push(rec)
    console.log(`  [${rec.status}] ${row.id}: ${JSON.stringify(r.outcome)}${why.length ? '  (' + why.join(',') + ')' : ''}`)
  }

  const doc = { label: args.label, plugin: table.plugin, group: args.group, mineflayer: require('mineflayer/package.json').version, finishedAt: new Date().toISOString(), rows: results }
  if (args.jsonOut) fs.writeFileSync(args.jsonOut, JSON.stringify(doc, null, 1))
  const nc = results.filter(r => r.status !== 'observed').length
  console.log(`\n${results.length} rows, ${results.length - nc} observed, ${nc} not checked`)
  for (const b of Object.values(bots)) b.quit()
  rcon.close()
  process.exit(0)
}

main().catch(e => { console.error('ERROR', e && e.stack ? e.stack : e); process.exit(2) })
