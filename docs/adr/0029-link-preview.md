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
    - 🔗 2026-10-14（3b-28，门的名字主人定；其余带 `linkParsing` 的名字跟着换是主会话照规矩定）：**门叫 `LinkPreviewer`**：`createLinkPreviewer`、`LinkPreviewerOptions`、文件 `link-preview/link-previewer.ts`。带 `linkParsing` / `LinkParsing` 的名字把这个词换成 `linkPreview` / `LinkPreview`；`ResolveLinkParsingPoliciesInput` 照改名表改 `…Options`。（改名表里 `LinkParser` 那一格原写「改 `LinkResolver`」，那个名字已是解析器接口，改成 `LinkPreviewer`。）
    - 🔗 2026-10-14（3b-29，主人定，**修订本条的设置形状**）：**`linkPreview` 加回总开关、留冷却，由三格改五格**：总开关（默认关）、默认回不回、回复形式、按目标的例外、`cooldownSec`。总开关当初是摊平时顺手带掉的，没讨论过；链接预览回卡不走推送链，全局静音与免扰都管不到，所以要留一个一键全停。迁移一一对应、行为不变、名单不丢：总开关 ← 旧 `enabled`，默认 ← `defaults.parse`，回复形式 ← `defaults.form`（`miniapp` → `nativeShare`），例外 ← `groups`（条目里 `parse` → 开关、`form` → 回复形式），`cooldownSeconds` → `cooldownSec`。总开关与「默认」那一格的名字要避开 AI 写正文那边 `enabled`（那边表示默认）的撞义，施工时照命名规范起（文档里先写「总开关」「默认」两格，名字施工时定）。
    - 🔗 2026-10-17（3b-29，主人定，**落实上一条的名字**）：**五格落成 `linkPreview { enabled, isOnByDefault, replyForm, byTarget, cooldownSec }`**。总开关沿用 `enabled`（全仓的 `enabled` 只表示总开关），「默认回不回」叫 `isOnByDefault`，`byTarget` 例外条目里「回不回」叫 `isOn`、回复形式叫 `replyForm`；`byTarget` 条目的类型叫 `LinkPreviewTargetSettings`，折叠出的某目标答案叫 `LinkPreviewPolicy { isOn, replyForm }`。AI 写正文的默认同步改叫 `isOnByDefault`（见 ADR-0032 决策 1 下的 🔗）。迁移一步 `renameLinkParsing`：总开关单独一格、原样搬，不折进默认行 —— 0.x 的门先看总开关、再看逐群答案，折进去的话总开关关着、例外里显式开的群会从「不回」变成「回」。这一趟只含 `image` / `nativeShare` 两档，`text` 随 3b-31。
    - 🔗 2026-10-14（3b-31，主人定）：**回复形式「回文字」发什么**：作者名 + 作品文字（经作品取段的那一个函数，限长），不带链接（群友的消息里已有链接）。
    - 🔗 2026-10-20（3b-31 提交 4 已落）：**回文字落成**。`LINK_REPLY_FORMS` 加第三档 `text`；门里「发得出什么」分三路：`text` 直接可发（不碰渲染器、不问能力，没有 Chrome 也照发），`nativeShare` 且能签走原生分享，其余要渲染器。发的是 `作者名\n作品文字`，作品文字经 `postText(post, "plain")`，按码点截到 `TEXT_REPLY_MAX_CHARS`（200）；作品文字为空只发作者名。冷却与群额度与图片卡同一套；发送失败只记一行警告，不回落图片。面板三档标签「图片卡 / 小程序卡 / 文字」进面板字典。备份版本 20 → 21（迁移不动，修订号仍是 49）。
2. **原生分享与入站**：
    - 解析器交中立描述 `{ appId, title, description, imageUrl, pagePath, webUrl, iconUrl? }`，由 OneBot 适配器去签，签不了就回图片。施工先查签名接口收不收通用参数，不收就在适配器内部放一张 appId → 预设的对照表。
    - OneBot 入站的 B 站域名预筛删掉；64KB / 8 层的上限保留。
    - 入站链接带来源标记（正文 / 普通卡 / 原生分享卡），取代 `miniAppCardLinks`；规矩是「原生分享卡里的链接不回预览」。
    - 🔗 2026-10-14（3b-30，主人定）：**入站链接的来源标记落成**：`miniAppCardLinks` 删掉，适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" | "nativeShare" }[]`；正文里的链接仍由核心从 `text` 里挑，核心内部记成 `"text"`；规矩「原生分享卡里的链接不回预览」不变。`cardLinks` 改名 `sharedLinks` 是主人要求；不用 `linkPreviews`：它与 BN 回出去的 `LinkPreview` 同词两义。入站的另两格同批改名：私聊 `userId` → `address`，群消息 `groupId` → `address`、发言者 `userId` → `senderId`（与 `selfId` 成对；不用 `author`，那是作品作者），`InboundSinks` → `InboundHandlers`；桥协议帧不改名，由桥的适配器映射。
    - 🔗 2026-10-14（3b-31，主会话照规矩定）：**原生分享的命名与 appId**：载荷种类 `"miniapp-card"` → `"native-share"`，类型随 `NativeShare…`；能力格 `miniAppCard` → `nativeShare`；`appId` 填 B 站 QQ 小程序真实的 appid（施工时从真分享卡里读出来核），OneBot 签名接口不收通用参数就在适配器里放 appid → 预设的对照表；旧重推原件迁移补同一个 appid；桥帧里的能力名（`miniAppCard`）与载荷种类照旧不改，进 alpha 后两步改名。
    - 桥帧里那一格进 alpha 之后两步改名的清单。它是插件发给 BN 的入站字段，两步要反过来走：BN 先同时认新旧两种写法，插件再改发新的。
    - 🔗 2026-10-19（3b-31 提交 1 已落）：**载荷与对照表落成**。具名类型 `NativeShare`（`{ appId, title, description, imageUrl, pagePath, webUrl, iconUrl? }`）住 `internal` 的 `platform.ts`，`LinkPreview.nativeShare` 与载荷 `{ kind: "native-share" } & NativeShare` 共用它；B 站 QQ 小程序的 appid 取 `1109937557`，解析器导出常量 `QQ_MINI_APP_ID`。OneBot 签名接口不收通用参数（描述里没有 `sdkId` 一类的格），适配器里放 appid → 预设的对照表，今天一行（→ NapCat 的 `bili` 预设），表里没有的回 `unsupported`、不调接口、不碰能力缓存。webhook 通用 JSON 与桥帧的线上名字不变，由适配器映射（帧里没有 `appId`，对任何 `appId` 都映射成 `miniapp-card`）。重推原件里的小程序卡由迁移改成新形状并补同一个 appid（迁移修订号 49）。能力格改名 `nativeShare` 与「回文字」一档随 3b-31 的后续提交。
    - 🔗 2026-10-19（3b-31 提交 2 已落）：**能力格已改名**：`ConnectionCapabilities.miniAppCard` → `nativeShare`（OneBot 的缓存与探测、QQ 官方与 webhook 的回答、门的 `canSendNativeShare`、开发场景、面板一并跟改，不动盘）。桥适配器内部那一格也叫 `nativeShare`，取值仍读桥帧线上的 `capabilities.miniAppCard`，线上名照旧，进 alpha 后两步改。

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
