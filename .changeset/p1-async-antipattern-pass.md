---
"@bilibili-notify/api": patch
"@bilibili-notify/dynamic": patch
"@bilibili-notify/live": patch
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-live": patch
---

P1 async anti-pattern pass — cross-cutting #1 (`void`-discarded / `void`-typed
async) + #3 (no state recheck after `await`), from the final-sweep review.

- **api `onCookiesRefreshed`** (`@bilibili-notify/api`): callback type was
  `=> void`, so the refresh path couldn't await persistence — a failed
  cookie save passed as a successful refresh with an unhandled rejection.
  Type is now `=> Promise<void> | void`; the refresh path awaits it and
  loudly logs a reject (in-memory jar updated, disk lagged).
- **api cookie-refresh re-entry race** (`@bilibili-notify/api`): a slow
  in-flight `checkIfTokenNeedRefresh` from a previous login could land late
  and `onCookiesRefreshed`-overwrite a newer session's cookies. Added a
  refresh generation token (bumped on loadCookies / clearCookies / -101)
  rechecked after every network round-trip, plus a single-in-flight guard so
  the hourly timer and loadCookies don't run the RSA dance concurrently.
- **dynamic image-failure notify-once** (`@bilibili-notify/dynamic`):
  `imageFailureNotified` was set before `await sendErrorMsg` — one rejected
  notification pinned it `true` forever and silenced all later failures.
  Now set only after the notification actually succeeds; a failed notify
  retries next poll.
- **dynamic applyOps mid-tick mutation** (`@bilibili-notify/dynamic`):
  `applyOps` (not under the cron `withLock`) can unsubscribe a UID while
  `detectDynamics` is suspended at an image/AI/broadcast await — the in-flight
  scan still dispatched for it and resurrected its timeline anchor. Added a
  live-subscription recheck before each dispatch and before timeline
  write-back.
- **live `onLiveStart` post-await recheck** (`@bilibili-notify/live`): after
  the long room-info / card-render / push awaits it only checked `isDisposed`
  — an interleaved `onLiveEnd` flipping the room idle still got a live
  periodic timer armed. Now rechecks `liveStatus` and bails if no longer
  live.
- **auth `onAuthLost` / koishi callbacks** (`koishi-plugin-bilibili-notify` +
  the non-published server): `void flow.handleAuthLost()` discarded the
  promise → unhandled rejection + silently lost auth-lost transition. Routed
  through `.catch(logger)`; the koishi `onCookiesRefreshed` is now a
  void-returning block (matches the new union type, no `ctx.emit` boolean
  leak).
- **standalone message-bus defensive net** (non-published server): the `on`
  wrapper dropped the handler return value; if a future async handler rejects
  it would become an unhandled rejection. Added a thenable guard routing to
  `console.error` (sync-throw semantics unchanged; the koishi-runtime
  exactly-once delivery contract is unaffected).

`koishi-plugin-bilibili-notify-{dynamic,live}` are listed because the engine
behavior change ships through those thin shells. The lint-rule recommendation
(`noFloatingPromises`) is deferred to its own pass — it is nursery + type-aware
and a repo-wide enable is a large separate undertaking.
