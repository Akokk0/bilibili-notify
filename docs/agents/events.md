# 事件契约参考

跨插件事件、MessageBus 语义、独立端 WS channel 契约。CLAUDE.md 的渐进式披露目标之一。

## BusEvents

规范契约在 `packages/internal/src/platform.ts#BusEvents`:事件名 → 载荷。载荷一律是一个具名对象(没有载荷的是 `undefined`),`bus.emit(事件, 载荷)`、`bus.on(事件, 载荷 => …)`,不用位置参数。独立端把这批事件接到 WS channel(见文末)。

载荷里不许带 B 站的形状(`uid` 键、`Bili*` 类型、平台原始值的裸 string):守卫 `scripts/__tests__/bus-event-payloads.test.mjs` 走类型检查器逐个载荷查,开张时的违规记在它的棘轮表里,3b 末清零。

| 事件 | 说明 |
|---|---|
| `subscription-auth-changed` | `{ sourceKey, state }`:一个来源的登录状态或账号变了。**谁发**:只有宿主(`subscriptions/builtin-sources.ts`)——来源登记成功后订阅它的 `auth.onChange`,撤登记时先摘;来源不碰总线,发的口由 `engines.registerSource` 递进去;登记时不补发,面板进来走 `GET /api/sources/:sourceKey/auth`。**什么时候**:来源自己保证「对外的状态与账号都没变就不叫」(B 站:映射后的 `AuthState` 与 `account()` 的结果都没变不叫),宿主不替它去重。**听的**:WS `auth` 频道,与统计的 `stats/registry-source.ts`(3b-26:现读登录口,变化时重看「这个小时在记」、登录丢了就忘在飞场次)。**载荷**:`state` 是那一刻完整的中立 `AuthState`(取值在 `status` 里;`awaiting-scan` 带二维码的 `dataUrl`,`confirming` / `error` / `expired` 带服务端给的 `message`),不带账号(名字、头像走 `GET`),cookie 与令牌永远不在里面。独立端转成 `auth` WS channel 的同名帧,`data` 就是这个对象。替掉了原来的 `login-status-report` 与 `cookies-refreshed`(3a-29 B 站半):续期落盘成功只记一行 info「登录续期已落盘」,没有读者要它上总线 |
| `auth-lost` / `auth-restored` | **3b-47 已删**:`LoginFlow` 不再发这两条总线事件;B 站动态引擎与 `BiliLiveRooms` 改听 `watchLoginEdges`,由登录口 `auth.onChange` 收成登录掉线与恢复两条边 |
| `subscription-changed` | `{ ops }`:`SubscriptionStore` CRUD 后的 `SubscriptionOp[]` diff |
| `config-changed` | `{ scope }`:独立端 `ConfigStore` 写入后发出;scope ∈ `globals\|subscriptions\|targets\|connections\|secrets`。引擎据此 reconcile cron / 刷新状态 / 重建连接 |
| `engine-error` | 引擎或子系统的运行时错误 `{ source, message }`。`master-notifier`(→ master 私聊)+ `log` WS channel(→ AlertShell)消费。**谁发(3a-30 之后)**:`runtime/engines.ts` 里作品投递出图失败(`source: "post-delivery"`,文案带「已降级为纯文字推送」的提示),加开发场景 `engine.error`。直播引擎不再发它；B 站动态与直播的未登录、风控、拉动态失败、停监、受限房、放弃监听**不再发它**,改走问题表(`problems-changed`)。所以面板右上角的红条今天不再显示这些 |
| `problems-changed` | `{ reporter }`:问题表里这个报的人(来源键;核心自己报的设置读不懂那一条,报的人是 `core`)名下的问题变了(开了、换了文案、清了)。**谁发**:只有 `runtime/bootstrap.ts` 里问题表的 `onChanged`(表自己不碰总线);**按报的人合并**,第一次变起算 250ms 窗口,窗口里再变的只在尾沿发一次、不往后推(`PROBLEMS_CHANGED_COALESCE_MS`,与别的合并事件各算各的)。载荷里没有问题内容:独立端转成 `state` WS channel 的同名帧,面板据此让订阅列表过期、重取;订阅回应带着挂在该条订阅上的 `problems`,面板不直接读 `/api/problems`。问题通知器不听这个事件,它订的是表的 `subscribe`(每次变化当场叫、不合并)。不是转发器:没有任何东西把 `problems-changed` 翻回 `subscription-changed` |
| `history-recorded` | `HistoryStore.record` 建起一行(一次推送 × 一个目标,本体落地那一刻;无目标行也建)时发出的完整 `HistoryEntry`;独立端转到 `push-events` WS channel。`PushRouter.onSend` 每个目标一段回调 → `runtime/push-history.ts` 搬字段 → `record`。被过滤的作品留痕的那一行(`status: "filtered"`、带 `filteredBy`、`targetId: null`)也从这个事件出来,它不经 `PushRouter`:核心装配(`deliverPost`)的 `recordFiltered` → `historyRecordFromFilteredPost` → `record` |
| `history-updated` | 同一次推送的后续消息(@全体 / 图集 / 词云 / 总结)追加到已有那一行之后发出的**合并后整行**;前端按 `id` 换缓存、小卡同 id 换字不重弹。盘上是补丁行,读时并回 |
| `post-detected` | 核心入口 `PostQueue.enqueue`(`apps/server/src/posts/post-queue.ts`)对**每条订阅**发一份 `PostEvent{subscriptionId, identity, postId, url, post, postNoun?}`(`post` 里的图已是图库引用,来源交出之前就抓好 / 写好)。**谁发**:只有这一个入口,B 站动态引擎与拓展作品绑定交一条作品它就发一次(同步发)。**什么时候**:订阅过了设置读口 —— 在、启用着、作品开关开着、来源在跑 —— 之后;排在串行闸与过滤**之前**,所以口径是「UP 发了多少」,被屏蔽或推送失败的作品照样算产出(「我们推了多少」看 `history-recorded`,两者不可混用)。**对哪些订阅**:不该推的(不在 / 停用 / 开关关着 / 来源没在跑 / 队列已关)一概不发、也不推;同一个 UP 的遗留重复订阅各发一份(3a-28 起:来源上下文的 `reportPost` 按身份取全部订阅、逐条入队,各过各的设置读口,所以各推各的、统计各记各的;一条停用或关了作品开关只丢它自己那份。3a-27 的过渡期是只发先出现的那一条)。开播伪动态、翻译失败的动态来源就不交,没有事件。**只发一次**:没有「失败 → 下一轮重发」(引擎不重试、也不按投递成败决定时间线),统计仓仍按 `id` 幂等(`StatsStore.appendPost`,读的时候再按 `id` 去重一次),新消费方同样需要按 `id` 去重。**它是旁路通知,不是装配的入口**:装配由来源直调 `enqueue` 走,没有谁靠监听这个事件来推送(方向:「发生了什么」用事件,「做 X」用直调)。**谁在听**:统计(`stats/recorder.ts` 里**一个**监听,B 站与拓展两支共用,文件键是订阅 id;`postEntryFromEvent` 照事件记一行:有无视频看 `post.video`、发布时间取 `post.publishedAt`、多收的链接 / 标题 / 摘要 / 话题 / 视频时长经 `post-entry-extras.ts`;开播预约 `DYNAMIC_TYPE_LIVE` 记成不带视频的作品,自动开播推送 `DYNAMIC_TYPE_LIVE_RCMD` 来源不交) |
| `live-viewers-changed` | 场次引擎把开播、在播状态、断流接续、周期核对带来的 `currentViewers` / `totalViewers` 原样发出：载荷是 `{ subscriptionId, currentViewers?, totalViewers? }`，两个都是精确数；信号或核对至少带了一个人数才发，并且只带这一份带来的格。独立端转成 `push-events` 同名帧；面板按订阅 id 就地补在播行的 `totalViewers`，此刻在线不画。排成「1.2万」由消费方走 `formatCount`，字符串解析只留在迁移 |
| `live-session-changed` | 核心 `LiveSessionEngine` 的每一次变化：`start`、`tick`、`resume`、`status`、`ending`、`end`、`unmatched-end`。载荷是 `LiveSessionChange`（`packages/internal/src/live.ts`），与引擎交给进程内监听者的同一份中立纯数据投影；每支都带 `subscriptionId`，时刻都是 ISO，状态判定叫 `isLive`，结束时刻叫 `endedAt`。它与推送开关无关，订阅在、启用着、来源在跑才由引擎记场次；`session.interactions` 汇总本场弹幕、醒目留言与会员数，会员与醒目留言不再各开总线事件。独立端把每一帧原样转进 `push-events`；面板在入表 / 出表的 `start`、`resume`、`end`、`unmatched-end` 与下播 `status` 时让在播快照失效重取，在播 `status` 与 `tick` 时就地补标题、分区和累计观看。统计的中立监听（`stats/live-source.ts`）据此开一场、结束一场：开播取 `session.startedAt`，解析不出或晚于此刻时退回 `session.detectedAt`；结束只认 `end`，时刻取 `endedAt`、峰值取 `session.peakTotalViewers`。订阅不在时只忘内存，删文件跟 `subscription-changed`。B 站登录失效时由 B 站适配叫 `forgetOpenSessions("bilibili")`，之后这一场的 `end` 不写，恢复后再观测到同一场仍按开播时刻认出 |
| `extension-stopped` | 某个拓展不在跑了(停用 / 卸载 / 换代码 / 加载失败 / 设置读不了 / 关机)—— 它那面 ctx **开始收摊的那一刻**发,每面 ctx 一次,之后它的上报一概拒。「不在跑了」只认收摊这一处(`CreateExtensionContextOptions.onDisposed` → 装载器 `onStopped` → index.ts 发 bus),不在装载器的每条路上各记一遍。载荷 `{ extensionId }`;在播表据此清掉它名下的在播(ADR-0019 决策 61)。不进 WS |
| `followers-refreshed` | `{ entries: FollowersRefreshEntry[] }`:独立端 `ProfileRefresh` 的完整快照 —— 首页粉丝面板,一条订阅一行、**键是订阅 id**(ADR-0020 决策 8)。每条精确带 `{ subscriptionId, identity, current, refreshedAt, deltaSubscribed, delta24h, delta7d }`;`identity` 是来源键 + 外部 id,B 站与拓展同一种形状,`current` 取资料缓存,`refreshedAt` 是它的时刻。三种增量都从同一个粉丝时序算,「订阅以来」是当前减第一条样本,起点缺失及 24h / 7d 窗口无样本时为 `null`;B 站与拓展同一算法。每个 tick 发一次、开机恢复发一次、删订阅当场发;`subscription-profiles-changed` 时只重算变了的几条再发。统计关着时仍刷新资料与当前粉丝数,但粉丝样本、「在记」与 24h / 7d 增量不落盘 |
| `ready` | 业务核心完全启动 |
| `extension-status-changed` | 某个拓展喊了 `ctx.statusChanged()`(桥:一条接入连上 / 断开)。**按拓展合并**:第一喊起 250ms 窗口里的连喊只在尾沿发一次(`STATUS_CHANGED_COALESCE_MS`,窗口不随后来的喊往后推),收摊时挂着的那一发清掉。载荷 `{ extensionId }`;独立端转成 `state` WS channel 的同名帧,面板按 id 失效 `/api/ext/<id>/status` 与 bot 名单的缓存后自己重取 —— 数据本身不上 bus |
| `extension-settings-changed` | 某个拓展的设置经 `PATCH /api/ext/<id>/settings` 写进去了(ADR-0019 决策 35)。载荷 `{ extensionId }`;独立端转成 `state` WS channel 的 `extension-settings-changed` 帧,面板按 id 失效它的设置与视图(面板改走新口的那一片才接上,在那之前这一帧没人听)—— 设置里有密钥,数据本身不上 bus、不进帧。这是宿主自己知道的事实,不替拓展判视图变没变 |
| `extension-report-discrepancies-changed` | 某个订阅源拓展的「上报出入」(ADR-0019 决策 60:丢格、整条拒,ctx 里唯一那个出口 `recordDiscrepancy` → `onReportDiscrepancy`)新记了几条。记录在 `extensions/report-discrepancies.ts`(每个拓展最近 20 条,只在内存,卸载清空),**按拓展合并**:第一条起 250ms 窗口里再记的只在尾沿发一次(`REPORT_DISCREPANCIES_CHANGED_COALESCE_MS`,窗口不往后推,与 `extension-status-changed` 各算各的)。载荷 `{ extensionId }`;独立端转成 `state` WS channel 的同名帧,面板只让拓展表失效(框住在 `ExtensionDTO.reportDiscrepancies` 上)。**不借 `extension-status-changed`**:那一声说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表 |
| `subscription-profiles-changed` | 来源报的资料更新(`ctx.reportProfile`)经 `runtime/reported-profiles.ts` 与 `runtime/profile-cache.ts` 落进资料缓存(给了哪格改哪格、头像缺着时沿用)之后,面板看得见的名字 / 头像 / 粉丝**真变了**的订阅 id,载荷 `{ subscriptionIds }`(ADR-0019 决策 7 / 49 / 62)。按 250ms 窗口合并(拓展起来时可能一口气报一百条)。独立端转成 `state` WS channel 的同名帧,面板失效订阅列表重取;资料刷新据此重算这几条订阅在首页粉丝面板上的那一行、发 `followers-refreshed`。🔴 **资料不是配置,不发 `config-changed "subscriptions"`** —— 那一档会重建路由表、通知拓展「名下订阅变了」、让引擎 reconcile |

