# Changelog

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
