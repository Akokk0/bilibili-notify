---
"@bilibili-notify/live": patch
---

为直播间 WS 增加静默 watchdog:连接建立后持续记录 heartbeat / 消息活动,超过 180 秒无活动时自动重连,避免直播监听半开后漏掉开播事件
