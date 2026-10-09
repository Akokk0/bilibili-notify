# 推送链路参考

一条推送从引擎产出到落进历史要过六段。这份文档是那张图与各段的**边界**。

**「为什么这么定」不在这儿** —— 数据模型在 [ADR-0011](../adr/0011-push-data-model.md)，附加项（@全体 / 词云 / AI 总结）在 [ADR-0016](../adr/0016-push-extras.md)，桥接那一档在 [ADR-0009](../adr/0009-bot-framework-bridge.md)，人工重推在 [ADR-0017](../adr/0017-manual-repush.md)，订阅源、身份与中立装配在 [ADR-0019](../adr/0019-subscription-source-opening.md)。「这个参数为什么是这个数、这个坑是在哪儿踩的」在代码注释里，离出事地点最近。这儿只画图。订阅本身（两支、两种键、资料、上报）见 [subscriptions.md](./subscriptions.md)。

## 一句话

**总开关管引擎，推送路由管发给谁，dispatcher 管怎么送达。** 三把刀各切各的，谁都不许越界。

**B 站也只是一个来源**（ADR-0019 决策 65）：① 里分**来源层**（B 站的动态 / 直播引擎、拓展作品的消费者：拉数据或收上报、时间线、计时器、过滤，各管各的）与**中立装配**（出卡 → 按版式分组 → 交给绑到订阅上的发送，谁来都走同一段）；②–⑥ 对任何来源都是同一条链，按订阅 id 走。拓展订阅的**作品**（`runtime/extension-posts.ts`，与 B 站动态同一段装配）与**直播**（`runtime/extension-live-push.ts`，与 B 站直播同一个 `pushLiveNotify`）都已接上；拓展直播「什么时候推」由 BN 为它写的计时器模块决定（决策 57 / 58 / 61 / 67），不复用 B 站直播引擎的计时器；这一场从哪开始、到哪结束（含断流接续）另算在 `runtime/extension-live-sessions.ts`，推送与统计共用（ADR-0020 决策 6）—— 推送开关只管推不推，不管这一场在不在。

## 六段

| 段 | 住哪 | 干什么 |
|---|---|---|
| ① 引擎 | `apps/server/src/bilibili/dynamic` · `apps/server/src/bilibili/live` · `apps/server/src/runtime/extension-*.ts` | 来源层只认总开关，把平台数据翻成中立输入；中立装配出卡、分组、交给绑到订阅上的发送 |
| ② 适配 | `apps/server/src/runtime/engines.ts` | 把引擎的枚举翻成推送的词；B 站那条边把 uid 翻成订阅 id；把引擎交来的一次推送（锚点）翻成推送层的 `Push` |
| ③ 路由与闸 | `packages/push` · `PushRouter.push(push)` | 交进来时判一次（订阅、总开关、静音、免扰）+ 每个锚点选目标 |
| ④ 发送 | 同上 · `sendAnchor` → `sendBatch` → `sendSequence` → `sendToTarget` | 按锚点先后、分条、重试、@全体 分流；被静音 / 免扰挡下的只记不发 |
| ⑤ 投递 | `apps/server/src/push/target-dispatcher.ts` | 按连接找 adapter，真发出去 |
| ⑥ 历史 | `onSend` → `runtime/push-history.ts` → `history/store.ts` | 一行 = 一次推送 × 一个目标 |

### ① 引擎 —— 只认总开关

直播那头 `RoomContextBase.isSubscribed(sub, type)`（`apps/server/src/bilibili/live/session/room-context.ts`）就一句 `return sub[type]`，动态那头推送订阅表只收 `sub.post` 开着的；当年按目标拦的 `hasTargets` 已删。渲不渲图、开不开 WS、攒不攒弹幕，全在这一层定；**一个目标都没配也照渲照发**，发不出去是下游的事。

引擎拿到的是宿主折叠好的订阅视图（`SubItemView`，只含 B 站订阅），每把特性是一个**顶层裸布尔**。这个扁平形状是刻意的：`apps/server/src/bilibili/live` 因此不可能知道 @全体 存在（ADR-0016 决策 6）。

