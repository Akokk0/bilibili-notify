# 推送链路参考

一条推送从引擎产出到落进历史要过六段。这份文档是那张图与各段的**边界**。

**「为什么这么定」不在这儿** —— 数据模型在 [ADR-0011](../adr/0011-push-data-model.md)，附加项（@全体 / 词云 / AI 总结）在 [ADR-0016](../adr/0016-push-extras.md)，桥接那一档在 [ADR-0009](../adr/0009-bot-framework-bridge.md)，人工重推在 [ADR-0017](../adr/0017-manual-repush.md)，订阅源、身份与中立装配在 [ADR-0019](../adr/0019-subscription-source-opening.md)。「这个参数为什么是这个数、这个坑是在哪儿踩的」在代码注释里，离出事地点最近。这儿只画图。订阅本身（两支、两种键、资料、上报）见 [subscriptions.md](./subscriptions.md)。

## 一句话

**总开关管引擎，推送路由管发给谁，sink 管怎么送达。** 三把刀各切各的，谁都不许越界。

**B 站也只是一个来源**（ADR-0019 决策 65）：① 里分**来源层**（B 站的动态 / 直播引擎、拓展作品的消费者：拉数据或收上报、时间线、计时器、过滤，各管各的）与**中立装配**（出卡 → 按版式分组 → 交给绑到订阅上的发送，谁来都走同一段）；②–⑥ 对任何来源都是同一条链，按订阅 id 走。拓展订阅的**作品**已经接上（`runtime/extension-posts.ts`，与 B 站动态同一段装配）；拓展的**直播**接进来见 ADR-0019 决策 57 / 58 / 67，施工中 —— 今天拓展的直播上报只到首页在播表。

## 六段

| 段 | 住哪 | 干什么 |
|---|---|---|
| ① 引擎 | `packages/dynamic` · `packages/live` · `apps/server/src/runtime/extension-*.ts` | 来源层只认总开关，把平台数据翻成中立输入；中立装配出卡、分组、交给绑到订阅上的发送 |
| ② 适配 | `apps/server/src/runtime/engines.ts` | 把引擎的枚举翻成推送的词；B 站那条边把 uid 翻成订阅 id；把发送钉到一条订阅上 |
| ③ 路由与闸 | `packages/push` · `broadcastToFeature` | 七道闸 + 选目标 |
| ④ 发送 | 同上 · `sendBatch` → `sendSequence` → `sendToTarget` | 分条、重试、@全体 分流 |
| ⑤ 投递 | `apps/server/src/sink/multiplex.ts` | 按连接找 adapter，真发出去 |
| ⑥ 历史 | `onSend` → `runtime/push-history.ts` → `history/store.ts` | 一行 = 一次推送 × 一个目标 |

### ① 引擎 —— 只认总开关

直播那头 `RoomContextBase.isSubscribed(sub, type)`（`packages/live/src/room-context.ts`）就一句 `return sub[type]`，动态那头推送订阅表只收 `sub.dynamic` 开着的；当年按目标拦的 `hasTargets` 已删。渲不渲图、开不开 WS、攒不攒弹幕，全在这一层定；**一个目标都没配也照渲照发**，发不出去是下游的事。

引擎拿到的是宿主折叠好的订阅视图（`SubItemView`，只含 B 站订阅），每把特性是一个**顶层裸布尔**。这个扁平形状是刻意的：`packages/live` 因此不可能知道 @全体 存在（ADR-0016 决策 6）。

**来源层**（各管各的，决策 65）：

