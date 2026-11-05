One scenario per plugin, named `<plugin-slug>.js`. See the repository README for what a scenario must do.

A real-world fixture has no script; its manifest's `scenario` points at a note here named
`<plugin-slug>-real.md` instead (for example [`medieval-factions-real.md`](medieval-factions-real.md)),
which records where the data came from and how it was anonymised.

| Script | Plugin | What it creates |
|---|---|---|
| [`medieval-factions.js`](medieval-factions.js) | Medieval Factions | two bots: factions Alpha and Bravo, 3 + 2 claims made by walking, a mutual alliance, both descriptions, a chest Alice places and locks (Bob is refused at it), a lever-triggered gate that is opened and closed |

## Behaviour tables (T4, Stephenson-Software RFC 0017)

A behaviour table is a matrix of rows: who (a role) does what (an action with an item) to which
target, where (an arena), under which config group. `behaviour-driver.js` plays a table on a
running server and writes one outcome per row, read back from the world. It is run on the current
stable jar and on a candidate, each on fresh plugin data, and `--compare` reports every row whose
outcome changed. No expected values are needed.

| Table | Setup | Rows |
|---|---|---|
| [`medieval-factions-behaviour.json`](medieval-factions-behaviour.json) | [`medieval-factions-behaviour-setup.js`](medieval-factions-behaviour-setup.js) | 151: core actions for six roles in the owner's claim, world-changing and throw-type items, entities, doors, ladders and wilderness; a locked chest; PvP; claiming and unclaiming, who may manage a faction, faction home and law list; then wartime allowances and destruction, wilderness place/break prevention, the entity option, fire at war, friendly fire, war required for PvP, factionless players, allies' land, overclaiming, duels, vassal and liege land, and a gate, across 18 config groups |
| [`fiefs-behaviour.json`](fiefs-behaviour.json) | [`fiefs-behaviour-setup.js`](fiefs-behaviour-setup.js) | 41: a fief's land (fief member, faction member in no fief, member of another fief, enemy) and faction land outside any fief, the same land after the fief is renamed (`renamed` group), a member of another fief in the land with `claimedLandProtected` turned off for their own fief (`southFlagOff` group) or for the land's fief (`northFlagOff` group), and who may run fief commands (invite, kick, flags, rename, description, claim, unclaim, disband); played on top of Medieval Factions, which the gate installs as a dependency |
| [`currencies-behaviour.json`](currencies-behaviour.json) | [`currencies-behaviour-setup.js`](currencies-behaviour-setup.js) | 23 command rows: who may mint, rename, describe and retire a faction's currency (member, ally, enemy, stranger, bypass) and who may create one; played on top of Medieval Factions |
| [`democracy-behaviour.json`](democracy-behaviour.json) | [`democracy-behaviour-setup.js`](democracy-behaviour-setup.js) | 13 command rows: who may vote in a faction's election (including a second vote), start one, run in it and drop out; played on top of Medieval Factions |

```
node scenarios/behaviour-driver.js --rows scenarios/medieval-factions-behaviour.json \
     --setup scenarios/medieval-factions-behaviour-setup.js --group default \
     --port 25565 --rcon-port 25575 --rcon-password <pw> [--lang lang_en_US.properties] \
     [--only <id>,<id>] [--mc-version 26.1] --label stable --json-out stable.json
node scenarios/behaviour-driver.js --compare stable.json candidate.json   # exit 1 when a row changed
```

- Only `--rows` and `--setup` are required (or `--compare a b` on its own). `--group` defaults
  to `default`, and only rows whose `group` equals it are played. `--only` plays just the listed
  row ids of that group. `--label` (written into the outcome file and the `--compare` table)
  defaults to `run`. `--mc-version` defaults to auto-detection, as in a scenario; the driver does
  not read a table's `minecraftVersion`. `--host` defaults to `localhost`, `--port` to `25565`,
  `--rcon-port` to `25575` and `--rcon-password` to `minecraft`. Without `--json-out` a run writes
  no outcome file, and `--compare` needs one from each run. `--help` prints the driver's top-level
  `//` comment lines and exits; any other unknown argument is an error (exit 2).
- `mineflayer` (with `minecraft-data` and `vec3`) must resolve from the driver's directory or
  `NODE_PATH`; `--compare` reads only the two outcome files and needs neither mineflayer nor a
  server. A run that finishes exits 0 whatever its rows' outcomes; a table that does not
  validate (an unknown action, arena, role or config group; a `command` row whose `command` does
  not start with `/`, that observes an observer the setup module lacks, or that has no control; an
  `attackPlayer` row with an unknown `targetRole` or no control) or a run that fails exits 2.
  `--compare` exits 1 only when a row is `changed`; rows that are only `message-changed` or
  `not-compared` exit 0. It walks the first file's rows: a row missing from the second file is
  `not-compared`, and a row only in the second file is not reported.