**来源层**（各管各的，决策 65）：

- B 站动态：`DynamicEngine.detectDynamics`（`apps/server/src/bilibili/dynamic/dynamic-engine.ts`）拉 feed → 时间线闸 → 发 `dynamic-detected` → 开播伪动态（`DYNAMIC_TYPE_LIVE_RCMD`）**按类型**跳过、锚点照推进（从前靠出卡时抛错再认错误文案，关了出图或版式藏起卡片时它就被当普通动态推出去、和直播引擎的开播撞车）→ `postFromDynamic` 把原始动态翻成中立的 `Post`（**翻译只做一次**，过滤、AI 点评、出卡共用这一份；翻译抛错 = 这一条记 warn 跳过、锚点照推进）→ `filterPost`（过滤吃 `Post`，见下；被挡下的经引擎选项 `onPostFiltered` 交出 `FilteredPost` 留痕，见「被过滤的作品留痕」）→ `workFromDynamic` 包成 `NeutralWork` → `deliverWork`。主卡发送抛错 → `markFail`、锚点不前移、下一轮再来。
- 拓展作品：`bindExtensionPosts`（`apps/server/src/runtime/extension-posts.ts`）听 `subscription-reported` 里 `kind === "post"` 的，逐条订阅排进**这条订阅自己的串行闸**：再核还该推（订阅在、启用、拓展在跑 —— `extensionSubscriptionPushable`）→ 动态总开关关着就不出卡 → 取卡上作者名（`extensionSubscriptionName`）→ `postFromReport` 翻成中立的 `Post`（图的写盘用 `deferImageWrites` 推迟到出卡，所以被屏蔽的 / 不出卡的作品不往图库写）→ **`filterPost`**（和 B 站同一个函数，类型开关对拓展作品同样生效；被挡时经 `onPostFiltered` 留痕，不往外发任何东西）→ `extensionPostWork`（`runtime/extension-post-work.ts`）把同一份 `Post` 包成 `NeutralWork` → `deliverWork`。不判新、不去重；意外抛错只记 `[ext-post]` 错误日志、**不重试**（事件只来一次，决策 53 / 77）。
- B 站直播：`LiveEngine` / `RoomSession*` 管弹幕 WS、房间接口、周期「正在直播」（`liveStreaming` 开着才计时，间隔 `streamingIntervalHours`）/ 重启补报 / 断流接续这几个计时器。开播 / 直播中 / 下播卡由 `RoomContext.sendLiveNotifyCard`（`apps/server/src/bilibili/live/session/room-helpers.ts`）用 `liveCardInputFromRoomInfo`（`apps/server/src/bilibili/live/live-card-input.ts`，全仓唯一一份；面板的真实拉取预览 `routes/cards.ts` 也调它）把房间数据翻成 `LiveCardInput`、把「按 uid 推」绑成发送（`sendToUid`），再交 `pushLiveNotify`。翻译只交 `{ url }` 的封面（出卡前由 `fetchLiveCover` 抓），主播头像由调用方把订阅视图 `SubItemView.avatar`（宿主从订阅资料的 `cachedProfile.avatar` 抄，没有就缺键）作为 `avatar` 参数带进来、原样放进 `creator.avatar`（出卡时零网络；开播 / 直播中 / 下播 / 重启补报四处都递），人数**只收精确数、缺了就缺键**（人气读房间接口的 `online`，不补 0；点赞没收到点赞帧就没有这一格；累计观看是引擎存的 `WATCHED_CHANGE` 帧的精确数 `num`〔㉒d〕，一帧没收到就没有这一格、下播卡不画）。**观看人数一路是精确数**：`room-session` 存 `ev.num`、节流后经 `emitViewers` 发总线 `live-viewers-changed`，在播快照 `viewers` 也是它；「暂未获取到」不再写回直播数据（从前写回，下播卡会印出「累计观看人数：暂未获取到」），文字模板的 `{watched}` 缺数时由文字渲染器 `renderLiveText` 在出口印这一句、有数走 `formatCount`（B 站与拓展同一条路）。`liveData` 是会话级的，开播事件被接受那一刻（`onLiveStart`，刷房间信息与发开播卡之前）清掉上一场的观看人数与点赞，下播时不清（下播卡要用），开播时刻经 `liveTimeToIso`（`live_time` 的唯一一份解析）转成 ISO。SC / 上舰 / 特别关注各自出卡，不经它；下播的词云与 AI 总结是下播那次推送里排在卡片后面的两个附加项锚点（`RoomSessionBase.recapAnchors`：弹幕快照同步取、两样各自开始做，内容是约定），跟着下播卡经 `sendLiveNotifyCard` 的 `extras` 一次交出去 —— 串行闸只包到本体发完，附加项在推送层后台按「词云 → 总结」的先后发。醒目留言与上舰在 `RoomSession.onIncomeSuperChat` / `onGuardBuy`（`apps/server/src/bilibili/live/session/room-session.ts`）里：先由 `superchatEventFromLiveEvent` / `membershipEventFromLiveEvent` 把 B 站的原始消息翻成中立的 `SuperchatEvent` / `MembershipEvent`（醒目留言的档在这一步按价格算，上舰的档取自 `packages/internal/src/bilibili-guard.ts` 的档位表，认不出的 `guard_level` 丢弃并记警告），再过门槛（`interaction-gates.ts` 的 `passesSuperchatMinAmount` / `passesMembershipMinRank`；订阅折好的生效值是 `SubItemView.minSuperchatAmount` / `minGuardRank`，来自 `defaults.superchat.minAmount` / `defaults.membership.minRank.guard`），然后经 `ImageRenderer.generateSuperchatCard` / `generateMembershipCard`（输入 `SuperchatCardInput` / `MembershipCardInput`）出卡；上舰开了自定义文案（`templates.membership.guard`，按档的 key 取那一档的文案与图片，没填的格用体系默认，占位符 `{viewer}` / `{name}` / `{tier}`）时改发「图片 + 一句文字」。头像：主播头像读订阅视图的 `avatar`（零网络）；观众头像**只在确定要出卡时**才取，取不到只是没有观众头像、卡照出（不退文字、不抛），临时头像经引擎手里的 `imageFetcher`（引用方是「作品配图」那一家，名单恒空、靠 24 小时宽限期）：醒目留言取留言帧自带的 `user_info.face`（解析器放在 `LiveUser.avatarUrl`），上舰帧里没有，出卡前调一次 `api.fetchUserInfoInLive(观众 uid, 主播 uid)` 拿地址（两种都在 `apps/server/src/bilibili/live/viewer-avatar.ts`，头像档 480 宽、不回退原图）。面板卡片页的预览请求体里，SC 金额叫 `content.amount`、上舰那一档叫 `content.tierKey`（档的 key，服务端在档位表里找，认不出回 400）。
- 拓展直播：`bindExtensionLivePush`（`apps/server/src/runtime/extension-live-push.ts`）出每张卡时用 `liveCardInputFromReport`（`runtime/live-card-input-from-report.ts`，照 `postFromReport` 的样子）把在播表里的原件（封面与事件头像是字节、开播时刻是毫秒）翻成 `LiveCardInput`：字节经 `AppRuntime.liveImages` 存进图库、输入里只放引用，头像事件带的优先、没带的用订阅资料里的引用（都没有就没有头像，头像块收起），开播时刻转 ISO，人数报了才有。图的写盘用 `deferImageWrites` 推迟到出卡那一刻（包在渲染器外面的 `committing`）：版式藏起卡片、关了出图的直播不写盘，写盘失败 = 这一次出卡失败、降级成纯文字。`liveImages` 是图库的一家引用方，名单是**在播表里此刻那些行的封面与事件头像**（字节算得出引用）—— 直播可以播过 24 小时，周期卡几小时后还要用封面，不能像作品那样只靠宽限期；周期卡每次出卡也会再存一遍。

