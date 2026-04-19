# Changelog

## 0.0.2-beta.1

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`

## 0.0.2-alpha.0

### Patch Changes

- 40ebcbc: All bump

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- `KeyManager` — 本地加密密钥管理
- `CookieStore` — Cookie 加密持久化
- `StorageManager` — 统一初始化入口
