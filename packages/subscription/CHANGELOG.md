# Changelog

## 1.0.2

### Patch Changes

- 11deaba: Fix `Cannot read properties of undefined (reading 'some')` on remote
  installs by declaring `@bilibili-notify/subscription`'s runtime
  dependencies on `@bilibili-notify/api` and `@bilibili-notify/push`.

  `subscription/src` imports `LIVE_ROOM_MASTERS` from
  `@bilibili-notify/push` (a runtime value) and types from
  `@bilibili-notify/api`, but the package's `dependencies` field on npm
  was empty — a classic phantom dependency. The package only ran
  because consumers (core / live / dynamic / advanced-subscription)
  happened to install push themselves; if any consumer's `^1.0.0` range
  resolved to push@1.0.0 (which predates the `LIVE_ROOM_MASTERS`
  export, added in 1.0.1), subscription would crash at startup with
  `Cannot read properties of undefined (reading 'some')` from
  `needsLiveRoom`.

  Subscription now declares both deps explicitly via `workspace:^` so
  the published metadata pins compatible versions regardless of which
  consumer triggered installation. `api` is technically type-only at
  runtime but appears in subscription's `.d.ts` public surface, so
  declaring it avoids type-resolution errors for TS consumers too.

  All publishable packages that depend on subscription are bumped at
  the same time so updating users get a fresh resolution pass and
  existing lockfiles can no longer hold push at a
  `LIVE_ROOM_MASTERS`-less version.

## 1.0.1

### Patch Changes

- 9f51aa6: Fix `roomId must be Number` crash when only non-`live` live-room features are enabled.

  After the master switch refactor the live listener fires whenever any live-room feature (`liveEnd`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`, or the special user/danmaku configs) is on, but `subscription` was still resolving `roomId` only when `sub.live` was true. A configuration like `live=false` + `wordcloud=true` therefore left `roomId` empty and `tiny-bilibili-ws` rejected the listener with `roomId must be Number`.

  - `@bilibili-notify/push` — export `LIVE_ROOM_MASTERS` / `LiveRoomMaster` as the shared list of masters that imply needing the live-room WS. Used by `subscription` and `live` to stay in sync.
  - `@bilibili-notify/subscription` — `addEntry` / `loadSubscriptions` now resolve `roomId` whenever any live-room master or `customSpecial*.enable` is on. When the UP has no live room, every live-room master and both `customSpecial*.enable` flags are turned off so downstream `needsLiveMonitor` stays false.
  - `koishi-plugin-bilibili-notify-live` — `needsLiveMonitor` reuses `LIVE_ROOM_MASTERS`, and `startLiveRoomListener` rejects an empty / non-numeric `roomId` defensively instead of forwarding `NaN` to `tiny-bilibili-ws`.

## 1.0.0

### Major Changes

- 28d9700: Centralize per-feature configuration around a single source-of-truth list and decouple every notification type into an independent sub-level master switch.

  Breaking (internal type consumers):

  - `@bilibili-notify/push` — `PushArrEntry` keys lost the `Arr` suffix (e.g. `liveAtAllArr` → `liveAtAll`) and `SubItem` now extends `SubItemMasters` so it carries 9 required master booleans (`dynamic`, `dynamicAtAll`, `live`, `liveAtAll`, `liveEnd`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`). New exports: `PUSH_FEATURES`, `MASTER_FEATURES`, `PushFeature`, `MasterFeature`, `SubItemMasters`, `PushArrEntry`, `PushType.LiveEnd`.
  - `@bilibili-notify/subscription` — `FlatSubConfigItem` now extends `SubItemMasters`; consumers building it manually must include `liveEnd`.

  Behavior:

  - `koishi-plugin-bilibili-notify` — basic schema gains a `liveEnd` boolean per row (default `true`), and the AI-controlled `addSub` / `updateSub` APIs accept it.
  - `koishi-plugin-bilibili-notify-advanced-subscription` — every UP now has independent sub-level master switches for `dynamicAtAll`, `liveAtAll`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`; channel rows gain a `liveEnd` toggle. A disabled sub-level master suppresses the feature for every channel, regardless of channel-level flags.
  - `koishi-plugin-bilibili-notify-live` — handler hot paths (SC card, guard card, wordcloud collection, etc.) early-return when the corresponding master+target is empty, eliminating wasted rendering. Live-end card is routed through the new `target.liveEnd`, decoupled from `target.live`. Wordcloud and live summary fire independently of `liveEnd`. The WS listener is now started whenever any live-room feature requires it (not just `live`), and incremental subscription updates re-evaluate this on every change including target-only edits.

## 0.0.2

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- 40ebcbc: All bump
- 00a51a3: Code review fixes (P0/P1/P2/P3):

  - core: correct WBI `wts` timestamp; restrict `request-cors` to bilibili/hdslb hosts; switch SubItem diff to `isDeepStrictEqual`; require explicit `isReload`; reject empty cookies on login success.
  - api: drop the `cacheable-lookup` integration that was conflicting with `axios-cookiejar-support` and breaking startup; warn on cookie-refresh `-101`; correct `validateCaptcha` return type; pin ticket cron to `Asia/Shanghai`; remove unused `getCORSContent`.
  - storage: write the master key atomically (`.tmp` + rename) so a crash mid-write can no longer orphan encrypted cookies.
  - live: extract `handleLiveEnd` so polling fallback now also sends wordcloud/summary; always clear danmaku records regardless of `liveEnd`; close listener on post-init failure; scope `stopMonitoring` to a single room; wrap fire-and-forget broadcasts; narrow `INTERACT_WORD_V2` typing.
  - dynamic: advance timeline on filter-blocked items so notifications are not repeated; soft-fail image render with one-shot admin notification instead of permanently stopping the cron.
  - push: rewrite send-retry with proper online-first bot rotation, transport-error detection, and a bounded `pushArrMapReady` wait; relax `MasterConfig` shape and validate at runtime instead of casting.
  - subscription: extract `parseChannels` / `buildTargetFromFlat` / `defaultCustomFields` / `pushArrEntryFromTarget` helpers; accept explicit `isReload` flag; format `Error` messages cleanly.
  - advanced-subscription: collapse the 10 channel-flag if-blocks into a `CHANNEL_FIELDS` loop with a `satisfies` assertion.

## 0.0.2-beta.2

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`

## 0.0.2-beta.1

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

## 0.0.2-alpha.0

### Patch Changes

- 40ebcbc: All bump

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- `SubscriptionManager` — 订阅加载、重载、`PushArrMap` 构建
- `FlatSubConfigItem` 类型定义及 `fromFlatConfig` 转换方法
- 新增订阅时自动查询直播间号、关注 UP 主