**中立装配**（不认 uid、不读任何平台的原始数据 —— 身份由调用方绑进发送、设置与回问）：

| 件 | 住哪 | 干什么 |
|---|---|---|
| `deliverWork` | `apps/server/src/bilibili/dynamic/work-delivery.ts` | 吃 `NeutralWork` + 这条订阅折好的设置（`WorkSubscriptionSettings`，两个来源都由 `engines.ts` 的 `dynamicWorkSettings` 折，别抄第二份）+ 绑到订阅上的推送口（`DeliverWorkArgs.push`，收一组锚点 `PostPushAnchor[]`）+ `stillSubscribed()` 回问。出卡 → AI 点评 → 再核还订阅着 → 套模板 → 按版式装配 → 组成一次推送交出去：主卡是本体锚点、图集是排在后面不带键的附加项锚点，**只交一次**。本体没交出去**往外抛**，来源自己定怎么办；图集是附加项，在推送层后台发、成败不往回抛（否则 B 站那头会整条重推、重复 @全体） |
| `createCardFailureTracker` | 同上 | 出图连续失败只提醒一次的计数。`engines.ts` 里**全进程一份**，传给 B 站动态引擎（`cardFailures`）也交给拓展作品 —— 同一个渲染器，同一次故障只提醒一遍。告警的 `engine-error` 来源各算各的：拓展作品单列 `extension-post`（主人私聊按来源 60 秒节流，共用的话一边刚报过、另一边就被吞） |
| `pushLiveNotify` | `apps/server/src/bilibili/live/live-notify.ts` | 吃 `LiveCardInput` + 文案 + 链接 + 版式 + 绑到订阅上的发送（`LiveNotifySend`）；出卡 → 分组 → 发送。**什么时候推不在这里**（计时器、断流接续、串行闸归来源，决策 67） |
| `assembleMessageGroups` | `packages/internal/src/schema/message-layout.ts` | 按版式把卡 / 文字 / 链接装成消息组；上面两段共用这一份 |
| `createSerialGate` | `apps/server/src/bilibili/live/session/serial-gate.ts` | 串行闸：送达次序 = 发起次序，防「下播卡晚于新一场开播卡」的倒序。B 站按房间过闸（`RoomSessionBase.enqueuePush`）；拓展作品按订阅过闸（`bindExtensionPosts`，先报的那条出卡慢也先送到）；拓展直播同样按订阅（`bindExtensionLivePush`，决策 67） |
| 出卡入口 | 作品卡：`ImageRenderer.generatePostCard(post)`（吃中立的 `Post`；B 站动态先经 `apps/server/src/bilibili/dynamic` 的 `postFromDynamic` 翻成 `Post`、出卡前再经 `apps/server/src/bilibili/images.ts` 的 `fetchPostImages` 把图抓进图库（同一步还处理头像：外层作者读订阅视图 `SubItemView.avatar` 的引用、零网络；转发的原作者通常不是订阅的人，按 `repostAvatarUrlOf` 从原始动态读出的地址与配图同一并发上限现抓，抓不到就不画；正文表情同理，地址由 `emojiUrlsOf` 从原始动态读出（含被转发的原动态），表情那一档缩放（128 宽）抓、填进表情片段的 `image`，抓不到的卡上画文字），链接预览直接造 `Post`）；拓展作品经 `apps/server/src/runtime/post-from-report.ts` 的 `postFromReport` 翻成 `Post` 再走同一个 `generatePostCard`（图先存进图库）。直播卡：`ImageRenderer.generateLiveCard(input)`（**只此一个入口**，吃中立的 `LiveCardInput`；B 站先经 `apps/server/src/bilibili/live` 的 `liveCardInputFromRoomInfo`（封面出卡前由 `fetchLiveCover` 抓进图库）、拓展先经服务端的 `liveCardInputFromReport` 翻成它） | 不收平台原始数据。`Post` 里的图只认图库引用（`PostImage.ref`、`Creator.avatar`、正文小图标与表情、附加块文字行图标），出图器出卡前经宿主注入的 `resolveImageRef`（`images/image-data-url.ts`：引用 → 读字节 → data URL）事先解析；没有引用只有网址的图画占位，data URL 原样进卡 —— 出图器不联网（3a-37）：渲染页的请求闸在浏览器适配层 `runtime/puppeteer.ts`，每一页都开、只放行 `data:`，别的请求掐断，出图器按卡汇总记一条警告；解析不到的引用画占位，不拖累整张卡。**直播卡同理但兜底不同**：`cover: PostImage` 有 `ref` 认解析结果、解析不到当成没有封面（画直播专属的「暂无封面」占位、`live.hasCover` 为假，不退回 `url`），只有 `url` 原样用；`creator.avatar` 解析不到或没有，头像块整块收起；主人设的自定义直播封面优先级最高。`startedAt` 是 ISO、读不懂当没有开播时刻，数字格只收精确数（缺了那一格不画） |

