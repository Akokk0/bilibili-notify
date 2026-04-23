# Changelog

## 0.1.0-beta.9

### Minor Changes

- abd5015: Add SC/guard level push filters; unify wordcloud card style with other cards

## 0.0.3-beta.8

### Patch Changes

- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [53b9f9b]
  - koishi-plugin-bilibili-notify@4.0.0-beta.12

## 0.0.3-beta.7

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- Updated dependencies [beac16c]
  - koishi-plugin-bilibili-notify@4.0.0-beta.11
  - @bilibili-notify/push@0.0.2-beta.3

## 0.0.3-beta.6

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- Updated dependencies [76b1f79]
  - koishi-plugin-bilibili-notify@4.0.0-beta.10
  - @bilibili-notify/push@0.0.2-beta.2

## 0.0.3-beta.5

### Patch Changes

- ef5dcfe: fix(image): inline wordcloud JS scripts to fix file:// URL blocked by Chromium in Puppeteer; fix live status badge text vertical alignment

  fix(live): update blive-message-listener to 0.5.4; use listener.closed directly (removed .live indirection)

## 0.0.3-beta.4

### Patch Changes

- 2d08a6e: feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

  fix(live): fix word cloud and live summary not sent when AI is disabled

  refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition

- Updated dependencies [2d08a6e]
  - koishi-plugin-bilibili-notify@4.0.0-beta.9

## 0.0.3-beta.3

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
  - koishi-plugin-bilibili-notify@4.0.0-beta.8
  - @bilibili-notify/push@0.0.2-beta.1

## 0.0.3-alpha.2

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.5
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0

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
- 通过 WebSocket 实时监听 B 站直播间
- 开播 / 直播中 / 下播推送
- SC（超级留言）推送
- 上舰（大航海）推送
- 直播结束弹幕词云生成
- 直播结束直播总结生成
- 特别关注用户弹幕通知
- 特别关注用户进入直播间通知
- 自定义开播 / 直播中 / 下播消息模板
- 自定义上舰消息模板及舰长图片链接
- 可选接入 `bilibili-notify-image` 生成卡片图片