- B 站动态：`DynamicEngine.detectDynamics`（`packages/dynamic/src/dynamic-engine.ts`）拉 feed → 时间线闸 → 发 `dynamic-detected` → 开播伪动态（`DYNAMIC_TYPE_LIVE_RCMD`）**按类型**跳过、锚点照推进（从前靠出卡时抛错再认错误文案，关了出图或版式藏起卡片时它就被当普通动态推出去、和直播引擎的开播撞车）→ `filterDynamic`（四个类型开关，再交文字那一半 `filterByText`）→ `workFromDynamic` 把原始动态翻成 `NeutralWork` → `deliverWork`。主卡发送抛错 → `markFail`、锚点不前移、下一轮再来。
- 拓展作品：`bindExtensionPosts`（`apps/server/src/runtime/extension-posts.ts`）听 `subscription-reported` 里 `kind === "post"` 的，逐条订阅排进**这条订阅自己的串行闸**：再核还该推（订阅在、启用、拓展在跑 —— `extensionSubscriptionPushable`）→ 动态总开关关着就不出卡 → **只按文字过滤**（`filterByText`，看正文 + 视频标题；类型开关对拓展作品一律不看，决策 70；被挡时「屏蔽后提醒」用 `blockedNotice(name, reason, postNoun)`）→ `extensionCardAuthor` 取卡上作者 → `extensionPostWork`（`runtime/extension-post-work.ts`）翻成 `NeutralWork` → `deliverWork`。不判新、不去重；意外抛错只记 `[ext-post]` 错误日志、**不重试**（事件只来一次，决策 53 / 77）。
- B 站直播：`LiveEngine` / `RoomSession*` 管弹幕 WS、房间接口、周期推送 / 重启补推 / 断流接续这几个计时器。开播 / 直播中 / 下播卡由 `RoomContext.sendLiveNotifyCard`（`packages/live/src/room-helpers.ts`）用 `biliLiveCardInput`（`packages/image`，全仓唯一一份）把房间数据翻成 `LiveCardInput`、把「按 uid 推」绑成发送（`sendToUid`），再交 `pushLiveNotify`。SC / 上舰 / 词云 / 总结 / 特别关注各自出卡，不经它。

**中立装配**（不认 uid、不读任何平台的原始数据 —— 身份由调用方绑进发送、设置与回问）：

| 件 | 住哪 | 干什么 |
|---|---|---|
| `deliverWork` | `packages/dynamic/src/work-delivery.ts` | 吃 `NeutralWork` + 这条订阅折好的设置（`WorkSubscriptionSettings`，两个来源都由 `engines.ts` 的 `dynamicWorkSettings` 折，别抄第二份）+ 绑到订阅上的发送（`BoundWorkPush`）+ `stillSubscribed()` 回问。出卡 → AI 点评 → 再核还订阅着 → 套模板 → 按版式装配 → 推送 → 图集。主卡发送失败**往外抛**，来源自己定怎么办；图集失败吞掉（抛出去 B 站那头会整条重推、每轮重复 @全体） |
| `createCardFailureTracker` | 同上 | 出图连续失败只提醒一次的计数。`engines.ts` 里**全进程一份**，传给 B 站动态引擎（`cardFailures`）也交给拓展作品 —— 同一个渲染器，同一次故障只提醒一遍。告警的 `engine-error` 来源各算各的：拓展作品单列 `extension-post`（主人私聊按来源 60 秒节流，共用的话一边刚报过、另一边就被吞） |
| `pushLiveNotify` | `packages/live/src/live-notify.ts` | 吃 `LiveCardInput` + 文案 + 链接 + 版式 + 绑到订阅上的发送（`LiveNotifySend`）；出卡 → 分组 → 发送。**什么时候推不在这里**（计时器、断流接续、串行闸归来源，决策 67） |
| `assembleMessageGroups` | `packages/internal/src/schema/message-layout.ts` | 按版式把卡 / 文字 / 链接装成消息组；上面两段共用这一份 |
| `createSerialGate` | `packages/live/src/serial-gate.ts` | 串行闸：送达次序 = 发起次序，防「下播卡晚于新一场开播卡」的倒序。B 站按房间过闸（`RoomSessionBase.enqueuePush`）；拓展作品按订阅过闸（`bindExtensionPosts`，先报的那条出卡慢也先送到）；拓展直播同样按订阅（决策 67，施工中） |
| 出卡中立入口 | `ImageRenderer.generateNeutralDynamicCard(node)` / `generateNeutralLiveCard(input)` | 不收平台原始数据。`generateDynamicCard(raw)`（造 node）/ `generateLiveCard(raw…)`（`biliLiveCardInput`）是 B 站的适配层，签名不动。卡里的图只认字符串地址：远端网址走白名单预取，data URL 原样进卡 |

