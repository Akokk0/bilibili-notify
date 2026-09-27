# 1.0 推送链路

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

一条推送从来源交东西，到落进历史，要过六段。这份是 1.0 的那张图与各段的边界，文末列出与现行 `docs/agents/push.md` 的差异。数据形状见 [data-model.md](./data-model.md)；来源怎么交东西见 [subscription-sources.md](./subscription-sources.md)；拓展的推送出口见 [extension-contract.md](./extension-contract.md)。

## 一句话

**来源只交中立数据，装配只出消息，路由只认订阅 id，投递只认连接。** 四段各切各的，谁都不许越界。B 站与拓展从第二段起走完全同一条链。

## 六段

| 段 | 住哪 | 干什么 |
| --- | --- | --- |
| ① 来源 | 服务端 `bilibili/`；拓展经 `extensions/` 收件口 | 把平台数据翻成 `PostReport` / `LiveSignalReport`，只带 externalId 上报（来源不知道订阅 id）；图先用 `ctx.fetchImage` / `ctx.storeImage` 存进图库，上报里只交 `ImageRef` |
| ② 装配 | 服务端 `posts/`（作品）、`live/`（直播与直播附加项） | 过滤 → 出卡 → AI 点评 → 套文案 → 按版式分组 → 交给发送 |
| ③ 路由与闸 | `packages/push` 的 `PushRouter` | 按订阅 id 查路由、过闸、选目标、收窄附加项 |
| ④ 发送 | 同上 | 分条、重试、@全体 分流 |
| ⑤ 投递 | 服务端 `push/` 的 `TargetDispatcher` → `outlets/` 里的 `PushOutlet` | 按连接找出口，真发出去 |
| ⑥ 历史 | `history/` | 一行 = 一次推送 × 一个目标；存重推原件 |

### ① 来源

- 来源只管「和那个平台打交道」：拉数据或收上报、判新、翻成中立形状。判新、去重、限流归来源，BN 不兜底。
- B 站：拉动态翻成 `PostReport`，弹幕通道翻成 `LiveSignalReport`，按 uid（就是 externalId）经 `ctx.reportPost` / `ctx.reportLive` 上报。核心在进门那一刻按身份展开成每条订阅一份 `PostEvent` / `LiveSignal`，此后只见订阅 id（现在 `engines.ts` 里那层 `subscriptionIdOfUid` 适配消失）。
- 拓展：上报经宿主收件口核形状、毫秒换 ISO；图在上报之前已由拓展用 `ctx.fetchImage` / `ctx.storeImage` 存成 `ImageRef`。之后和 B 站一样由核心按身份展开。
- 直播「什么时候推」不在来源：核心的场次引擎决定开播、正在直播、下播、断流接续（见 [subscription-sources.md](./subscription-sources.md)「直播」）。

### ② 装配

中立装配住服务端，不开包，不认身份、不读平台原始数据。

| 步骤 | 规矩 |
| --- | --- |
| 过滤 | 第一步，对所有来源生效：`blockReposts` / `blockArticles` / `blockImages` / `blockVideos` 看 `Post` 上「有没有」；`allowKeywords` / `allowRegex` 与 `blockKeywords` / `blockRegex` 看文字。被挡时的「屏蔽后提醒」带 `postNoun` |
| 出卡 | `packages/image` 的 `generatePostCard` / `generateLiveCard`，只吃中立形状、只内联图库引用、不联网 |
| AI 点评 | `packages/ai`，按订阅设置 |
| 套文案 | 全仓唯一的 `interpolate`（internal）；变量 `{name}`、`{noun}`、`{viewer}`、`{key}` |
| 按版式分组 | internal 的版式分组，作品与直播共用一份；版式块：卡片、文字、链接（作品本身的地址）、正文链接、分条符。**正文链接**（09-27 拍板）：默认显示、默认跟在「链接」块后面同一条消息；把正文里 `type: "link"` 的片段一个一行写成「显示文字 地址」，同一地址只列一次，没有就不占行；只认片段类型，不认来源（卡片上的链接点不了，靠它把地址带出去） |
| 交给发送 | 收成一个出口 `broadcast(subscriptionId, messages, kind)`；`PushLike` 全仓一份 |

