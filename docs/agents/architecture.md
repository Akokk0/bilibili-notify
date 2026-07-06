# 架构参考

仓库结构、包清单、各端模块图。CLAUDE.md 的渐进式披露目标之一。

## 顶层布局

```
packages/   平台中立业务核心(@bilibili-notify/*)
koishi/     Koishi 薄壳插件(koishi-plugin-bilibili-notify*)
apps/       Hono 服务端 + React Dashboard(pnpm 子 workspace)
```

`pnpm-workspace.yaml` glob:`["packages/*", "koishi/*", "apps/*"]`。单 workspace、单 lockfile;`apps/server` 经 pnpm `workspace:*` 协议消费业务核心。`nodeLinker: hoisted`(写在 `pnpm-workspace.yaml`,pnpm 11 从这里读)使 `node_modules` 扁平化,Koishi 的插件加载器才能正常工作。

## 包清单

### 业务核心(`packages/`,零 koishi 依赖)

| 包 | npm 名 | 角色 |
|---|---|---|
| `packages/internal` | `@bilibili-notify/internal` | Zod schema(Subscription / PushTarget / GlobalConfig / HistoryEntry)+ 平台接口(ServiceContext / MessageBus / NotificationSink / NotificationPayload)+ 工具(withLock / retry / interpolate) |
| `packages/api` | `@bilibili-notify/api` | `BilibiliAPI`(HTTP + WBI 签名)+ `LoginFlow`(扫码 + cookie 状态机) |
| `packages/storage` | `@bilibili-notify/storage` | `StorageManager` —— cookie/密钥持久化 + AES 加密 |
| `packages/push` | `@bilibili-notify/push` | `BilibiliPush` —— 经 `PushLike` 适配器做推送路由,每次投递 emit `history-recorded` |
| `packages/subscription` | `@bilibili-notify/subscription` | `SubscriptionStore` —— `Subscription[]` 内存 CRUD + `subscription-changed` diff |
| `packages/dynamic` | `@bilibili-notify/dynamic` | `DynamicEngine` —— 动态轮询 cron + 过滤 + 渲染分发 |
| `packages/live` | `@bilibili-notify/live` | `LiveEngine`(拆分:ListenerManager / DanmakuCollector / WordcloudGenerator / LiveTemplateRenderer / LiveSummaryRequester) |
| `packages/image` | `@bilibili-notify/image` | `ImageRenderer` —— Vue/UnoCSS/JSDOM SSR + 经 `PuppeteerLike` 接口包 puppeteer |
| `packages/ai` | `@bilibili-notify/ai` | `CommentaryGenerator` —— OpenAI 兼容的 chat / summary / commentary |

### Koishi 薄壳(`koishi/`)

单一包,`koishi/` → npm 名 `koishi-plugin-bilibili-notify`。此前拆成 core + dynamic/live/image/ai/advanced-subscription 六个包(各自一个子目录),已合并成这一个包并展平掉 `core/` 那层子目录 —— 旧的五个卫星包不再更新。

`koishi/src/runtime/service-context.ts` 提供 `makeKoishiServiceContext` + `makeKoishiMessageBus` 适配器(把 koishi `Context` 包成业务核心消费的 `ServiceContext` / `MessageBus`),只在包内部使用,不再对外发布(原 `@bilibili-notify/koishi-runtime` 包已删除)。

## 工作区依赖卫生

每个 workspace `src/` import 若解析到**运行时值**(常量 / 类 / 函数),**必须**声明进该包 `package.json` 的 `dependencies`。`import type` 不进 cjs/mjs 产物,无需声明。

漏声明的后果:install 期当消费者版本范围解析到一个不再导出该值的版本时直接断裂。

## Koishi 配置模式

`koishi/src/config/` 按功能域拆成一个域一个文件,每个域各自的 Schema + TS 接口;`config/index.ts` 汇总成 `BilibiliNotifyConfigSchema` / `BilibiliNotifyConfig`,`index.ts` 再 re-export 成 koishi 标准的 `Config` / `apply`:

