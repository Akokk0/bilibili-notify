---
"@bilibili-notify/internal": patch
"koishi-plugin-bilibili-notify": patch
"koishi-plugin-bilibili-notify-advanced-subscription": patch
---

修复 koishi 端订阅列表显示 UP 名称退化为 UID:订阅配置新增 `name` 字段承载用户手填昵称,普通订阅与高级订阅转换时写入,`bili list` / `bili ll` / 控制台 notifier 直接读取该字段并在缺失时回退 UID