- **装配不管静音和免扰**：那是路由层的事。代价：免扰期间照样出卡、照样调 AI（花钱）再丢——主人知情拍板，推翻了先定的「装配前先判」（Q20）。
- **没配目标照样出卡**（不动）：引擎不许知道目标，发不出去是下游的事。
- 作品装配入口是 `deliverPost`；主卡发送失败往外抛，来源自己定怎么办；图集（`PostPushPart` 的 `post-images`）失败吞掉，它是 `role: "extra"`、不许 @全体。
- 串行：送达次序 = 发起次序，按订阅过 `createSerialQueue`，防「下播卡晚于新一场开播卡」。渲染闸另叫 `createRenderGate`。
- 直播附加项（词云、直播总结）的生产在 `live/`。

### ③ 路由与闸

`PushRouter`（原 `BilibiliPush`）只认订阅 id 与目标 id，不认平台，也不看订阅是哪个来源。

**1.0 的关键变化**：静音与免打扰只管推送，**推送层先算出目标、再判静音 / 免扰**。被挡下的每个目标落一行 `silenced`，存下重推原件；它不算推送，也不算失败。

| # | 闸 | 依据 | 挡掉之后 |
| --- | --- | --- | --- |
| 1 | 生命周期 | disposed / generation | 静默 |
| 2 | 无订阅记录 | 按订阅 id 找 | 静默 |
| 3 | 总开关 | 折叠后的 `features[feature]` | 静默 |
| 4 | 无可用目标 | 路由 ∩ 目标 / 连接启用 | 历史落「无目标」行 |
| 5 | 附加项收窄成空 | 附加项三态表 | 静默，**不是**「无目标」 |
| 6 | 全局静音 / 免扰时段 | `core.muteEndsAt`（原 `mutedUntil`）、订阅折叠后的免扰时段（`defaults.quietHours`） | 每个目标落一行 `silenced` + 重推原件 |

⚠️ 第 5、6 两道的先后、以及 `silenced` 的附加项消息怎么记，设计稿只定了「先算目标再判」，具体顺序施工时定。

- 只有「时间上的挡」（静音、免扰）才落 `silenced`；总开关关着、附加项收窄成空、平台不支持 @全体，照旧静默、不落行。
- `silenced` 连带三处：不算「今日推送」与趋势（现 `countsAsDelivery`），追加补丁（词云、总结）时不被 `computeStatus` 重算成 failed，补发闸（`repushDenial`）放行。
- ⛔ 被挡时不弹警告卡，历史页也不加按状态筛选（09-05 否过）。

「会不会被监听」和「推不推」是两件事：前者核心有唯一判定（在 internal），后者是这几道闸。

### ④ 发送

照旧：

- 一个目标的多条按序发，某条失败即中止该目标后续条。
- 目标不可达时退避重试，**每次重试前复检这条订阅自己的路由**——防「取消了还在推」。
- @全体 那支同步发起、不 await，顺序靠它先于卡片交给投递。

### ⑤ 投递

| 名字 | 原名 | 管什么 |
| --- | --- | --- |
| `TargetDispatcher` | `NotificationSink` / 多路分发 `MultiplexSink` | 按目标所在的连接找出口；避免和 `PushOutlet` 同叫「出口」 |
| `PushOutlet` | `PlatformAdapter` | 一种连接怎么真发出去；内置在 `outlets/`，拓展经 `registerPushOutlet` 登记 |
| `PushOutletRegistry` | `AdapterRegistry` | 出口登记表 |

- ⚠️ 按连接找出口，**不按消息里报的平台名找**——拓展借来的 bot 平台名是开放字符串。
- 出口内部拆成的两半（原 `Connector` / `PlatformDialect`）新名施工时定。
- 线上格式不改：桥协议的帧（`forward`、`desc`、`picUrl`…）与通用 webhook 的 JSON（`forward`、`ts`…）原样，改名只改到出口内部，各有快照守卫。
- 连接与目标的数据形状见 [data-model.md](./data-model.md)「连接与目标」。凭据按 `secret: true` 打码下发。

### ⑥ 历史

一行 = 一次推送 × 一个目标。同一次推送的后续消息（@全体 / 图集 / 词云 / 总结）追加到同一行。

| 字段 | 1.0 |
| --- | --- |
| 行类型 | `HistoryRow`（原 `HistoryEntry`）；记录入参的目标叫 `targetId` |
| 身份 | 行上带 `identity: { sourceKey, externalId }`，不再分「B 站行 / 拓展行」两套格 |
| 快照 | `nameSnapshot`；`avatarSnapshot` 是图库引用（所有来源都有头像快照了） |
| 时刻 | `createdAt`（ISO） |
| 推送种类 | 那一格叫 `feature`（原 `kind`），值直接用特性键名：`post` / `liveStart` / `liveStreaming` / `liveEnd` / `membership` / `superchat` / `specialDanmaku` / `specialUserEnter`；`featureToPushKind` 删掉；`/api/history?feature=`、按天计数的键同一套 |
| 重推关系 | `repushOf` / `HistoryRepushMessage`（原 `retryOf` / `HistoryRetryMessage`；retry 只指传输层自动重试 `maxRetries`） |