- `config/account.ts` —— User-Agent、日志级别、登录健康检查间隔、cookie 加密口令
- `config/push.ts` —— 主人账号/平台、安静时段(`MasterConfig` / `QuietHourRange`)
- `config/subscriptions.ts` —— 扁平订阅列表(`FlatSubConfigItem[]`)
- `config/render.ts` —— 图片渲染开关 + 卡片样式
- `config/ai.ts` —— AI 点评/对话开关 + 模型配置(`PersonaConfig`)
- `config/dynamic.ts` —— 动态推送设置(核心能力,无 `enabled` 开关,恒开)
- `config/live.ts` —— 直播推送设置(核心能力,无 `enabled` 开关,恒开)
- `config/advanced-sub.ts` —— 高级订阅开关 + per-UP 精细配置(`SubItemRawConfig`)

除 `render`/`ai`/`advancedSub` 外都不带 `enabled` 字段 —— `account`/`push`/`subscriptions` 是插件核心必需项,`dynamic`/`live` 是恒开的核心能力(见下方生命周期)。`render`/`ai`/`advancedSub` 域内的"仅当 enabled 才必需"字段用 `Schema.intersect([Schema.object({enabled}), Schema.union([...])])` 模式表达 —— TS 类型上这些字段是可选的(不是判别式联合),与 `push.ts` 里 `MasterConfig` 的既有写法一致。

## Koishi 插件生命周期(`koishi/`)

`apply()` 注册两个顶层插件:

1. **`BilibiliNotifyDataServer`**(`bridges/data-server.ts`)—— 到 koishi 控制台 UI 的 WebSocket 桥(扫码登录流走客户端)
2. **`BilibiliNotifyServerManager`**(`runtime/bootstrap.ts`,Service)—— 编排启动,内部拆为:

| 文件 | 职责 |
|---|---|
| `runtime/bootstrap.ts` | Service 外壳 + 生命周期;commands 全部在 `start()` 里注册一次 |
| `runtime/lifecycle.ts` | `bringUp()` / `tearDown()` —— 造/析构 api/push/store/registry/subLoader,再调 `runtime/engines.ts` 造/析构 render/ai/dynamic/live |
| `runtime/engines.ts` | render→ai→dynamic→live 的统一构造/析构点;dynamic/live 直接持有 render/ai 的 engine 引用(构造顺序保证,无需晚注入) |
| `bridges/login-flow-bridge.ts` | 包 `LoginFlow`;监听控制台 `start-login` / `reset-key`;经 `qrcode` 渲染二维码 PNG |
| `subscriptions/subscription-loader.ts` | koishi config → `SubscriptionStore` 播种(`subscriptions` 扁平列表 或 `advancedSub` 高级订阅二选一) |
| `runtime/master-notifier.ts` | 同时消费 `auth-lost` / `engine-error`,per-source 60s 节流转发到 master 私聊(与独立端对称) |
| `push/target-registry.ts` | 内存 `PushAdapter` + `PushTarget` 注册表 |
| `push/target-synthesis.ts` | 从 koishi-config 输入合成 target |
| `push/sink.ts` | `KoishiNotificationSink` 实现(按 target 路由) |
| `render/service.ts`、`ai/service.ts`、`dynamic/service.ts`、`live/service.ts` | 四个引擎的普通类(非 Service),构造函数直接收依赖引用 |
| `commands/` | `bili.ts` / `status.ts` / `sys.ts` / `ai.ts` / `dynamic.ts` / `live.ts` —— 全部绑定 `this: BilibiliNotifyServerManager`,经 `this.slots` / `this.engines` 动态读取当前引擎实例 |

render/ai/dynamic/live 不再是独立 koishi Service —— 它们是 `ManagerSlots.engines` 里与 api/push/store/registry **同生命周期**的普通类实例,`bringUp()`/`tearDown()` 一起造/析构。`bn restart` 因此会完整重建这四个引擎(此前它们是独立 `ctx.plugin()` 注册,`bn restart` 不会重建,存在重启后内部引用过期的潜伏 bug)。commands 只在 `ServerManager.start()` 里注册一次(不随 `bringUp()` 重复),避免 koishi `ctx.command(name)` 按名字复用同一 Command 对象导致 action 重复挂载。

