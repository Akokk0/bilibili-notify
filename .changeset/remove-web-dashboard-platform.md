---
"@bilibili-notify/internal": minor
---

移除未使用的 web-dashboard 推送平台

从 `PushTargetPlatformSchema` / `PushAdapterSchema` / `PushTargetSchema` 删除 `web-dashboard` 平台及其 adapter config / session schema 与对应类型导出。独立端不再注册该 adapter。存量配置里的 web-dashboard 条目在加载时静默丢弃(双层兼容:`migrateLegacyTargets` 不再合成该平台 target + `NodeConfigStore` 在 `safeParse` 前过滤),不影响其它推送目标。
