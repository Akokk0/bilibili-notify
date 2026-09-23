# 事件契约参考

跨插件事件、MessageBus 语义、独立端 WS channel 契约。CLAUDE.md 的渐进式披露目标之一。

## BiliEvents

规范契约在 `packages/internal/src/platform.ts#BiliEvents`。独立端把这批事件接到 WS channel(见文末)。

| 事件 | 说明 |
|---|---|
| `login-status-report` | `LoginFlow` 发出;独立端 `auth` WS channel 消费 |
| `auth-lost` / `auth-restored` | 登录状态切换(限流通知 master) |
| `cookies-refreshed` | 触发 cookie 持久化 |
| `subscription-changed` | `SubscriptionStore` CRUD 后发出的 `SubscriptionOp[]` diff |
| `config-changed` | 独立端 `ConfigStore` 写入后发出;scope ∈ `globals\|subscriptions\|targets\|connections\|secrets`。引擎据此 reconcile cron / 刷新状态 / 重建连接 |
| `engine-error` | 引擎或子系统的运行时错误 `(source, message)`。`master-notifier`(→ master 私聊)+ `log` WS channel(→ AlertShell)消费 |
| `history-recorded` | `HistoryStore.record` 建起一行(一次推送 × 一个目标,本体落地那一刻;无目标行也建)时发出的完整 `HistoryEntry`;独立端转到 `push-events` WS channel。`BilibiliPush.onSend` 每个目标一段回调 → `runtime/push-history.ts` 搬字段 → `record` |
| `history-updated` | 同一次推送的后续消息(@全体 / 图集 / 词云 / 总结)追加到已有那一行之后发出的**合并后整行**;前端按 `id` 换缓存、小卡同 id 换字不重弹。盘上是补丁行,读时并回 |
| `dynamic-detected` | `DynamicEngine` 每条动态首次越过 per-uid 时间线闸门时发出 `DynamicDetectedEvent{uid,id,type,ts}`。刻意放在**过滤器 / per-UP 开关 / 投递之前** —— 口径是「UP 发了多少」,被屏蔽或推送失败的动态照样算产出(「我们推了多少」看 `history-recorded`,两者不可混用)。`type` 是 B 站原始类型串,事件层不做语义归类,归类策略集中在 stats 聚合层一处。**bus 上不是严格 exactly-once**:投递失败走 `markFail`、时间线锚点不前移,下轮重判会把同一条再发一次。现有消费方 `StatsRecorder` 靠 `StatsStore.appendDynamic` 的 `id` 幂等挡掉,新消费方同样需要按 `id` 去重 |
| `live-state-changed` | `LiveEngine` 的开/关播切换 `(uid, "live"\|"idle", startedAt?)`(grace 闸门之后,断流接续不翻转)。转 `live` 时 `startedAt` 带 B 站 `live_time` 的真实开播时刻(ISO;`room-session` 按 UTC+8 解析后转换),缺失时消费方回落到收到事件的时刻 —— 服务端在 UP 已开播时启动也能算出真实时长 |
| `live-viewers-changed` | `room-session` 每 uid 2s 节流的 `WATCHED_CHANGE` 帧 `(uid, viewers)` |
| `extension-stopped` | 某个拓展不在跑了(停用 / 卸载 / 换代码 / 加载失败 / 设置读不了 / 关机)—— 它那面 ctx **开始收摊的那一刻**发,每面 ctx 一次,之后它的上报一概拒。「不在跑了」只认收摊这一处(`CreateExtensionContextOptions.onDisposed` → 装载器 `onStopped` → index.ts 发 bus),不在装载器的每条路上各记一遍。载荷只有拓展 id;在播表据此清掉它名下的在播(ADR-0019 决策 61)。不进 WS |
| `extension-live-changed` | 拓展订阅的在播表(`runtime/extension-live.ts`,按订阅 id 记开播 / 下播 / 直播状态)变了:进表、出表、面板看得见的那几格(标题 / 分区 / 人数 / 开播时刻)变了。**按 1s 窗口合并**(`EXTENSION_LIVE_COALESCE_MS`,不随后来的变化往后推)—— 直播状态可能每轮都报。载荷为空;独立端转成 `push-events` 的同名帧,面板让 `["live","listening"]` 失效重取。🔴 **拓展的在播不发 `live-state-changed`**:`StatsRecorder` 按 uid 订着它记场次,而统计不含拓展(决策 12) |
| `fans-refreshed` | 独立端 `FansPoller` 每个 tick 的完整 `FansRefreshEntry[]` 快照 |
| `ready` | 业务核心完全启动 |
| `extension-status-changed` | 某个拓展喊了 `ctx.statusChanged()`(桥:一条接入连上 / 断开)。**按拓展合并**:第一喊起 250ms 窗口里的连喊只在尾沿发一次(`STATUS_CHANGED_COALESCE_MS`,窗口不随后来的喊往后推),收摊时挂着的那一发清掉。载荷只有拓展 id;独立端转成 `state` WS channel 的 `extension-changed` 帧,面板按 id 失效 `/api/ext/<id>/status` 与 bot 名单的缓存后自己重取 —— 数据本身不上 bus |
| `subscription-reported` | 订阅源拓展经 `handle.report*` 报上来一条、ctx 核过形状(`checkSubscriptionReport`:不认识的字段 / 必填坏了整条拒,选填坏了只丢那一格)、按 `(拓展, 外部 id)` 对上了它名下的订阅(ADR-0019 决策 7 / 57 / 59 / 62)。**五种上报走这一个事件**,按 `report.kind` 分:三种事件 `post` / `liveStart` / `liveEnd` 与两种不触发推送的 `profile` / `liveStatus`。载荷 `SubscriptionReportDelivery{extensionId, externalId, subscriptionIds, report}`:`subscriptionIds` 已按开关筛过 —— 事件与直播状态只含开着的订阅,资料更新含全部;一条都对不上就不发。图是 `Uint8Array`,**不进 WS 帧**。index.ts 经装载器的 `onSubscriptionReport` 接到 bus。丢格与拒绝不上 bus,走 ctx 里唯一那个「上报问题」出口(日志 + `onSubscriptionReportProblem`)。消费方:资料落盘(`runtime/reported-profiles.ts`,只收 `profile`,见 `subscription-profiles-changed`)、拓展订阅的在播表(`runtime/extension-live.ts`,收 `liveStart` / `liveEnd` / `liveStatus`,见 `extension-live-changed`);出卡与推送在 ④ 后面几片接 |
| `extension-settings-changed` | 某个拓展的设置经 `PATCH /api/ext/<id>/settings` 写进去了(ADR-0019 决策 35)。载荷只有拓展 id;独立端转成 `state` WS channel 的 `extension-settings-changed` 帧,面板按 id 失效它的设置与视图(面板改走新口的那一片才接上,在那之前这一帧没人听)—— 设置里有密钥,数据本身不上 bus、不进帧。这是宿主自己知道的事实,不替拓展判视图变没变 |
| `extension-report-problems-changed` | 某个订阅源拓展的「上报问题」(ADR-0019 决策 60:丢格、整条拒,ctx 里唯一那个出口 `reportProblem` → `onSubscriptionReportProblem`)新记了几条。记录在 `extensions/report-problems.ts`(每个拓展最近 20 条,只在内存,卸载清空),**按拓展合并**:第一条起 250ms 窗口里再记的只在尾沿发一次(`REPORT_PROBLEMS_CHANGED_COALESCE_MS`,窗口不往后推,与 `extension-status-changed` 各算各的)。载荷只有拓展 id;独立端转成 `state` WS channel 的同名帧,面板只让拓展表失效(框住在 `ExtensionDTO.reportProblems` 上)。**不借 `extension-status-changed`**:那一声说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表 |
| `subscription-profiles-changed` | 拓展报的资料更新(`subscription-reported` 里 `kind === "profile"` 的)经 `runtime/reported-profiles.ts` 落进资料缓存(`SubRuntimeStore.cachedProfile`,给了哪格改哪格)与头像文件(摘要不同才覆盖)之后,面板看得见的名字 / 头像 / 粉丝**真变了**的订阅 id(ADR-0019 决策 7 / 49 / 62)。按 250ms 窗口合并(拓展起来时可能一口气报一百条)。独立端转成 `state` WS channel 的同名帧,面板失效订阅列表重取。🔴 **资料不是配置,不发 `config-changed "subscriptions"`** —— 那一档会重建路由表、通知拓展「名下订阅变了」、让引擎 reconcile |

