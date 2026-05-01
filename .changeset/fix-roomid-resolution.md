---
"@bilibili-notify/push": patch
"@bilibili-notify/subscription": patch
"koishi-plugin-bilibili-notify-live": patch
---

Fix `roomId must be Number` crash when only non-`live` live-room features are enabled.

After the master switch refactor the live listener fires whenever any live-room feature (`liveEnd`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`, or the special user/danmaku configs) is on, but `subscription` was still resolving `roomId` only when `sub.live` was true. A configuration like `live=false` + `wordcloud=true` therefore left `roomId` empty and `tiny-bilibili-ws` rejected the listener with `roomId must be Number`.

- `@bilibili-notify/push` — export `LIVE_ROOM_MASTERS` / `LiveRoomMaster` as the shared list of masters that imply needing the live-room WS. Used by `subscription` and `live` to stay in sync.
- `@bilibili-notify/subscription` — `addEntry` / `loadSubscriptions` now resolve `roomId` whenever any live-room master or `customSpecial*.enable` is on. When the UP has no live room, every live-room master and both `customSpecial*.enable` flags are turned off so downstream `needsLiveMonitor` stays false.
- `koishi-plugin-bilibili-notify-live` — `needsLiveMonitor` reuses `LIVE_ROOM_MASTERS`, and `startLiveRoomListener` rejects an empty / non-numeric `roomId` defensively instead of forwarding `NaN` to `tiny-bilibili-ws`.
