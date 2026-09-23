# 推送链路参考

一条推送从引擎产出到落进历史要过六段。这份文档是那张图与各段的**边界**。

**「为什么这么定」不在这儿** —— 数据模型在 [ADR-0011](../adr/0011-push-data-model.md)，附加项（@全体 / 词云 / AI 总结）在 [ADR-0016](../adr/0016-push-extras.md)，桥接那一档在 [ADR-0009](../adr/0009-bot-framework-bridge.md)。「这个参数为什么是这个数、这个坑是在哪儿踩的」在代码注释里，离出事地点最近。这儿只画图。

## 一句话

**总开关管引擎，推送路由管发给谁，sink 管怎么送达。** 三把刀各切各的，谁都不许越界。

## 六段

| 段 | 住哪 | 干什么 |
|---|---|---|
| ① 引擎 | `packages/dynamic` · `packages/live` | 只认总开关，产出平台中立的 segment |
| ② 适配 | `apps/server/src/runtime/engines.ts` | 把引擎的枚举翻成推送的词，uid 翻成订阅 id |
| ③ 路由与闸 | `packages/push` · `broadcastToFeature` | 七道闸 + 选目标 |
| ④ 发送 | 同上 · `sendBatch` → `sendSequence` → `sendToTarget` | 分条、重试、@全体 分流 |
| ⑤ 投递 | `apps/server/src/sink/multiplex.ts` | 按连接找 adapter，真发出去 |
| ⑥ 历史 | `onSend` → `runtime/push-history.ts` → `history/store.ts` | 一行 = 一次推送 × 一个目标 |

### ① 引擎 —— 只认总开关

`isSubscribed(sub, type)` 就一句 `return sub[type]`；当年按目标拦的 `hasTargets` 已删。渲不渲图、开不开 WS、攒不攒弹幕，全在这一层定；**一个目标都没配也照渲照发**，发不出去是下游的事。

引擎拿到的是宿主折叠好的订阅视图（`SubItemView`），每把特性是一个**顶层裸布尔**。这个扁平形状是刻意的：`packages/live` 因此不可能知道 @全体 存在（ADR-0016 决策 6）。

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

身份也在这儿翻：引擎说的是 B 站 uid，推送链认的是**订阅自己的 id**（ADR-0019 决策 50）。两个适配器先用 `subscriptionIdOfUid`（`findByUid(uid)?.id`）翻一次，查不到就不往下交，只记一行 debug「uid=… 无订阅记录，跳过」。同一个 uid 配了两条订阅时，引擎那侧先出现的那条说了算 —— 引擎本来就只按 uid 认人。

### ③ 路由与闸

`broadcastToFeature` 全仓只有 **4 个调用方**，全在 `engines.ts` 的两个 PushLike 适配器里。routing 查找也只有 2 处（入口一次、重试前复检一次），**都按订阅 id**（`store.findById`）：同一个 UP 的两条订阅各推各的路由，拓展订阅（没有 uid）也找得到。

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

`onSend` 每个目标回调一次，带的是订阅 id；行里的 B 站 uid 与 UP 快照由 `push-history.ts` 回查订阅取（拓展订阅这一步先不记，行形状归 ADR-0019 施工第 ④ 步「接进推送链」那一片定）。同 `pushId` 的后续消息（@全体 / 图集 / 词云 / 总结）追加到同一行。四态：

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
- **推送层不许知道平台。** 它只认 `targetId`，翻译成投递是 sink 的事。
- **MessageBus 不在这条链上。** 它走 `live-state-changed` 这类状态通知去仪表盘，与推送载荷两条路。

## 要改的时候

| 想干的事 | 动哪儿 |
|---|---|
| 加一把可订阅的特性 | `FEATURE_KEYS` → 扩散到 FeatureFlags / SubscriptionRouting / overrides |
| 加一个附加项 | `EXTRA_KEYS` + `PUSH_EXTRAS` 各一行；面板与收窄都按注册表自动铺开 |
| 改「发给谁」 | 只有 `broadcastToFeature` 入口那一行（`store.findById`），和重试前的 `isStillRouted`；B 站 uid → 订阅 id 在 `engines.ts` 的 `subscriptionIdOfUid` |
| 加一个平台 | adapter registry，推送层一个字不动 |
