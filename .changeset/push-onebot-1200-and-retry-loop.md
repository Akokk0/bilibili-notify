---
"@bilibili-notify/push": patch
---

Fix duplicate pushes + spurious "放弃推送" log when OneBot reports
`retcode: 1200` for `@全体` messages.

Two stacked bugs in `BilibiliPush.sendOnceWithRetry`:

1. **OneBot retcode 1200 is ambiguous-success.** NapCat / Lagrange and
   similar implementations occasionally throw a non-zero retcode on
   `send_group_msg` when the payload contains `@全体`, but the message
   is actually delivered. We were treating the thrown error as a normal
   send failure, which fed bug #2.

2. **`!onlineBot` branch conflated two cases.** When every online bot
   had been tried and all threw non-transport errors, we still went
   into the "no online bot" backoff (`sleep(delay) + triedBotIds.clear() + continue`),
   which sent the same message *again* to the *same* bot — and on
   retcode-1200-already-delivered this duplicated the push to the
   group N times before finally giving up after ~96s. The user-visible
   symptom was "平台 onebot 所有机器人均不可用，放弃推送" appearing
   while the message was already (multiply) in the group.

Fixes:

- Add `isAmbiguousSuccess(platform, err)` — when `platform === "onebot"`
  and the error message matches `/\bretcode:\s*1200\b/`, treat the
  send as successful and return without retry. Logs a warn so the
  ambiguity stays visible.
- Split the `!onlineBot` branch by checking `hasOnlineUntried` vs
  `hasAnyOnline`. If at least one bot is online but all have been
  tried with non-transport errors, give up immediately rather than
  sleep-clear-retry. The original sleep+clear path is reserved for
  "every bot is currently offline" — the case it was originally
  designed for.
