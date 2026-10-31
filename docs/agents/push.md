# 推送链路参考

一条推送从来源与装配产出到落进历史要过六段。这份文档是那张图与各段的**边界**。

**「为什么这么定」不在这儿** —— 数据模型在 [ADR-0011](../adr/0011-push-data-model.md)，附加项（@全体 / 词云 / AI 总结）在 [ADR-0016](../adr/0016-push-extras.md)，桥接那一档在 [ADR-0009](../adr/0009-bot-framework-bridge.md)，人工重推在 [ADR-0017](../adr/0017-manual-repush.md)，订阅源、身份与中立装配在 [ADR-0019](../adr/0019-subscription-source-opening.md)。「这个参数为什么是这个数、这个坑是在哪儿踩的」在代码注释里，离出事地点最近。这儿只画图。订阅本身（两支、两种键、资料、上报）见 [subscriptions.md](./subscriptions.md)。

## 一句话

**总开关管来源与装配，推送路由管发给谁，dispatcher 管怎么送达。** 三把刀各切各的，谁都不许越界。

**B 站也只是一个来源**（ADR-0019 决策 65）：① 里分**来源层**（B 站的动态、B 站来源里的直播间连接、拓展上报的翻译：拉数据或收上报、翻译，各管各的）与**中立装配**（作品：过滤 → 出卡 → 点评 → 按版式分组 → 交给绑到订阅上的发送，谁来都走同一段）；**作品这一头来源只生产**：翻成中立的 `PostEvent`、图在交出之前就抓好 / 写好，然后交给核心的一个入口（`posts/post-queue.ts` 的 `PostQueue.enqueue`，同步、没有返回值），过滤与后面所有步骤都是核心的事，来源不看结果。②–⑥ 对任何来源都是同一条链，按订阅 id 走。拓展订阅的**作品**（`extensions/extension-source.ts`，上报经 `createExtensionSource` 翻成中立形状后交核心来源上下文，再由它交同一个入口、同一段装配）与**直播**（`live/live-push.ts`，与 B 站直播同一个 `pushLiveNotify`）都已接上；直播「什么时候推」由核心 `LiveSessionEngine` / `bindLivePush` 决定（决策 57 / 58 / 61 / 67）；这一场从哪开始、到哪结束（含断流接续）也在 `live/live-sessions.ts`（`LiveSessionEngine`，3b-20 起住核心的 `live/`），推送与统计共用（ADR-0020 决策 6）—— 推送开关只管推不推，不管这一场在不在。

## 六段

| 段 | 住哪 | 干什么 |
|---|---|---|
| ① 来源与装配 | `apps/server/src/bilibili/dynamic` · `apps/server/src/bilibili/live/session` · `apps/server/src/posts` · `apps/server/src/live` | 来源层把平台数据翻成中立输入（作品：只生产，交给 `PostQueue`；直播交 `reportLive` / `reportLiveInteraction`）；中立装配过滤（作品）、管场次、出卡、分组、交给绑到订阅上的发送 |
| ② 适配 | `apps/server/src/push/bound-push.ts` | 把来源与装配的枚举翻成推送的词；B 站那条边把 uid 翻成订阅（作品：来源与装配交的 uid 在这里换成订阅、入队）；把装配交来的一次推送（锚点）翻成推送层的 `Push` |
| ③ 路由与闸 | `packages/push` · `PushRouter.push(push)` | 交进来时判一次（订阅、总开关、静音、免扰）+ 每个锚点选目标 |
| ④ 发送 | 同上 · `sendAnchor` → `sendBatch` → `sendSequence` → `sendToTarget` | 按锚点先后、分条、重试、@全体 分流；被静音 / 免扰挡下的只记不发 |
| ⑤ 投递 | `apps/server/src/push/target-dispatcher.ts` | 按连接找 adapter，真发出去 |
| ⑥ 历史 | `onSend` → `runtime/push-history.ts` → `history/store.ts` | 一行 = 一次推送 × 一个目标 |

### ① 来源与装配 —— 只认总开关

直播那头 `ListenerManager`（`apps/server/src/bilibili/live/session/listener-manager.ts`）只给名单里 `monitorsLive` 为真的人开连接，动态那头的推送名单只收名单里 `features` 含 `post` 的人（名单由来源上下文给，见 [subscriptions.md](./subscriptions.md)「来源登记表与名单」）；当年按目标拦的 `hasTargets` 已删。渲不渲图、开不开 WS、攒不攒弹幕，全在这一层定；**一个目标都没配也照渲照发**，发不出去是下游的事。

直播与动态来源拿的都是 `SourceSubscriptionView { externalId, features, monitorsLive }`，3a-28 起原先那套订阅视图与订阅操作词表在动态这一侧已删：作品设置不在来源里，核心每条作品现折。这个扁平形状是刻意的：`apps/server/src/bilibili/live/session` 因此不可能知道 @全体 存在（ADR-0016 决策 6）。

**来源层**（各管各的，决策 65）：

