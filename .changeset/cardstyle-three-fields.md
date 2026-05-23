---
"@bilibili-notify/internal": patch
---

`CardStyleSchema` 加 `font` / `hideDesc` / `hideFollower` 三字段(`DEFAULT_CARD_STYLE` 同步补默认值),独立端 dashboard 用户可直接编辑卡片字体与隐藏开关 —— 之前独立端 `ImageRenderer` 这三参数硬编码字面量,只有 koishi 端能通过 plugin config 配。

`.default(...)` 让缺这三字段的老 `globals.json` 加载时被 zod 自动补全;新字段都向后兼容,不影响 koishi 端(koishi 仍通过自己的 plugin schema 配三字段,跟 internal `DEFAULT_CARD_STYLE` 对齐)。
