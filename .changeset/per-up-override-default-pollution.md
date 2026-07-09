---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/internal": patch
---

修复 per-UP(高级订阅频道)过滤 / 调度覆盖被全局默认值污染的问题

`overrides.filters` / `overrides.schedule` 的 partial 校验 schema 此前直接对带 `.default()` 的完整 schema 调用 `.partial()`,而 Zod 的 `.partial()` 不会剥离内层 `.default()`——频道只自定义了直播阈值(`minScPrice`/`minGuardLevel`)或调度(如 `pushTime`)时,解析结果仍会被静默注入 `blockDraw: false` / `blockAv: false` / `liveEndGrace: false` 等未填字段的默认值。当全局默认恰好为 `true` 时,这条注入的 `false` 会覆盖全局值,导致该频道的过滤 / 断流接续实际生效值与配置界面显示的不一致,且没有任何提示。现 partial schema 改为显式声明无默认的可选字段,未填字段保持 `undefined`、纯继承全局默认。
