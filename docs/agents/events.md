# 事件契约参考

跨插件事件、MessageBus 语义、独立端 WS channel 契约。CLAUDE.md 的渐进式披露目标之一。

## BusEvents

规范契约在 `packages/internal/src/platform.ts#BusEvents`:事件名 → 载荷。载荷一律是一个具名对象(没有载荷的是 `undefined`),`bus.emit(事件, 载荷)`、`bus.on(事件, 载荷 => …)`,不用位置参数。独立端把这批事件接到 WS channel(见文末)。

载荷里不许带 B 站的形状(`uid` 键、`Bili*` 类型、平台原始值的裸 string):守卫 `scripts/__tests__/bus-event-payloads.test.mjs` 走类型检查器逐个载荷查,开张时的违规记在它的棘轮表里,3b 末清零。

| 事件 | 说明 |
|---|---|
| `login-status-report` | `LoginFlow` 发出;独立端 `auth` WS channel 消费 |
| `auth-lost` / `auth-restored` | 登录状态切换(限流通知 master) |
| `cookies-refreshed` | `{ refreshedAt }`:登录 cookie 刷新并落了盘。**cookie 本身不上总线**(它是密钥,盘上那份由 `api.commitLogin` 写好,写成功之后才发这个事件);独立端转成 `auth` WS channel 的同名帧 |
| `subscription-changed` | `{ ops }`:`SubscriptionStore` CRUD 后的 `SubscriptionOp[]` diff |
| `config-changed` | `{ scope }`:独立端 `ConfigStore` 写入后发出;scope ∈ `globals\|subscriptions\|targets\|connections\|secrets`。引擎据此 reconcile cron / 刷新状态 / 重建连接 |
| `engine-error` | 引擎或子系统的运行时错误 `{ source, message }`。`master-notifier`(→ master 私聊)+ `log` WS channel(→ AlertShell)消费 |
| `history-recorded` | `HistoryStore.record` 建起一行(一次推送 × 一个目标,本体落地那一刻;无目标行也建)时发出的完整 `HistoryEntry`;独立端转到 `push-events` WS channel。`PushRouter.onSend` 每个目标一段回调 → `runtime/push-history.ts` 搬字段 → `record`。被过滤的作品留痕的那一行(`status: "filtered"`、带 `filteredBy`、`targetId: null`)也从这个事件出来,它不经 `PushRouter`:核心装配(`deliverPost`)的 `recordFiltered` → `historyRecordFromFilteredPost` → `record` |
| `history-updated` | 同一次推送的后续消息(@全体 / 图集 / 词云 / 总结)追加到已有那一行之后发出的**合并后整行**;前端按 `id` 换缓存、小卡同 id 换字不重弹。盘上是补丁行,读时并回 |
| `post-detected` | 核心入口 `PostQueue.enqueue`(`apps/server/src/posts/post-queue.ts`)对**每条订阅**发一份 `PostEvent{subscriptionId, identity, postId, url, post, postNoun?}`(`post` 里的图已是图库引用,来源交出之前就抓好 / 写好)。**谁发**:只有这一个入口,B 站动态引擎与拓展作品绑定交一条作品它就发一次(同步发)。**什么时候**:订阅过了设置读口 —— 在、启用着、作品开关开着、来源在跑 —— 之后;排在串行闸与过滤**之前**,所以口径是「UP 发了多少」,被屏蔽或推送失败的作品照样算产出(「我们推了多少」看 `history-recorded`,两者不可混用)。**对哪些订阅**:不该推的(不在 / 停用 / 开关关着 / 来源没在跑 / 队列已关)一概不发、也不推;同一个 UP 的遗留重复订阅各发一份(3a-28 起:来源上下文的 `reportPost` 按身份取全部订阅、逐条入队,各过各的设置读口,所以各推各的、统计各记各的;一条停用或关了作品开关只丢它自己那份。3a-27 的过渡期是只发先出现的那一条)。开播伪动态、翻译失败的动态来源就不交,没有事件。**只发一次**:没有「失败 → 下一轮重发」(引擎不重试、也不按投递成败决定时间线),统计仓仍按 `id` 幂等(`StatsStore.appendPost`,读的时候再按 `id` 去重一次),新消费方同样需要按 `id` 去重。**它是旁路通知,不是装配的入口**:装配由来源直调 `enqueue` 走,没有谁靠监听这个事件来推送(方向:「发生了什么」用事件,「做 X」用直调)。**谁在听**:统计(`stats/recorder.ts` 里**一个**监听,B 站与拓展两支共用,文件键是订阅 id;`postEntryFromEvent` 照事件记一行:有无视频看 `post.video`、发布时间取 `post.publishedAt`、多收的链接 / 标题 / 摘要 / 话题 / 视频时长经 `post-entry-extras.ts`;开播预约 `DYNAMIC_TYPE_LIVE` 记成不带视频的作品,自动开播推送 `DYNAMIC_TYPE_LIVE_RCMD` 来源不交) |
| `live-state-changed` | `LiveEngine` 的开/关播切换 `{ uid, status: "live"\|"idle", at? }`(grace 闸门之后,断流接续不翻转)。转 `live` 时 `at` 带 B 站 `live_time` 的真实开播时刻(ISO;`room-session` 按 UTC+8 解析后转换),缺失时消费方回落到收到事件的时刻 —— 服务端在 UP 已开播时启动也能算出真实时长 |
| `live-viewers-changed` | `room-session` 每 uid 2s 节流的 `WATCHED_CHANGE` 帧 `{ uid, viewers }`,**`viewers` 是帧里的精确数 `num`(`number`)**(㉒d 起;从前是 B 站排好的「1.2万」字符串)。排成「1.2万」是消费方的事:面板「正在直播」那一列走 `formatCount`、统计(`stats/bili-source.ts`)直接拿它取本场最大值,「1.2万」的解析只留在迁移(`migration/stats.ts` 的 `parseBiliViewers`)。载荷只改了类型、没改名,按订阅认、拆「此刻在线 / 累计观看」两格的最终形状归 3b。同一个数也是在播快照 `LiveListenerSnapshot.viewers`(`GET /api/live/listening` 的 B 站行)与 WS `push-events` 同名帧的值 |
| `extension-stopped` | 某个拓展不在跑了(停用 / 卸载 / 换代码 / 加载失败 / 设置读不了 / 关机)—— 它那面 ctx **开始收摊的那一刻**发,每面 ctx 一次,之后它的上报一概拒。「不在跑了」只认收摊这一处(`CreateExtensionContextOptions.onDisposed` → 装载器 `onStopped` → index.ts 发 bus),不在装载器的每条路上各记一遍。载荷 `{ extensionId }`;在播表据此清掉它名下的在播(ADR-0019 决策 61)。不进 WS |
| `extension-live-changed` | 拓展订阅的在播表(`runtime/extension-live.ts`,按订阅 id 记开播 / 下播 / 直播状态)变了:进表、出表、面板看得见的那几格(标题 / 分区 / 累计观看 `totalViewers` / 开播时刻)变了 —— 此刻在线(`viewers`)面板不画,变了不发(ADR-0019 决策 75)。**按 1s 窗口合并**(`EXTENSION_LIVE_COALESCE_MS`,不随后来的变化往后推)—— 直播状态可能每轮都报。载荷为空;独立端转成 `push-events` 的同名帧,面板让 `["live","listening"]` 失效重取。🔴 **拓展的在播不发 `live-state-changed`**:那是统计的 B 站适配按 uid 订着记场次的口。拓展订阅的场次边界走 `extension-live-session`(见下一行) |
| `extension-live-session` | 拓展订阅的一场直播开始 / 结束了(ADR-0020 决策 4 / 6)—— `runtime/extension-live-sessions.ts` 算的场次边界,按订阅 id。载荷 `ExtensionLiveSessionEvent`(`packages/internal/src/platform.ts`):`{phase: "start", subscriptionId, extensionId, startedAt, at, trigger}` / `{phase: "end", subscriptionId, extensionId, startedAt, at, reason, totalViewers?}`,时刻都是 ISO。**与推送开关无关**:订阅在、启用着、拓展在跑就记(统计记「UP 做了什么」)。开始由开播事件(`trigger: "liveStart"`),或 BN / 拓展起来之后见到的在播状态(`"liveStatus"`)。结束:下播事件(`reason: "ended"`;断流接续开着的等满了才发,`at` 是**下播事件到达那一刻**)、没报下播又开播(`superseded`)、拓展停了(`extension-stopped`)、订阅停用 / 删了(`disabled` / `removed`)、关机(`shutdown`)。**`startedAt` 是这一场的身份**:开始时定下(状态没带开播时刻就取认出它的那一刻),结束帧原样带着;拓展或 BN 重启之后状态里带着同一个开播时刻,消费方据此接回同一场。**结束帧的 `totalViewers`** 是这一场里开播 / 直播状态 / 下播报过的最大累计观看(ADR-0020 决策 7;累计只增不减,最大的就是本场最后的累计数):断流接续是同一场、接着取,新的一场从头取;只认 `totalViewers`、不拿此刻在线 `viewers` 顶替,一次都没报过就没有这一格。断流接续里的那一下、直播状态、手里没有这一场的下播都**不发**。拓展直播的推送吃同一份场次(`onChange` 直接听,不经总线)。统计的拓展适配(`stats/extension-source.ts`)订它开一场 / 关一场,峰值照抄结束帧的 `totalViewers` —— 每种结束都补一帧下播,删了的(`removed`)除外(文件随订阅删);关机时这几帧交出去得比记录器收尾早,记录器收尾时等它们落盘、不再补第二帧。同一场接回之后又写的下播帧峰值更小时,读的时候取大的(`stats/store.ts` 的配对)。不进 WS |
| `fans-refreshed` | `{ entries }`:独立端 `FansPoller` 的完整 `FansRefreshEntry[]` 快照 —— 首页粉丝面板,一条订阅一行、**键是订阅 id**(ADR-0020 决策 8)。B 站条目带 `uid`(本轮问 B 站采到的);拓展条目带 `extensionId` + `externalId`,只列启用着、**有粉丝时序**的(时序由统计的拓展适配按资料里的粉丝数写),当前数取资料缓存、起点 / 24h / 7d 从时序算(起点 = 第一条样本)。每个 tick 发一次(B 站风控退避时照发,拓展那几行不问 B 站)、开机恢复发一次、删订阅当场发;拓展报了新的粉丝数(`subscription-profiles-changed`)时只重算报了的那几条再发 |
| `ready` | 业务核心完全启动 |
| `extension-status-changed` | 某个拓展喊了 `ctx.statusChanged()`(桥:一条接入连上 / 断开)。**按拓展合并**:第一喊起 250ms 窗口里的连喊只在尾沿发一次(`STATUS_CHANGED_COALESCE_MS`,窗口不随后来的喊往后推),收摊时挂着的那一发清掉。载荷 `{ extensionId }`;独立端转成 `state` WS channel 的同名帧,面板按 id 失效 `/api/ext/<id>/status` 与 bot 名单的缓存后自己重取 —— 数据本身不上 bus |
| `subscription-reported` | 订阅源拓展经 `handle.report*` 报上来一条、ctx 核过形状(`checkSubscriptionReport`:不认识的字段 / 必填坏了整条拒,选填坏了只丢那一格)、按 `(拓展, 外部 id)` 对上了它名下的订阅(ADR-0019 决策 7 / 57 / 59 / 62)。**五种上报走这一个事件**,按 `report.kind` 分:三种事件 `post` / `liveStart` / `liveEnd` 与两种不触发推送的 `profile` / `liveStatus`。载荷 `SubscriptionReportDelivery{extensionId, externalId, subscriptionIds, report}`:`subscriptionIds` 已按开关筛过 —— 事件与直播状态只含开着的订阅,资料更新含全部;一条都对不上就不发。图是 `Uint8Array`,**不进 WS 帧**。index.ts 经装载器的 `onSubscriptionReport` 接到 bus。丢格与拒绝不上 bus,走 ctx 里唯一那个「上报出入」出口(日志 + `onReportDiscrepancy`)。消费方:资料落盘(`runtime/reported-profiles.ts`,只收 `profile`,见 `subscription-profiles-changed`)、拓展订阅的在播表(`runtime/extension-live.ts`,收 `liveStart` / `liveEnd` / `liveStatus`,见 `extension-live-changed`)、拓展作品绑定(`posts/extension-post.ts`,只收 `post`:翻成信封交给 `PostQueue`)、拓展直播的场次(`runtime/extension-live-sessions.ts`,收 `liveStart` / `liveEnd` / `liveStatus`,见 `extension-live-session`;拓展直播推送与计时器 `runtime/extension-live-push.ts` 吃它,最新状态取在播表)、统计的拓展适配(`stats/extension-source.ts`,五种都收、只记启用着的:资料里的粉丝数 → 粉丝时序,外加一条「在记」;作品行不在这里,走 `post-detected` 那一个监听;直播的场次与峰值从 `extension-live-session` 来;ADR-0020 决策 4–9 / 16),推送两者见 push.md |
| `extension-settings-changed` | 某个拓展的设置经 `PATCH /api/ext/<id>/settings` 写进去了(ADR-0019 决策 35)。载荷 `{ extensionId }`;独立端转成 `state` WS channel 的 `extension-settings-changed` 帧,面板按 id 失效它的设置与视图(面板改走新口的那一片才接上,在那之前这一帧没人听)—— 设置里有密钥,数据本身不上 bus、不进帧。这是宿主自己知道的事实,不替拓展判视图变没变 |
| `extension-report-discrepancies-changed` | 某个订阅源拓展的「上报出入」(ADR-0019 决策 60:丢格、整条拒,ctx 里唯一那个出口 `recordDiscrepancy` → `onReportDiscrepancy`)新记了几条。记录在 `extensions/report-discrepancies.ts`(每个拓展最近 20 条,只在内存,卸载清空),**按拓展合并**:第一条起 250ms 窗口里再记的只在尾沿发一次(`REPORT_DISCREPANCIES_CHANGED_COALESCE_MS`,窗口不往后推,与 `extension-status-changed` 各算各的)。载荷 `{ extensionId }`;独立端转成 `state` WS channel 的同名帧,面板只让拓展表失效(框住在 `ExtensionDTO.reportDiscrepancies` 上)。**不借 `extension-status-changed`**:那一声说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表 |
| `subscription-profiles-changed` | 拓展报的资料更新(`subscription-reported` 里 `kind === "profile"` 的)经 `runtime/reported-profiles.ts` 落进资料缓存(`SubRuntimeStore.cachedProfile`,给了哪格改哪格)与图库里的头像(同一张图引用不变)之后,面板看得见的名字 / 头像 / 粉丝**真变了**的订阅 id,载荷 `{ subscriptionIds }`(ADR-0019 决策 7 / 49 / 62)。按 250ms 窗口合并(拓展起来时可能一口气报一百条)。独立端转成 `state` WS channel 的同名帧,面板失效订阅列表重取;粉丝轮询(`runtime/fans-poller.ts`)据此重算这几条拓展订阅在首页粉丝面板上的那一行、发 `fans-refreshed`。🔴 **资料不是配置,不发 `config-changed "subscriptions"`** —— 那一档会重建路由表、通知拓展「名下订阅变了」、让引擎 reconcile |