拓展作品翻成作品的规矩（`extension-post-work.ts`，决策 55 / 68 / 69 / 71 / 72 / 77）：类型套进 B 站的动态类型（`extensionPostType`：带视频 AV、有图 DRAW、只有字 WORD）；node 的正文用 `buildPlainText`，图廊是一份 `GalleryImage` 列表：只有前 9 张图转成 data URL、宽高由 `readImageSize`（`packages/internal`，只读文件头）读、gif 标动图，其余只占张数给 `+N`；没报的视频 / 互动格空着不画；链接部件是事件的 `url`；**不附图集**（图集载荷只带网址，拓展交的是字节）；AI 看作品图 + 视频封面，单张超 3 MiB 跳过、最多 4 张。卡上作者与 `{name}` 走 `extension-push-common.ts`：名字依次取事件里的作者名 → 资料名 → 主人起的别名（`name`，**不是** `notes`）→ 外部 id；头像事件带了用它，否则读存下的头像文件的字节转 data URL（资料里那个面板相对地址截图加载不到）。

### ② 适配 —— 唯一同时懂两套词的地方

引擎说 `LivePushType` / `PushKind`，推送层说 `FeatureKey`。翻译只在这一处，一进来分出四样：

| 函数 | 产出 | 管什么 |
|---|---|---|
| `liveTypeToFeature` | `FeatureKey` | 开关与路由 |
| `liveTypeToPushKind` | `PushKind` | 历史记成哪一类 |
| `liveTypeAllowsAtAll` | `boolean` | 允不允许 @全体 |
| `liveTypeToExtra` | `ExtraKey \| undefined` | 这是哪个附加项 |

两张表只差一处：周期「正在直播」（type 0）与开播（3）共用 `feature: "live"`，历史上却是两类。⚠️ **下播卡本体（9）的 `liveTypeToExtra` 必须是 `undefined`** —— 带上键的话整张卡会被它自己的附加项三态表收窄掉。

动态端同理，`broadcastOptsForDynamicKind` 把 `dynamic-images`（图集）标成 `role: "extra"` 且 `allowAtAll: false`，否则一条 DRAW 动态会在主卡和图集各 @ 一次。

身份也在这儿翻：引擎说的是 B 站 uid，推送链认的是**订阅自己的 id**（ADR-0019 决策 50）。两个适配器（`makeDynamicPushLike` / `makeLivePushLike`）先用 `subscriptionIdOfUid`（`findByUid(uid)?.id`）翻一次，查不到就不往下交，只记一行 debug「uid=… 无订阅记录，跳过」。同一个 uid 配了两条订阅时，引擎那侧先出现的那条说了算 —— 引擎本来就只按 uid 认人。

**把发送钉到一条订阅上**的两件也在 `engines.ts`，挨着这两个适配器：`bindSubscriptionPush(push, subscriptionId)` 回一个 `(feature, payload, opts)` 的发送，只做「把订阅 id 钉上」；`boundWorkPush(send)` 把它包成 `deliverWork` 要的 `BoundWorkPush`（段 → 载荷、特性恒为 `dynamic`、`broadcastOptsForDynamicKind`）。B 站动态（`makeDynamicPushLike` 先翻 uid）与拓展作品（`pushFor(id)`）走的是同一跳。