## MessageBus 语义

`apps/server/src/runtime/message-bus.ts` 的 `NodeMessageBus`(mitt 风格)是业务核心**唯一**的事件通道:引擎、订阅仓、推送路由都只对它 `emit` / `on`。

**关键约束:绝不要在 bus 与任何别的事件通道之间写转发器**(`bus.on(X) → other.emit(X)` 且反向也接)—— 会自喂死循环、爆栈。当年 koishi 插件里 bus 与 `ctx` 是同一条通道的两个视图,这条铁律就是那里立下的;独立端的 WS channel 是单向的下游,不回灌 bus。回归测试:`apps/server/src/runtime/__tests__/message-bus.test.ts`。

## 独立端 WS channel 契约

信封:`{ type: <channel>, event: <name>, ts, data }`。每个频道有哪些事件、`data` 长什么样,住在 contract 的事件表 `WsEvents`(`apps/contract/src/ws.ts`):总线转来的事件与总线同名,`data` 就是总线的载荷(没有载荷的是 `null`);历史行投影成 `HistoryEntryView`;`hydrate`、资源采样、日志行是服务端自己造的。服务端经 `ws/channels.ts` 的 `envelope(频道, 事件, data)` 造帧,面板用 `services/ws.ts` 的 `isWsEvent(env, 频道, 事件)` 判帧,`data` 都按这张表定型,不手写类型断言。