- The outcome file holds `label`, `plugin`, `group`, `mineflayer`, `finishedAt` and `rows`, one
  per row played: `id`, `role`, `arena`, `status` (`observed` or `not-checked`), `why` (on a
  `not-checked` row, the failed checks, plus `controlHarness` or `controlNoEffect` for its
  control), `checks`, `outcome` and `messages` (the reply lines). A run that fails writes none.

- `dataPaths` (server-root-relative globs) names the plugin's data, which the release-gates behaviour gate deletes before every pass so each jar starts fresh. Medieval Factions keeps its H2 database at the server root, outside its plugin folder.
- A setup module exports `roles` (role name → bot username; one bot joins per role),
  `setup(ctx)` (run once after the bots join and the arenas are built), and `controlRole` and
  `controlArena`, the default control for a block or entity row (Fiefs: `owner` in `fiefArena`).
  `prepare(ctx, arena)` and `observers` are optional and serve every action except `attackPlayer`,
  not only `command` rows: before a block row the driver runs `prepare` and leaves the row
  `not-checked` when it fails, and a block row's `observe` may name an observer (Medieval
  Factions' `gateOpened`). `ctx` holds `rcon`, `bots` (by role), `arenas` (by name), `lang`, `say`,
  `tp`, `Y`, `targetPoint`, `sleep`, `table`, `setup` and `group`.
