---
"@bilibili-notify/api": patch
"@bilibili-notify/live": patch
"koishi-plugin-bilibili-notify-live": patch
---

修复加密 / 付费 / 测试等受限直播间导致的无限重连刷屏。建立弹幕 WS 前先用 `getLiveRoomInfoStreamKey` 预检弹幕连接信息,B 站明确拒绝(明确的非风控错误码 / 无 token / 无弹幕服务器列表)时判定为受限房,直接停止该房间监测并告警一次,不再反复从 1s 退避重连。`code=-352` 属于常见风控 / 校验拦截,只视为预检不确定并回退到原直接建连路径,避免误杀普通房间。普通房间与临时网络失败的重连 / watchdog 行为保持不变。
