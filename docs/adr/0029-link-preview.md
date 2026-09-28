# ADR-0029：链接预览 —— 群里贴链接，回一张预览

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）。**未施工**。
- **记录方式**：拷问当场落的定案。接口与迁移条目的正本在 [docs/1.0/](../1.0/)；本份只写定了什么、为什么、否了什么。
- **影响面**：原 `link-parser`（改名 `link-preview/`）、`bilibili/` 的链接解析器、OneBot 适配器的入站与原生分享签名、设置与面板的链接那一页、桥帧的改名清单。
- **依赖**：[ADR-0006](0006-link-parsing.md)、[ADR-0024](0024-push-platform-adapter.md)（`sendToAddress`）、[ADR-0026](0026-failure-results.md)。

## 背景

这一块在不同地方叫「链接解析」「链接卡片」「原生分享」「小程序卡」，设置叫 `linkParsing`，1.0 原定改 `linkCards`。出口一侧还带着 B 站的知识：OneBot 入站先用 B 站域名预筛链接，签原生分享卡时写死 `type: "bili"`；入站形状里的 `miniAppCardLinks` 把「B 站小程序卡里的链接不回」这条规矩做进了数据形状。

## 决策

1. **统一叫「链接预览」**：目录 `link-preview/`；设置 `linkPreview { enabled, replyForm, byTarget }`（从 `linkParsing` 迁移，原定的 `linkCards` 作废）；产出 `LinkPreview { post, canonicalId, nativeShare? }`；解析器仍叫 `LinkResolver`（链接解析器），补 `label`；`replyForm` 取 `image` / `nativeShare` / `text`，面板上是「回图片 / 回原生分享 / 回文字」。
    - `resolve` 返回结果形状。
    - 核心先用通用网址正则挑出候选，再问各解析器 `matches`。
    - 冷却键是「群 + 解析器 + canonicalId」。
    - 回复经 `TargetDispatcher.sendToAddress` 发回原会话（ADR-0024 决策 13）。
2. **原生分享与入站**：
    - 解析器交中立描述 `{ appId, title, description, imageUrl, pagePath, webUrl, iconUrl? }`，由 OneBot 适配器去签，签不了就回图片。施工先查签名接口收不收通用参数，不收就在适配器内部放一张 appId → 预设的对照表。
    - OneBot 入站的 B 站域名预筛删掉；64KB / 8 层的上限保留。
    - 入站链接带来源标记（正文 / 普通卡 / 原生分享卡），取代 `miniAppCardLinks`；规矩是「原生分享卡里的链接不回预览」。
    - 桥帧里那一格进 alpha 之后两步改名的清单。它是插件发给 BN 的入站字段，两步要反过来走：BN 先同时认新旧两种写法，插件再改发新的。

## 取代与修订的旧条款

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0006 决策 9「真相住在 `linkParsing`」（ADR-0023 曾改为 `linkCards`） | 修订：设置叫 `linkPreview`，摊平成 `{ enabled, replyForm, byTarget }` | 1 |
| ADR-0023 决策 6「链接卡：配置叫 `linkCards`」、决策 13「`linkCards.base`」 | 修订：同上 | 1 |

## 明确不做

- **出口按平台域名预筛链接**：出口不该认识任何一家来源；该不该回，由解析器的 `matches` 说了算。
- **在入站形状里放某一家的小程序卡链接**：改成通用的来源标记。

## 后果

- 签不了原生分享的出口，会一直回图片。
