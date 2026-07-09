---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/internal": minor
"@bilibili-notify/dynamic": minor
"@bilibili-notify/live": minor
"@bilibili-notify/push": minor
---

消息版式自定义

补发独立端 alpha.16 已验证、但此前从未随 koishi 侧 changeset 发布的消息版式功能(实现早已合入,只是缺 changeset):

动态与直播(开播 / 直播中 / 下播)推送的消息结构现可拆分 / 重排为多条消息 —— 卡片图 / 文本 / 链接三个部件可排序、显隐,插入分条符把一次推送拆成多条消息,同条内相邻文本部件的连接符可自定义;全局与 per-UP 均可配置。