- B 站动态：`DynamicPoller.detectDynamics`（`apps/server/src/bilibili/dynamic/dynamic-poller.ts`）**只生产**：拉 feed → 错误码与恢复处理 → 逐条认 uid、过**时间线闸**（`isDue`：锚点在、且仍早于这条的发布时间）→ 开播伪动态（`DYNAMIC_TYPE_LIVE_RCMD`）**按类型**跳过、锚点照推进（从前靠出卡时抛错再认错误文案，关了出图或版式藏起卡片时它就被当普通动态推出去、和场次引擎的开播撞车；开播预约 `DYNAMIC_TYPE_LIVE` 不在此列，照常交）→ 不在动态轮询的表里的人（没订阅、停用、作品开关关着，连全局作品开关关掉也算）：根本没有锚点，循环开头就跳过，不翻译、不抓图、不交；作品开关再打开时进表，锚点从那一刻（现在）起算，关着期间发的动态不补推 → `postFromDynamic` 把原始动态翻成中立的 `Post`（**翻译只做一次**；抛错 = 这一条记 warn 跳过）→ 把 `publishedAt` 覆写成动态轮询自己算好的发布时间（它有 `pub_time` 文字兜底，翻译里只有 `pub_ts`、缺了落在纪元）→ **`fetchPostImages` 抓图**（交出之前就抓好：被过滤的、关了出图的动态也抓；外层作者头像不在这一步填，核心出卡时按订阅资料补）→ 抓图的 `await` 之后**重校**一次（这个人还在表里、锚点还在且仍早于这条；`isDue` 与循环开头共用，不用对象身份），不过就不交 → `reportPost(uid, { postId, url, post })`，没有返回值。**生产这一段按创作者分组并行**：一轮里的闸先逐条判完，越过闸的按 uid 分组；同一位创作者的几条仍一条接一条生产（交出的先后照动态流的次序），不同创作者的链同时跑、最多 4 条（`POST_PRODUCE_CONCURRENCY`；每条作品内部已最多同时抓 3 张图，上限防着叠起来无限放大对图床的并发）——所以一位的图抓得慢不再堵住别人的作品。一轮仍是所有链都跑完才算结束（最慢的那位决定这一轮多久），锚点在那之后才一次性单调回写。接线在来源上下文（`subscriptions/source-context.ts` 的 `reportPost`）：按身份 `listByIdentity` 取全部订阅，逐条补上描述符里的 `postNoun`（B 站是「动态」），各交一份给 `PostQueue.enqueue`。**每条越过时间线闸的动态恰好前移一次锚点**，不论后面成没成；来源不等装配、不看结果、**不重试**，过滤、出卡、点评、推送、图集、留痕、「还订阅着吗」的回问都是核心的事（见「中立装配」）。从前有一条「主卡发送抛错 → `markFail`、锚点不前移、下一轮再来」，生产里从来走不到（推送层发送失败不抛，`boundPostPush` 也不看返回值），已随这一片删掉。
- 拓展作品：拓展在 `activate(ctx)` 里经 `ctx.registerSource(def)` 交出 `SourceDef`，宿主用 `createExtensionSource`（`apps/server/src/extensions/extension-source.ts`）把它包成核心 `Source`。拓展调 `reportPost` 后，这个来源的串行队逐条核外部 id、清单声明的种类与上报形状，再把图库引用读回字节补宽高与动图标记、按「事件名 → 资料名 → 身份标签」补作者名，翻成中立的 `PostReport` 交核心 `SourceContext.reportPost`；后者按身份展开成每条订阅的 `PostEvent`，补上清单里的 `postNoun`，交 `PostQueue.enqueue`。图片和头像都由拓展先用 `ctx.storeImage` 存进图库，上报只带引用。订阅在不在、启用没有、作品开关与来源在不在跑的预检和回问，过滤，留痕，出卡都不在这里。不判新、不去重；坏的可选格丢掉、整条拒与丢格都记进「上报出入」，翻译途中意外抛错只记错误日志、**不重试**、这条不入队（决策 53 / 77）。
- B 站直播：`BiliLiveRooms` / `RoomSession`（`apps/server/src/bilibili/live/session/`）管弹幕 WS、房间接口、预检、心跳与重连，把帧翻成 `source.reportLive` / `source.reportLiveInteraction`。核心 `LiveSessionEngine` 管每一场的开播 / 下播、周期「正在直播」（`liveStreaming` 开着才推，间隔 `streamingIntervalHours`）、重启补报、断流接续与下播回顾；`bindLivePush` 出开播 / 直播中 / 下播卡。卡输入由核心 `apps/server/src/live/live-card-input.ts` 的 `liveCardInputFromDetails` 翻成 `LiveCardInput`。封面在 B 站来源里经 `ctx.fetchImage` 存进图库，详情里只带引用；主播头像按订阅 id 读资料缓存的 `cachedProfile.avatar`（没有就缺键），出卡时零网络；人数**只收精确数、缺了就缺键**（人气读房间接口的 `online`，不补 0；点赞没收到点赞帧就没有这一格；累计观看是 `WATCHED_CHANGE` 帧的精确数 `num`〔㉒d〕，一帧没收到就没有这一格、下播卡不画）。**观看人数一路是精确数**：`RoomSession` 取 `ev.num`，核心场次记下 `totalViewers`，过渡输出 `live/live-runtime.ts` 再发 `live-viewers-changed`，在播快照 `viewers` 也是它；「暂未获取到」不再写回直播数据（从前写回，下播卡会印出「累计观看人数：暂未获取到」），文字模板的 `{watched}` 缺数时由文字渲染器 `renderLiveText` 在出口印这一句、有数走 `formatCount`（B 站与拓展同一条路）。开播时刻经 `liveTimeToIso`（`live_time` 的唯一一份解析）转成 ISO。下播的词云与 AI 总结由核心 `apps/server/src/live/recap/recap-anchors.ts` 的 `recapAnchors` 排在卡片后面：弹幕快照同步取、两样各自开始做；总结锚点交两份正文，`messages` 是模板那份，`aiMessages` 是 AI 那份，由推送层逐目标挑。串行闸只包到本体发完，附加项在推送层后台按「词云 → 总结」的先后发。醒目留言、上舰、特别弹幕与特别进场现在都经 `live/live-interactions.ts`：B 站 `RoomSession` 只把帧翻成中立 `reportLiveInteraction`；核心按订阅现折 `LiveSettings` 过门槛，确定要出卡时才取徽章与观众头像，再经 `pushSuperchat` / `pushMembership` / `pushViewerChat` / `pushViewerEnter` 出卡。发出去的是中立的消息段，**图一律是取回来的字节、不是网址**；图取不到只发文字并记一条带原因的警告，醒目留言与会员可用来源交的 `fallbackText`。头像仍**只在确定要出卡时**才取，取不到只是没有观众头像、卡照出；B 站的上舰观众头像仍经 `ViewerAvatarFetcher`，撞限流〔`rate_limited`〕后冷却 5 分钟：期间所有直播间的上舰卡都不再查、没有观众头像、卡照出；进冷却记一条 warn，不进问题表、不私聊；冷却由 B 站来源（`bilibili/source.ts`）里的那一个 `viewerAvatars` 持有，全来源共用。别的失败（没登录、表外码、回应形状不对、没给地址）只是这一张卡没有头像，不进冷却。面板卡片页的预览请求体里，SC 金额叫 `content.amount`、上舰那一档叫 `content.tierKey`（档的 key，服务端在档位表里找，认不出回 400）。
- 拓展直播：拓展用 `reportLive` 交开播 / 直播状态 / 下播三种信号；`createExtensionSource`（`apps/server/src/extensions/extension-source.ts`）核形状并翻成只带图库引用的中立 `LiveSignalReport`，封面与头像已由拓展经 `ctx.storeImage` 存好。信号经核心 `SourceContext.reportLive` 按身份展开后进 `LiveSessionEngine`；`bindLivePush`（`apps/server/src/live/live-push.ts`）出卡时用 `live/live-card-input.ts` 的 `liveCardInputFromDetails` 把详情翻成 `LiveCardInput`，头像事件带的优先、没带的用订阅资料里的引用（都没有就没有头像，头像块收起），开播时刻转 ISO，人数报了才有。`liveImages` 是图库的一家引用方，名单是**在播表里此刻那些行的封面与事件头像**——直播可以播过 24 小时，周期卡几小时后还要用封面，不能像作品那样只靠宽限期。

**中立装配**（不认 uid、不读任何平台的原始数据 —— 身份由调用方绑进发送、设置与回问）：

