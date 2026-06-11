---
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-live": patch
"koishi-plugin-bilibili-notify-ai": patch
---

为 Koishi core 与 dynamic/live/ai 子插件增加显式 internals protocol 诊断。core 现在通过 `probeInternals()` 暴露 internals 协议版本、核心包版本和未就绪原因;子插件启动时会区分 core 启动失败 / 内部实例未就绪 / token 不一致 / 协议不兼容,不再统一报“内部实例尚未就绪或插件版本不匹配”。旧的 token v1 core 若能返回 internals 仍按 v1 兼容处理。
