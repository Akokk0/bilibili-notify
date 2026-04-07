# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Yarn workspace monorepo for **koishi-plugin-bilibili-notify** — a [Koishi](https://koishi.chat/) chatbot plugin for Bilibili live stream and dynamic post notifications. It publishes multiple npm packages, each as a separate Koishi plugin.

## Commands

```bash
# Install dependencies
yarn install

# Build all packages (watch mode)
yarn build          # tsdown -W

# Build a single package
yarn workspace koishi-plugin-bilibili-notify build

# Type check all packages in parallel
yarn typecheck

# Lint / format (Biome)
yarn lint           # check only
yarn lint:fix       # auto-fix
yarn format         # auto-format
yarn check          # lint + format check
yarn check:fix      # lint + format auto-fix

# Git hooks (Lefthook) are installed automatically on yarn install
# Pre-commit: biome check --staged --write on *.ts, *.js, *.json
```

No test scripts are configured in this project.

## Architecture

### Package Structure

| Package (workspace path) | Published Name | Role |
|---|---|---|
| `packages/core` | `koishi-plugin-bilibili-notify` | **Main plugin** — entry point, config schema, lifecycle orchestration |
| `packages/api` | `@bilibili-notify/api` (internal) | Bilibili HTTP API client (WBI signing, cookie auth) |
| `packages/storage` | `@bilibili-notify/storage` (internal) | Cookie/key persistence on disk |
| `packages/push` | `@bilibili-notify/push` (internal) | Push routing — maps subscriptions to Koishi sessions |
| `packages/subscription` | `@bilibili-notify/subscription` (internal) | Subscription manager — loads/reloads SubItem map, builds PushArrMap |
| `packages/internal` | `@bilibili-notify/internal` (internal) | Shared constants (e.g. BILIBILI_NOTIFY_TOKEN) |
| `packages/dynamic` | `koishi-plugin-bilibili-notify-dynamic` | Optional: dynamic post polling via cron |
| `packages/live` | `koishi-plugin-bilibili-notify-live` | Optional: live stream monitoring via WebSocket |
| `packages/image` | `koishi-plugin-bilibili-notify-image` | Optional: card image rendering via Puppeteer/jsdom |
| `packages/advanced-subscription` | `koishi-plugin-bilibili-notify-advanced-subscription` | Optional: fine-grained per-UP subscription config |

Internal packages (`@bilibili-notify/*`) have `"private": true` and are not published to npm — they are workspace dependencies only.

### Config pattern

Each published plugin separates config into its own file:
- `packages/core/src/config.ts` — exports `BilibiliNotifyConfig` interface + `BilibiliNotifyConfigSchema`
- `packages/live/src/config.ts` — exports `BilibiliNotifyLiveConfig` (interface + Schema, same name, declaration merge)
- `packages/dynamic/src/config.ts` — exports `BilibiliNotifyDynamicConfig` interface + `BilibiliNotifyDynamicSchema`
- `packages/advanced-subscription/src/advanced-subscription.ts` — exports `BilibiliNotifyAdvancedSubConfig` + `applyAdvancedSub`

Each `index.ts` re-exports these as the Koishi-standard `Config` type + value and `apply` function.

### Plugin Lifecycle (main package)

`apply()` → registers two sub-plugins:
1. **`BilibiliNotifyDataServer`** — WebSocket bridge between Koishi console UI and the backend (handles QR login flow)
2. **`BilibiliNotifyServerManager`** (Service) — orchestrates startup:
   - Initializes `StorageManager` (reads cookies/keys from disk)
   - Registers `BilibiliAPI`, `BilibiliPush`, and `SubscriptionManager` as child plugins
   - Listens for `bilibili-notify/cookies-refreshed` to persist refreshed cookies

### Service dependency graph

```
BilibiliNotifyServerManager
  ├── BilibiliAPI          (service: bilibili-notify-api)
  ├── BilibiliPush         (service: bilibili-notify-push)
  └── SubscriptionManager  (wires subscriptions → api/push)

# Optional plugins (installed separately by user)
koishi-plugin-bilibili-notify-dynamic   → requires bilibili-notify-api, bilibili-notify-push
koishi-plugin-bilibili-notify-live      → requires bilibili-notify-api, bilibili-notify-push; optionally bilibili-notify-image
koishi-plugin-bilibili-notify-image     → requires puppeteer; provides bilibili-notify-image service
koishi-plugin-bilibili-notify-advanced-subscription → emits bilibili-notify/advanced-sub event
```

### Koishi Events (inter-plugin communication)

Custom events declared on the Koishi `Context`:
- `bilibili-notify/login-status-report` — login QR/status from API to DataServer
- `bilibili-notify/advanced-sub` — advanced subscription config from advanced-subscription plugin
- `bilibili-notify/ready-to-receive` — signals push system is ready
- `bilibili-notify/cookies-refreshed` — triggers cookie persistence
- `bilibili-notify/subscription-changed` — subscription list updated
- `bilibili-notify/ready` — BilibiliAPI fully initialized
- `bilibili-notify/plugin-error` — error report from sub-plugins (source, message)

### Toolchain

- **tsdown** — builds each package to both ESM (`.mjs`) and CJS (`.cjs`) with declaration files
- **Biome** — linter and formatter (tab indentation, 100-char line width). Vue files are included in lint scope
- **Lefthook** — pre-commit hook runs `biome check --staged --write`

### Console UI (client)

`packages/core/client/` contains the Koishi console frontend (Vue-based). It is loaded via:
- Dev: `resolve(__dirname, "../client/index.ts")`
- Prod: `resolve(__dirname, "../dist")`