拓展作品翻成作品的规矩（`extension-post-work.ts` 包成中立作品、`post-from-report.ts` 翻 `Post`，决策 55 / 68 / 69 / 71 / 72 / 77，ADR-0021 决策 22 下 10-05 的 🔗）：出卡时才翻（`renderCard` 被调到才存图，关了出图 / 版式藏起卡片时不白写盘）；第一个话题进 `Post.topic`（正文上方的话题标签），正文里照上报的话题名找到的 `#名字#` / `#名字` 切成 `RichText` 的 `topic` 片段（`plainTextSegments`，BN 不按 `#` 自己猜）；带视频就带 `video` 与 `label: "投稿了视频"`；互动数照搬成数字、排版归出图器；配图 / 视频封面 / 事件带来的作者头像经 `AppRuntime.postImages`（图库的一家引用方，**名单恒空**——作品是在途数据，图靠新图 24 小时宽限期活到卡画完，之后由清扫收走）存进图库，`PostImage` 只放引用与宽高（`readImageSize` 读文件头）、gif 标动图；只存前 9 张（`GALLERY_MAX_IMAGES`），其余只占张数给 `+N`；图库不收的图（格式不认 / 超 8 MiB）没有 `ref` 也没有 `url`，出图器画占位；磁盘写失败是抛错（这一次出卡失败，装配降级成纯文字）；链接部件是事件的 `url`；**不附图集**（图集载荷只带网址，拓展交的是字节）；AI 看作品图 + 视频封面，单张超 3 MiB 跳过、最多 `WORK_COMMENT_IMAGES_MAX`（4）张。卡上作者与 `{name}` 走 `extension-push-common.ts` 的 `extensionSubscriptionName`：名字依次取事件里的作者名 → 资料名 → 外部 id（别名已退役，ADR-0021 决策 16；`notes` 是备注，**不当名字用**）；头像事件带了字节就存进图库用它，否则用资料里引用的那一张（没有就没有头像块）。