拓展订阅不需要翻身份：它的上报在 ctx 那一步已经按 `(拓展, 外部 id)` 对到订阅 id 上（见 [subscriptions.md](./subscriptions.md)）。事件种类到特性键的映射是 `SUBSCRIPTION_EVENT_FEATURES`（`packages/internal/src/constants.ts`：`post → dynamic`、`liveStart → live`、`liveEnd → liveEnd`）。

### ③ 路由与闸

`broadcastToFeature(subscriptionId, …)` 全仓只有 **3 个调用点**，全在 `engines.ts`：`bindSubscriptionPush` 一处（B 站动态与拓展作品都经它）+ `makeLivePushLike` 两处（B 站直播；拓展直播接进来时也走 `bindSubscriptionPush`，施工中）。routing 查找也只有 2 处（入口一次、重试前复检一次），**都按订阅 id**（`store.findById`）：同一个 UP 的两条订阅各推各的路由，拓展订阅（没有 uid）也找得到。推送层不分订阅是哪一支 —— 只有日志里那一截 `subscriptionLabel`（B 站 `uid=…`、拓展 `<拓展 id>:<外部 id>`）按支写。

### ④ 发送

- `sendSequence`：一个目标的多条按序发，**某条失败即中止该目标后续条**（失败后大概率继续失败，乱序补发比缺失更糟）。
- `sendToTarget`：目标不可达时退避重试 3s→6s→…→96s，累计约 190s 后放弃。**每次重试前复检 routing** —— 否则用户在重试窗口里取消了订阅，目标一恢复那条还是会发出去（「取消了还在推」）。复检的是**这条推送自己那条订阅**（`opts.routing.subscriptionId`）：同一个 UP 的另一条订阅还路由着这个目标不算数。
- @全体 那支：**同步发起但不 await**。没有管理权限的群发 @全体 会被协议端拒绝并触发 adapter 重试，顺序 await 会把卡片正文连同后续任务一起拖住。顺序保证靠「它的 `sink.send` 先于卡片被调用」。

### ⑤ 投递

| 问法 | 判据 | 谁在问 |
|---|---|---|
| `isEnabled` | 目标 / 连接没被停用 | ③ 选目标时 |
| `isAvailable` | 连接在 + 平台实现在 + adapter 说可达 | ④ 每次重试前 |
| `send` | `adapterForConnection` → 平台 adapter | ④ |

⚠️ **按连接找 adapter，不按消息里报的平台名找** —— 拓展驮进来的连接后面挂着 telegram 时平台报的是 telegram，而认领它的 adapter 按的是拓展 id。

### ⑥ 历史

`onSend` 每个目标回调一次，带的是订阅 id；`runtime/push-history.ts` 的 `historyRecordFromSend` 回查订阅（`findById`）与资料缓存，补上「替谁发的」与快照，查不到（推送途中被删）就不记 —— 挂在谁名下都不对。「替谁发的」按支记（ADR-0019 决策 73 / 74，schema 在 `packages/internal/src/schema/history.ts`）：

| | B 站行 | 拓展行 |
|---|---|---|
| 身份 | `uid` | `extensionId` + `externalId`，**不记 `uid`** |
| 快照 | 名字 + 头像（`unameSnapshot` / `uavatarSnapshot`） | 只存名字 —— 它的头像是面板里的相对地址，订阅一删文件就没了；订阅还在时面板显示它现在的头像 |

`uid` 是选填：两格拓展身份都在就是拓展行，否则是 B 站行，旧行读进来就是 B 站行。⚠️ **别把外部 id 塞进 `uid`**：它恰好是一串等于某个 B 站 uid 的数字时，订阅删掉之后重推与面板会按 uid 把它认成那位 B 站 UP。

