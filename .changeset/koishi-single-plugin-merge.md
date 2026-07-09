---
"koishi-plugin-bilibili-notify": major
---

koishi 端五个独立插件(core / dynamic / live / ai / advanced-subscription)合并为单一 `koishi-plugin-bilibili-notify` 包。旧五包不再更新,请卸载后仅安装本包。

**破坏性变更**:

- **不再需要单独安装** `koishi-plugin-bilibili-notify-dynamic` / `-live` / `-ai` / `-advanced-subscription` —— 动态推送、直播推送现在是核心能力,随主插件启用即开,不再需要单独装子插件;AI 点评与高级订阅改为主插件 Schema 里的开关(`ai.enabled` / `advancedSub.enabled`),开了就用,不再需要单独装子插件。
- **配置结构重新按功能域组织**,分成 `account` / `push` / `subscriptions` / `render` / `ai` / `dynamic` / `live` / `advancedSub` 八个子段。原先分散在五个插件各自 config 里的同名字段(如 `logLevel`、`cardColorStart`)现在各自归属到对应功能域,升级后需要按新结构重新配置一遍(控制台可视化编辑,不是纯 yaml 手改)。
- **对外 API 全部内化**:原本供 dynamic/live/ai 子插件跨包访问核心 api/push/store 的 `probeInternals()` / `getInternals()` / `BILIBILI_NOTIFY_TOKEN` 探针协议整体删除 —— 单包内部直接持有引用,不再需要跨包边界的访问令牌机制。若有第三方插件依赖这套探针 API,需要改造。
- **`bn restart` 现在会完整重建动态/直播/AI/渲染引擎**:此前这四个引擎是独立的 koishi Service,`bn restart` 只重启核心 api/push,不会刷新它们内部持有的 api/push 引用(潜伏 bug,重启后个别推送路径可能用到旧引用);现在四者与核心 api/push/store 同一生命周期,`bn restart` 会一起重建,更彻底也更符合直觉。

**迁移建议**:先卸载 `koishi-plugin-bilibili-notify-dynamic` / `-live` / `-ai` / `-advanced-subscription`,只保留（并升级）`koishi-plugin-bilibili-notify`,再对照控制台里新的分域配置项重新填写一遍。