## MessageBus 语义

`apps/server/src/runtime/message-bus.ts` 的 `NodeMessageBus`(mitt 风格)是业务核心**唯一**的事件通道:引擎、订阅仓、推送路由都只对它 `emit` / `on`。

**关键约束:绝不要在 bus 与任何别的事件通道之间写转发器**(`bus.on(X) → other.emit(X)` 且反向也接)—— 会自喂死循环、爆栈。当年 koishi 插件里 bus 与 `ctx` 是同一条通道的两个视图,这条铁律就是那里立下的;独立端的 WS channel 是单向的下游,不回灌 bus。回归测试:`apps/server/src/runtime/__tests__/message-bus.test.ts`。

## 独立端 WS channel 契约

信封:`{ type: <channel>, event: <name>, data: <args> }`。单参事件 unwrap 成参数本身;多参事件序列化成 tuple。

`resources` 是唯一一条**按订阅开关采样**的:订阅那一刻发一帧 `hydrate`(静态量 + 近 5 分钟缓冲),之后每 tick 一帧 `sample`;名册空了服务端就摘掉采样监听(浏览器子树那一项要起子进程)。前端相应地有 `unsubscribeChannels`,别的频道整个会话都开着、不用它。

| Channel | 来源 | 前端消费者 |
|---|---|---|
| `auth` | `login-status-report` | `useAuthChannel` → 扫码 / 登录状态 |
| `push-events` | `history-recorded` / `history-updated` / `live-state-changed` / `live-viewers-changed` / `extension-live-changed` / `fans-refreshed` | `usePushEventsChannel` → tanstack-query `setQueryData` 补丁(recorded 头插 + 日桶 +1,无目标行不计;updated 按 id 换行、不插);两种在播变化让「正在直播」失效重取 |
| `log` | `engine-error` + 每条 `logger.<level>`(在单一 fan-out 点脱敏,同时归档进 LogStore jsonl) | `useAlertChannel`(engine-error → AlertShell)+ `useLogChannel`(全量流 → Logs tab) |
| `state` | `hydrate`(订阅 / 重连时)+ `config-changed`(只带 scope)+ `extension-changed` / `extension-settings-changed`(都只带拓展 id)+ `extension-report-problems-changed`(只带拓展 id)+ `subscription-profiles-changed`(只带订阅 id) | `useStateChannel` → 按 scope / 按拓展 id invalidate tanstack-query 缓存;上报问题变了失效拓展表;资料变了失效订阅列表 |
| `resources` | `ResourceMonitor` 每 2 秒一份系统资源样本(宿主机 / 本体 / 浏览器子树) | `useResourcesChannel` → 概览页「系统资源」卡 |

## 推送历史的行模型

一行 = 一次推送 × 一个目标(`HistoryEntry`,schema 在 `packages/internal/src/schema/history.ts`):`pushId` 串起同一次推送的几次广播(下播卡 → 词云 → 总结;动态主卡 → 图集),`kind` 是 8 类推送之一(`dynamic` / `live` / `live-ongoing` / `live-end` / `guard` / `sc` / `special-danmaku` / `special-enter`),`targetId` 可空(空 = 无目标行),`messages[]` 每条带 `role`(`main` 本体 / `extra` 附加项)与结果。四态 `status`:全到 = `delivered`;第一条本体没到 = `failed`;本体到了、别的没到 = `partial`;`no-targets`。上游三道闸(静音 / 特性关 / 免扰)与无订阅**不**回调、不落行 —— 那不是「无目标」。老格式行(`source` / `result` / `payload`)读时映射,不重写。