行 → 订阅一律「**先认 `subscriptionId`、找不到再认人、绝不跨支**」：B 站行找第一个同 uid 的 B 站订阅，拓展行找第一个同拓展 + 同外部 id 的拓展订阅（两层 map，不拼串）。服务端是 `runtime/target-scope.ts` 的 `currentSubscriptionOf`（重推用），面板是 `pages/up/subscription-lookup.ts` 的 `forRow`，同一条规矩两份实现。行的颜色跟着人走（`utils/up-display.ts` 的 `historyRowColor`），删了再加也不变。

**人工重推**（ADR-0017，`history/repush-runner.ts`）从历史行再发一次：发送口固定注入 `BilibiliPush.sendToTarget(…, { routing })` —— 所以静音 / 免扰 / 总开关三道（在它上游的 `broadcastToFeature` 里）天然不参与，退避重试与重试前复检 routing 照有；订阅按上面那条规矩找回，结果追加进原来那一行。

同 `pushId` 的后续消息（@全体 / 图集 / 词云 / 总结）追加到同一行。四态：

| 态 | 判据 |
|---|---|
| `no-targets` | `target === null`（有推送、但一个可用目标都没有） |
| `delivered` | 有结果且全 ok |
| `failed` | 本体（第一条 `role: "main"`）没到 |
| `partial` | 本体到了、别的没到 |

上 bus 的 `history-recorded` / `history-updated` 见 [events.md](./events.md)。

## 闸的顺序（顺序本身是设计）

| # | 闸 | 依据 | 挡掉之后 |
|---|---|---|---|
| 1 | disposed / generation | 生命周期 | 静默 |
| 2 | **全局静音** | `muted()` | 静默。**排在推送层所有查询之前** —— 静音期间推送层一次订阅查找都不做 |
| 3 | 无订阅记录 | `store.findById`（B 站那条边先在 ② 把 uid 翻成订阅 id） | 静默 |
| 4 | **总开关** | `eff.features[feature]` | 静默 |
| 5 | 免扰时段 | `inQuietHours(eff.schedule.quietHours)` | 静默 |
| 6 | 无可用目标 | `routing[feature] ∩ isEnabled` | **回调 `target: null`** → 历史落「无目标」行 |
| 7 | 附加项收窄成空 | `extras[key][id] ?? 折叠默认` | 静默 —— **不是「无目标」**，见下 |

第 2 步说的「所有查询」只管推送层自己：B 站引擎那条边在 ② 把 uid 翻成订阅 id 的那一次 `findByUid` 在它上游，静音期间照做（内存里扫一遍数组，不深拷贝）。

第 4 步的 `eff` 是 `resolve(sub, globals.defaults)` 的产出：全局 + per-UP 折叠。第 6 步与第 7 步的区别是这条链最容易看岔的一处：本体那一行明明已送达，附加项只是谁都没订，落一行「无目标」等于把配置意图报成故障。

## 附加项：生产与推送是两个问题

**@全体 没有「生产」这一步** —— payload 是发的时候现拼的，零成本，所以它只有「推不推」。词云 / AI 总结有三道，全在引擎侧、全看折叠值、**一个目标都不看**：

1. **攒不攒弹幕**（开播那一刻）：下播开着且两个附加项至少一个开着。
2. **要不要算**（下播那一刻）：下播总开关 + 各自那把键。
3. **算出来了吗**：生产者自己会弃权 —— 词云在热词不足 / 出图关着 / 渲染失败时回 `undefined`；总结只在发言人数不足时回 `undefined`（**AI 关着或失败会回落到模板，不算弃权**）。

产出是 `undefined` 的那条**根本不发起广播**。这跟第 7 道闸看起来一样（都没消息、都不落行），但成因相反：一个是**没东西可发**，一个是**有东西没人要**。排查先看日志是 `[wordcloud] 热词不足` 还是 `附加项 wordcloud 无人订阅`。

## 不走这条链的三条旁路

