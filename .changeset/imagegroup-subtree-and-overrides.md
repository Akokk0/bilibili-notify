---
"@bilibili-notify/internal": minor
"@bilibili-notify/dynamic": patch
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-advanced-subscription": patch
---

动态图集开关从 `AppConfig` 顶层下移到独立的 `GlobalDefaults.imageGroup` 子段,新增 per-UP 覆盖能力。

**@bilibili-notify/internal**(API 变更):

- 新增 `GlobalDefaults.imageGroup: { enable, forward }`(带 `.default` 让老 `globals.json` 加载时自动补全)。
- `Subscription.overrides.dynamic` rename 为 `Subscription.overrides.imageGroup`(per-UP 覆盖入口同步搬家)。
- `AppConfig` 删除两顶层字段(整合进 `imageGroup`)。
- `forward-images` payload 加 `forward: boolean` 字段(区分合并转发卡片 vs 普通多图)。
- 老 `globals.json` 缺 `imageGroup` 时按默认值兜底,但 `Subscription.overrides.dynamic` 旧数据需要被外部迁移工具或 dashboard 重新写一遍才会落到新字段。

**@bilibili-notify/dynamic**:`DynamicEngineConfig.imageGroup` 由扁平字段改为嵌套对象,engine 内部按 sub-level override 折叠。

**koishi-plugin-bilibili-notify** / **-dynamic** / **-advanced-subscription**:

- koishi 端 plugin schema 同步搬家,sub-view 透传 imageGroup。
- advanced-subscription `customDynamic` rename 为 `customImageGroup = { enable, imgEnable?, forward? }`。
- koishi/core/sink 的 `forward-images` 分支按 `payload.forward` 二分(`h("message", { forward: true }, nodes)` 合并转发 vs `h("message", images)` 多张图)。

主人无感升级路径:全局 `imageGroup.enable=true, forward=false` 是默认行为,与之前 alpha 一致;想关闭图集推送或开合并转发可在 dashboard / koishi 端继续配置。
