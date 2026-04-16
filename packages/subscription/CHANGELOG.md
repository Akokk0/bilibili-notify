# Changelog

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
