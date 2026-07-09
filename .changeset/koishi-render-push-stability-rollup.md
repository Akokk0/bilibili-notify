---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/dynamic": patch
"@bilibili-notify/image": patch
"@bilibili-notify/live": patch
---

一批渲染与推送稳定性修复

补发独立端 alpha.14~17 已验证、但此前从未随 koishi 侧 changeset 发布的一批修复(实现早已合入,只是缺 changeset):

- 开启「推送动态图集」时,一条图文动态的主卡片与图集附图会各 @ 一次全体成员;现图集附图不再重复 @,仅主卡片 @
- 超大 B 站 CDN 图片在内联前先压缩,避免渲染超时 / 内存膨胀
- 直播间号解析结果与登录账号信息改为缓存复用,减少重复请求
