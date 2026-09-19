# Medieval Factions — real-world fixture (`medieval-factions/5.8.1-real`)

Not a scripted scenario. This fixture is a real Medieval Factions database from a live
server, anonymised, published so that every future Medieval Factions release is booted
over data that a real community produced over nine months — including the shapes a
scripted scenario never generates (dozens of players, thousands of claims, vassalage
trees, wars, locks, an abandoned duel invite).

Release: `medieval-factions/5.8.1-real` —
`medieval-factions-5.8.1-real.tar.gz`, `manifest.json`, and for review
`medieval-factions-5.8.1-real.h2.sql` (the same database as a readable SQL dump).

## Provenance

- Server: Viridian Gulf, a Medieval Factions community server operated by the
  repository owner, who consented to the use of the data. It ran from 2025-09-21 to
  2026-06-06 on Medieval Factions 5.8.x with the embedded H2 database (`medieval_factions_db.mv.db`
  in the server root, `MODE=MYSQL;DATABASE_TO_UPPER=false`).
- The database file was recovered with H2's `Recover` tool (the shaded H2 2.1.214
  inside the plugin jar), because the plugin's shutdown path had failed to close the
  store on 225 consecutive shutdowns. The recovered data was complete: 14 factions,
  2,628 claimed chunks, 38 players. The last write is from 2026-05-30.
- Schema: Flyway migrations V1–V8 as applied by 5.8.x (`mf_schema_history` is kept).

## Anonymisation

Everything that could identify a player is gone; everything structural is kept.

| Data | Treatment |
|---|---|
| Player UUIDs (every column that holds one: `mf_player.id`, `mf_faction_member`, `mf_faction_invite`, `mf_faction_chat_member`, `mf_faction_application`, `mf_duel`, `mf_duel_invite`, `mf_player_interaction_status`, `mf_gate_creation_context`, `mf_locked_block`, `mf_locked_block_accessor`, `mf_chat_channel_message`) | Replaced by a deterministic `uuid5(secret salt, original)`; the same original maps to the same fake everywhere, so joins hold. The salt was discarded. |
| Player names (`mf_player.name`) | `Player1` … `Player38`, numbered by the fake id so the numbering carries nothing about the originals. |
| Faction names | `Faction1` … `Faction14` (player-authored text). |
| Faction descriptions, prefixes, laws, chat messages | Replaced by `#` of the same length (all descriptions were empty and all prefixes null in the source; one 9-character chat message and no laws). |
| Faction ids, role ids, relationship ids, gate/lock ids, world ids | Kept — random UUIDs that identify nothing. |
| Roles, permissions, flags (JSON), power values, versions, claims, relationships, gates, locks, home locations, timestamps | Kept verbatim. Role names were the plugin defaults (`Owner`/`Officer`/`Member`) plus generic custom ranks. |

The anonymised database was dumped with H2 `Script` and rebuilt from that dump into a
fresh file, so no original bytes survive in unreferenced MVStore chunks. Both the dump
and the binary were then searched for every original UUID and name (UTF-8, UTF-16 and
Latin-1) and for anything IPv4-shaped: nothing survived.

## Row counts (identical before and after)

| Table | Rows |
|---|---|
| `mf_player` | 38 |
| `mf_faction` | 14 |
| `mf_faction_member` | 25 |
| `mf_faction_relationship` | 69 (60 ally, 4 at-war, 3 vassal, 2 liege) |
| `mf_claimed_chunk` | 2628 |
| `mf_locked_block` | 11 |
| `mf_locked_block_accessor` | 1 |
| `mf_gate` | 1 |
| `mf_faction_invite` | 1 |
| `mf_duel_invite` | 1 |
| `mf_chat_channel_message` | 1 |
| `mf_player_interaction_status` | 4 |
| `mf_schema_history` | 9 |
| `mf_duel`, `mf_law`, `mf_faction_application`, `mf_faction_chat_member`, `mf_gate_creation_context` | 0 |

## What the manifest expects

The `expected` counts are what Medieval Factions 5.8.1 logs as `<n> <label> loaded`
when it enables over this database: `players` 38, `factions` 14,
`faction relationships` 69, `claims` 2628, `locked blocks` 11, `gates` 1, `duels` 0,
`duel invites` 1.

## Layout

The archive holds server-root-relative paths, no wrapper directory:

```
medieval_factions_db.mv.db
plugins/MedievalFactions/config.yml     (5.8.1 defaults; the plugin regenerates lang/)
```

The save-compatibility gate in
[release-gates](https://github.com/Dans-Plugins/release-gates) takes it through
`fixture_url` / `fixture_manifest_url` with `extra_data_paths: medieval_factions_db*`.

## Not re-recorded on promotion

A real-world fixture is not produced by a scenario, so promoting a release does not
re-record it. It stays pinned to the data it was taken from until a newer real-world
capture replaces it.

_drafted by Claude on behalf of Daniel Stephenson_