| 态 | 判据 |
| --- | --- |
| `no-targets` | 有推送、但一个可用目标都没有 |
| `delivered` | 有结果且全到 |
| `failed` | 本体（第一条 `role: "main"`）没到 |
| `partial` | 本体到了、别的没到 |
| `silenced` | 被静音 / 免扰挡下；追加补丁时**不被重算成 failed** |

**重推原件与图**：

- 每行存重推原件，原件类型叫 `RepushOriginal`（原 `DraftSchema` / `DRAFT_GONE`，和锐评草稿撞词；字段 `v` → `version`、`own` → `isOwnCopy`）；原件里的图（卡片图、自存图）与头像快照都按内容摘要存进统一图库 `images/<sha256>.<ext>`，行里只存引用。取消 `history/img/`。
- 保留期清理那一趟按引用全局清扫图库，引用方含历史行、重推原件、资料缓存。不再「按日删日文件时连图一起删」。
- 人工重推走 `PushRouter` 的单目标发送，所以静音 / 免扰 / 总开关天然不参与，退避重试与重试前复检照有。**补发闸放行 `silenced` 行**：主人静音期间被挡下的，事后可以补发。

## 附加项

生产与推送仍是两个问题：

- **@全体 没有「生产」**：只有推不推。1.0 只有 `atAllPost` 与 `atAllLiveStart` 两把；只有开播能 @全体，周期「正在直播」不能。
- **词云 / 直播总结**在 `live/` 生产，三道全看折叠值、不看目标：开播时攒不攒弹幕 → 下播时要不要算 → 生产者自己弃权（热词不足等回 `undefined`）。产出是 `undefined` 的**根本不发起广播**，和「收窄成空」看起来一样、成因相反。
- 附加项的逐目标三态表、注册表照旧；盘上以特性键 / 附加项做键的配置由迁移改键（见 [data-and-migration.md](./data-and-migration.md)）。

## 主人通知与问题上报

推送层告诉主人只有一个口 `notifyMaster(text)`（合掉 `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg`）。出口上的 `sendPrivate` 与「强制私聊」标志 `{ private: true }` 删掉，出口只有普通的 `send`：主人要是在面板上选了群目标，强制私聊会把群号当成 QQ 号去调「发私聊」，要么报错、要么错投。私聊的要求挪到选主人目标时——`master.targetId` 必须指向私聊目标（schema 校验，面板下拉只列私聊目标）；迁移时指向群目标的清空，首访页提示重选。

| 通路 | 受静音管？ | 说明 |
| --- | --- | --- |
| 主人通知 `notifyMaster`（指令回复、出错告诉主人） | 否 | 挡掉的话主人只会看到指令毫无反应 |
| `ctx.reportProblem({ …, notify: true })` | 否 | 来源定严重度与文案；核心按「同一来源、同一 code 60 秒一次」节流；同时进面板问题框 |
| `ctx.reportProblem({ … })`（不带 notify） | — | 只进面板问题框，不私聊 |
| `engine-error` | 否 | 只剩流水线错误（如出卡失败）；`source` 改成中立模块名（施工时定）；出图连续失败只提醒一次 |

来源级问题（登录失效、关注同步失败、拿不到直播状态）一律走 `reportProblem`，不再走 `engine-error`。

## 不走这条链的旁路

| 旁路 | 差在哪 |
| --- | --- |
| 主人通知 | 发给主人目标（必须是私聊目标），不受全局静音管 |
| 手动发一条（连接自测、卡片预览发送、AI 试一句、锐评投递） | 走同一套重试与投递，但不查路由、不落历史 |
| 链接卡 | 不进 `PushRouter`：`link-cards/` 的闸门过完，按收到那一帧的连接直接找出口回源群；解析经 `LinkResolver` 登记表 |

## 边界：谁不许知道什么

