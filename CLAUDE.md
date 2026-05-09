# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Yarn workspace monorepo for the Bilibili-Notify project. Two product forms share a single platform-neutral business core:

- **Koishi sub-plugins** (under `koishi/`) — historical / current shipping form, npm-published as `koishi-plugin-bilibili-notify*`
- **Standalone Hono + React dashboard** (under `apps/`) — primary product form going forward

Both ends consume the same `@bilibili-notify/*` core packages.

## Commands

```bash
yarn install
yarn build                          # tsdown -W (all packages, watch)
yarn workspace koishi-plugin-bilibili-notify build   # build a single package
yarn typecheck                      # tsc --noEmit across the workspace
yarn run test                       # vitest, all packages

# Lint / format (Biome)
yarn lint           # check only
yarn lint:fix       # auto-fix
yarn format         # auto-format
yarn check          # lint + format check
yarn check:fix      # lint + format auto-fix

# Git hooks (Lefthook) installed automatically on yarn install
# Pre-commit: yarn check:fix (full repo), then biome check --staged --write on *.ts, *.js, *.json
```

## Top-level layout

```
packages/   ← platform-neutral business core (@bilibili-notify/*)
koishi/     ← Koishi thin-shell plugins (koishi-plugin-bilibili-notify*)
apps/       ← Hono server + React dashboard (pnpm sub-workspace)
```

Yarn workspaces glob: `["packages/*", "koishi/*"]`. `apps/` has its own pnpm sub-workspace and is intentionally invisible to the root yarn install — see "Branch model" below for why.

**Path constraint**: never put the substring `bilibili-notify` in any directory under `koishi/` — Koishi's plugin loader gets confused. The koishi main plugin lives at `koishi/core/`, not `koishi/bilibili-notify/`. The npm name `koishi-plugin-bilibili-notify` is decoupled from the directory name (set in package.json's `name`).

## Package inventory

### Platform-neutral business core (`packages/`)

| Path | npm name | Role |
|---|---|---|
| `packages/internal` | `@bilibili-notify/internal` | Zod schemas (Subscription / PushTarget / GlobalConfig / HistoryEntry) + platform interfaces (ServiceContext / MessageBus / NotificationSink / NotificationPayload) + utils (withLock, retry, interpolate). Zero koishi deps. |
| `packages/api` | `@bilibili-notify/api` | `BilibiliAPI` (HTTP + WBI signing) + `LoginFlow` (QR + cookie state machine). Constructed with `{ serviceCtx, ... }`. Zero koishi deps. |
| `packages/storage` | `@bilibili-notify/storage` | `StorageManager` — cookie/key persistence + AES encryption. Zero koishi deps. |
| `packages/push` | `@bilibili-notify/push` | `BilibiliPush` — push routing (still has koishi peer dep; refactor pending in stage 2). |
| `packages/subscription` | `@bilibili-notify/subscription` | `SubscriptionManager` — current koishi-tainted form; will be rewritten as `SubscriptionStore` consuming `Subscription[]` in stage 2. |
| `packages/dynamic` | `@bilibili-notify/dynamic` | `DynamicEngine` — dynamic-poll cron + filter + render dispatch. Zero koishi deps. |
| `packages/live` | `@bilibili-notify/live` | `LiveEngine` (split into ListenerManager / DanmakuCollector / WordcloudGenerator / TemplateRenderer / LiveSummaryRequester). Zero koishi deps. |
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
- `koishi/advanced-subscription/src/advanced-subscription.ts` — `BilibiliNotifyAdvancedSubConfig` + `applyAdvancedSub`

Each shell's `index.ts` re-exports as the koishi-standard `Config` / `apply`.

## Plugin lifecycle (koishi/core)

`apply()` registers two sub-plugins:

1. **`BilibiliNotifyDataServer`** — WebSocket bridge to the koishi console UI (handles QR login flow client-side)
2. **`BilibiliNotifyServerManager`** (Service) — orchestrates startup. Internally split across:
   - `app-bootstrap.ts` — Service shell + lifecycle + `getInternals(token)`
   - `lifecycle.ts` — bringUp / tearDown / waitForServices
   - `login-flow-bridge.ts` — wraps `LoginFlow` (from `@bilibili-notify/api`); listens to console `start-login` / `reset-key`; renders QR PNG via `qrcode` dep
   - `subscription-loader.ts` — config → `SubscriptionManager` init + `addSub` / `removeSub` / `updateSub` wrappers
   - `subscription-crud.ts` — pure CRUD on a snapshot
   - `health-check.ts` — rate-limited master notify on auth-lost
   - `master-notifier.ts` — `bilibili-notify/plugin-error` log
   - `bootstrap-helpers.ts` / `sub-diff.ts` — small helpers

