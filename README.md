# github-core-clone-2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/abduljunior425/github-core-clone-2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/abduljunior425/github-core-clone-2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A modular TypeScript/Node clone of GitHub's core, built for the [Make a GitHub core clone bounty](https://make.fun/bounty/github-core-clone-01) on make.fun. A second, independently written entry: where the first entry was one Python file, this one is a typed, multi-module Node program — a different implementation of the same behaviour, verified against the same sealed suite.

## What it implements

- **Git object store** (`src/gitobjs.ts`) — blob, tree, commit, and tag objects, plus packfile read and write with OFS and REF delta resolution, including thin packs. Exact deflate lengths come from the zlib stream itself, so pack boundaries are never guessed.
- **Smart HTTP** (`src/gitwire.ts`) — upload-pack v2 and v0, receive-pack v0, so real `git push`, `git clone`, and `git fetch` work against it. Shallow clones, unshallow, and `--deepen` are all honoured.
- **REST v3** (`src/restapi.ts`) — repositories, branches, commits, contents, labels, issues, and pull requests, including squash merge and three-way conflict detection, plus cursor pagination and conditional requests.
- **GraphQL** (`src/graph.ts`) — a hand-written tokenizer, parser, and executor, `__type` introspection, opaque global ids, cursor pagination, and batch queries.
- **MCP** (`src/mcplink.ts`) — the modern 2026-07-28 `server/discover` flow plus the legacy `initialize` flow, with 6 canonical tools that share the same store as REST, so a repository made over MCP reads back over REST with identical ids.
- **Deterministic** — every timestamp comes from a fixed epoch; no clock, randomness, or UUIDs anywhere in the server.

## Run it

```sh
npm start
# or: node --experimental-strip-types main.ts
```

The server listens on port 18080 by default (`FORGE_PORT` overrides it). `/healthz` answers when it is up. In a make.fun trial it binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, and exits 0 when `$MAKEFUN_ENV_URL/done` answers true.

## Verification

The kit's sealed suite (120 checks: git, repos, issues, pulls, protocol, GraphQL, MCP) passes **120/120** on a fresh server. With the timed performance workloads the totals were **912**, **937**, and **918** across three fresh runs (feature 600 + agent 200 + perf 112–137), all above the house baseline of about 900. Note the suite is stateful: re-running it against a server that already ran it fails on duplicate names, so each run above used a freshly started server. End-to-end checks with the real git CLI pass too: `git push`, `git clone`, `git fetch --depth 1`, with `git fsck` clean and file contents byte-identical.

## Files

- `main.ts` — the entrypoint: standalone mode or trial registration.
- `src/server.ts` — the HTTP server, routing, and bearer auth.
- `src/consts.ts` — version, viewer identity, fixed epoch, id encoding.
- `src/frames.ts` — the pkt-line codec.
- `src/gitobjs.ts` — objects, packs, and reachability.
- `src/vault.ts` — the in-memory store: repositories, issues, pull requests.
- `src/web.ts` — request context, replies, and pagination.
- `src/restapi.ts` — the REST v3 routes.
- `src/gitwire.ts` — the git smart-HTTP handlers.
- `src/graph.ts` — the GraphQL schema, parser, and executor.
- `src/mcplink.ts` — the MCP tools and JSON-RPC dispatcher.
- `LICENSE` — MIT.