| 件 | 住哪 | 干什么 |
|---|---|---|
| `PostQueue`（`createPostQueue`） | `apps/server/src/posts/post-queue.ts` | **作品进核心的唯一入口**，B 站动态与拓展作品调的是同一个 `enqueue(event: PostEvent)`：同步返回、没有返回值、永不抛。次序：① 问设置读口（`deps.settings`），订阅不在 / 停用 / 作品开关关着 / 来源没在跑（或队列已关）回空 → 记 debug、丢，**不发事件**；② 同步发 **`post-detected`**（旁路通知，给统计，事件总线不在推送链上；监听者抛错只记 error、不挡装配）—— 排在串行闸与过滤**之前**，所以被过滤的、前面还排着慢作品的也算 UP 的产出；③ 按订阅排进一道串行闸（同一条订阅的作品按入队次序一条条装配，不同订阅互不排队）跑 `deliverPost`，活登记进 `serviceCtx.track`（发出去不等，关停等它推完）。装配途中抛错只记 error、**不重试**（作品只交一次，核心不替来源重放）。订阅删了（`subscription-changed` 的 `remove`）闸从表里摘掉；队列关停后设置读口一律回空，入口、装配开头、回问三处都不再往下走 |
| `deliverPost` | `apps/server/src/posts/deliver-post.ts` | 吃 `PostEvent` + 一包协作者（`DeliverPostDeps`：设置读口 `settings(订阅 id)`、渲染器 / AI 的**现取**读口 `image()` / `ai()`、`avatar`、`readImage`、绑到订阅上的推送口 `push`、`recordFiltered`、`emitPipelineError`（3a-30 删了原来的 `sendErrorMsg`））；设置是这条订阅折好的 `PostSettings`，两个来源都由 `posts/post-settings.ts` 的 `postSettingsOf` 折（经 `makePostSettingsReader` 每条现折，别抄第二份）。次序：现折设置（回空就停）→ **过滤**（`filterPost`，`posts/post-filter.ts`；挡下的经 `recordFiltered` 留痕后返回，留痕失败只记 warn）→ **出卡**（失败软降级、连着失败只提醒一次；外层作者没带头像时用 `avatar(订阅 id)` 补）→ **AI 点评**（看图见下）→ **回问**（再问一次设置读口，回空就不发，模板与版式仍用开头折的那一份）→ 套模板 → 按版式装配（模板版恒做，生成了点评就按同一版式再做一份交给推送层当本体锚点的 `aiMessages`，由推送层逐目标挑；`aiEnabled` 已折进「AI 总开关且有目标用得上」，点评是空串 / 只有空白当没写出来）→ **图集**（从最外层 `post.images` 推出来，**只取带公网网址的图**，元素 `{ url, width, height }`；多于一张才许合并转发）→ 组成一次推送交出去：主卡是本体锚点、图集是排在后面不带键的附加项锚点，**只交一次**。图集是附加项，在推送层后台发、成败不往回抛。发送抛错会往外抛，由入口接住、记日志、不重试（推送层发送失败本来就收成结果、记进历史，抛的只是调用方写错这类意外） |
| `createCardFailureTracker` | 同上 | 出图连续失败只提醒一次的计数。`pipeline.ts` 里**全进程一份**，放在 `deliverPost` 的依赖里 —— B 站动态与拓展作品是同一个渲染器、同一条装配，同一次故障只提醒一遍。告警的 `pipeline-error` 来源统一叫 `post-delivery`（主人私聊按来源 60 秒节流，不与别的推送链路错误共用一个键）。3a-30 起提醒**只剩这一路推送链路错误**（`deliverPost` 的 `emitPipelineError`，文案带「已降级为纯文字推送，请检查图片插件状态」），原先另有一条 `sendErrorMsg` 直发私聊已删；发射是同步的，发射出去这一串就算提醒过（`claimNotice` / `settle`），不再等送达、不再因没送达重试，只有发射同步抛了才放回去下次再试 |
| `pushLiveNotify` | `apps/server/src/live/live-notify.ts`（3a-40 起住核心的 `live/`，同目录还有直播文案模板 `live-text.ts`、推送类型与特性键 `live-types.ts`、断流接续等待与封面轮换 `live-settings.ts`） | 吃 `LiveCardInput` + 中立消息段 + 版式 + 绑到订阅上的发送（`LiveNotifySend`）；出卡 → 分组 → 发送。场次时钟、断流与推送次序归 `LiveSessionEngine` / `bindLivePush` |
| `assembleMessageGroups` | `packages/internal/src/schema/message-layout.ts` | 按版式把卡 / 文字 / 链接装成消息组；上面两段共用这一份 |
| `createSerialGate` | `packages/internal/src/util/serial-gate.ts` | 串行闸（全仓**只此一把**，渲染闸也是它）：`run` 经闸跑一件异步活，送达次序 = 发起次序，防「下播卡晚于新一场开播卡」的倒序、失败不断链。作品按订阅过闸（`PostQueue`，先交的那条出卡慢也先送到）；拓展来源的上报在交给核心之前由 `createExtensionSource` 的 `createSerialQueue` 保序；直播按订阅（`bindLivePush`，决策 67） |
| 出卡入口 | 作品卡：`ImageRenderer.generatePostCard(post)`（吃中立的 `Post`；B 站动态先经 `apps/server/src/bilibili/dynamic` 的 `postFromDynamic` 翻成 `Post`、**交给核心之前**再经 `apps/server/src/bilibili/images.ts` 的 `fetchPostImages` 把图抓进图库（同一步还处理头像：外层作者的头像不在这里填，核心出卡时读订阅资料里的引用补、零网络；转发的原作者通常不是订阅的人，按 `repostAvatarUrlOf` 从原始动态读出的地址与配图同一并发上限现抓，抓不到就不画；正文表情同理，地址由 `emojiUrlsOf` 从原始动态读出（含被转发的原动态），表情那一档缩放（128 宽）抓、填进表情片段的 `image`，抓不到的卡上画文字），链接预览直接造 `Post`）；拓展作品经 `apps/server/src/extensions/extension-source.ts` 的 `createExtensionSource` 翻成 `Post` 再走同一个 `generatePostCard`（图由拓展先用 `ctx.storeImage` 存进图库，上报只带引用）。直播卡：`ImageRenderer.generateLiveCard(input)`（**只此一个入口**，吃中立的 `LiveCardInput`；B 站房间数据先经 `apps/server/src/bilibili/live/live-card-input.ts` 的 `liveDetailsFromRoomInfo` 翻成 `LiveDetails`，拓展的上报经 `extension-source.ts` 的 `createExtensionSource` 翻成带 `LiveDetails` 的中立信号，两者再由 `apps/server/src/live/live-card-input.ts` 的 `liveCardInputFromDetails` 翻成卡输入） | 不收平台原始数据。`Post` 里的图只认图库引用（`PostImage.ref`、`Creator.avatar`、正文小图标与表情、附加块文字行图标），出图器出卡前经宿主注入的 `resolveImageRef`（`images/image-data-url.ts`：引用 → 读字节 → data URL）事先解析；没有引用只有网址的图画占位，data URL 原样进卡 —— 出图器不联网（3a-37）：渲染页的请求闸在浏览器适配层 `runtime/puppeteer.ts`，每一页都开、只放行 `data:`，别的请求掐断，出图器按卡汇总记一条警告；解析不到的引用画占位，不拖累整张卡。**直播卡同理但兜底不同**：`cover: PostImage` 有 `ref` 认解析结果、解析不到当成没有封面（画直播专属的「暂无封面」占位、`live.hasCover` 为假，不退回 `url`），只有 `url` 原样用；`creator.avatar` 解析不到或没有，头像块整块收起；主人设的自定义直播封面优先级最高。`startedAt` 是 ISO、读不懂当没有开播时刻，数字格只收精确数（缺了那一格不画） |

