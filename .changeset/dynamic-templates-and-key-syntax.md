---
"@bilibili-notify/internal": minor
"@bilibili-notify/live": minor
"@bilibili-notify/dynamic": minor
---

动态推送文本模板可自定义 + 全部消息模板占位符统一 `{name}` 风格

- 新增可自定义的动态推送文案模板(普通动态 / 视频投稿两段,变量 `{name}` / `{url}`),全局默认 + advanced-subscription 高级规则 per-UP 覆盖
- 直播 / 上舰 / 特别关注 / 弹幕总结模板占位符从 `-name` 统一为 `{name}` 风格;渲染器同时兼容旧 `-name` 写法,已保存的旧模板继续生效
- 直播消息模板去掉启用总开关,与动态模板一致:改了即生效(默认值等于内建文案,未编辑时输出不变)
- 修复动态推送「有图 / 无图」两条分支文案不一致(无图分支重复前缀);per-UP 模板 override 被全局默认值污染、导致无关 override 误关联动态模板覆盖
