# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Single pnpm workspace monorepo for the Bilibili-Notify project. Two product forms share a single platform-neutral business core:

- **Koishi sub-plugins** (under `koishi/`) — historical / current shipping form, npm-published as `koishi-plugin-bilibili-notify*`
- **Standalone Hono + React dashboard** (under `apps/`) — primary product form going forward

Both ends consume the same `@bilibili-notify/*` core packages.

## Commands

Toolchain is **vp (vite-plus)** — unified Node + package manager + task runner.
It wraps pnpm under the hood (reads `package.json#packageManager`) but never
exposes a `pnpm` shim on PATH; always go through `vp`. Shorthands: `vpr <script>`
≡ `vp run <script>`; `vpx <bin>` runs a binary — local `node_modules/.bin` first
(like `vp exec`), else `vp dlx` (download); `pkg@version` / `-p` / shell-mode
force dlx. Package-script bodies may still contain `pnpm -r ...` — `vp run`
injects the embedded pnpm into the subprocess PATH so they keep working.

```bash
vp install
vp run build                          # pnpm -r run build (topo order) + koishi console UI
vp run -F koishi-plugin-bilibili-notify build   # build one package — filter BEFORE the script name
vp run typecheck                      # tsc --noEmit across the workspace
vp test run                           # vite-plus → vitest, all packages

# Dashboard (apps/) dev — root scripts
vp run dev:server   # tsx watch on apps/server
vp run dev:web      # vite dev server on apps/web
vp run dev:apps     # both, in parallel with stream-prefixed logs

# Lint / format (Biome)
vp run lint           # check only
vp run lint:fix       # auto-fix
vp run format         # auto-format
vp run check          # lint + format check
vp run check:fix      # lint + format auto-fix
vpx biome check .     # one-off ad-hoc Biome run (vpx → local bin, else dlx)

# Git hooks (Lefthook) installed automatically on `vp install` (prepare hook).
# Pre-commit: biome check --staged --write on *.ts, *.js, *.mjs, *.json (lefthook.yml).
# Commit-msg: commitlint --edit — conventional-commits enforced; non-compliant messages rejected.
```

> `vp run -F <pkg> <script>` — the `-F` filter MUST precede the script name.
> `vp run <script> -F <pkg>` forwards `-F` to the script (e.g. tsc) and breaks.

## Top-level layout

```
packages/   ← platform-neutral business core (@bilibili-notify/*)
koishi/     ← Koishi thin-shell plugins (koishi-plugin-bilibili-notify*)
apps/       ← Hono server + React dashboard (pnpm sub-workspace)
```

pnpm-workspace.yaml glob: `["packages/*", "koishi/*", "apps/*"]`. Single workspace + single lockfile; apps/server consumes business cores via the pnpm `workspace:*` protocol.

**Path constraint**: never put the substring `bilibili-notify` in any directory under `koishi/` — Koishi's plugin loader gets confused. The koishi main plugin lives at `koishi/core/`, not `koishi/bilibili-notify/`. The npm name `koishi-plugin-bilibili-notify` is decoupled from the directory name (set in package.json's `name`).

## Package inventory

### Platform-neutral business core (`packages/`)

| Path | npm name | Role |
|---|---|---|
| `packages/internal` | `@bilibili-notify/internal` | Zod schemas (Subscription / PushTarget / GlobalConfig / HistoryEntry) + platform interfaces (ServiceContext / MessageBus / NotificationSink / NotificationPayload) + utils (withLock, retry, interpolate). Zero koishi deps. |
| `packages/api` | `@bilibili-notify/api` | `BilibiliAPI` (HTTP + WBI signing) + `LoginFlow` (QR + cookie state machine). Constructed with `{ serviceCtx, ... }`. Zero koishi deps. |
| `packages/storage` | `@bilibili-notify/storage` | `StorageManager` — cookie/key persistence + AES encryption. Zero koishi deps. |
| `packages/push` | `@bilibili-notify/push` | `BilibiliPush` — push routing over a `PushLike` adapter; emits `history-recorded` on each delivery. Zero koishi deps. |
| `packages/subscription` | `@bilibili-notify/subscription` | `SubscriptionStore` — in-memory CRUD over `Subscription[]` + diff emission via `subscription-changed`. Zero koishi deps. |
| `packages/dynamic` | `@bilibili-notify/dynamic` | `DynamicEngine` — dynamic-poll cron + filter + render dispatch. Zero koishi deps. |
| `packages/live` | `@bilibili-notify/live` | `LiveEngine` (split into ListenerManager / DanmakuCollector / WordcloudGenerator / LiveTemplateRenderer / LiveSummaryRequester). Zero koishi deps. |
| `packages/image` | `@bilibili-notify/image` | `ImageRenderer` — Vue/UnoCSS/JSDOM SSR + puppeteer wrapper via `PuppeteerLike` interface. Zero koishi deps. |
| `packages/ai` | `@bilibili-notify/ai` | `CommentaryGenerator` — OpenAI-compatible chat / summary / commentary. Zero koishi deps. |