拓展作品翻成作品的规矩（`extensions/extension-source.ts` 的 `createExtensionSource`，决策 55 / 68 / 69 / 71 / 72 / 77，ADR-0021 决策 22 下 10-05 的 🔗）：**交给核心之前就翻，图也先由拓展写进图库**（3a-27 起；被屏蔽的 / 关了出图 / 版式藏起卡片的作品，图也照样先存）；第一个话题进 `Post.topic`（正文上方的话题标签），富文本片段由拓展随上报交来，适配层按 schema 核下（片段拼起来对不上正文就丢 `richText` 并记进「上报出入」）并交给 `normalizePost` 整理，BN 不按 `#` 自己猜；带视频就带 `video`，宿主不再替它写 `label: "投稿了视频"`；互动数照搬成数字、排版归出图器；配图 / 视频封面 / 事件带来的作者头像都由拓展经 `ctx.storeImage` 存进图库，`PostImage` 只放引用与宽高（`createExtensionSource` 读图库文件头补宽高、gif 标动图）；每条上报最多 30 张作品图，卡上仍只画前 9 张、其余占张数给 `+N`；图库引用读不回时只放 `ref` 并记 debug，出图器画占位；链接部件是信封的 `url`；**不附图集**（图集从 `post.images` 推出来、只取带公网网址的图，拓展交的是图库引用、没有网址，所以自然没有）；AI 看作品图 + 视频封面：只有图库引用的经 `readImage` 读出字节、单张超 3 MiB 跳过、编成 data URL，最多 `POST_COMMENT_IMAGES_MAX`（4）张（B 站同一个数）。卡上作者与 `{name}` 走 contract 的 `displayNameOf`：事件里的作者名 → 资料名 → 身份标签（别名已退役，ADR-0021 决策 16；`notes` 是备注，**不当名字用**）；身份标签按来源描述符的 `externalIdNoun` 拼；头像事件带了图库引用就用它，否则用资料里引用的那一张（没有就没有头像块）。

### ② 适配 —— 唯一同时懂两套词的地方

来源与装配说 `LivePushType`，推送层说 `FeatureKey`。翻译只在这一处，一进来分出两样（`livePushHead`）：

| 函数 | 产出 | 管什么 |
|---|---|---|
| `liveTypeToFeature` | `FeatureKey` | 开关与路由 |
| `liveTypeAllowsAtAll` | `boolean` | 允不允许 @全体（不允许就给这次推送带 `allowAtAll: false`） |

附加项不靠推送类型认：来源与装配交来的锚点自己带着附加项的键（`LivePushAnchor.extra`，词云 `wordcloud`、总结 `liveSummary`），`toPushAnchors` 把角色与键原样带过去、内容（现成的或约定，`messages` 与有才带的 `aiMessages`）逐条翻成载荷。`LivePushType` 里原先给词云 / 总结用的 5、10 两档已删。

历史行记的就是特性键（⑬f 起没有单独的推送种类）：开播（3）→ `liveStart`、可以 @全体；重启补报（`CatchUp`，11）→ `liveStart`、不 @全体，卡与文字仍是「正在直播」那一套；周期「正在直播」（0）→ `liveStreaming`、不 @全体。⚠️ **本体那个锚点不带附加项的键** —— 带上键的话整张卡会被那张附加项三态表收窄掉。

动态端同理：主卡是本体锚点，图集是 `role: "extra"`、不带键的锚点。附加项锚点永不带 @全体，所以一条 DRAW 动态不会在主卡和图集各 @ 一次。

身份在核心的 `subscriptions/source-context.ts` 翻：来源只报 `{ sourceKey, externalId }`，推送链认的是**订阅自己的 id**（ADR-0019 决策 50）。`reportPost`、`reportLive`、`reportLiveInteraction` 都用 `listByIdentity` 取全部订阅、逐条带着订阅 id。查不到就不往下交，只记一行 debug。同一个 uid 配了两条订阅（老版本留下的遗留重复）时，作品、直播信号与互动都**每条各一份**，一条停用或关了对应开关只丢它自己那份。

**把推送钉到一条订阅上**的两件在 `push/bound-push.ts`：`boundPostPush(push, subscriptionId)` 回 `deliverPost` 的依赖 `push` 要的那个推送口（锚点 → `Push`，段 → 载荷、特性恒为 `post`）；`boundLivePush(push, subscriptionId)` 回 `pushLiveNotify` 要的 `LiveNotifySend`（特性键与 @全体 照 `livePushHead`）。B 站动态与拓展作品都经 `PostQueue` 的装配调 `boundPostPush`；B 站与拓展直播共用 `bindLivePush` / `sendFor(id)`。

拓展订阅不需要翻身份：它的上报在 ctx 那一步已经按 `(拓展, 外部 id)` 对到订阅 id 上（见 [subscriptions.md](./subscriptions.md)）。拓展订阅能有哪些特性直接看清单与视图里的 `supportedFeatures`（`post` / `liveStart` / `liveStreaming` / `liveEnd`）；声明 `liveStreaming` 要同时声明开播与下播，面板与服务端用同一份。`SUBSCRIPTION_EVENT_FEATURES` / `featuresForEvents` 已删。

### ③ 路由与闸

一次推送整个交给 `PushRouter.push(push)`：`Push = { subscriptionId, feature, allowAtAll?, anchors }`，`anchors` 是按顺序排好的锚点（`PushAnchor = { role, extra?, messages }`：本体至多一个且排第一个，其余是附加项；`messages` 是现成的一串载荷或一个约定）。3b 起（ADR-0032 决策 2）锚点上多一格可选的 AI 版 `aiMessages`（`PushAnchor`、`PostPushAnchor` 与装配侧的 `LivePushAnchor` 各一格，形状同 `messages`；直播这边只有下播总结会带），推送层用 `PushRouterOptions.aiWriting: () => AiWritingSettings`（必填，每个锚点发出时现取）自己现取 `ai.writing`，推导某个目标用哪一份正文：`sendAnchor` 在收窄出目标之后逐目标挑，本体且特性是 `post` 看 `writing.post`，带 `liveSummary` 键的附加项看 `writing.liveSummary`，别的锚点没有 AI 版这回事；例外（`byTarget`）写了听例外，没写跟默认行（`aiWritingFor`）。「谁收」（路由、闸、附加项三态表）与「用哪份字」是两个维度，互不干涉。`aiMessages` 没给、约定被拒绝、结果为空，都当没有 AI 版，所有目标收 `messages`（锚点不跳过；`messages` 自己为空或被拒绝才跳过）。被静音挡下的行、无目标那一行（记「默认那一份」，只看默认行）、@全体 分支（`sendBatch` / `sendAtAllThenCard` 按目标取载荷，先不 @ 的组、后 @ 的组的次序不变）都按各自目标的那份；历史一行一目标，存的就是它实际收到的那份，重推照它发。装配那头（`deliverPost`）模板正文恒备，AI 总开关开着且 `writing.post` 默认开或任一现存目标的例外开才去点评，点评回来是空串 / 只有空白算没写出来；这道生成门折在 `postSettingsOf` 的 `aiEnabled` 里（`makePostSettingsReader` 递进现存目标 id 的读口，悬空的例外 id 不算开着）。它全仓只有 `boundPostPush`（B 站动态、拓展作品）与 `boundLivePush`（B 站、拓展直播）两类调用点。

