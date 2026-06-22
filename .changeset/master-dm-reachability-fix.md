---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/push": minor
---

修复 master 私聊「目标不可达」的根因

master 的推送平台与实际机器人 `bot.platform` 是两个配置源,用户常在 master 里选了 `qq`,实际跑的却是 onebot(NapCat / Lagrange / go-cqhttp 在 koishi 里平台名是 `onebot`)→ 精确匹配找不到 bot → 群能发、私聊主人却永远「不可达」。

- **容错解析**:精确匹配(平台 + selfId)失败、且当前只有唯一在线平台时,回退用该在线 bot 投递,并打一条去重的可操作告警指出该把平台改成哪个;在线平台有多个则不瞎猜。
- **平台字段放宽**:master `platform` 从固定下拉改为自由文本输入(文案提示 OneBot 实现应填 `onebot` 而非 `qq`)。旧配置值仍兼容。
- **空格容错**:平台名 / selfId / channelId / userId / guildId 统一 `trim`,消除误带空格导致的静默匹配失败。
- **启动期虚警收尾**(`@bilibili-notify/push`):新增 `recheckMasterReachability()`,在 bot 上线(`login-added` / `login-updated`)时复检 master 可达性,让启动早于 bot 连上时残留的「不可达」状态在 bot 连上后自动转为「已恢复」。
