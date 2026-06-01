---
"@bilibili-notify/internal": patch
"@bilibili-notify/live": patch
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-live": patch
"koishi-plugin-bilibili-notify-ai": patch
---

修 Koishi 端升级后子插件可能无法获取核心内部实例的问题,并收紧缺插件告警判定。

- internal token 改为进程全局 `Symbol.for("@bilibili-notify/internal/BILIBILI_NOTIFY_TOKEN/v1")`,兼容 Koishi 升级后 duplicated `@bilibili-notify/internal` 副本导致的 symbol identity mismatch
- dynamic / live / ai 子插件在 core service 缺失、internals 未就绪或版本不匹配时给出更明确的启动错误
- 主插件缺 dynamic / live 子插件告警改为按有效 feature 判断,避免 disabled 订阅、显式关闭 feature、默认关闭的 live 细分特性误报
- live 引擎特别关注进房目标 key 对齐为 `specialUserEnter`,修复该特性配置了 routing 但无法推送的问题
