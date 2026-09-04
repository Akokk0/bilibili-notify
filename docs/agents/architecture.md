# 架构参考

仓库结构、包清单、各端模块图。CLAUDE.md 的渐进式披露目标之一。

## 顶层布局

```
packages/   平台中立业务核心(@bilibili-notify/*)
apps/       Hono 服务端 + React Dashboard + Tauri 桌面壳 + wire 契约
```

`pnpm-workspace.yaml` glob:`["packages/*", "apps/*"]`。单 workspace、单 lockfile,pnpm 默认 isolated 布局;`apps/server` 经 pnpm `workspace:*` 协议消费业务核心。Koishi 插件与 AstrBot 插件不在 dev 上(维护线 `koishi-astrbot-maintenance`,见 build-release.md)。

## 包清单

### 业务核心(`packages/`,零宿主框架依赖)

| 包 | npm 名 | 角色 |
|---|---|---|
| `packages/internal` | `@bilibili-notify/internal` | Zod schema(Subscription / PushTarget / GlobalConfig / HistoryEntry)+ 平台接口(ServiceContext / MessageBus / NotificationSink / NotificationPayload)+ 工具(withLock / retry / interpolate) |
| `packages/api` | `@bilibili-notify/api` | `BilibiliAPI`(HTTP + WBI 签名)+ `LoginFlow`(扫码 + cookie 状态机) |
| `packages/storage` | `@bilibili-notify/storage` | `StorageManager` —— cookie/密钥持久化 + AES 加密 |
| `packages/push` | `@bilibili-notify/push` | `BilibiliPush` —— 经 `PushLike` 适配器做推送路由,每次投递 emit `history-recorded` |
| `packages/subscription` | `@bilibili-notify/subscription` | `SubscriptionStore` —— `Subscription[]` 内存 CRUD + `subscription-changed` diff |
| `packages/dynamic` | `@bilibili-notify/dynamic` | `DynamicEngine` —— 动态轮询 cron + 过滤 + 渲染分发 |
| `packages/live` | `@bilibili-notify/live` | `LiveEngine`(拆分:ListenerManager / DanmakuCollector / WordcloudGenerator / LiveTemplateRenderer / LiveSummaryRequester) |
| `packages/blive` | `@bilibili-notify/blive` | 自实现的 B 站直播信息流 WSS 客户端(协议编解码 + 命令解析 + 哑管道 `connectLiveRoom`,连接参数全注入、无内部 HTTP/重连;替代 blive-message-listener / tiny-bilibili-ws)。scripts/ 下有真机录帧 / 冒烟 / 登录态探针三个工具(**只读铁律:loadCookies 绝不传 refreshToken**) |
| `packages/image` | `@bilibili-notify/image` | `ImageRenderer` —— Vue/UnoCSS/JSDOM SSR + 经 `PuppeteerLike` 接口包 puppeteer |
| `packages/ai` | `@bilibili-notify/ai` | `CommentaryGenerator` —— OpenAI 兼容的 chat / summary / commentary |
| `packages/ui` | `@bilibili-notify/ui` | 纯展示 React 基础件 + design tokens(theme.css)。**源码直出**(exports 指 src,无构建步),仅 vite 系消费者(web / desktop 启动页)。组件清单在包内 README |

### 宿主适配

引擎(`dynamic` / `live` / `push` / `image`)通过 `ServiceContext` / `MessageBus` / `PushLike` / 各自的注入钩子与宿主对接;独立端 `apps/server/src/runtime/` 是唯一宿主,这些钩子一律必填、不留「宿主不注入就走旧路径」的分支。将来薄适配插件把 Koishi / AstrBot 桥接进来时,接的是**跑着的独立端**(推送平台 union + `apps/server/src/platforms/` adapter 矩阵),不再各自内嵌一份引擎。

## 工作区依赖卫生

每个 workspace `src/` import 若解析到**运行时值**(常量 / 类 / 函数),**必须**声明进该包 `package.json` 的 `dependencies`。`import type` 不进产物,无需声明;但 `declare module "x"` 这种类型增强要能从本包解析到 `x`,否则静默变成孤立声明(isolated 布局下 `packages/image` 的 Vue JSX 增强就这样断过)。

漏声明的后果:install 期当消费者版本范围解析到一个不再导出该值的版本时直接断裂。

## 服务依赖图(独立端)

```
ConfigStore        (apps/server/src/config;globals / subscriptions / targets / adapters 的文件权威,写入后 emit config-changed)
BilibiliAPI        (@bilibili-notify/api)
SubscriptionStore  (@bilibili-notify/subscription;Subscription[] 的内存权威)
BilibiliPush       (@bilibili-notify/push;sink = MultiplexSink → 各平台 adapter,注入 defaults / muted / serviceCtx)

apps/server/src/runtime/engines.ts 按顺序构造(image → ai → dynamic → live),后两者直接拿前两者的引用:

image  (cardStyle.enabled 才造)  → ImageRenderer({ puppeteer, resolveAsset, resolveFontFace, ... })
ai     (ai.enabled 才造)         → CommentaryGenerator({ api, ... })
dynamic(恒造)                     → DynamicEngine({ api, push, image?, ai?, getSubs, pickCardBackground, ... })
live   (恒造)                     → LiveEngine({ api, push, contentBuilder, imageRenderer?, commentary?, emitLiveState, emitViewers, pickCardBackground, onRoomIdResolved, ... })
```