### ② 适配 —— 唯一同时懂两套词的地方

引擎说 `LivePushType`，推送层说 `FeatureKey`。翻译只在这一处，一进来分出两样（`livePushHead`）：

| 函数 | 产出 | 管什么 |
|---|---|---|
| `liveTypeToFeature` | `FeatureKey` | 开关与路由 |
| `liveTypeAllowsAtAll` | `boolean` | 允不允许 @全体（不允许就给这次推送带 `allowAtAll: false`） |

附加项不靠推送类型认：引擎交来的锚点自己带着附加项的键（`LivePushAnchor.extra`，词云 `wordcloud`、总结 `liveSummary`），`toPushAnchors` 把角色与键原样带过去、内容（现成的或约定）逐条翻成载荷。`LivePushType` 里原先给词云 / 总结用的 5、10 两档已删。

历史行记的就是特性键（⑬f 起没有单独的推送种类）：开播（3）→ `liveStart`、可以 @全体；重启补报（`CatchUp`，11）→ `liveStart`、不 @全体，卡与文字仍是「正在直播」那一套；周期「正在直播」（0）→ `liveStreaming`、不 @全体。⚠️ **本体那个锚点不带附加项的键** —— 带上键的话整张卡会被那张附加项三态表收窄掉。

动态端同理：主卡是本体锚点，图集是 `role: "extra"`、不带键的锚点。附加项锚点永不带 @全体，所以一条 DRAW 动态不会在主卡和图集各 @ 一次。

