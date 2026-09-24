# plugin-fixtures

Recorded plugin data folders used to verify that a new release of a Dans-Plugins plugin loads the previous release's saved data intact.

A **fixture** is the data folder a plugin produced while a known stable release ran a scripted scenario on a throwaway Spigot server. Before the next release is published, the candidate build is booted over that fixture and must load, read back, write to, and reload the data without loss. On promotion the candidate re-records the fixture, so every release is upgrade-tested from the one before it.

This repository holds no plugin code and no secrets. Fixtures are produced on a disposable server with a placeholder operator and contain only what the scenario created.

## Layout

```
scenarios/<plugin-slug>.js      the script that produces the fixture (console commands over RCON,
                                and a mineflayer bot where a real player is required)
scenarios/<plugin-slug>-real.md the provenance and anonymisation note of a real-world fixture
                                (below), which takes the place of a script
fixtures/<slug>-<version>/      the manifest of each published fixture, for review — the archives
                                themselves are release assets (below)
schema/manifest.schema.json     the manifest format every fixture asset must carry
```

## Fixtures are release assets

Each recorded fixture is published as a GitHub release of this repository, tagged
`<plugin-slug>/<plugin-version>` (for example `dans-set-home/2.0.0`), with two assets:

- `<plugin-slug>-<plugin-version>.tar.gz` — the plugin's data folder, and for database-backed plugins the database file(s) the server wrote alongside it
- `manifest.json` — what the fixture contains and what a reload must find

A manifest:

```json
{
  "plugin": "Dans-Set-Home",
  "slug": "dans-set-home",
  "version": "2.0.0",
  "minecraft": "26.2",
  "scenario": "scenarios/dans-set-home.js",
  "scenarioSha": "<commit of this repository the scenario was run from>",
  "recordedAt": "2026-09-20T02:14:00Z",
  "paths": ["plugins/DansSetHome"],
  "expected": {
    "homes": 3,
    "players": 2
  }
}
```

`expected` lists a count per persisted entity type — every type, not only the root one. A release that reports a type as empty when the manifest says otherwise has a read-side defect, even if nothing threw.

`minecraft` pins the server version the fixture was recorded on. Testing a fixture on a different server version conflates a plugin upgrade with a server upgrade; bumping the server version is its own event and its own re-record.

## Real-world fixtures

A scripted scenario proves the shapes it was written to create. A **real-world fixture**
is a database or data folder taken from a live server, anonymised, and published under the
tag `<plugin-slug>/<plugin-version>-real` with the same two assets. Its manifest carries
`"kind": "real-world"`, and its `scenario` points at a note in `scenarios/` that records
where the data came from, what was scrubbed and how, and the row counts before and after.
It is not re-recorded on promotion; it stays pinned until a newer capture replaces it.

A real-world fixture must contain no player identity: every player UUID replaced by a
deterministic fake, every name by `Player<n>`, every free-text field (descriptions,
prefixes, laws, chat) by a same-length placeholder — and the published files searched for
every original value before release. Structure (factions, members and roles, claims,
relationships, locks, gates, power) is kept intact and row counts must be unchanged.

The manifest of each published fixture is committed under `fixtures/<slug>-<version>/` so
it can be reviewed; the archive itself is only ever a release asset.

Current real-world fixtures:

| Tag | Note | What it holds |
|---|---|---|
| `medieval-factions/5.8.1-real` | [scenarios/medieval-factions-real.md](scenarios/medieval-factions-real.md) | nine months of a live Medieval Factions server: 38 players, 14 factions, 2,628 claims, 69 relationships, 11 locks, 1 gate |

## Writing a scenario

A scenario must:

1. create at least one of every entity type the plugin persists;
2. be repeatable — the same scenario against the same release produces the same `expected` counts;
3. expose a **read-back** step for each entity type (a command whose output proves the data was loaded, not merely that the file exists);
4. expose one **write** step that can run after a restart, so a candidate's own writer is exercised against a folder its reader just loaded;
5. use console commands wherever a non-player sender is accepted, and a mineflayer bot only where a `Player` is required.

The Medieval Factions bot harness (mineflayer + RCON) is the reference for the bot side; its hard-won constraints — the bot must genuinely aim, continuous-use items are undecidable, read state back over RCON rather than trusting the client, a stalled server is indistinguishable from "nothing happened" — apply to every scenario. [`scenarios/medieval-factions.js`](scenarios/medieval-factions.js) is the first scenario written to them; [scenarios/README.md](scenarios/README.md) has the command line every scenario shares and how the release-gates workflow runs one.

Current recorded fixtures:

| Tag | Scenario | What it holds |
|---|---|---|
| `medieval-factions/5.8.1-bots` | [scenarios/medieval-factions.js](scenarios/medieval-factions.js) | 2 players, 2 factions, 5 claims, 2 relationship rows (a mutual alliance), 1 locked block, 1 gate — recorded on Spigot **26.1**, because the published mineflayer stack cannot join 26.2 yet (the scenario's `server-version` step reports this) |

## What this does not prove

- Data written by features the scenario does not exercise.
- Downgrade compatibility: a fixture is loaded by a *newer* release, never an older one.
