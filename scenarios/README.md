One scenario per plugin, named `<plugin-slug>.js`. See the repository README for what a scenario must do.

A real-world fixture has no script; its manifest's `scenario` points at a note here named
`<plugin-slug>-real.md` instead (for example [`medieval-factions-real.md`](medieval-factions-real.md)),
which records where the data came from and how it was anonymised.

| Script | Plugin | What it creates |
|---|---|---|
| [`medieval-factions.js`](medieval-factions.js) | Medieval Factions | two bots: factions Alpha and Bravo, 3 + 2 claims made by walking, a mutual alliance, both descriptions, a chest Alice places and locks (Bob is refused at it), a lever-triggered gate that is opened and closed |

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
- The last stdout line is `SCENARIO_EXPECTED {json}`: the count per persisted entity type,
  keyed by the label the plugin prints in its `<n> <label> loaded` startup lines. That object
  is what goes into the fixture manifest's `expected`, and the workflow asserts the plugin's
  next boot reports the same numbers.
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
