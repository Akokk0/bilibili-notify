# 事件契约参考

跨插件事件、MessageBus 语义、独立端 WS channel 契约。CLAUDE.md 的渐进式披露目标之一。

## BiliEvents

规范契约在 `packages/internal/src/platform.ts#BiliEvents`。Koishi 适配器把每个事件桥到 `ctx.emit("bilibili-notify/<event>")`;独立端把同一批事件直接接到 WS channel。

| 事件 | 说明 |
|---|---|
| `login-status-report` | `LoginFlow` 发出;koishi 控制台 UI + 独立端 `auth` WS channel 消费 |
| `auth-lost` / `auth-restored` | 登录状态切换(限流通知 master) |
| `cookies-refreshed` | 触发 cookie 持久化 |
| `subscription-changed` | `SubscriptionStore` CRUD 后发出的 `SubscriptionOp[]` diff |
| `config-changed` | 独立端 `ConfigStore` 写入后发出;scope ∈ `globals\|subscriptions\|targets\|adapters\|secrets`。引擎据此 reconcile cron / 刷新状态 / 重建连接 |
| `engine-error` | 引擎或子系统的运行时错误 `(source, message)`。`master-notifier`(koishi→master 私聊)+ `log` WS channel(独立端→AlertShell)消费 |
| `history-recorded` | `BilibiliPush` 每次投递后发出的完整 `HistoryEntry`;独立端转到 `push-events` WS channel |
| `dynamic-detected` | `DynamicEngine` 每条动态首次越过 per-uid 时间线闸门时发出 `DynamicDetectedEvent{uid,id,type,ts}`。刻意放在**过滤器 / per-UP 开关 / 投递之前** —— 口径是「UP 发了多少」,被屏蔽或推送失败的动态照样算产出(「我们推了多少」看 `history-recorded`,两者不可混用)。`type` 是 B 站原始类型串,事件层不做语义归类,归类策略集中在 stats 聚合层一处。**bus 上不是严格 exactly-once**:投递失败走 `markFail`、时间线锚点不前移,下轮重判会把同一条再发一次。现有消费方 `StatsRecorder` 靠 `StatsStore.appendDynamic` 的 `id` 幂等挡掉,新消费方同样需要按 `id` 去重 |
| `live-state-changed` | `LiveEngine` 的开/关播切换 `(uid, "live"\|"idle", startedAt?)`(grace 闸门之后,断流接续不翻转)。转 `live` 时 `startedAt` 带 B 站 `live_time` 的真实开播时刻(ISO;`room-session` 按 UTC+8 解析后转换),缺失时消费方回落到收到事件的时刻 —— 服务端在 UP 已开播时启动也能算出真实时长 |
| `live-viewers-changed` | `room-session` 每 uid 2s 节流的 `WATCHED_CHANGE` 帧 `(uid, viewers)` |
| `fans-refreshed` | 独立端 `FansPoller` 每个 tick 的完整 `FansRefreshEntry[]` 快照 |
| `ready` | 业务核心完全启动 |

## MessageBus ↔ koishi 语义

`koishi/src/runtime/service-context.ts` 提供(单包内部实现,不对外发布):

- `makeKoishiServiceContext(ctx, name, logLevel?)` —— 把 `Context` 包成 `ServiceContext`(logger / setInterval / setTimeout / onDispose)
- `makeKoishiMessageBus(ctx)` —— 把 `Context` 包成 `MessageBus`:`bus.emit("X", p)` ≡ `ctx.emit("bilibili-notify/X", p)`;`bus.on("X", h)` ≡ `ctx.on("bilibili-notify/X", h)`

**关键约束:bus 与 ctx 是同一条事件通道的两个视图。** 绝不要写 `bus.on(X) → ctx.emit(bilibili-notify/X)` 或 `ctx.on(bilibili-notify/X) → bus.emit(X)` 这种转发器 —— 会自喂死循环、爆栈。经 `ctx.on("bilibili-notify/...")` 监听的代码已经免费收到核心的 `bus.emit`。回归测试:`koishi/src/runtime/__tests__/message-bus.test.ts`。

## 独立端 WS channel 契约

信封:`{ type: <channel>, event: <name>, data: <args> }`。单参事件 unwrap 成参数本身;多参事件序列化成 tuple。

| Channel | 来源 | 前端消费者 |
|---|---|---|
| `auth` | `login-status-report` | `useAuthChannel` → 扫码 / 登录状态 |
| `push-events` | `history-recorded` / `live-state-changed` / `live-viewers-changed` / `fans-refreshed` | `usePushEventsChannel` → tanstack-query `setQueryData` 补丁 |
| `log` | `engine-error` + 每条 `logger.<level>`(在单一 fan-out 点脱敏,同时归档进 LogStore jsonl) | `useAlertChannel`(engine-error → AlertShell)+ `useLogChannel`(全量流 → Logs tab) |
| `state` | 运行时健康快照 | `useStateChannel` |
