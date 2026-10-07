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
| [`medieval-factions-behaviour.json`](medieval-factions-behaviour.json) | [`medieval-factions-behaviour-setup.js`](medieval-factions-behaviour-setup.js) | 86: core actions for six roles in the owner's claim, world-changing and throw-type items, entities, doors, ladders and wilderness; wartime allowances, wilderness place/break prevention, the entity option, fire at war, a locked chest, and PvP (friendly fire, allies, war required, factionless players), across ten config groups |
| [`fiefs-behaviour.json`](fiefs-behaviour.json) | [`fiefs-behaviour-setup.js`](fiefs-behaviour-setup.js) | 22: a fief's land (fief member, faction member in no fief, member of another fief, enemy) and faction land outside any fief; played on top of Medieval Factions, which the gate installs as a dependency |

```
node scenarios/behaviour-driver.js --rows scenarios/medieval-factions-behaviour.json \
     --setup scenarios/medieval-factions-behaviour-setup.js --group default \
     --port 25565 --rcon-port 25575 --rcon-password <pw> [--lang lang_en_US.properties] \
     --label stable --json-out stable.json
node scenarios/behaviour-driver.js --compare stable.json candidate.json   # exit 1 when a row changed
```

- `dataPaths` (server-root-relative globs) names the plugin's data, which the release-gates behaviour gate deletes before every pass so each jar starts fresh. Medieval Factions keeps its H2 database at the server root, outside its plugin folder.
- Actions: `useOnBlock`, `breakBlock`, `useOnEntity`, `attackPlayer` (the row's role hits `targetRole` once; outcome `damaged`, read from the victim's health over RCON; such a row must name a `control: {role, targetRole}` hit that lands, and the server must allow PvP), and `command` (the row's role sends `command`, e.g. `"/f claim"`, from the middle of its arena, after its inventory is cleared and given `item` × `count` when the row names one; see below).
- A `command` row's observations come from the setup module: `observers[name](ctx, arena, role)` reads some state (the acting role is passed for state that is the player's own, such as coins held) (Medieval Factions: `claimChanged` reads the chunk's owner), and the outcome is whether it differs after the command. Before every attempt the setup module's optional `prepare(ctx, arena)` restores the arena's starting state (an arena's `claimedBy`), because a command changes more than the arena's blocks; if that fails, or the bot cannot be placed, the command is not sent and the row is `not-checked`. A command row must name its control, `control: {role, arena}`, where the command is expected to work (`/f claim` by the owner on unclaimed land); only a message-only row (`observe: []`, whose outcome is the reply: took effect when no refusal key came back) may say `control: false`. Table-level `ignoreLines` are chat lines to drop (territory notices naming a faction), and `informationalMessageKeys` are replies that are not refusals (a claim's success message).
- `expect` (Stephenson-Software RFC 0019) records what the docs promise for a row: `{effect, refusal?, source, reviewed, note?}`, with `source` the doc line pinned to a commit (`Dans-Plugins/Medieval-Factions/CONFIG.md@<sha>#L<a>-L<b>`). The behaviour gate (release-gates v22+) checks every reviewed one on both jars. The driver ignores the field. A reviewed expectation needs a source; where the docs are silent, add the sentence to the docs first.
- The driver never restarts the server. The harness applies a row group's `configGroups` entry
  to `config.yml` and restarts between groups.
- Every row is paired with a control: the same action by the owner in their own claim (by the
  named role, for `attackPlayer` and `command` rows). When the
  control does not change the world either, the bot cannot decide the row and it is recorded as
  `not-checked`, as is a row whose bot was not aiming at the target, did not reach its position,
  did not hold the item server-side, or whose server stopped answering. A `not-checked` row is
  never compared.
- Outcomes are booleans or sets (never counts, which vary between identical runs), and refusal
  messages are mapped to lang keys with `--lang` (a plugin without a lang file lists its fixed
  messages in the table as `messagePatterns: [{key, pattern}]`, regular expressions matched before
  the lang file), so a reworded message is reported as
  `message-changed` rather than `changed`.

## Running a scenario

Every scenario is a single Node file with the same command line, so the
[release-gates](https://github.com/Dans-Plugins/release-gates) save-compatibility workflow can
run any of them from a raw URL (`scenario_script`):

```
node scenarios/<slug>.js --host localhost --port 25565 --rcon-port 25575 \
     --rcon-password <password> --bots 2 \
     [--server-log docker:<container>|<file>] [--mc-version 26.1] [--json-out <file>]
```

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
- `--mc-version` defaults to auto-detection. A server whose protocol the installed mineflayer
  does not know is reported in one line (`server-version` step) instead of failing inside the
  handshake.

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