**交进来那一刻判一次**（订阅在不在、总开关、全局静音、免扰时段），裁决管整次推送，之后的锚点不再看这四样。**锚点按先后发**：内容各做各的，前一个锚点对它该发的目标都有了结果才发后一个，空的跳过，约定被拒绝记一条警告并跳过；`push()` 在本体发完时返回，其后的锚点在后台接着发（经 `serviceCtx.track` 登记，关停等它们）。每个锚点发出时现查订阅的路由与附加项表（`sendAnchor`）。routing 查找只有 2 处（每个锚点一次、重试前复检一次），**都按订阅 id**（`store.findById`）：同一个 UP 的两条订阅各推各的路由，拓展订阅（没有 uid）也找得到。推送层不分订阅是哪一支 —— 只有日志里那一截 `subscriptionLabel`（B 站 `uid=…`、拓展 `<拓展 id>:<外部 id>`）按支写。

### ④ 发送

- `sendSequence`：一个目标的多条按序发，**某条失败即中止该目标后续条**（失败后大概率继续失败，乱序补发比缺失更糟）。
- `sendToTarget`：目标不可达时退避重试 3s→6s→…→96s，累计约 190s 后放弃。**每次重试前复检 routing** —— 否则用户在重试窗口里取消了订阅，目标一恢复那条还是会发出去（「取消了还在推」）。复检的是**这条推送自己那条订阅**（`opts.routing.subscriptionId`）：同一个 UP 的另一条订阅还路由着这个目标不算数。
- @全体 那支：它是推送层自己插在本体前面的锚点，唯一「只保证先后、不等结果」的 —— **同步发起但不 await**。没有管理权限的群发 @全体 会被协议端拒绝并触发 adapter 重试，顺序 await 会把卡片正文连同后续任务一起拖住。顺序保证靠「它的 `sink.send` 先于卡片被调用」。

### ⑤ 投递

| 问法 | 判据 | 谁在问 |
|---|---|---|
| `isEnabled` | 目标 / 连接没被停用 | ③ 选目标时 |
| `supportsAtAll` | 这个目标所挂连接的适配器对 `atAll` 能力的回答不是「不支持」（「还不知道」也发）；目标或连接不在就不发 | ④ 分流 @全体 时 |
| `isAvailable` | 目标 / 连接没被停用 + 目标与连接的平台对得上（这两样派发器自己查，适配器不再各查一遍）+ 连接在 + 平台实现在 + adapter 说可达。适配器只拿到去向 `DestinationRef`，不是整条目标 | ④ 每次重试前 |
| `send` | `adapterForConnection` → 平台 adapter | ④ |

⚠️ **按连接找 adapter，不按消息里报的平台名找** —— 拓展驮进来的连接后面挂着 telegram 时平台报的是 telegram，而认领它的 adapter 按的是拓展 id。

### ⑥ 历史

`onSend` 每个锚点对每个目标回调一次，带的是订阅 id 与这次推送的 `pushId`（推送层自己生成）；被静音 / 免扰挡下的推送同样回调，消息带 `isSilenced`、没有结果；`runtime/push-history.ts` 的 `historyRecordFromSend` 回查订阅（`findById`）与资料缓存，补上「替谁发的」与快照，查不到（推送途中被删）就不记 —— 挂在谁名下都不对。「替谁发的」记成一格 `identity`（`{ sourceKey, externalId }`，和订阅是同一个身份，`subscriptionIdentityOf` 给的；schema 在 `packages/internal/src/schema/history.ts`）：

| | B 站行 | 拓展行 |
|---|---|---|
| 身份 | `{ sourceKey: "bilibili", externalId: uid }` | `{ sourceKey: 拓展 id, externalId: 外部 id }` |
| 快照 | 名字（`nameSnapshot`）；头像快照（`avatarSnapshot` 只装图库引用）：写行时抄资料缓存里的 `avatar`，B 站头像抓进图库后同样有；资料里还没有 `avatar` 时缺着，面板退到订阅现在的头像、再退到首字 | 名字 + 头像（`nameSnapshot` / `avatarSnapshot`：写行时抄资料缓存里存进图库的 `avatar`，历史仓先续期，续不上就不写这一格；⑳d 取代 ADR-0019 决策 74 的「拓展行不存头像快照」） |

⚠️ 身份两格一起比：外部 id 恰好是一串等于某个 B 站 uid 的数字，来源键不同，也不是同一个人。0.x 与 ⑱b 之前的行（`uid` / `extensionId` + `externalId` 散格）由迁移并成 `identity`（`migration/history.ts`），推不出身份的是坏行、原样不动。

行 → 订阅一律「**先认 `subscriptionId`、找不到再按身份认、绝不跨来源**」：找第一个来源键与外部 id 都相同的订阅（两层 map，不拼串）。服务端是 `runtime/target-scope.ts` 的 `currentSubscriptionOf`（重推用），面板是 `pages/up/subscription-lookup.ts` 的 `forRow`，同一条规矩两份实现。行的颜色跟着人走（`utils/up-display.ts` 的 `historyRowColor`），删了再加也不变。

**人工重推**（ADR-0017，`history/repush-runner.ts`）从历史行再发一次：发送口固定注入 `PushRouter.sendToTarget(…, { routing })` —— 所以静音 / 免扰 / 总开关三道（在它上游的 `PushRouter.push` 里）天然不参与，退避重试与重试前复检 routing 照有；订阅按上面那条规矩找回，结果追加进原来那一行。能补的是「有目标、且行里还有没送到的或被挡下的消息」的行（`history/repush.ts` 的 `unsentIndices`，看消息不看 `status`；补发闸、列表与 WS 投影给不给 `repush`、补完删不删原件三处同一个判据）；被挡下的消息算「没送到的」，补发不带 @全体（被挡时没记它）。无目标行与被过滤的行不能补，拒绝的话各说各的。

