---
"@bilibili-notify/api": patch
"koishi-plugin-bilibili-notify": patch
---

二维码渲染收进 `LoginFlow` 默认实现:之前 koishi 端、独立端各自实现一遍 PNG 输出,现在 `@bilibili-notify/api` 的 `LoginFlow` 默认带渲染逻辑,两端共用同一份。koishi/core 的扫码登录路径相应简化,行为不变。