`config-changed` 之后 engines.ts 按 scope 热重载:cron / 模板 / 版式走 `updateConfig`,渲染器与 AI 上下线走 `setImage` / `setAi`(dynamic)与 `setImageRenderer` / `setCommentary`(live)。

## 独立端模块图(`apps/`)

四个子包共用根 pnpm workspace:`apps/server`(Hono HTTP + WS;`vp pack` 出 `lib/`,`build:bundle` 出自包含的 `dist/`(入口 + hash 分块))、`apps/web`(Vite + React 19 + Tailwind 4 + tanstack-query + zustand + react-router-dom;图表是手绘 SVG,无图表库;prod 由 `apps/server` 当静态资源服务)、`apps/contract`(`@bilibili-notify/contract`,独立端 REST/WS wire 契约)、`apps/desktop`(Tauri 壳 + 启动页,装的是同一份 bundle 载荷)。

### `apps/contract`

独立端两端共同消费的 **wire 契约**:REST 响应 DTO(SubscriptionDTO / history / fans / logs / live)+ WS channel 注册表与 envelope。只放纯类型与纯常量、零运行时依赖 —— web 端 `import type` 零成本,server 端可 import 值(CHANNELS / LOG_LEVELS);zod 校验 schema 是服务端职责,留在 apps/server,用契约类型注解防漂移。注意它在 `apps/` 下、不在 `./packages/*` glob 内 —— 根脚本的 packages 预构建过滤器要显式带上 `--filter '@bilibili-notify/contract'`(dev / build:update-payload / dev:desktop / build:desktop 已配)。

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
  skins/                皮肤库(<dataDir>/skins/<id>/skin.json + assets/)+ CSS 白名单 + 聊天里的 create_skin
  maid-skills/          女仆技能(<dataDir>/maid-skills/<name>/SKILL.md)+ 内置表 + 聊天里的 load_skill
  routes/               REST:auth / subs / targets / adapters / globals / history / logs / fans / live / cards / push / health
                        / ai / skins / maid-skills
  ws/                   server(ws upgrade + 按连接 channel 过滤)+ channels + log-channel
  sink/                 NotificationSink 分发(PushTarget.id → 平台适配器)
  platforms/            OneBot v11(HTTP / ws / ws-reverse)+ Webhook + QQ 官方机器人 + WebDashboard 适配器;推送平台 union 在 internal/schema/targets.ts
```

### `apps/web`

```
src/
  pages/        Dashboard / Subs / Targets / History / Rules / Cards / Ai / System / Logs
  components/   共享原子组件 + 图标
  hooks/        useAuthChannel / usePushEventsChannel / useAlertChannel / useLogChannel / useStateChannel / ...
  services/     HTTP client(api.ts)+ 类型化封装(dashboard.ts,wire 类型 re-export 自 @bilibili-notify/contract)
  store/        zustand 管瞬态 UI 状态;tanstack-query 缓存管服务端状态
  types/domain.ts  域类型门面:类型 `import type` 自 internal/contract(编译期擦除),值级常量走
                   `@bilibili-notify/internal/constants` 零依赖子路径(不含 zod,bundle 零增量);
                   本地只剩 UI 文案 / 工厂函数。手维护镜像与 conformance 护栏测试已随之退役。
```

页面级状态归 tanstack-query;WS push 帧经 `setQueryData` 打补丁,实时更新无需额外 HTTP 往返。

## 女仆技能(Agent Skill)

**只在独立端 dashboard 的聊天里存在**,群聊那条路拿不到 —— 群里没有权限门,而技能正文是「从网上抄一份贴进来」的提示词注入面。

一条技能 = 一份 `SKILL.md`(YAML frontmatter + Markdown 正文),住在
`<dataDir>/maid-skills/<name>/`。**单文件、不带附件、不跑脚本**:这台 server 攥着
B站 cookie、推送目标与 AI key,给它开脚本口子等于给面板开 RCE。

- **名字 = 目录名 = 斜杠命令**,kebab-case ASCII。白名单里没有 `.` `/` `\`,`..` 在
  构造上就拼不出来 —— 这条是安全闸,不是口味(皮肤库那次审计的教训)。
- **盘是权威。** 主人可以手放一份进去,`GET /api/maid-skills` 每次现读;读不进来的
  经 `problems` 显示给他看,不静默消失。
- **内置那几条写在 `maid-skills/builtin.ts`**,只读、跟版本走,同名一律拒。
  `builtin.test.ts` 钉住它们声明与提到的工具名真的存在。
- **两条触发路**:模型读目录自选(`load_skill`,经 ExtraTool 注入,**绝不进
  `TOOL_DEFINITIONS`**),或主人打斜杠(请求带 `skill`,服务端取正文追加进 system
  并当场收窄工具面)。两条路都在消息流里留一枚 `load_skill` 痕迹胶囊。
- **`allowed-tools` 只减不加。** 收窄是对现有工具表做交集(`narrowTools`),写一个
  不存在的名字长不出工具来 —— 用户可写的数据永远不能扩大能力面。收窄只活一次请求。
- **正文追加在人格之后**,不顶掉它:主人要的是「按这套步骤做事」,不是换个女仆。