| 旁路 | 入口 | 差在哪 |
|---|---|---|
| 主人私聊 | `sendToMaster` / `sendPrivateMsg` / `sendErrorMsg` | 强制私聊，**不受全局静音管** —— 指令回复走的就是这条，挡掉的话主人只会看到指令毫无反应 |
| 手动发一条 | `push.sendToTarget` —— 连接自测、卡片预览发送、AI 试一句、锐评投递 | 走同一套重试与 sink，但**不查 routing、不落历史** |
| 链接解析回卡 | `createLinkParser` 的 `send` | **根本不进 `BilibiliPush`**：按收到那一帧的连接直接找 adapter 回源群 |

devtools 的「假状态 / 截流」注入在哪些边界上，见 [devtools.md](./devtools.md)。

## 边界：谁不许知道什么

- **引擎不许知道目标。** 词云照渲、AI 照问，发不发是推送层的事。认下的代价：把某个附加项的所有目标都关掉却留着总开关时，那次 AI 调用照花钱。
- **`packages/live` / `packages/dynamic` 不许知道 @全体。** 今天靠「特性是个裸布尔」天然挡住。
- **中立装配不许认身份、不许读平台原始数据。** `deliverWork` / `pushLiveNotify` / 两个中立出卡入口只吃中立形状，uid 或订阅 id 由调用方绑进发送、设置与「还订阅着吗」的回问。一段步骤两个来源共用 —— B 站那条以后加了什么，拓展那条自动有；往来源那头另加一步，另一边就静默漏掉（决策 66）。
- **推送层不许知道平台。** 它只认订阅 id 与 `targetId`，翻译成投递是 sink 的事；订阅是哪一支它也不看（只有日志那一截按支写）。
- **MessageBus 不在这条链上。** 它走 `live-state-changed` 这类状态通知去仪表盘，与推送载荷两条路。

## 要改的时候

| 想干的事 | 动哪儿 |
|---|---|
| 加一把可订阅的特性 | `FEATURE_KEYS` → 扩散到 FeatureFlags / SubscriptionRouting / overrides |
| 加一个附加项 | `EXTRA_KEYS` + `PUSH_EXTRAS` 各一行；面板与收窄都按注册表自动铺开 |
| 改「发给谁」 | 只有 `broadcastToFeature` 入口那一行（`store.findById`），和重试前的 `isStillRouted`；B 站 uid → 订阅 id 在 `engines.ts` 的 `subscriptionIdOfUid` |
| 改一条作品推送的步骤（出卡 / 点评 / 模板 / 图集 / 回问的位置） | `deliverWork` 一处，B 站与拓展共用；别在来源那头另加一步 |
| 改一条作品的设置怎么折（版式 / 皮肤 / 模板 / AI / 过滤覆盖） | `engines.ts` 的 `dynamicWorkSettings`，B 站视图与拓展作品共用；过滤配置的翻法是 `dynamicFilterOf` |
| 改拓展作品怎么翻、怎么过滤 | 翻：`extension-post-work.ts`；作者与名字：`extension-push-common.ts`（拓展直播也要用）；过滤只许走 `filterByText`，类型开关不许对拓展作品生效 |
| 改直播卡怎么发 | `pushLiveNotify`；**什么时候**推（计时器、断流接续、串行闸）在来源那头：B 站是 `packages/live` 的 `room-session*` |
| 改版式怎么分组、怎么拼文字 | `assembleMessageGroups` 一处 |
| 改卡片吃什么 | 中立入口的输入（`DynamicNode` / `LiveCardInput`）；B 站的翻译在 `generateDynamicCard` / `biliLiveCardInput`，不许让中立入口回头去读原始数据 |
| 改历史行记谁 | `historyRecordFromSend` 按支分；行 → 订阅的回找两份实现（`currentSubscriptionOf` / `forRow`）一起改 |
| 加一个推送平台 | adapter registry，推送层一个字不动 |
| 加一个订阅平台 | 写一个订阅源拓展，这条链一个字不动（见 [subscriptions.md](./subscriptions.md)） |