**保留分两层**（ADR-0022 决策 9，`history/retention.ts`）：文字不设上限，日文件一份都不删；图与重推原件按保留天数清。清到哪一天记成一条水位线 `history/retention.json` 的 `clearedThrough`（UTC 日、含当天，只往前走），清扫每 6 小时加开机一次，只处理水位线之后、到期日及以前的那几天：删那几天的重推原件目录，再把水位线推过去，紧接着跑一轮图库清扫。**清扫本身不碰图**：图在图库 `images/`，历史行的配图（`payload.image`）与头像快照（`avatarSnapshot`）、重推原件里的图各是图库的一家引用方（`listHistoryImageRefs` 只读水位线之后的日文件，本体行与补丁行都数，读不动就抛；`listRepushImageRefs` 读盘上每份原件），水位线一推过去，那几天的行就不再留住它们的图，由图库按引用收走。`deleteRange`、重推原件的 `drop` 同样只删行与 JSON，不删图。列表接口给水位线及以前的行带上 `isPastRetention`，面板在原来画图的位置写「图已清理」（消息的 `kind` 是 `image`、或带着 `image` 格；迁移时过期的老行图格已拿掉，所以要靠 `kind`），这些行的头像快照面板也不用；这些行的原件也没了，重推按钮照旧因为「原件不在」而灰掉。唯一还会删文字的是 devtools 清截流记录用的 `deleteRange`。从 0.x 迁上来时，迁移在「推送历史」那一步里先跑一次同样的清扫（`migration/history.ts` 的 `sweepMigratedHistory`，水位线随新代一起就位），再迁日文件与原件：`history/img/` 不整目录搬，保留期内的行与原件引用着的逐张复制进图库（`migration/history-images.ts`），过了保留期的行只拿掉图格、不读图文件，孤儿不搬。保留天数是 `history.retentionDays`，只许 90 / 60 / 30 / 15 / 7 / 3 / 1 七档。

同 `pushId` 的后续消息（@全体 / 图集 / 词云 / 总结）追加到同一行。六态（`computeStatus(targetId, messages, filteredBy?)`，消息的纯函数外加行上的 `filteredBy`，按每条消息的最后一次尝试算）：

| 态 | 判据 |
|---|---|
| `filtered` | 行上有 `filteredBy`（这条作品被过滤挡下了，只是留痕）。排在最前：它的 `targetId` 也是空的，但不是「无目标」 |
| `no-targets` | `target === null` 且不是被过滤的行（有推送、但一个可用目标都没有） |
| `silenced` | 本体的最后一次是被挡的（`isSilenced`）；或没有本体、全是被挡的。一条都没发，不算推送也不算失败（`countsAsDelivery` / `countsAsFailure` 都是假），可以补发 |
| `delivered` | 有结果且全 ok（被挡的附加项不参与这一条的判断） |
| `failed` | 本体（第一条 `role: "main"`）没到 |
| `partial` | 本体到了、别的没到 |

被挡的每条消息带 `isSilenced: true`、没有 `result`；这一格让「被挡的」与「因为前一条失败而没发出去的」（同样没有结果）分得开。被挡的行同样留重推原件、图同样进图库。

上 bus 的 `history-recorded` / `history-updated` 见 [events.md](./events.md)。

## 闸的顺序（顺序本身是设计）

| # | 闸 | 什么时候判 | 依据 | 挡掉之后 |
|---|---|---|---|---|
| 1 | disposed / generation | 交进来时、每个锚点发出前 | 生命周期 | 静默 |
| 2 | 无订阅记录 | 交进来时 | `store.findById`（B 站那条边先在 ② 把 uid 翻成订阅 id） | 静默，什么都不留 |
| 3 | **总开关** | 交进来时 | `eff.features[feature]` | 静默，什么都不留 |
| 4 | 无可用目标 | 每个锚点 | `routing[feature] ∩ isEnabled` | **回调 `target: null`** → 历史落「无目标」行（静音 / 免扰期间也落） |
| 5 | 附加项收窄成空 | 每个锚点 | `extraTargets[key][id] ?? 折叠默认` | 静默 —— **不是「无目标」**，见下 |
| 6 | **全局静音 / 免扰时段** | 交进来时判一次，管整次推送 | `muted()`、`inQuietHours(eff.schedule.quietHours)` | 一条都不发，也不插 @全体；每个锚点对它该发的每个目标回调一次，消息带 `isSilenced` → 历史落 `silenced` 行、留重推原件 |

第 2、3、6 三道在 `judgePush` 里、交进来那一刻判一次：放行了，之后才做好的附加项不再看时间（22:59 下播卡发出、23:01 写好的总结照发）；挡下了，免扰结束后才做好的也一起记成被挡。**先算目标、再记被挡**：第 4、5 两道排在第 6 道前面，所以 `silenced` 行里只有这个目标本来会收到的消息。

第 3 步的 `eff` 是 `resolve(sub, globals.defaults)` 的产出：全局 + per-UP 折叠。第 4 步与第 5 步的区别是这条链最容易看岔的一处：本体那一行明明已送达，附加项只是谁都没订，落一行「无目标」等于把配置意图报成故障。

**`targetId` 为空的行有两种，分哪一种看 `status`，不看 `targetId`**：无目标行（`no-targets`）与被过滤的行（`filtered`）。面板的「去配置」小卡只给前一种；补发两种都不给、理由不同；首页「最近推送」不列后一种。

**被过滤的作品留痕**（ADR-0021 决策 34 的 🔗）：过滤挡下一条作品，历史里记一行 `filtered` —— **一条订阅一行**（不按目标拆）、`targetId: null`、`feature: "post"`、自己的 `pushId`（不对应任何推送）、行上 `filteredBy`（六种 `PostFilterReason`，词表在 `packages/internal/src/post.ts`）、一条 `role: "main"` 的文字（摘要 + 换行 + 原帖地址，没有 `result` 也没有 `isSilenced`）。只留痕：不出卡、不调 AI、不存重推原件，不能补发（图在来源交出之前就抓好 / 写好了，被过滤的作品也一样，3a-27 起）；不算推送也不算失败（`countsAsDelivery` / `countsAsFailure` 都是假）；写一次就完，不和别的行合并、不进历史仓的 `open` 表、之后不追加。它**不经推送层、不走事件总线**：过滤在核心里（`deliverPost` 第二步），B 站与拓展作品是同一处：挡下时经装配依赖 `recordFiltered` 交出 `FilteredPost { subscriptionId, filteredBy, text, url }`（`text` 是 `postText(post, "plain")` 整条、没截过，`url` 是信封上的作品地址 —— 视频动态是视频页，从前 B 站留痕用的是另算的动态页）。`pipeline.ts` 把 `recordFiltered` 接到 `runtime/push-history.ts` 的 `historyRecordFromFilteredPost`：身份与名字 / 头像快照的取法同 `historyRecordFromSend`，摘要在这儿截（`POST_SUMMARY_MAX_CHARS`，按字符），查不到订阅不记。行落下后照发 `history-recorded`，面板不为它弹小卡。被过滤的作品只留这一行，不往任何目标发东西（从前装配里有一句「某某发了一条被屏蔽的作品」的提醒，10-08 删了；它从来没有设置项，面板上也没有过开关）。

