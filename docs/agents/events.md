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
| `config-changed` | 独立端 `ConfigStore` 写入后发出;scope ∈ `globals\|subscriptions\|targets\|adapters\|secrets`。引擎据此 reconcile cron / 刷新状态 / 重建连接 |
| `engine-error` | 引擎或子系统的运行时错误 `(source, message)`。`master-notifier`(→ master 私聊)+ `log` WS channel(→ AlertShell)消费 |
| `history-recorded` | `HistoryStore.record` 建起一行(一次推送 × 一个目标,本体落地那一刻;无目标行也建)时发出的完整 `HistoryEntry`;独立端转到 `push-events` WS channel。`BilibiliPush.onSend` 每个目标一段回调 → `runtime/push-history.ts` 搬字段 → `record` |
| `history-updated` | 同一次推送的后续消息(@全体 / 图集 / 词云 / 总结)追加到已有那一行之后发出的**合并后整行**;前端按 `id` 换缓存、小卡同 id 换字不重弹。盘上是补丁行,读时并回 |
| `dynamic-detected` | `DynamicEngine` 每条动态首次越过 per-uid 时间线闸门时发出 `DynamicDetectedEvent{uid,id,type,ts}`。刻意放在**过滤器 / per-UP 开关 / 投递之前** —— 口径是「UP 发了多少」,被屏蔽或推送失败的动态照样算产出(「我们推了多少」看 `history-recorded`,两者不可混用)。`type` 是 B 站原始类型串,事件层不做语义归类,归类策略集中在 stats 聚合层一处。**bus 上不是严格 exactly-once**:投递失败走 `markFail`、时间线锚点不前移,下轮重判会把同一条再发一次。现有消费方 `StatsRecorder` 靠 `StatsStore.appendDynamic` 的 `id` 幂等挡掉,新消费方同样需要按 `id` 去重 |
| `live-state-changed` | `LiveEngine` 的开/关播切换 `(uid, "live"\|"idle", startedAt?)`(grace 闸门之后,断流接续不翻转)。转 `live` 时 `startedAt` 带 B 站 `live_time` 的真实开播时刻(ISO;`room-session` 按 UTC+8 解析后转换),缺失时消费方回落到收到事件的时刻 —— 服务端在 UP 已开播时启动也能算出真实时长 |
| `live-viewers-changed` | `room-session` 每 uid 2s 节流的 `WATCHED_CHANGE` 帧 `(uid, viewers)` |
| `fans-refreshed` | 独立端 `FansPoller` 每个 tick 的完整 `FansRefreshEntry[]` 快照 |
| `ready` | 业务核心完全启动 |

## MessageBus 语义

`apps/server/src/runtime/message-bus.ts` 的 `NodeMessageBus`(mitt 风格)是业务核心**唯一**的事件通道:引擎、订阅仓、推送路由都只对它 `emit` / `on`。

**关键约束:绝不要在 bus 与任何别的事件通道之间写转发器**(`bus.on(X) → other.emit(X)` 且反向也接)—— 会自喂死循环、爆栈。当年 koishi 插件里 bus 与 `ctx` 是同一条通道的两个视图,这条铁律就是那里立下的;独立端的 WS channel 是单向的下游,不回灌 bus。回归测试:`apps/server/src/runtime/__tests__/message-bus.test.ts`。

## 独立端 WS channel 契约

信封:`{ type: <channel>, event: <name>, data: <args> }`。单参事件 unwrap 成参数本身;多参事件序列化成 tuple。

| Channel | 来源 | 前端消费者 |
|---|---|---|
| `auth` | `login-status-report` | `useAuthChannel` → 扫码 / 登录状态 |
| `push-events` | `history-recorded` / `history-updated` / `live-state-changed` / `live-viewers-changed` / `fans-refreshed` | `usePushEventsChannel` → tanstack-query `setQueryData` 补丁(recorded 头插 + 日桶 +1,无目标行不计;updated 按 id 换行、不插) |
| `log` | `engine-error` + 每条 `logger.<level>`(在单一 fan-out 点脱敏,同时归档进 LogStore jsonl) | `useAlertChannel`(engine-error → AlertShell)+ `useLogChannel`(全量流 → Logs tab) |
| `state` | 运行时健康快照 | `useStateChannel` |

## 推送历史的行模型

一行 = 一次推送 × 一个目标(`HistoryEntry`,schema 在 `packages/internal/src/schema/history.ts`):`pushId` 串起同一次推送的几次广播(下播卡 → 词云 → 总结;动态主卡 → 图集),`kind` 是 8 类推送之一(`dynamic` / `live` / `live-ongoing` / `live-end` / `guard` / `sc` / `special-danmaku` / `special-enter`),`targetId` 可空(空 = 无目标行),`messages[]` 每条带 `role`(`main` 本体 / `extra` 附加项)与结果。四态 `status`:全到 = `delivered`;第一条本体没到 = `failed`;本体到了、别的没到 = `partial`;`no-targets`。上游三道闸(静音 / 特性关 / 免扰)与无订阅**不**回调、不落行 —— 那不是「无目标」。老格式行(`source` / `result` / `payload`)读时映射,不重写。