`resources` 是唯一一条**按订阅开关采样**的:订阅那一刻发一帧 `hydrate`(静态量 + 近 5 分钟缓冲),之后每 tick 一帧 `sample`;名册空了服务端就摘掉采样监听(浏览器子树那一项要起子进程)。前端相应地有 `unsubscribeChannels`,别的频道整个会话都开着、不用它。

| Channel | 来源 | 前端消费者 |
|---|---|---|
| `auth` | `subscription-auth-changed`(这个频道只有这一种帧;`auth-lost` / `auth-restored` 与已退役的 `login-status-report` / `cookies-refreshed` 都不在) | `useAuthChannel` → 按帧里的 `sourceKey` 把 `state` 写进 `["source-auth", sourceKey]` 那条查询缓存并让它失效重取(账号与头像只走 `GET`);重连后 `state` 频道的 `hydrate` 让整个 `["source-auth"]` 前缀失效 |
| `push-events` | `history-recorded` / `history-updated` / `live-session-changed` / `live-viewers-changed` / `followers-refreshed` | `usePushEventsChannel` → tanstack-query `setQueryData` 补丁(recorded 头插 + 日桶 +1,无目标行不计;updated 按 id 换行、不插);场次进出或下播让「正在直播」失效重取,在播状态、周期核对与人数变化就地补对应订阅那一行 |
| `log` | `engine-error` + 每条 `logger.<level>`(在单一 fan-out 点脱敏,同时归档进 LogStore jsonl) | `useAlertChannel`(engine-error → AlertShell)+ `useLogChannel`(全量流 → Logs tab) |
| `state` | `hydrate`(订阅 / 重连时)+ `config-changed`(只带 scope)+ `extension-status-changed` / `extension-settings-changed` / `extension-report-discrepancies-changed`(都只带 `extensionId`)+ `subscription-profiles-changed`(只带 `subscriptionIds`)+ `problems-changed`(只带 `reporter`,3a-30) | `useStateChannel` → 按 scope / 按拓展 id invalidate tanstack-query 缓存;上报出入变了失效拓展表;资料或问题变了失效订阅列表 |
| `resources` | `ResourceMonitor` 每 2 秒一份系统资源样本(宿主机 / 本体 / 浏览器子树) | `useResourcesChannel` → 概览页「系统资源」卡 |

