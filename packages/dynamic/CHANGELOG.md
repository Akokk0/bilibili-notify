# Changelog

## 1.0.2

### Patch Changes

- 7d01398: 修复账号失效时控制台仍显示「已登录」、整天无推送的 bug，并重构登录态管线：

  - BilibiliAPI 在响应体识别到 code -101 时通过新的 `onAuthLost` 回调通知上层
    （60 秒防抖），cookie 刷新返回 -101 时也走同一路径，不再静默重置 HTTP
    客户端。
  - 新增 `LoginStatusController` 集中管理登录态：所有 14 处 emit 收敛到
    reporter；启动期 `getMyselfInfo` 返回 -101 不再误报 LOGGED_IN；之前静默
    swallow 的异常路径也会上报。控制器只在 `(status, msg, data)` 实际变化
    时 emit，避免心跳带来的 UI 抖动。
  - 新增配置项 `loginHealthCheckMinutes`（默认 30 分钟，范围 5–180），在已
    登录态下定期 probe，运行中失效会立即翻转 UI、广播内部事件
    `bilibili-notify/auth-lost`；恢复后广播 `bilibili-notify/auth-restored`，
    让 dynamic / live 自动重启检测，无需手动重启插件。
  - live 删除手写的 3 次 retry（API 层已 retry 3 次），失败时改为 emit
    `plugin-error` 而非静默 return。
  - 新增调试命令 `bili status auth` 查看当前登录状态。
  - 控制台 UI 删除一闪而过的「登录成功」中转视图（与「已登录」重复）及无
    listener 的「重启插件」按钮。
  - `BiliLoginStatus` 枚举删除 `LOGGING_IN`（从未 emit）与 `LOGIN_SUCCESS`
    （已被 `LOGGED_IN` 取代），故 api 包按 minor 级别 bump。
  - 工具函数 `withLock` 提升到 `@bilibili-notify/internal` 供后续复用。
  - 修复 `auth-restored` 在"运行中失效 → 扫码恢复"路径下不会触发的回归：
    之前用"上一帧 status === NOT_LOGIN"作判据，但失效后用户扫码会经过
    LOGIN_QR / LOGGING_QR 中间态，导致 dynamic / live 永远收不到恢复事件
    无法重启监测；改用 sticky 的 `needsRestore` 标志解决。
  - 修复登录刚成功瞬间 controller 把 LOGIN_QR 留下的 base64 字符串作为
    `data` fallback 传给前端，导致前端访问 `data.card.face` 抛错的小问题；
    现在仅当 `snapshot.data` 形态像 card 时才沿用，前端也加了 `data?.card`
    的安全访问。
  - 整理 `UserCardInfoData` 类型：拆出 `UserCard` / `UserCardSpace` /
    `UserCardInfo` 子类型并补齐控制台 UI 实际使用的 `attention` /
    `vip.vipStatus` / `vip.label.img_label_uri_hans_static` / `space.l_img`
    字段，删除前端 settings.vue 内联的 80+ 行 workaround 类型定义。
  - 收敛 `auth-lost` 事件来源：由 api response interceptor 的
    `onAuthLost` 回调单点广播，dynamic 在 -101 分支不再重复 emit；同时
    删除 dynamic 自己的"账号未登录"私信，避免与 server-manager 节流私
    信内容重复。

- Updated dependencies [7d01398]
  - @bilibili-notify/api@0.1.0
  - @bilibili-notify/internal@0.0.3
  - koishi-plugin-bilibili-notify@4.2.0

## 1.0.1

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

- Updated dependencies [11deaba]
  - koishi-plugin-bilibili-notify@4.1.2

## 1.0.0

### Patch Changes

- Updated dependencies [28d9700]
  - @bilibili-notify/push@1.0.0
  - koishi-plugin-bilibili-notify@4.1.0

## 0.1.0

### Minor Changes

- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

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

- 2a11604: Alpha
- 921f0ad: Workspace replace
- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [2d08a6e]
- Updated dependencies [beac16c]
- Updated dependencies [76b1f79]
- Updated dependencies [eeaca8f]
- Updated dependencies [8f47115]
- Updated dependencies [ed0e7c9]
- Updated dependencies [8b6aa5a]
- Updated dependencies [40ebcbc]
- Updated dependencies [a9b2cca]
- Updated dependencies [cc1455e]
- Updated dependencies [00a51a3]
- Updated dependencies [9414097]
- Updated dependencies [2a11604]
- Updated dependencies [921f0ad]
- Updated dependencies [53b9f9b]
  - koishi-plugin-bilibili-notify@4.0.0
  - @bilibili-notify/api@0.0.2
  - @bilibili-notify/push@0.0.2
  - @bilibili-notify/internal@0.0.2

## 0.1.0-beta.7

### Patch Changes

- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [53b9f9b]
  - koishi-plugin-bilibili-notify@4.0.0-beta.12

## 0.1.0-beta.6

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- Updated dependencies [beac16c]
  - koishi-plugin-bilibili-notify@4.0.0-beta.11
  - @bilibili-notify/api@0.0.2-beta.4
  - @bilibili-notify/push@0.0.2-beta.3

## 0.1.0-beta.5

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- Updated dependencies [76b1f79]
  - koishi-plugin-bilibili-notify@4.0.0-beta.10
  - @bilibili-notify/api@0.0.2-beta.3
  - @bilibili-notify/push@0.0.2-beta.2

## 0.1.0-beta.4

### Minor Changes

- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

### Patch Changes

- Updated dependencies [8b6aa5a]
  - koishi-plugin-bilibili-notify@4.0.0-beta.8
  - @bilibili-notify/api@0.0.2-beta.2
  - @bilibili-notify/push@0.0.2-beta.1

## 0.0.3-alpha.3

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/api@0.0.2-alpha.1
  - koishi-plugin-bilibili-notify@4.0.0-alpha.5
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0

## 0.0.3-alpha.2

### Patch Changes

- Updated dependencies [ed0e7c9]
- Updated dependencies [a9b2cca]
  - @bilibili-notify/api@0.0.2-alpha.0
  - koishi-plugin-bilibili-notify@4.0.0-alpha.4

## 0.0.3-alpha.1

### Patch Changes

- 921f0ad: Workspace replace
- Updated dependencies [921f0ad]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.3

## 0.0.3-alpha.0

### Patch Changes

- 2a11604: Alpha
- Updated dependencies [2a11604]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.2

## 0.0.2-alpha.0

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output
- Updated dependencies [fdc2c7b]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.1

## [0.0.1] - 2026-04-04

### Added

- 首次作为独立插件发布（原属核心包）
- 通过 cron 定时轮询 UP 主最新动态（默认每 2 分钟）
- 支持图文、视频、专栏、转发等各类动态类型
- 动态屏蔽过滤（关键词、正则、白名单）
- 视频动态支持附带 BV 号链接
- 可选接入 `bilibili-notify-image` 生成动态卡片图片