- **来源不许知道目标。** 推不推、推给谁归 BN。
- **装配不许认身份、不许读平台原始数据。** 一段步骤所有来源共用，往来源那头另加一步，别的来源就静默漏掉。
- **出图器不许联网。** 图只认图库引用。
- **推送层不许知道平台。** 只认订阅 id 与目标 id。
- **MessageBus 不在这条链上。** 状态通知（`live-session-changed`、`post-detected`…）去统计与面板，与推送载荷两条路。

## 要改的时候

| 想干的事 | 动哪儿 |
| --- | --- |
| 加一把特性 | `FEATURE_KEYS`；历史的推送种类 `PushKind` 从特性键表取子集，不另写同名列表；迁移清单守卫会逼你补迁移 |
| 加一个附加项 | `EXTRA_KEYS` + 附加项注册表；来源在 `descriptor.supportedExtras` 声明 |
| 改一条作品推送的步骤 | `posts/` 的 `deliverPost` 一处 |
| 改直播卡怎么发 | `live/` 的直播装配；什么时候推在 `live/` 的场次引擎 |
| 改历史行记什么 | `history/`；盘上形状变了要进迁移模块 |
| 加一个推送平台 | 写一个 `PushOutlet`（内置进 `outlets/`，或做成拓展），推送层一个字不动 |
| 加一个订阅平台 | 写一个订阅源拓展，这条链一个字不动 |

## 与现行 docs/agents/push.md 的差异

| 现在 | 1.0 |
| --- | --- |
| ① 引擎在 `packages/dynamic` / `packages/live` / `runtime/extension-*.ts` | 来源在 `bilibili/` 与 `extensions/` 收件口；四个 B 站包删掉 |
| ② 适配段：`liveTypeToFeature` / `liveTypeToPushKind` / `liveTypeToExtra`、`subscriptionIdOfUid` | 整段消失：推送种类就是特性键（B 站引擎内部的 0 / 3 / 9 在 `bilibili/` 里翻）；uid → 订阅 id 由核心在进门处按身份展开（来源只报 externalId） |
| 装配在 `packages/dynamic`（`deliverWork`）与 `packages/live`（`pushLiveNotify`） | 在服务端 `posts/` 与 `live/` |
| 拓展作品只按文字过滤，类型开关不看 | 过滤看 `Post` 上有没有，对所有来源生效 |
| 拓展作品套进 B 站动态类型出卡 | 渲染器只认 `Post` |
| 卡里的图是地址：远端走白名单预取，拓展图转 data URL | 只认图库引用，出图器不联网，B 站域名白名单删掉 |
| 静音排在推送层所有查询之前，被挡不落行 | 先算目标再判，被挡的每个目标落 `silenced` 行 + 重推原件 |
| B 站开播与周期「正在直播」共用 `feature: "live"` | 拆成 `liveStart` / `liveStreaming` / `liveEnd` |
| 两套直播计时（B 站 `room-session*`、拓展直播计时器） | 核心一个场次引擎 + `fetchLiveStatus` |
| 历史行按支记：B 站 `uid` + `unameSnapshot` / `uavatarSnapshot`；拓展 `extensionId` + `externalId`、只存名字 | 行带 `identity`；`nameSnapshot` / `avatarSnapshot`（图库引用） |
| 历史种类 `dynamic` / `live` / `live-ongoing` / `live-end` / `guard` / `sc` / `special-danmaku` / `special-enter` | 特性键名 |
| 历史图在 `history/img/`，随日文件删 | 统一图库，按引用清扫 |
| `BilibiliPush` / `NotificationSink` / `MultiplexSink` / `PlatformAdapter` | `PushRouter` / `TargetDispatcher` / `PushOutlet` |
| 链接解析 `createLinkParser` | `link-cards/` + `LinkResolver` |
| 出错告诉主人经 `engine-error` 按来源 60 秒节流 | 来源级问题走 `reportProblem`，按来源 + code 60 秒节流 |
| 主人私聊走 `sendPrivateMsg` 等三个方法 + 出口的强制私聊 | 一个 `notifyMaster`；强制私聊删掉，主人目标必须是私聊目标 |
| 连接 `testStatus`、`/api/connections/:id/test`、`/api/push/test`；目标 `testStatus.lastCheckedAt` | `probeStatus`（三态）、`/probe`、`/api/targets/:id/test`；`reachability.changedAt` |
| 订阅顶层 `extras`（按目标三态表）；载荷 `"forward-images"`；小程序卡 `picUrl` / `path` | `extraTargets`；`"image-group"`；`imageUrl` / `pagePath`（桥帧照旧，outlet 映射） |
