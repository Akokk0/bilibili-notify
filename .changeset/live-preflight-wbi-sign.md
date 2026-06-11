---
"@bilibili-notify/api": patch
"@bilibili-notify/live": patch
"koishi-plugin-bilibili-notify-live": patch
---

修复直播弹幕连接预检每次被风控拦成 `-352` 的问题。B 站 `getDanmuInfo` 现已强制 wbi 签名，而 `getLiveRoomInfoStreamKey` 之前用未签名的裸请求，导致预检固定返回 `code=-352`、一路回退到直接建连：加密/受限房识别从未真正生效，且每个房间都会刷一条风控告警日志。改为走 `wbiGet` 自动附加 `wts` + `w_rid` 签名后，预检能拿到真实弹幕连接信息——普通房正常放行、受限房（无 token / 无弹幕服务器列表）才停止监测，`-352` 告警噪音消除。
