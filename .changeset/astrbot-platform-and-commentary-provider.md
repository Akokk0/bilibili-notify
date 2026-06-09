---
"@bilibili-notify/internal": patch
"@bilibili-notify/ai": patch
"@bilibili-notify/dynamic": patch
"@bilibili-notify/live": patch
---

AstrBot 产品形态的核心包基建,均为附加式,对 Koishi 端无行为变化:

- **`@bilibili-notify/internal`**:新增 canonical `astrbot` 推送平台,以及 `AstrBotAdapter` / `AstrBotPushTarget` schema 与类型(空 adapter config、要求 `unified_msg_origin` 的 `AstrBotSessionSchema`)。该平台在 Koishi / 独立端的平台选择器中隐藏,仅 AstrBot 端使用。
- **`@bilibili-notify/ai`**:导出结构化 `CommentaryProvider` 接口,使 AstrBot Provider 桥能作为 commentary 能力注入,无需伪装成具体 `CommentaryGenerator`。
- **`@bilibili-notify/dynamic` / `@bilibili-notify/live`**:动态 / 直播引擎的 commentary 消费方放宽为结构化 `comment()` 能力(具体 `CommentaryGenerator` 仍满足该结构),供 AstrBot 桥复用。