## MessageBus ↔ koishi event semantics

`@bilibili-notify/koishi-runtime` provides:

- `makeKoishiServiceContext(ctx, name, logLevel?)` — wraps `Context` as a `ServiceContext` (logger / setInterval / setTimeout / onDispose)
- `makeKoishiMessageBus(ctx)` — wraps `Context` as a `MessageBus`. Internally:
  - `bus.emit("X", payload)` ≡ `ctx.emit("bilibili-notify/X", payload)`
  - `bus.on("X", h)` ≡ `ctx.on("bilibili-notify/X", h)`

**Critical**: bus and ctx are two views of the same event channel. Never write a "bus.on(X) → ctx.emit(bilibili-notify/X)" or "ctx.on(bilibili-notify/X) → bus.emit(X)" forwarder — that creates a self-feeding loop and stack-overflows. (Regression test: `koishi/runtime/src/__tests__/message-bus.test.ts`.) Anything that listens via `ctx.on("bilibili-notify/...")` already sees the core's `bus.emit` for free.

## Service dependency graph

```
BilibiliAPI         (in @bilibili-notify/api, also exposed as bilibili-notify Service via core's getInternals)
BilibiliPush        (still koishi-tainted; service: bilibili-notify-push)
SubscriptionManager (still koishi-tainted; injected into push)

# Koishi shells consume the engines via direct construction
koishi/dynamic   → DynamicEngine({ api, push: PushLike, image?, ai?, ... })   requires bilibili-notify
koishi/live      → LiveEngine({ api, push, contentBuilder, image?, ai?, ... }) requires bilibili-notify; optional image/ai
koishi/image     → ImageRenderer({ puppeteer: PuppeteerLike, ... })            requires puppeteer; provides bilibili-notify-image
koishi/ai        → CommentaryGenerator({ api, ... })                            requires bilibili-notify
koishi/advanced-subscription → emits bilibili-notify/advanced-sub event
```

## Cross-plugin koishi events

Custom events declared on `Context` (prefix `bilibili-notify/`):

- `login-status-report` — emitted by `LoginFlow` via MessageBus, consumed by `BilibiliNotifyDataServer`
- `auth-lost` / `auth-restored` — login state transitions
- `cookies-refreshed` — triggers cookie persistence
- `advanced-sub` — advanced-subscription schema → main subscription manager
- `ready-to-receive` / `ready` — startup signals
- `subscription-changed` — subscription list updated
- `plugin-error` — error report from sub-plugins

## Toolchain

- **tsdown** — builds each package to ESM (`.mjs`) + CJS (`.cjs`) with declaration files
- **Biome** — linter + formatter (tab indent, 100-char line width). Vue files in lint scope.
- **Lefthook** — pre-commit runs `yarn check:fix` (full repo) then `biome check --staged --write`
- **Vitest** — unit tests (`yarn run test`)
- **Changesets** — release tooling. `updateInternalDependencies: "patch"` only **syncs version ranges in `package.json`** for downstream consumers; it does **not** automatically include publishable downstream packages in the release. When a change in package A affects the runtime behavior of publishable package B, B must be listed explicitly in the changeset frontmatter.

## Console UI (Koishi)

`koishi/core/client/` contains the Koishi console frontend (Vue-based). Loaded via:

- Dev: `resolve(__dirname, "../client/index.ts")`
- Prod: `resolve(__dirname, "../dist")`

The standalone end uses a separate React + Vite dashboard under `apps/web/`; these don't share UI code.

## Branch model

Single trunk + three coexisting top-level directories (`packages/`, `koishi/`, `apps/`). No fork into per-product branches.

- `main` — frozen old release snapshot (last published koishi-only build). Receives a merge from `refactor` only when cutting an npm release.
- `refactor` — active development trunk. All `packages/`, `koishi/`, and `apps/` changes land here.

Both product forms ship from `refactor` continuously:
- Koishi side publishes to npm via `changesets` — touches `packages/*` and `koishi/*`.
- Standalone side ships as a docker / GHCR image — touches `apps/*`. Never published to npm.

`apps/` is a separate pnpm sub-workspace and is invisible to the root yarn workspace, so its heavyweight deps (Hono, ws, Vite, etc.) do not pollute koishi-end installs. Business core packages reach it via pnpm `link:` to `../../packages/*`.

Earlier plan iterations described splitting `koishi/` and `standalone/` into separate long-lived branches with one-way merges from `refactor`. **That model has been dropped** — single-trunk maintenance is simpler, debugging is faster (one commit fixes both ends), and the directory split + pnpm isolation already gives sufficient separation.