身份也在这儿翻：引擎说的是 B 站 uid，推送链认的是**订阅自己的 id**（ADR-0019 决策 50）。两个适配器（`makeDynamicPushLike` / `makeLivePushLike`）先用 `subscriptionIdOfUid`（按 `{ 来源: B 站, 外部 id: uid }` 的身份 `findByIdentity(...)?.id`）翻一次，查不到就不往下交，只记一行 debug「uid=… 无订阅记录，跳过」。同一个 uid 配了两条订阅时，引擎那侧先出现的那条说了算 —— 引擎本来就只按 uid 认人。

**把推送钉到一条订阅上**的两件也在 `engines.ts`，挨着这两个适配器：`boundPostPush(push, subscriptionId)` 回 `deliverWork` 要的那个推送口（锚点 → `Push`，段 → 载荷、特性恒为 `post`）；`boundLivePush(push, subscriptionId)` 回 `pushLiveNotify` 要的 `LiveNotifySend`（只有本体那一个锚点，特性键与 @全体 照 `livePushHead`）。B 站动态（`makeDynamicPushLike` 先翻 uid）与拓展作品（`pushFor(id)`）走的是同一跳；B 站直播（`makeLivePushLike`）与拓展直播（`sendFor(id)`）用同一套映射。

拓展订阅不需要翻身份：它的上报在 ctx 那一步已经按 `(拓展, 外部 id)` 对到订阅 id 上（见 [subscriptions.md](./subscriptions.md)）。事件种类到特性键的映射是 `SUBSCRIPTION_EVENT_FEATURES`（`packages/internal/src/constants.ts`：`post → post`、`liveStart → liveStart`、`liveEnd → liveEnd`）；拓展订阅能有哪些特性看 `featuresForEvents`（同文件）：照这张表映射，声明了开播与下播两种事件的再加一把 `liveStreaming`，面板与服务端用同一份。

### ③ 路由与闸

一次推送整个交给 `PushRouter.push(push)`：`Push = { subscriptionId, feature, allowAtAll?, anchors }`，`anchors` 是按顺序排好的锚点（`PushAnchor = { role, extra?, messages }`：本体至多一个且排第一个，其余是附加项；`messages` 是现成的一串载荷或一个约定）。它全仓只有 **3 个调用点**，全在 `engines.ts`：`boundPostPush`（B 站动态、拓展作品）、`boundLivePush`（拓展直播）、`makeLivePushLike`（B 站直播）。

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

**被过滤的作品留痕**（ADR-0021 决策 34 的 🔗）：过滤挡下一条作品，历史里记一行 `filtered` —— **一条订阅一行**（不按目标拆）、`targetId: null`、`feature: "post"`、自己的 `pushId`（不对应任何推送）、行上 `filteredBy`（六种 `PostFilterReason`，词表在 `packages/internal/src/post.ts`）、一条 `role: "main"` 的文字（摘要 + 换行 + 原帖地址，没有 `result` 也没有 `isSilenced`）。只留痕：不出卡、不抓图、不调 AI、不存重推原件，不能补发；不算推送也不算失败（`countsAsDelivery` / `countsAsFailure` 都是假）；写一次就完，不和别的行合并、不进历史仓的 `open` 表、之后不追加。它**不经推送层、不走事件总线**：B 站动态引擎从选项 `onPostFiltered` 交出 `FilteredPost { uid, filteredBy, text, url }`（`text` 是 `postText(post, "plain")` 整条、没截过，`url` 是动态页），`engines.ts` 把 `uid` 换成订阅 id；拓展作品在 `bindExtensionPosts` 里过滤，同样经它的 `onPostFiltered`（带订阅 id 与上报里的作品地址）。两头都接到 `runtime/push-history.ts` 的 `historyRecordFromFilteredPost`：身份与名字 / 头像快照的取法同 `historyRecordFromSend`，摘要在这儿截（`POST_SUMMARY_MAX_CHARS`，按字符），查不到订阅不记。行落下后照发 `history-recorded`，面板不为它弹小卡。被过滤的作品只留这一行，不往任何目标发东西（从前引擎里有一句「某某发了一条被屏蔽的作品」的提醒，10-08 删了；它从来没有设置项，面板上也没有过开关）。