### Koishi thin shells (`koishi/`)

| Path | npm name | Role |
|---|---|---|
| `koishi/core` | `koishi-plugin-bilibili-notify` | Main koishi plugin entry — `apply()`, ServerManager Service, console UI, login bridge, subscription loader. Wires `BilibiliAPI` + `LoginFlow` from the core. |
| `koishi/dynamic` | `koishi-plugin-bilibili-notify-dynamic` | Wraps `DynamicEngine` with a `PushLike` adapter onto `BilibiliPush`. |
| `koishi/live` | `koishi-plugin-bilibili-notify-live` | Wraps `LiveEngine` with `PushLike` + koishi-`h(...)` `LiveContentBuilder`. |
| `koishi/image` | `koishi-plugin-bilibili-notify-image` | Wraps `ImageRenderer` with a `PuppeteerLike` adapter on `ctx.puppeteer`. Provides `bilibili-notify-image` koishi service. |
| `koishi/ai` | `koishi-plugin-bilibili-notify-ai` | Wraps `CommentaryGenerator`. Provides `bilibili-notify-ai` koishi service. |
| `koishi/advanced-subscription` | `koishi-plugin-bilibili-notify-advanced-subscription` | Advanced subscription schema. Will become a Subscription[] transformer in stage 2. |
| `koishi/runtime` | `@bilibili-notify/koishi-runtime` | Shared `makeKoishiServiceContext` + `makeKoishiMessageBus` adapter helpers. Imported by all 6 koishi shells above. |

