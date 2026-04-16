---
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-live": patch
"@bilibili-notify/api": patch
"@bilibili-notify/push": patch
"@bilibili-notify/subscription": patch
---

feat(core): add `bili ai` test command to verify AI connectivity

fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error
