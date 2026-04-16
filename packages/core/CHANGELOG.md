# Changelog

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
