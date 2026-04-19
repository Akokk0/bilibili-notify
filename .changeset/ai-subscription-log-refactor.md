---
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-image": patch
"koishi-plugin-bilibili-notify-live": patch
"@bilibili-notify/api": patch
"@bilibili-notify/push": patch
"@bilibili-notify/storage": patch
"@bilibili-notify/subscription": patch
---

- feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
- fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
- style: unify all log messages to `[tag] 消息` format across all packages
- refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
- refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