## MessageBus 语义

`apps/server/src/runtime/message-bus.ts` 的 `NodeMessageBus`(mitt 风格)是业务核心**唯一**的事件通道:引擎、订阅仓、推送路由都只对它 `emit` / `on`。

**关键约束:绝不要在 bus 与任何别的事件通道之间写转发器**(`bus.on(X) → other.emit(X)` 且反向也接)—— 会自喂死循环、爆栈。当年 koishi 插件里 bus 与 `ctx` 是同一条通道的两个视图,这条铁律就是那里立下的;独立端的 WS channel 是单向的下游,不回灌 bus。回归测试:`apps/server/src/runtime/__tests__/message-bus.test.ts`。

## 独立端 WS channel 契约

信封:`{ type: <channel>, event: <name>, ts, data }`。每个频道有哪些事件、`data` 长什么样,住在 contract 的事件表 `WsEvents`(`apps/contract/src/ws.ts`):总线转来的事件与总线同名,`data` 就是总线的载荷(没有载荷的是 `null`);历史行投影成 `HistoryEntryView`;`hydrate`、资源采样、日志行是服务端自己造的。服务端经 `ws/channels.ts` 的 `envelope(频道, 事件, data)` 造帧,面板用 `services/ws.ts` 的 `isWsEvent(env, 频道, 事件)` 判帧,`data` 都按这张表定型,不手写类型断言。