静音期间的落盘量：凡是走这条链的推送（作品、开播 / 正在直播 / 补报 / 下播与它的词云、总结、上舰、醒目留言、特别弹幕、特别进场，以及拓展的作品与直播）在静音或免扰里每条都会落行、存原件，卡片图进图库；文字不设上限，图与原件按保留天数清。

## 附加项：生产与推送是两个问题

**@全体 没有「生产」这一步** —— payload 是发的时候现拼的，零成本，所以它只有「推不推」。词云 / AI 总结有三道，全在引擎侧、全看折叠值、**一个目标都不看**：

1. **攒不攒弹幕**（开播那一刻）：下播开着且两个附加项至少一个开着。
2. **要不要算**（下播那一刻）：下播总开关 + 各自那把键。
3. **算出来了吗**：生产者自己会弃权 —— 词云在热词不足 / 出图关着 / 渲染失败时回 `undefined`；总结只在发言人数不足时回 `undefined`（**AI 关着或失败会回落到模板，不算弃权**）。

产出是 `undefined` 的那个锚点**直接跳过**（约定给了 `undefined`）。这跟「附加项收窄成空」那道闸看起来一样（都没消息、都不落行），但成因相反：一个是**没东西可发**，一个是**有东西没人要**。排查先看日志是 `[wordcloud] 热词不足` 还是 `附加项 wordcloud 无人订阅`。

## 不走这条链的三条旁路

| 旁路 | 入口 | 差在哪 |
|---|---|---|
| 主人私聊 | `PushRouter.notifyMaster`（文字或消息体，回结果形状） | 主人目标只许是私聊目标（保存时拒收、发送时复检），走普通的 `send`；**不受全局静音管**（指令回复 3a-19 起不走这条，见下面「指令回复」一行）—— 挡掉的话主人只会看到指令毫无反应 |
| 手动发一条 | `push.sendToTarget` —— 连接自测、卡片预览发送、AI 试一句、锐评投递 | 走同一套重试与 dispatcher，但**不查 routing、不落历史**，也不过静音 / 免扰（人工补发同样走它，见 ⑥） |
| 指令回复 | `CommandDef.run` 收到的 `ctx.reply`（分发器按消息现造） | **不进 `PushRouter`**：经 `TargetDispatcher.sendToAddress` 回到发指令的那条连接上的私聊；不过闸、不落历史、不重试；登录二维码也经它发图 |
| 链接解析回卡 | `createLinkParser` 的 `send`（`runtime/link-reply.ts`） | **不进 `PushRouter`**：经 `TargetDispatcher.sendToAddress` 回到收到那一帧的连接上的源群；不过闸、不落历史、不重试，连接停用或不可达就不回 |

devtools 的「假状态 / 截流」注入在哪些边界上，见 [devtools.md](./devtools.md)。

## 边界：谁不许知道什么

- **引擎不许知道目标。** 词云照渲、AI 照问，发不发是推送层的事。认下的代价：把某个附加项的所有目标都关掉却留着总开关时，那次 AI 调用照花钱。
- **`apps/server/src/bilibili/live` / `apps/server/src/bilibili/dynamic` 不许知道 @全体。** 今天靠「特性是个裸布尔」天然挡住。
- **中立装配不许认身份、不许读平台原始数据。** `deliverWork` / `pushLiveNotify` / 两个中立出卡入口只吃中立形状，uid 或订阅 id 由调用方绑进发送、设置与「还订阅着吗」的回问。一段步骤两个来源共用 —— B 站那条以后加了什么，拓展那条自动有；往来源那头另加一步，另一边就静默漏掉（决策 66）。
- **推送层不许知道平台。** 它只认订阅 id 与 `targetId`，翻译成投递是 dispatcher 的事；订阅是哪一支它也不看（只有日志那一截按支写）。
- **MessageBus 不在这条链上。** 它走 `live-state-changed` 这类状态通知去仪表盘，与推送载荷两条路。

## 要改的时候