All koishi shell packages publish under `koishi-plugin-bilibili-notify*` names; `@bilibili-notify/koishi-runtime` is the only `@bilibili-notify/*`-scoped package living under `koishi/` (it's a koishi-only adapter helper, not core business logic).

## Workspace dependency hygiene

Every workspace `src/` import that resolves to a runtime value (constants, classes, functions) **must** be declared in that package's `package.json` `dependencies`. Type-only imports (`import type`) don't appear in the cjs/mjs output and don't need to be declared.

Concrete example (`c30ef62`): `@bilibili-notify/subscription/src` imported `LIVE_ROOM_MASTERS` (runtime value) from `@bilibili-notify/push` without declaring the dep, breaking at install time when consumer ranges resolved to a push version that no longer exported the constant.

## Config pattern

Each koishi shell separates its koishi `Schema` into its own file:

- `koishi/core/src/config.ts` — `BilibiliNotifyConfig` interface + `BilibiliNotifyConfigSchema`
- `koishi/live/src/config.ts` — `BilibiliNotifyLiveConfig`
- `koishi/dynamic/src/config.ts` — `BilibiliNotifyDynamicConfig` + `BilibiliNotifyDynamicSchema`
- `koishi/advanced-subscription/src/core.ts` — `BilibiliNotifyAdvancedSubConfig` + `applyAdvancedSub`

Each shell's `index.ts` re-exports as the koishi-standard `Config` / `apply`.

## Plugin lifecycle (koishi/core)

`apply()` registers two sub-plugins:

1. **`BilibiliNotifyDataServer`** (`data-server.ts`) — WebSocket bridge to the koishi console UI (handles QR login flow client-side)
2. **`BilibiliNotifyServerManager`** (Service) — orchestrates startup. Internally split across:
   - `app-bootstrap.ts` — Service shell + lifecycle + `getInternals(token)`
   - `lifecycle.ts` — bringUp / tearDown / waitForServices
   - `login-flow-bridge.ts` — wraps `LoginFlow` (from `@bilibili-notify/api`); listens to console `start-login` / `reset-key`; renders QR PNG via `qrcode` dep
   - `subscription-loader.ts` — koishi config → `SubscriptionStore` seeding + `addSub` / `removeSub` / `updateSub` wrappers
   - `health-check.ts` — rate-limited master notify on auth-lost
   - `master-notifier.ts` — `engine-error` consumer; forwards to master DM
   - `target-registry.ts` — in-memory `PushAdapter` + `PushTarget` registry
   - `target-synthesis.ts` — synthesizes targets from koishi-config-sourced inputs
   - `sink.ts` — `KoishiNotificationSink` impl (per-target routing)
   - `config.ts` — `BilibiliNotifyConfig` interface + Schema
   - `types.ts` — shared local types (`InternalsShape` etc.)
   - `commands/` — `bili.ts` / `status.ts` / `sys.ts` koishi command registrations
   - `bootstrap-helpers.ts` — small lifecycle helpers

## MessageBus ↔ koishi event semantics

`@bilibili-notify/koishi-runtime` provides:

- `makeKoishiServiceContext(ctx, name, logLevel?)` — wraps `Context` as a `ServiceContext` (logger / setInterval / setTimeout / onDispose)
- `makeKoishiMessageBus(ctx)` — wraps `Context` as a `MessageBus`. Internally:
  - `bus.emit("X", payload)` ≡ `ctx.emit("bilibili-notify/X", payload)`
  - `bus.on("X", h)` ≡ `ctx.on("bilibili-notify/X", h)`

**Critical**: bus and ctx are two views of the same event channel. Never write a "bus.on(X) → ctx.emit(bilibili-notify/X)" or "ctx.on(bilibili-notify/X) → bus.emit(X)" forwarder — that creates a self-feeding loop and stack-overflows. (Regression test: `koishi/runtime/src/__tests__/message-bus.test.ts`.) Anything that listens via `ctx.on("bilibili-notify/...")` already sees the core's `bus.emit` for free.

## Service dependency graph

```
BilibiliAPI        (in @bilibili-notify/api, also exposed as bilibili-notify Service via core's getInternals)
BilibiliPush       (in @bilibili-notify/push; constructed inside the host shell, fed a PushLike adapter)
SubscriptionStore  (in @bilibili-notify/subscription; in-memory authority over Subscription[])

# Koishi shells consume the engines via direct construction
koishi/dynamic   → DynamicEngine({ api, push: PushLike, image?, ai?, ... })   requires bilibili-notify
koishi/live      → LiveEngine({ api, push, contentBuilder, image?, ai?, ... }) requires bilibili-notify; optional image/ai
koishi/image     → ImageRenderer({ puppeteer: PuppeteerLike, ... })            requires puppeteer; provides bilibili-notify-image
koishi/ai        → CommentaryGenerator({ api, ... })                            requires bilibili-notify
koishi/advanced-subscription → emits bilibili-notify/advanced-sub{,-adapters,-targets} events
```

## Cross-plugin events (BiliEvents)

The canonical event contract lives in `packages/internal/src/platform.ts#BiliEvents`. Koishi adapter
bridges every event onto `ctx.emit("bilibili-notify/<event>")`; standalone wires the same events
straight onto WS channels.

- `login-status-report` — emitted by `LoginFlow`; consumed by Koishi console UI + standalone `auth` WS channel
- `auth-lost` / `auth-restored` — login state transitions (rate-limited master notify)
- `cookies-refreshed` — triggers cookie persistence
- `subscription-changed` — `SubscriptionOp[]` diff emitted by `SubscriptionStore` after CRUD
- `config-changed` — emitted by standalone `ConfigStore` after a write; scope ∈ `globals|subscriptions|targets|adapters|secrets`. Engines reconcile cron / refresh state on this.
- `engine-error` — `(source, message)` runtime error from an engine/subsystem. Replaces the old `plugin-error`. Consumed by `master-notifier` (Koishi → master DM) and `log` WS channel (standalone → AlertShell)
- `history-recorded` — full `HistoryEntry` emitted by `BilibiliPush` after each delivery; standalone forwards on `push-events` WS channel
- `live-state-changed` — `(uid, "live"|"idle")` open/close transition from `LiveEngine`
- `live-viewers-changed` — `(uid, viewers)` per-uid 2s-throttled `WATCHED_CHANGE` frame from `room-session`
- `fans-refreshed` — full `FansRefreshEntry[]` snapshot per tick of the standalone `FansPoller`
- `ready` — business core fully booted
- Koishi-only signaling events (not part of `BiliEvents`, raw `ctx.emit`):
  - `ready-to-receive` — Koishi core signals subscription-loader ready for `advanced-sub` payloads
  - `advanced-sub` / `advanced-sub-adapters` / `advanced-sub-targets` — advanced-subscription Schema → main `SubscriptionStore`

## Toolchain

- **tsdown** — builds each package to ESM (`.mjs`) + CJS (`.cjs`) with declaration files
- **Biome** — linter + formatter (tab indent, 100-char line width). Vue files in lint scope.
- **Lefthook** — pre-commit runs `biome check --staged --write` on staged ts/js/mjs/json files
- **Vitest** — unit tests (`vp test run`)
- **Changesets** — release tooling. `updateInternalDependencies: "patch"` only **syncs version ranges in `package.json`** for downstream consumers; it does **not** automatically include publishable downstream packages in the release. When a change in package A affects the runtime behavior of publishable package B, B must be listed explicitly in the changeset frontmatter.

## Console UI (Koishi)

`koishi/core/client/` contains the Koishi console frontend (Vue-based). Loaded via:

- Dev: `resolve(__dirname, "../client/index.ts")`
- Prod: `resolve(__dirname, "../dist")`

The standalone end uses a separate React + Vite dashboard under `apps/web/`; these don't share UI code.

## Standalone dashboard (`apps/`)

Two sub-packages share the root pnpm workspace:

- `apps/server` — Hono HTTP + WS gateway. Single tsdown bundle to `apps/server/lib/index.mjs`.
- `apps/web` — Vite + React 19 + Tailwind 4 + tanstack-query + zustand + react-router-dom. Charts (StatsBar / Donut) are hand-drawn SVG, no chart library. Served as static assets by `apps/server` in prod; `vp run dev:web` for the Vite dev server in dev.

### apps/server module map

```
src/
  index.ts              ← CLI / bootstrap entry
  app.ts                ← Hono app composition + basic-auth + route mounting
  auth/                 ← QR + cookie state via @bilibili-notify/api LoginFlow
  config/               ← ConfigStore: tmpfile+rename atomic writes to <dataDir>/state/*.json + emits config-changed
  runtime/
    bootstrap.ts        ← AppRuntime container (api/storage/push/store/engines/fansPoller/...)
    service-context.ts  ← NodeServiceContext (pino + setInterval/setTimeout/onDispose)
    message-bus.ts      ← NodeMessageBus (mitt-like BiliEvents emitter)
    subscription-store.ts ← Wires SubscriptionStore over the in-process MessageBus
    content-builder.ts  ← Plain-text NotificationPayload builder (no koishi h(...))
    engines.ts          ← Hot-reload engine wiring; consumes config-changed to swap dynamicCron + reseed templates without restart
    fans-poller.ts      ← FansPoller — follows globals.app.dynamicCron, writes <dataDir>/fans/<uid>.jsonl, emits fans-refreshed
    master-notifier.ts  ← Forwards engine-error to master target as DM
    puppeteer.ts        ← puppeteer-core adapter for cards preview
  fans/store.ts         ← append-only jsonl time-series + findNearestBefore(uid, ts)
  history/
    store.ts            ← HistoryStore — <dataDir>/history/<YYYY-MM-DD>.jsonl with uname/avatar snapshots
    retention.ts        ← daily sweep dropping files older than globals.app.historyRetentionDays
  logs/
    store.ts            ← LogStore — buffered jsonl-by-day <dataDir>/logs/<YYYY-MM-DD>.jsonl; unconditional ingest (level gating is upstream in service-context fanOut), ~1s/100-batch flush, final-flush on serviceCtx dispose
    retention.ts        ← daily sweep dropping files older than globals.app.logRetentionDays
    redact.ts           ← credential scrub (SESSDATA/bili_jct/refresh_token/sk-/Bearer) — single fan-out point
    sink.ts             ← createLogSink: redact ONCE → tee to WS ring (live tail) + LogStore (archive); both get exactly what passed the upstream service-context fanOut level gate
  routes/               ← REST: auth, subs, targets, adapters, globals, history, logs, fans, live, cards, push, health
  ws/
    server.ts           ← ws upgrade + per-conn channel filter
    channels.ts         ← bridges BiliEvents → 4 channels: auth / push-events / log / state
    log-channel.ts      ← in-memory ring buffer (WS live tail)
  sink/                 ← NotificationSink dispatch over PushTarget.id → platform adapter
  platforms/            ← OneBot v11 + Webhook + WebDashboard adapters
```

### WS channel contract

Envelope: `{ type: <channel>, event: <name>, data: <args> }`. Single-arg events unwrap to the arg
itself; multi-arg events serialize as a tuple.

| Channel | Source | Frontend consumer |
|---|---|---|
| `auth` | `login-status-report` | `useAuthChannel` → QR / login state |
| `push-events` | `history-recorded` / `live-state-changed` / `live-viewers-changed` / `fans-refreshed` | `usePushEventsChannel` → tanstack-query `setQueryData` patches |
| `log` | `engine-error` + every `logger.<level>` (redacted at the single fan-out, also archived to LogStore jsonl) | `useAlertChannel` (engine-error → AlertShell) **and** `useLogChannel` (full stream → Logs tab) |
| `state` | runtime health snapshots | `useStateChannel` |

### apps/web layout

```
src/
  pages/        ← Dashboard / Subs / Targets / History / Rules / Cards / Ai / System / Logs
  components/   ← Shared atoms (Avatar/Btn/Pill/...) + icons
  hooks/        ← useAuthChannel / usePushEventsChannel / useAlertChannel / useLogChannel / useStateChannel / useAuthHydrate / useBackendReachable
  services/     ← HTTP client (services/api.ts) + typed wrappers (services/dashboard.ts)
  store/        ← zustand for transient UI state; tanstack-query cache for server state
  styles.css    ← Tailwind 4 @theme tokens + bn-anim-* keyframes + bn-no-scrollbar
```

Page-level state is owned by tanstack-query; WS push frames patch the cache via `setQueryData` so
no extra HTTP round-trips are needed for live updates.

## Branch model

Single trunk + three coexisting top-level directories (`packages/`, `koishi/`, `apps/`). No fork into per-product branches.

- `main` — frozen old release snapshot (last published koishi-only build). Receives a merge from `refactor` only when cutting an npm release.
- `refactor` — active development trunk. All `packages/`, `koishi/`, and `apps/` changes land here.

Both product forms ship from `refactor` continuously:
- Koishi side publishes to npm via `changesets` — touches `packages/*` and `koishi/*`.
- Standalone side ships as a docker image on Docker Hub (`akokk0/bilibili-notify`) — touches `apps/*`. Never published to npm.

`apps/` shares the single root pnpm workspace with `packages/` and `koishi/`. apps/server consumes business cores via `workspace:*`. With `nodeLinker: hoisted` set in `pnpm-workspace.yaml` (pnpm 11 reads it from there, not `.npmrc`), the layout matches yarn-classic's flat `node_modules` so koishi's plugin loader keeps working.

Earlier plan iterations described splitting `koishi/` and `standalone/` into separate long-lived branches with one-way merges from `refactor`. **That model has been dropped** — single-trunk maintenance is simpler, debugging is faster (one commit fixes both ends), and the directory split + pnpm isolation already gives sufficient separation.

### Docker image (standalone)

`apps/Dockerfile` (multi-stage: builder runs `pnpm install` + `pnpm -r run build` over the whole monorepo → runtime is `node:24-bookworm-slim` + chromium + tini, carrying only built artifacts + prod deps). The builder deliberately uses **corepack-provisioned pnpm, not vp** — an intentional, documented exception to the repo's vp-everywhere toolchain, mirroring the `publish.yml` corepack carve-out (corepack ships free in the node base image; vp has no Docker bootstrap action like setup-vp; both resolve the same pinned pnpm so artifacts are byte-identical). Don't "fix" it to vp without re-evaluating the bootstrap cost.

**Build context MUST be the repo root, not `apps/`** — apps/server depends on `packages/*` via the pnpm `workspace:*` protocol, so `apps/` alone can't resolve them. Manual build from the repo root:

```bash
docker build -f apps/Dockerfile -t bilibili-notify:dev .
```

`.github/workflows/image-release.yml` pushes to `docker.io/akokk0/bilibili-notify` on `refactor`/`main` + `image-v*.*.*` tags; auth via `DOCKERHUB_TOKEN` repo secret. `apps/docker-compose.example.yaml` is the deploy template. No changeset needed for `apps/*`-only changes.

## Agent skills

### Issue tracker

GitHub Issues at `Akokk0/bilibili-notify`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). Only `wontfix` exists in the repo today; the other four need `gh label create` before first use (commands in `docs/agents/triage-labels.md`).

### Domain docs

Single-context repo. `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/grill-with-docs` once terms or decisions actually get resolved). See `docs/agents/domain.md`.
