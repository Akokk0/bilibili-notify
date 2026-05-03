---
"@bilibili-notify/subscription": patch
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-live": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-advanced-subscription": patch
---

Fix `Cannot read properties of undefined (reading 'some')` on remote
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