`resources` 是唯一一条**按订阅开关采样**的:订阅那一刻发一帧 `hydrate`(静态量 + 近 5 分钟缓冲),之后每 tick 一帧 `sample`;名册空了服务端就摘掉采样监听(浏览器子树那一项要起子进程)。前端相应地有 `unsubscribeChannels`,别的频道整个会话都开着、不用它。

| Channel | 来源 | 前端消费者 |
|---|---|---|
| `auth` | `login-status-report` / `auth-lost` / `auth-restored` / `cookies-refreshed` | `useAuthChannel` → 扫码 / 登录状态 |
| `push-events` | `history-recorded` / `history-updated` / `live-state-changed` / `live-viewers-changed` / `extension-live-changed` / `fans-refreshed` | `usePushEventsChannel` → tanstack-query `setQueryData` 补丁(recorded 头插 + 日桶 +1,无目标行不计;updated 按 id 换行、不插);两种在播变化让「正在直播」失效重取 |
| `log` | `engine-error` + 每条 `logger.<level>`(在单一 fan-out 点脱敏,同时归档进 LogStore jsonl) | `useAlertChannel`(engine-error → AlertShell)+ `useLogChannel`(全量流 → Logs tab) |
| `state` | `hydrate`(订阅 / 重连时)+ `config-changed`(只带 scope)+ `extension-status-changed` / `extension-settings-changed` / `extension-report-discrepancies-changed`(都只带 `extensionId`)+ `subscription-profiles-changed`(只带 `subscriptionIds`) | `useStateChannel` → 按 scope / 按拓展 id invalidate tanstack-query 缓存;上报出入变了失效拓展表;资料变了失效订阅列表 |
| `resources` | `ResourceMonitor` 每 2 秒一份系统资源样本(宿主机 / 本体 / 浏览器子树) | `useResourcesChannel` → 概览页「系统资源」卡 |