## 服务依赖图

```
BilibiliAPI        (@bilibili-notify/api;由 ServerManager 直接持有,commands 经 this.api 访问)
BilibiliPush       (@bilibili-notify/push;喂一个 PushLike 适配器)
SubscriptionStore  (@bilibili-notify/subscription;Subscription[] 的内存权威)
TargetRegistry     (koishi/ 内部;PushAdapter/PushTarget 注册表)

runtime/engines.ts 按顺序构造(render → ai → dynamic → live),后两者直接拿前两者的 engine 引用:

render (config.render.enabled 才造) → ImageRenderer({ puppeteer: PuppeteerLike, ... })
ai     (config.ai.enabled 才造)     → CommentaryGenerator({ api, store, registry, ... })
dynamic(恒造)                        → DynamicEngine({ api, push, store, image?, ai?, ... })
live   (恒造)                        → LiveEngine({ api, push, store, contentBuilder, image?, ai?, ... })
```

## Koishi 控制台 UI

`koishi/client/` 是 koishi 控制台前端(Vue)。加载:dev `resolve(__dirname, "../client/index.ts")`,prod `resolve(__dirname, "../dist")`。独立端用的是 `apps/web/` 下另一套 React + Vite Dashboard,两者不共享 UI 代码。

## 独立端模块图(`apps/`)

两个子包共用根 pnpm workspace:`apps/server`(Hono HTTP + WS,单 tsdown bundle 到 `apps/server/lib/index.mjs`)、`apps/web`(Vite + React 19 + Tailwind 4 + tanstack-query + zustand + react-router-dom;图表是手绘 SVG,无图表库;prod 由 `apps/server` 当静态资源服务)。

### `apps/server`

```
src/
  index.ts              CLI / bootstrap 入口
  app.ts                Hono app 组装 + 鉴权 + 路由挂载
  auth/                 经 @bilibili-notify/api LoginFlow 的扫码 + cookie 状态;bare-auth-policy / session / ws-ticket
  config/               loader(bootstrap 配置加载)+ ConfigStore(原子写 <dataDir>/state/*.json,emit config-changed)+ schema
  runtime/
    bootstrap.ts          AppRuntime 容器(api/storage/push/store/engines/fansPoller/...)
    service-context.ts    NodeServiceContext(pino + setInterval/setTimeout/onDispose)
    message-bus.ts        NodeMessageBus(mitt 风格 BiliEvents emitter)
    engines.ts            引擎热重载接线;消费 config-changed
    fans-poller.ts        FansPoller —— 写 <dataDir>/fans/<uid>.jsonl,emit fans-refreshed
    master-notifier.ts    engine-error 转 master 私聊
    puppeteer.ts          puppeteer-core 适配器(卡片预览)
  fans/store.ts         append-only jsonl 时序
  history/              HistoryStore(<dataDir>/history/<日期>.jsonl)+ retention
  logs/                 LogStore + retention + redact(凭据脱敏)+ sink
  routes/               REST:auth / subs / targets / adapters / globals / history / logs / fans / live / cards / push / health
  ws/                   server(ws upgrade + 按连接 channel 过滤)+ channels + log-channel
  sink/                 NotificationSink 分发(PushTarget.id → 平台适配器)
  platforms/            OneBot v11(HTTP / ws / ws-reverse)+ Webhook + WebDashboard 适配器
```

### `apps/web`

```
src/
  pages/        Dashboard / Subs / Targets / History / Rules / Cards / Ai / System / Logs
  components/   共享原子组件 + 图标
  hooks/        useAuthChannel / usePushEventsChannel / useAlertChannel / useLogChannel / useStateChannel / ...
  services/     HTTP client(api.ts)+ 类型化封装(dashboard.ts)
  store/        zustand 管瞬态 UI 状态;tanstack-query 缓存管服务端状态
  types/domain.ts  @bilibili-notify/internal schema 的手维护镜像(纯 JSON 消费者,运行时不 import 核心)
```

页面级状态归 tanstack-query;WS push 帧经 `setQueryData` 打补丁,实时更新无需额外 HTTP 往返。