静音期间的落盘量：凡是走这条链的推送（作品、开播 / 正在直播 / 补报 / 下播与它的词云、总结、上舰、醒目留言、特别弹幕、特别进场，以及拓展的作品与直播）在静音或免扰里每条都会落行、存原件，卡片图进图库；文字不设上限，图与原件按保留天数清。

## 附加项：生产与推送是两个问题

**@全体 没有「生产」这一步** —— payload 是发的时候现拼的，零成本，所以它只有「推不推」。词云 / AI 总结有三道，全在装配侧、全看折叠值、**不看这次推送的路由**（总结的 AI 那份要不要做另算，见第 3 道）：

1. **攒不攒弹幕**（开播那一刻）：下播开着且两个附加项至少一个开着。
2. **要不要算**（下播那一刻）：下播总开关 + 各自那把键。
3. **算出来了吗**：生产者自己会弃权 —— 词云在热词不足 / 出图关着 / 渲染失败时回 `undefined`；总结只在发言人数不足时回 `undefined`（**AI 关着或失败会回落到模板，不算弃权**）。总结的模板那份恒做；AI 那份做不做是宿主折好的一个布尔读口 `isAiEnabled`（`live/live-runtime.ts` 每次下播现算）：AI 总开关开着，且 `ai.writing.liveSummary` 默认开或任一**现存**目标（含停用的，`targetIds` 与作品那份共用）的例外开 —— 悬空的例外 id 不算，装配自己不看目标。生成失败或回空串由推送层让所有目标回落模板。

产出是 `undefined` 的那个锚点**直接跳过**（约定给了 `undefined`）。这跟「附加项收窄成空」那道闸看起来一样（都没消息、都不落行），但成因相反：一个是**没东西可发**，一个是**有东西没人要**。排查先看日志是 `[wordcloud] 热词不足` 还是 `附加项 wordcloud 无人订阅`。

## 不走这条链的三条旁路

| 旁路 | 入口 | 差在哪 |
|---|---|---|
| 主人私聊 | `PushRouter.notifyMaster`（文字或消息体，回结果形状） | 主人目标只许是私聊目标（保存时拒收、发送时复检），走普通的 `send`；**不受全局静音管**（指令回复 3a-19 起不走这条，见下面「指令回复」一行）—— 挡掉的话主人只会看到指令毫无反应 |
| 谁在调主人私聊（上一行的来路，3a-30 之后只有两家） | `problems/problem-notifier.ts`、`runtime/master-notifier.ts` | 问题通知器：问题表里 `notify` 为真的问题（宿主报的登录失效、B 站的风控、直播间停止监听、直播间受限），节流键 报的人 + code、60 秒，`notifyMaster` 回 ok 才算真私聊过，稍后可重试的失败按 10 秒 / 30 秒 / 60 秒 / 5 分钟 / 15 分钟再送五次，清掉时对真私聊过的补一句恢复说法；换语言或口吻时问题表重报，通知器把「只换了说法」当同一件事：记成「不再说」的不重发，之后补的「已恢复」用新说法；推送链路错误通知器 `runtime/master-notifier.ts`：只听 `pipeline-error`，按 `source` 节流 60 秒，每条先落一行 warn（现在的发射者是作品投递出图失败与开发场景）。**推送链路里不再有任何自己的私聊口**：`masterTellers`、动态与直播的 `PushLike.sendPrivateMsg`、作品投递的 `sendErrorMsg` 都已删，`PushForEngines` 只剩 `push`。两家各有各的节流表，B 站的这几类报错只走问题表、不再同时发推送链路错误。<br>**3b 要改的几处**（契约第 3 版，ADR-0025 决策 11、ADR-0037 决策 15）：① 问题进表从此三条路外加宿主自己的事 —— 集成自己报（拓展也有同一个签名的 `reportProblem` / `resolveProblem`）、宿主看登录状态报（订每个有登录口的来源的 `auth.onChange`：`expired` 进表并私聊，`logged-out` 只进表，`logged-in` 清，B 站不再报 `auth_lost`）、宿主探连接报。🔗 登录这半句已落（3b-51）：`subscriptions/login-problems.ts` 的 `watchLoginProblems`，由 `builtin-sources.ts` 登记来源时接上；B 站的分层只剩风控与请求失败两层；② `Problem.about` 在 `{ subscriptionId }` 之外多 `{ connectionId }` 一支，连接删了关于它的全清、适配器停下它名下的全清，宿主核 `connectionId` 是不是这个适配器的连接，不是就拒收；③ 集成写的 `message` / `recoveryMessage` 一律平实、只说事，宿主私聊时按口吻补完整（女仆层「主人，刚刚 <名字> 报告：<message>」，平实版「<名字> 报告：<message>」，名字取来源描述符的 `label` 或拓展清单的 `name`；恢复句同理）；宿主自己写的整句不加「X 报告」。🔗 已落（3b-51）：写者名由三个上下文入口盖进 `writtenBy`（不在 `Problem` 与 `GET /api/problems` 上），引子只在通知器交给 `notifyMaster` 那一刻按当前语言与口吻加，账上仍存原句；内置适配器暂用适配器键，拓展用当前语言的清单名；没给恢复句时带名字与集成原句（`problem.relay.recoveredGeneric`）；④ 连接通断改成宿主每分钟调适配器的 `probe`，连续两次探不通算断，探测结果状态变了才写盘；运行中断了才私聊，启动后一直没连上的、主人改设置造成的只进表；主人的私聊目标走的就是这条断了的连接就不发、不再试、恢复后不补；⑤ 连接设置不合法由宿主报：只隔离那一条、进问题表、不私聊，记在那条连接所属适配器名下。🔗 ④⑤ 已落（3b-52）：探测与报问题住 `push/connection-probe-engine.ts`，码 `connection_unreachable` / `connection_settings_invalid`，QQ 官方网关连不上 `gateway_offline`（连续 60 秒才报，只进表）；手动「测试」只算恢复；细节与残余风险见 `docs/1.0/push.md`「连接通不通」 |
| 手动发一条 | `push.sendToTarget` —— 连接自测、卡片预览发送、AI 试一句、锐评投递 | 走同一套重试与 dispatcher，但**不查 routing、不落历史**，也不过静音 / 免扰（人工补发同样走它，见 ⑥） |
| 指令回复 | `CommandDef.run` 收到的 `ctx.reply`（分发器按消息现造） | **不进 `PushRouter`**：经 `TargetDispatcher.sendToAddress` 回到发指令的那条连接上的私聊；不过闸、不落历史、不重试；登录二维码也经它发图 |
| 链接解析回卡 | `createLinkPreviewer` 的 `send`（`link-preview/link-reply.ts`） | **不进 `PushRouter`**：经 `TargetDispatcher.sendToAddress` 回到收到那一帧的连接上的源群；不过闸、不落历史、不重试，连接停用或不可达就不回。这扇门叫 `LinkPreviewer`（ADR-0029，文件 `link-preview/link-previewer.ts`），回复形式「回文字」发作者名加作品文字（经作品取段的函数、限长），不带链接；`linkPreview` 设置加回总开关并留 `cooldownSec` |