## 推送历史的行模型

一行 = 一次推送 × 一个目标(`HistoryEntry`,schema 在 `packages/internal/src/schema/history.ts`):`pushId` 串起同一次推送的几个锚点(下播卡 → 词云 → 总结;动态主卡 → 图集),`feature` 是这次推送的特性键(`post` / `liveStart` / `liveStreaming` / `liveEnd` / `membership` / `superchat` / `viewerChat` / `viewerEnter`;0.x 存的推送种类由迁移翻过来),`targetId` 可空(空 = 无目标行或被过滤的行,分哪一种看 `status`),`messages[]` 每条带 `role`(`main` 本体 / `extra` 附加项)与结果;被全局静音 / 免扰时段挡下的那几条带 `isSilenced: true`、没有结果。六态 `status`:全到 = `delivered`;第一条本体没到 = `failed`;本体到了、别的没到 = `partial`;`no-targets`;本体被挡下 = `silenced`(一条都没发,不算推送也不算失败,可以补发);作品被过滤挡下 = `filtered`(行上 `filteredBy` 记原因,一条订阅一行、只有一条文字,只是留痕,不算推送也不算失败,不能补发)。特性关着与无订阅**不**回调、不落行 —— 那不是「无目标」;静音 / 免扰挡下的照落行,两个 WS 事件照发(面板不为它弹小卡)。0.x 的老格式行(`source` / `result` / `payload`)由迁移改写(`migration/history.ts`),历史仓只认新形状。
