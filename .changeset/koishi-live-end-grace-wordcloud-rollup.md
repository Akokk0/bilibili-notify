---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/internal": minor
"@bilibili-notify/live": minor
---

断流接续 + 弹幕词云停用词

补发独立端 alpha.13 已验证、但此前从未随 koishi 侧 changeset 发布的两项功能(实现早已合入,只是缺 changeset):

- 断流接续:直播阈值新增「断流接续」开关 + 等待时长(1–10 分钟,默认 2)。开启后 UP 下播先延迟判定,等待窗口内重新开播即接续为同一场直播(弹幕 / 时长 / 词云沿用首次开播基线),用于吸收网络抖动 / 超管掐流导致的瞬时断流误报
- 弹幕词云停用词:直播总结分类下新增停用词设置(英文逗号分隔,追加到内置中文停用词表后再分词);全局与 per-UP 覆盖均可配置