devtools 的「假状态 / 截流」注入在哪些边界上，见 [devtools.md](./devtools.md)。

## 边界：谁不许知道什么

- **装配不许知道目标。** 词云照渲、AI 照问，发不发是推送层的事。认下的代价：把某个附加项的所有目标都关掉却留着总开关时，那次 AI 调用照花钱。
- **`apps/server/src/bilibili/live` / `apps/server/src/bilibili/dynamic` 不许知道 @全体。** 今天靠「特性是个裸布尔」天然挡住。
- **中立装配不许认身份、不许读平台原始数据。** `deliverPost` / `pushLiveNotify` / 两个中立出卡入口只吃中立形状，uid 或订阅 id 由调用方绑进发送与设置（作品的「还订阅着吗」回问是 `deliverPost` 自己经设置读口再问一次）。一段步骤两个来源共用 —— B 站那条以后加了什么，拓展那条自动有；往来源那头另加一步，另一边就静默漏掉（决策 66）。
- **推送层不许知道平台。** 它只认订阅 id 与 `targetId`，翻译成投递是 dispatcher 的事；订阅是哪一支它也不看（只有日志那一截按支写）。
- **MessageBus 不在这条链上。** 它走 `live-session-changed`、`post-detected` 这类状态通知去仪表盘与统计，与推送载荷两条路。方向：「发生了什么」用事件，「做 X」用直调 —— 来源把作品交给核心是直调 `PostQueue.enqueue`，`post-detected` 是入口顺手发的旁路通知，**不是装配的入口**，没有谁靠监听它来推送。

## 要改的时候

| 想干的事 | 动哪儿 |
|---|---|
| 加一把可订阅的特性 | `FEATURE_KEYS` → 扩散到 FeatureFlags / SubscriptionRouting / overrides |
| 加一个附加项 | `EXTRA_KEYS` + `PUSH_EXTRAS` 各一行；面板与收窄都按注册表自动铺开 |
| 改「发给谁」 | 只有 `sendAnchor` 里那一处（`store.findById` 后取 `routing[feature]`），和重试前的 `isStillRouted`；B 站 uid → 订阅在来源上下文的 `reportPost` / `reportLive` / `reportLiveInteraction`（`subscriptions/source-context.ts`），按 `listByIdentity` 展开 |
| 改一条作品推送的步骤（过滤 / 出卡 / 点评 / 模板 / 图集 / 回问的位置） | `posts/deliver-post.ts` 的 `deliverPost` 一处，B 站与拓展共用；别在来源那头另加一步 |
| 改作品怎么入队（谁先谁后、什么时候发 `post-detected`、哪些订阅不收） | `posts/post-queue.ts` 的 `enqueue`；「不该推」的判据在 `posts/post-settings.ts` 的 `makePostSettingsReader` |
| 改一条作品的设置怎么折（版式 / 皮肤 / 模板 / AI / 过滤覆盖） | `posts/post-settings.ts` 的 `postSettingsOf`，B 站与拓展作品共用，每条作品现折；过滤直接吃折好的 `ContentFilters`（`filterPost` 的 `PostFilterRules`），中间没有再翻译的一层 |
| 改拓展作品怎么翻、怎么过滤 | 翻：`extensions/extension-source.ts` 的 `createExtensionSource`；上报形状在 `schema/extension-report.ts`；作者缺名按「资料名 → 身份标签」补也在 `createExtensionSource`。过滤只许走 `filterPost`，**过滤与 AI 点评取的字都只经 `postText`**（`apps/server/src/posts/post-text.ts`，守卫 4 点名），别处不许自己拼作品文字 |
| 改被过滤的作品在历史里怎么记（摘要、链接、一行里有什么） | `runtime/push-history.ts` 的 `historyRecordFromFilteredPost`；状态与落盘在 `history/store.ts`（`NewHistoryEntry.filteredBy`、`computeStatus`）；面板的标签在 `apps/web/src/config/push-features.ts`，六种原因的中文在 `pages/History.tsx` |
| 改过滤规则（类型开关、关键词 / 正则 / 白名单） | `apps/server/src/posts/post-filter.ts` 的 `filterPost`：文字 `postText(post, "plain")`，类型开关只看**最外层**（`blockReposts` ← 有 `repost`、`blockArticles` ← 有 `article`、`blockImages` ← 有图集 `images`、`blockVideos` ← 有 `video`；被转发的原作品里的图集与视频归 `blockReposts` 管），对所有来源生效；正则数组每条各自判 |
| 改直播卡怎么发 | `pushLiveNotify`；**什么时候**推（场次时钟、断流接续、串行闸）在核心 `LiveSessionEngine` / `bindLivePush`，B 站来源只负责直播间连接与中立上报 |
| 改版式怎么分组、怎么拼文字 | `assembleMessageGroups` 一处 |
| 改卡片吃什么 | 出卡入口的输入（作品卡是 `Post`，直播卡是 `LiveCardInput`）；B 站的翻译在 `postFromDynamic`（`apps/server/src/bilibili/dynamic`）/ `liveDetailsFromRoomInfo`（`apps/server/src/bilibili/live/live-card-input.ts`），统一再由 `liveCardInputFromDetails`（`apps/server/src/live/live-card-input.ts`）翻成卡输入；拓展的直播详情也在 `extensions/extension-source.ts` 的 `createExtensionSource` 里由外来上报翻成 `LiveDetails`，不许让出卡入口回头去读原始数据 |
| 改一位 UP 的卡用哪套皮肤、他怎么拧它 | 皮肤 id 与这位 UP 那层旋钮覆盖（`cardSkin` / `cardSkinKnobs`，ADR-0014 决策 17）在 `postSettingsOf` / `liveSettingsOf` 里一起折，per-UP 旋钮**原样**递到每个 `generate*`、不折全局（全局随渲染器 config 热更）；两层逐枚合并只在渲染器 `renderWithSkin` 一处（`effectiveCardSkinKnobs`，预览路由用同一个函数） |
| 改历史行记谁 | `historyRecordFromSend` 按支分；行 → 订阅的回找两份实现（`currentSubscriptionOf` / `forRow`）一起改 |
| 加一个推送平台 | adapter registry，推送层一个字不动 |
| 加一个订阅平台 | 写一个订阅源拓展，这条链一个字不动（见 [subscriptions.md](./subscriptions.md)） |

🔗现状（4-55，2026-10-31）：PushRouter必填timezone回调，免扰判断按当前核心timezone的当地时分，跨午夜等原规则不变。改时区立即影响下一次判断，不移动已有到期epoch；roast/profile/dynamic墙钟cron收旧timer后按新时区未来格排，不补跑；统计60秒、首轮3秒、退避等纯间隔不重排。