- Actions: `useOnBlock`, `breakBlock`, `useOnEntity`, `attackPlayer` (the row's role hits `targetRole` once; outcome `damaged`, read from the victim's health over RCON; such a row must name a `control: {role, targetRole}` hit that lands, played in the row's own arena, and the server must allow PvP; its `observe` is not read), and `command` (the row's role sends `command`, e.g. `"/f claim"`, from the middle of its arena, after its inventory is cleared and given `item` × `count` when the row names one; see below).
- `arenas` maps a name to `{chunk: [x, z], owner}`, and the driver force-loads and builds each one. Before every attempt except a `command` row's it wipes the arena back to a stone floor. `owner` is the faction name the chunk shows a player (`null` for none); the driver only drops that name from replies as a territory notice, and the setup module does the claiming. `keepBlocks: true` keeps the blocks between attempts, for a structure the setup module builds once, so its rows rely on `prepare` to restore it (entities are still removed). The driver ignores any other field, which is the setup module's own (Medieval Factions' `claimedBy`, below).
- A block or entity row (`useOnBlock`, `breakBlock`, `useOnEntity`) names a `target`, placed in the middle of the arena: `{block}` (a door gets both halves), `{block, placed: false}` for a block the setup module already built, `{floor}` to replace the floor block there (`grass_patch` lays 3×3 of grass), or `{entity}` to summon one (an `item_frame` hangs on a stone block). The role's inventory is cleared and given the row's `item` × `count` (`count` defaults to 1). `sneak: true` holds sneak through the action, and `alsoUseItem: true` on a `useOnBlock` row uses the held item as well as clicking, so a throwable is thrown.
- A block or entity row's `observe` lists what is read afterwards: `targetChanged` (the block is no longer the target), `doorOpened`, `adjacentChanged` (the block on the clicked face is no longer air), `fireAdjacent` (fire beside or above the target), `plantsGrown` (more of a `grass_patch`'s 3×3 is covered than before), `entitySpawned` (the entity types that appeared within 8 blocks, except items, experience orbs, players and `ignoreEntities`), `containerOpened`, `entityChanged` (the entity's data, minus the fields that move on their own), or the name of a setup module observer.
- A `command` row's observations come from the setup module: `observers[name](ctx, arena, role)` reads some state (the acting role is passed for state that is the player's own, such as coins held) (Medieval Factions: `claimChanged` reads the chunk's owner), and the outcome is whether it differs after the command. Before every attempt the setup module's optional `prepare(ctx, arena)` restores the arena's starting state (an arena's `claimedBy`), because a command changes more than the arena's blocks; if that fails, or the bot cannot be placed, the command is not sent and the row is `not-checked`. A command row must name its control, `control: {role, arena}`, where the command is expected to work (`/f claim` by the owner on unclaimed land); only a message-only row (`observe: []`, whose outcome is the reply: took effect when no refusal key came back) may say `control: false`. Table-level `ignoreLines` are whole chat lines a `command` row drops (territory notices naming a faction, the fixed lines of a Medieval Factions faction info card), and `informationalMessageKeys` are replies that are not refusals, for every action (a claim's success message). Such a reply is still part of the outcome, kept apart from `refusal` as one string, `notice`, so a success that turns into a refusal is reported as `changed`.
- Table-level `ignoreMessageKeys` are the message keys (lang file or `messagePatterns`) of messages that arrive on a timer rather than because of the row (Medieval Factions' power ticks); one that lands inside a row's window is left out of that row's outcome, for every action.
- `expect` (Stephenson-Software RFC 0019) records what the docs promise for a row: `{effect, refusal?, source, reviewed, note?}`, with `source` the doc line pinned to a commit (`Dans-Plugins/Medieval-Factions/CONFIG.md@<sha>#L<a>-L<b>`). The behaviour gate (release-gates v22+) checks every reviewed one on both jars. The driver ignores the field. A reviewed expectation needs a source; where the docs are silent, add the sentence to the docs first.
- The driver never restarts the server. The harness applies a row group's `configGroups` entry
  (dotted `config.yml` keys and their values, `{}` for the defaults) to `config.yml` and restarts
  between groups. The setup module receives the group as
  `ctx.group`, so state a group needs that is not in `config.yml` is set up there (Fiefs' fief
  flags, Medieval Factions' vassals, duel and gate).
- Every row is paired with a control: the same action by the setup module's `controlRole` in its
  `controlArena` (the owner in their own claim), or by the row's own `control: {role, arena}`
  (Medieval Factions' gate rows; the named role, for `attackPlayer` and `command` rows). A block
  row whose outcome is only the reply may say `control: false` and is played without one
  (`barehand-stone-enemy`). When the
  control does not change the world either, or fails one of the checks below, the bot cannot
  decide the row and it is recorded as `not-checked`, as is a row whose bot was not aiming at the
  target, did not reach its position, or did not hold the item server-side, whose target entity's
  data changed before the action, whose setup module observer could not be read, or whose server
  stopped answering. A `not-checked` row is never compared. Rows alike in everything but role and
  arena share one control attempt, played for the first of them.
- Outcomes are booleans or sets (never counts, which vary between identical runs), and refusal
  messages are mapped to lang keys with `--lang` (a plugin without a lang file lists its fixed
  messages in the table as `messagePatterns: [{key, pattern}]`, regular expressions matched before
  the lang file, and any table may use them, as Medieval Factions' does for `LawListEntry`; a reply
  that matches neither is kept as `text:<line>`), so a reworded message is reported as
  `message-changed` rather than `changed`, while a refusal that appears or goes away is `changed`.
  A row's `ignoreEntities` lists entities vanilla spawns
  at random as a by-product, which are left out of its `entitySpawned` set (Medieval Factions'
  thrown eggs hatch a `chicken` one time in eight).

## Running a scenario

Every scenario is a single Node file with the same command line, so the
[release-gates](https://github.com/Dans-Plugins/release-gates) save-compatibility workflow can
run any of them from a raw URL (`scenario_script`):

```
node scenarios/<slug>.js --host localhost --port 25565 --rcon-port 25575 \
     --rcon-password <password> --bots 2 \
     [--server-log docker:<container>|<file>] [--mc-version 26.1] [--json-out <file>]
```

- Every flag is optional: `--host` defaults to `localhost`, `--port` to `25565`, `--rcon-port` to
  `25575`, `--rcon-password` to `minecraft` and `--bots` to `2`. Fewer than 2 bots, or an unknown
  argument, is an error; `medieval-factions.js` plays Alice and Bob whatever the count.
- `mineflayer` (which brings `minecraft-data`, `minecraft-protocol` and `vec3`) must resolve
  from the script's directory; the workflow installs pinned versions beside a copy of the script.
- The server must be in offline mode (bots join under any name) and must not make the bots
  operators — the scenario proves what a player can do with the plugin's default permissions.
- Exit code 0 means every step verified; anything else means a step failed, and the output
  says which and what was received instead.
- When every step verified, the last stdout line is `SCENARIO_EXPECTED {json}`: the count per
  persisted entity type, keyed by the label the plugin prints in its `<n> <label> loaded`
  startup lines. That object is what goes into the fixture manifest's `expected`, and the
  workflow asserts the plugin's next boot reports the same numbers. A failed run prints no
  `SCENARIO_EXPECTED` line.
- `--json-out <file>` writes the run as JSON (`passed`, every step with its result and detail,
  `expected` — `null` on failure — and the mineflayer version), whether the run passed or not.
- `--server-log docker:<container>|<file>` adds a final `server-log` step: every chat command
  a bot sent must appear in the server log as `<bot> issued server command: <command>`, and
  the log must have no plugin `ERROR`/`SEVERE` lines. Without it the step passes as
  "not checked".
- `--help` prints the script's top-level `//` comment lines, starting with its header, and exits.
- `--mc-version` defaults to auto-detection; `--mc-version auto` (or `false`) asks for it
  explicitly, in a scenario and in the behaviour driver alike. A server whose protocol the
  installed mineflayer does not know is reported in one line (`server-version` step) instead of
  failing inside the handshake.

## Lessons carried over from the Medieval Factions bot harness

- Read state back; never trust the client. Chat replies are the plugin's own word, `/f info`
  and `/f claim check` are read-backs, and RCON `execute if block` proves what the world holds.
- A stalled server looks exactly like "nothing happened". Generating terrain around a far-off
  arena stalls a small server for tens of seconds, so the script waits for three quick RCON
  round-trips before it starts relying on reply timeouts, and reply timeouts are long (60 s).
- In Medieval Factions 5.8.1, `/f checkclaim` (as listed in plugin.yml) is not a subcommand;
  the read-back is `/f claim check`. Locking a block does not leave lock mode (`/lock cancel`
  does). A gate's `minHeight` is measured as `maxY - minY`, so "at least 3 blocks tall" needs
  four blocks.
