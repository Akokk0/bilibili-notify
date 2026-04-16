# Changelog

## 0.0.2-beta.3

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

## 0.0.2-beta.2

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

## 0.0.2-alpha.1

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/storage@0.0.2-alpha.0

## 0.0.2-alpha.0

### Patch Changes

- ed0e7c9: Workspace replace
- a9b2cca: Workspace replace

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- WBI 签名与 Biliticket 生成及定时刷新
- Cookie 管理（tough-cookie）及自动刷新
- 二维码登录流程
- 动态列表、用户信息、直播间信息等接口封装
- 请求缓存与自动重试