| 想干的事 | 动哪儿 |
|---|---|
| 加一把可订阅的特性 | `FEATURE_KEYS` → 扩散到 FeatureFlags / SubscriptionRouting / overrides |
| 加一个附加项 | `EXTRA_KEYS` + `PUSH_EXTRAS` 各一行；面板与收窄都按注册表自动铺开 |
| 改「发给谁」 | 只有 `sendAnchor` 里那一处（`store.findById` 后取 `routing[feature]`），和重试前的 `isStillRouted`；B 站 uid → 订阅 id 在 `engines.ts` 的 `subscriptionIdOfUid` |
| 改一条作品推送的步骤（出卡 / 点评 / 模板 / 图集 / 回问的位置） | `deliverWork` 一处，B 站与拓展共用；别在来源那头另加一步 |
| 改一条作品的设置怎么折（版式 / 皮肤 / 模板 / AI / 过滤覆盖） | `engines.ts` 的 `dynamicWorkSettings`，B 站视图与拓展作品共用；过滤直接吃折好的 `ContentFilters`（`filterPost` 的 `PostFilterRules`），中间没有再翻译的一层 |
| 改拓展作品怎么翻、怎么过滤 | 翻：`post-from-report.ts`（上报 → `Post`，含话题切段与图库写盘推迟）、`extension-post-work.ts`（包成 `NeutralWork`）；作者与名字：`extension-push-common.ts`（拓展直播也要用）；过滤只许走 `filterPost`，**过滤与 AI 点评取的字都只经 `postText`**（`packages/internal/src/post.ts`，守卫 4 点名），别处不许自己拼作品文字 |
| 改被过滤的作品在历史里怎么记（摘要、链接、一行里有什么） | `runtime/push-history.ts` 的 `historyRecordFromFilteredPost`；状态与落盘在 `history/store.ts`（`NewHistoryEntry.filteredBy`、`computeStatus`）；面板的标签在 `apps/web/src/config/push-features.ts`，六种原因的中文在 `pages/History.tsx` |
| 改过滤规则（类型开关、关键词 / 正则 / 白名单） | `apps/server/src/bilibili/dynamic/post-filter.ts` 的 `filterPost`：文字 `postText(post, "plain")`，类型开关只看**最外层**（`blockReposts` ← 有 `repost`、`blockArticles` ← 有 `article`、`blockImages` ← 有图集 `images`、`blockVideos` ← 有 `video`；被转发的原作品里的图集与视频归 `blockReposts` 管），对所有来源生效；正则数组每条各自判 |
| 改直播卡怎么发 | `pushLiveNotify`；**什么时候**推（计时器、断流接续、串行闸）在来源那头：B 站是 `apps/server/src/bilibili/live` 的 `room-session*` |
| 改版式怎么分组、怎么拼文字 | `assembleMessageGroups` 一处 |
| 改卡片吃什么 | 出卡入口的输入（作品卡是 `Post`，直播卡是 `LiveCardInput`）；B 站的翻译在 `postFromDynamic`（`apps/server/src/bilibili/dynamic`）/ `liveCardInputFromRoomInfo`（`apps/server/src/bilibili/live`），拓展直播的翻译在 `liveCardInputFromReport`（`apps/server/src/runtime/`），不许让出卡入口回头去读原始数据 |
| 改一位 UP 的卡用哪套皮肤、他怎么拧它 | 皮肤 id 与这位 UP 那层旋钮覆盖（`cardSkin` / `cardSkinKnobs`，ADR-0014 决策 17）在 `dynamicWorkSettings` / `liveWorkSettings` 里一起折，per-UP 旋钮**原样**递到每个 `generate*`、不折全局（全局随渲染器 config 热更）；两层逐枚合并只在渲染器 `renderWithSkin` 一处（`effectiveCardSkinKnobs`，预览路由用同一个函数） |
| 改历史行记谁 | `historyRecordFromSend` 按支分；行 → 订阅的回找两份实现（`currentSubscriptionOf` / `forRow`）一起改 |
| 加一个推送平台 | adapter registry，推送层一个字不动 |
| 加一个订阅平台 | 写一个订阅源拓展，这条链一个字不动（见 [subscriptions.md](./subscriptions.md)） |
