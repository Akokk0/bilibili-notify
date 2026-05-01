# Changelog

## 4.1.0

### Minor Changes

- 28d9700: Centralize per-feature configuration around a single source-of-truth list and decouple every notification type into an independent sub-level master switch.

  Breaking (internal type consumers):

  - `@bilibili-notify/push` — `PushArrEntry` keys lost the `Arr` suffix (e.g. `liveAtAllArr` → `liveAtAll`) and `SubItem` now extends `SubItemMasters` so it carries 9 required master booleans (`dynamic`, `dynamicAtAll`, `live`, `liveAtAll`, `liveEnd`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`). New exports: `PUSH_FEATURES`, `MASTER_FEATURES`, `PushFeature`, `MasterFeature`, `SubItemMasters`, `PushArrEntry`, `PushType.LiveEnd`.
  - `@bilibili-notify/subscription` — `FlatSubConfigItem` now extends `SubItemMasters`; consumers building it manually must include `liveEnd`.

  Behavior:

  - `koishi-plugin-bilibili-notify` — basic schema gains a `liveEnd` boolean per row (default `true`), and the AI-controlled `addSub` / `updateSub` APIs accept it.
  - `koishi-plugin-bilibili-notify-advanced-subscription` — every UP now has independent sub-level master switches for `dynamicAtAll`, `liveAtAll`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`; channel rows gain a `liveEnd` toggle. A disabled sub-level master suppresses the feature for every channel, regardless of channel-level flags.
  - `koishi-plugin-bilibili-notify-live` — handler hot paths (SC card, guard card, wordcloud collection, etc.) early-return when the corresponding master+target is empty, eliminating wasted rendering. Live-end card is routed through the new `target.liveEnd`, decoupled from `target.live`. Wordcloud and live summary fire independently of `liveEnd`. The WS listener is now started whenever any live-room feature requires it (not just `live`), and incremental subscription updates re-evaluate this on every change including target-only edits.

### Patch Changes

- Updated dependencies [28d9700]
  - @bilibili-notify/push@1.0.0
  - @bilibili-notify/subscription@1.0.0

## 4.0.0

### Patch Changes

- 2d08a6e: feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

  fix(live): fix word cloud and live summary not sent when AI is disabled

  refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- eeaca8f: Fix client-side TypeScript type errors
- 8f47115: Add console client build
- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

- 40ebcbc: All bump
- cc1455e: Change build tool to yakumo for console
- 00a51a3: Code review fixes (P0/P1/P2/P3):

  - core: correct WBI `wts` timestamp; restrict `request-cors` to bilibili/hdslb hosts; switch SubItem diff to `isDeepStrictEqual`; require explicit `isReload`; reject empty cookies on login success.
  - api: drop the `cacheable-lookup` integration that was conflicting with `axios-cookiejar-support` and breaking startup; warn on cookie-refresh `-101`; correct `validateCaptcha` return type; pin ticket cron to `Asia/Shanghai`; remove unused `getCORSContent`.
  - storage: write the master key atomically (`.tmp` + rename) so a crash mid-write can no longer orphan encrypted cookies.
  - live: extract `handleLiveEnd` so polling fallback now also sends wordcloud/summary; always clear danmaku records regardless of `liveEnd`; close listener on post-init failure; scope `stopMonitoring` to a single room; wrap fire-and-forget broadcasts; narrow `INTERACT_WORD_V2` typing.
  - dynamic: advance timeline on filter-blocked items so notifications are not repeated; soft-fail image render with one-shot admin notification instead of permanently stopping the cron.
  - push: rewrite send-retry with proper online-first bot rotation, transport-error detection, and a bounded `pushArrMapReady` wait; relax `MasterConfig` shape and validate at runtime instead of casting.
  - subscription: extract `parseChannels` / `buildTargetFromFlat` / `defaultCustomFields` / `pushArrEntryFromTarget` helpers; accept explicit `isReload` flag; format `Error` messages cleanly.
  - advanced-subscription: collapse the 10 channel-flag if-blocks into a `CHANNEL_FIELDS` loop with a `satisfies` assertion.

- 9414097: Remove roomid from subscription config
- 2a11604: Alpha
- 921f0ad: Workspace replace
- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [beac16c]
- Updated dependencies [76b1f79]
- Updated dependencies [ed0e7c9]
- Updated dependencies [8b6aa5a]
- Updated dependencies [40ebcbc]
- Updated dependencies [a9b2cca]
- Updated dependencies [00a51a3]
  - @bilibili-notify/api@0.0.2
  - @bilibili-notify/push@0.0.2
  - @bilibili-notify/storage@0.0.2
  - @bilibili-notify/subscription@0.0.2
  - @bilibili-notify/internal@0.0.2

## 4.0.0-beta.12

### Patch Changes

- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot

## 4.0.0-beta.11

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- Updated dependencies [beac16c]
  - @bilibili-notify/api@0.0.2-beta.4
  - @bilibili-notify/push@0.0.2-beta.3
  - @bilibili-notify/storage@0.0.2-beta.1
  - @bilibili-notify/subscription@0.0.2-beta.2

## 4.0.0-beta.10

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- Updated dependencies [76b1f79]
  - @bilibili-notify/api@0.0.2-beta.3
  - @bilibili-notify/push@0.0.2-beta.2
  - @bilibili-notify/subscription@0.0.2-beta.1

## 4.0.0-beta.9

### Patch Changes

- 2d08a6e: feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

  fix(live): fix word cloud and live summary not sent when AI is disabled

  refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition

## 4.0.0-beta.8

### Patch Changes

- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

- Updated dependencies [8b6aa5a]
  - @bilibili-notify/api@0.0.2-beta.2
  - @bilibili-notify/push@0.0.2-beta.1

## 4.0.0-alpha.7

### Patch Changes

- cc1455e: Change build tool to yakumo for console

## 4.0.0-alpha.6

### Patch Changes

- eeaca8f: Fix client-side TypeScript type errors
- 8f47115: Add console client build
- 9414097: Remove roomid from subscription config

## 4.0.0-alpha.5

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/api@0.0.2-alpha.1
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0
  - @bilibili-notify/storage@0.0.2-alpha.0
  - @bilibili-notify/subscription@0.0.2-alpha.0

## 4.0.0-alpha.4

### Patch Changes

- Updated dependencies [ed0e7c9]
- Updated dependencies [a9b2cca]
  - @bilibili-notify/api@0.0.2-alpha.0

## 4.0.0-alpha.3

### Patch Changes

- 921f0ad: Workspace replace

## 4.0.0-alpha.2

### Patch Changes

- 2a11604: Alpha

## 4.0.0-alpha.1

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output

## [4.0.0-alpha.0] - 2026-04-04

### Breaking Changes

- 重构为 Yarn workspace monorepo，核心包路径变更为 `packages/core`
- 动态推送、直播推送、图片渲染拆分为独立可选插件，需单独安装
- 订阅配置格式调整，旧版订阅需重新配置

### Added

- 新增 `bilibili-notify/plugin-error` 事件，用于子插件向核心上报错误
- 控制台扫码登录 UI

### Changed

- Config 抽离至独立文件 `config.ts`，导出 `BilibiliNotifyConfig` + `BilibiliNotifyConfigSchema`
- `SubscriptionLoader` 重命名为 `SubscriptionManager`，移至 `@bilibili-notify/subscription` 包