## 推送历史的行模型

一行 = 一次推送 × 一个目标(`HistoryEntry`,schema 在 `packages/internal/src/schema/history.ts`):`pushId` 串起同一次推送的几个锚点(下播卡 → 词云 → 总结;动态主卡 → 图集),`feature` 是这次推送的特性键(`post` / `liveStart` / `liveStreaming` / `liveEnd` / `membership` / `superchat` / `specialDanmaku` / `specialUserEnter`;0.x 存的推送种类由迁移翻过来),`targetId` 可空(空 = 无目标行或被过滤的行,分哪一种看 `status`),`messages[]` 每条带 `role`(`main` 本体 / `extra` 附加项)与结果;被全局静音 / 免扰时段挡下的那几条带 `isSilenced: true`、没有结果。六态 `status`:全到 = `delivered`;第一条本体没到 = `failed`;本体到了、别的没到 = `partial`;`no-targets`;本体被挡下 = `silenced`(一条都没发,不算推送也不算失败,可以补发);作品被过滤挡下 = `filtered`(行上 `filteredBy` 记原因,一条订阅一行、只有一条文字,只是留痕,不算推送也不算失败,不能补发)。特性关着与无订阅**不**回调、不落行 —— 那不是「无目标」;静音 / 免扰挡下的照落行,两个 WS 事件照发(面板不为它弹小卡)。0.x 的老格式行(`source` / `result` / `payload`)由迁移改写(`migration/history.ts`),历史仓只认新形状。
