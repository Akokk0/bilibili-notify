# 架构参考

仓库结构、包清单、各端模块图。CLAUDE.md 的渐进式披露目标之一。

## 顶层布局

```
packages/     平台中立业务核心(@bilibili-notify/*)
apps/         Hono 服务端 + React Dashboard + Tauri 桌面壳 + wire 契约
extensions/   拓展 —— 经窄面 ctx 挂进宿主,不编在主程序里
```

`pnpm-workspace.yaml` glob:`["packages/*", "apps/*", "extensions/*"]`。单 workspace、单 lockfile,pnpm 默认 isolated 布局;`apps/server` 经 pnpm `workspace:*` 协议消费业务核心。Koishi 插件与 AstrBot 插件不在 dev 上(维护线 `koishi-astrbot-maintenance`,见 build-release.md)。

## 包清单

### 业务核心(`packages/`,零宿主框架依赖)

| 包 | npm 名 | 角色 |
|---|---|---|
| `packages/internal` | `@bilibili-notify/internal` | Zod schema(Subscription —— 一种形状、带 identity,见 subscriptions.md —— / PushTarget / GlobalConfig / HistoryEntry)+ 平台接口(ServiceContext / MessageBus / TargetDispatcher / NotificationPayload)+ 工具(withLock / retry / interpolate / **串行闸 `createSerialGate`**:全仓唯一一把,`run` 按发起次序跑异步活、带低优先级车道,直播房间推送、作品入口、拓展作品与拓展直播、渲染都用它)+ 作品模型与信封(`Post` / `PostReport` / `PostEvent`;取段函数 `postText` 在服务端 `posts/`)+ 按版式装配消息组 `assembleMessageGroups`(动态与直播共用)+ 链接预览的跨平台接口 `LinkResolver` / `LinkPreview`(`link-preview.ts`,3b-27) |
| `apps/server/src/bilibili/api` | 不是包(3a-24 搬进服务端) | `Api`(HTTP + WBI 签名);扫码 + cookie 的状态机 `LoginFlow` 在 `apps/server/src/bilibili/auth/`(3a-29 B 站半从这里搬过去) |
| `packages/storage` | `@bilibili-notify/storage` | 持久化底层与密钥:原子写 / 追加 / 隔离 / 清扫等文件原语、`KeyManager` 与 `KeyProvider`(主密钥或口令派生)、GCM 加解密。没有 `StorageManager` / `CookieStore` 了(3a-26):B 站的 cookie 与令牌住在它这个集成自己的 `secrets` 里,由服务端的 `integration-store/` 管 |
| `packages/http` | `@bilibili-notify/http` | 集成的请求底座,通用、不带任何平台的默认值:`HttpClient`(`fetch` 回 `Result<HttpResponse>`:手动逐跳跟重定向并收 Set-Cookie、每跳之前可否决,非 2xx 不抛,网络断 / 超时 / 被中止 / 被否决回失败结果)、`CookieJar`(RFC 6265 子集,`load` / `clear` 原地换、`onChange` 通知、`epoch` 挡迟到响应)、浏览器身份(`generateBrowserIdentity` / `upgradeBrowserIdentity`)。B 站经 `bilibili/api` 里的 `ApiClient` 薄包用它,保住「非 2xx 抛错、JSON 自动解析、-101 探测」。出网点名表的白名单是它的 `http-client.ts` |
| `packages/push` | `@bilibili-notify/push` | `PushRouter` —— 经 `PushLike` 适配器做推送路由;一次推送整个交给 `push(push)`(按顺序排好的锚点,订阅 / 总开关 / 静音 / 免扰在交进来时判一次);只把**启用的**目标当候选,每个锚点对每个目标收完一段序列回调一次 `onSend`(带 `pushId` / `feature` / 逐条结果,被静音 / 免扰挡下的消息带 `isSilenced`),一个可用目标都没有时以 `target: null` 回调一次(见 events.md「推送历史的行模型」) |
| `packages/subscription` | `@bilibili-notify/subscription` | `SubscriptionStore` —— `Subscription[]` 内存 CRUD + `subscription-changed` diff。B 站与拓展的订阅同一份列表;`findById` 按订阅 id 找,`listByIdentity` 按身份(来源 + 外部 id)列出全部(遗留重复订阅是多条;作品那一路用它),`findByIdentity` 按身份找第一条(直播那几处仍用它,随 3b) |
| `apps/server/src/bilibili/dynamic` | 不是包(3a-24 搬进服务端) | `DynamicEngine` —— 动态轮询 cron + 时间线闸 + 翻译(`postFromDynamic`)+ 抓图,**只生产**:作品经来源上下文的 `reportPost` 交给核心入口,过滤 / 出卡 / 点评 / 推送都不在这里。**由 B 站来源(`bilibili/source.ts`)在 `start(ctx)` 里造并起、`stop()` 里停**,不再由 `createEngines` 造;吃名单(`subscriptions()` 与 `syncSubscriptions()`),不再有 `getSubs` / `applyOps` 那套订阅操作。作品装配与过滤住 `apps/server/src/posts/`(见下)。见 push.md ① |
| `apps/server/src/bilibili/live` | 不是包(3a-24 搬进服务端) | `LiveEngine`(拆分:ListenerManager / LiveTemplateRenderer;弹幕收集器 `DanmakuCollector`、词云、AI 总结的请求器是中立件,住 `apps/server/src/live/recap/`,3b-19 起)。中立直播装配 `pushLiveNotify`(吃 `LiveCardInput`,不认 uid)3a-40 起不在这里,住核心的 `apps/server/src/live/`(见下);这里另有 B 站房间数据 → `LiveCardInput` 的翻译 `liveCardInputFromRoomInfo`(串行闸 `createSerialGate` 不在这里,住 `packages/internal`) |
| `apps/server/src/posts` | 不是包 | **作品这一段的核心**(B 站动态与拓展作品共用,不认 uid、不读平台原始数据):`post-queue.ts` 的 `PostQueue` 是来源交作品的唯一入口(`enqueue`,同步、无返回值;按订阅一道串行闸、同步发 `post-detected`)、`deliver-post.ts` 的 `deliverPost`(过滤 → 出卡 → AI 点评 → 回问 → 模板 → 版式装配 → 图集 → 推送;含 `PostSettings`、出图失败计数 `createCardFailureTracker`)、`post-filter.ts` 的 `filterPost`、`post-text.ts` 的 `postText`(作品文字唯一的取段函数)、`post-push.ts`(推送的锚点与段、`FilteredPost`)、`card-style.ts`(动态卡样式覆盖的解析 `resolveDynamicColorOptions`,3a-40 从 `bilibili/dynamic/` 搬来)、拓展作品那一路的 `extension-post.ts`(`bindExtensionPosts`:上报翻成信封交入口)与 `post-from-report.ts`(上报 → `Post`)。见 push.md |
| `apps/server/src/bilibili/live`(`client.ts` / `codec.ts` / `events.ts` / `parser.ts`,原 blive 包) | 不是包(3a-24 平铺并进 `live/`) | 自实现的 B 站直播信息流 WSS 客户端(协议编解码 + 命令解析 + 哑管道 `connectLiveRoom`,连接参数全注入、无内部 HTTP/重连;建连口 `createSocket` 必填、只收地址,握手头由 `packages/http` 的 `websocket()` 出,blive 不依赖 `ws`;替代 blive-message-listener / tiny-bilibili-ws)。scripts/ 下有真机录帧 / 冒烟 / 登录态探针三个工具(**只读铁律:loadCookies 绝不传 refreshToken**) |
| `packages/image` | `@bilibili-notify/image` | `ImageRenderer` —— Vue/UnoCSS SSR + 经 `PuppeteerLike` 接口包 puppeteer。作品卡的出卡入口是 `generatePostCard(post)`(吃中立的 `Post`,B 站动态由 `bilibili/dynamic` 的 `postFromDynamic` 先翻成 `Post`;拓展作品经服务端的 `postFromReport` 翻成 `Post`、图先存进图库,出图器按引用取图(注入的 `resolveImageRef`));直播卡的出卡入口是 `generateLiveCard(input)`(吃中立的 `LiveCardInput`,图是图库引用、开播时刻是 ISO、人数只收精确数;B 站由 `bilibili/live` 的 `liveCardInputFromRoomInfo` 翻、拓展订阅由服务端的 `liveCardInputFromReport` 翻,出图器不再认 B 站原始数据) |
| `packages/ai` | `@bilibili-notify/ai` | `CommentaryGenerator` —— OpenAI 兼容的 chat / summary / commentary |
| `packages/extension` | `@bilibili-notify/extension` | **宿主给拓展的那一面**,也是拓展拿 BN 东西的**唯一一扇门**:ctx / 挂载点 / upgrade / 表单字段表定义在这里,推送源契约与域类型从 `internal` **转出一道**。只放类型不放实现(拓展会被打成自包含 bundle)。列出来的就是契约的全部 —— 加一格是一次明确的加宽决定 |
| `packages/ui` | `@bilibili-notify/ui` | 纯展示 React 基础件 + design tokens(theme.css)。**源码直出**(exports 指 src,无构建步),仅 vite 系消费者(web / desktop 启动页)。组件清单在包内 README |

### 宿主适配

引擎(`live` / `push` / `image`)通过 `ServiceContext` / `MessageBus` / `PushLike` / 各自的注入钩子与宿主对接;动态引擎不直接拿 `ServiceContext`,只收 `logger` 与 `setTimeout`(加 `MessageBus` / `PushLike` / `reportPost` / 名单等注入钩子),由 B 站来源在 `start(ctx)` 里递给它;独立端 `apps/server/src/runtime/` 是唯一宿主,这些钩子一律必填、不留「宿主不注入就走旧路径」的分支。薄适配插件把 Koishi / AstrBot 桥接进来时,接的是**跑着的独立端**,走的是**拓展**那条路(见下面「拓展」一节),不再各自内嵌一份引擎。

## 工作区依赖卫生

每个 workspace `src/` import 若解析到**运行时值**(常量 / 类 / 函数),**必须**声明进该包 `package.json` 的 `dependencies`。`import type` 不进产物,无需声明;但 `declare module "x"` 这种类型增强要能从本包解析到 `x`,否则静默变成孤立声明(isolated 布局下 `packages/image` 的 Vue JSX 增强就这样断过)。

漏声明的后果:install 期当消费者版本范围解析到一个不再导出该值的版本时直接断裂。

## 服务依赖图(独立端)

```
ConfigStore        (apps/server/src/config;globals / subscriptions / targets / connections 的文件权威,写入后 emit config-changed;
                    订阅一个文件 subscriptions.json,行行带 identity)
Api        (apps/server/src/bilibili/api)
SubscriptionStore  (@bilibili-notify/subscription;Subscription[] 的内存权威,B 站与拓展同一份)
PushRouter       (@bilibili-notify/push;dispatcher = TargetDispatcher → 各平台 adapter,注入 defaults / muted / serviceCtx)

apps/server/src/runtime/engines.ts 按顺序构造(image → ai → postQueue → live),后面的直接拿前面的引用;作品来源(B 站)不在这里造,`createEngines` 返回之后由 `compose.ts` 的 `registerSources` 调 `engines.registerSource` 登记并启动:

image  (cards.enabled 才造)  → ImageRenderer({ puppeteer, resolveAsset, resolveFontFace, ... })
ai     (ai.enabled 才造)         → CommentaryGenerator({ api, ... })
postQueue(恒造)                  → createPostQueue({ deps: { settings: makePostSettingsReader(...), image: () => 外层的渲染器, ai: () => 外层的 AI,
                                   cardFailures, avatar, readImage, push: boundPostPush(push, 订阅 id), recordFiltered, ... } })
live   (恒造)                     → LiveEngine({ api, push, problems(入口经 `biliProblems` 递进来的分层上报器,3b 直播并进来源后撤), contentBuilder, imageRenderer?, commentary?, emitLiveState, emitViewers, pickCardBackground, onRoomIdResolved, ... })
拓展作品(给了 extensionSources 才接)→ bindExtensionPosts({ subscription, profileName, postNoun, postImages, enqueue: postQueue.enqueue, ... })
B 站来源(createEngines 之后)        → compose.ts: createBiliSource({ api, bus, problems(分层上报器,与给入口的是同一个), imageFetcher, loginCheck(定时登录检查的开关,入口递的 setHealthCheckMs), setTimeout, auth })
                                   → engines.registerSource({ sourceKey, source, integration, logger }):建来源上下文、登记表 `await source.start(ctx)`
                                   → B 站来源 start(ctx) 里 new DynamicEngine({ logger, api, problems, imageFetcher, reportPost: ctx.reportPost, subscriptions: ctx.subscriptions, config });start 最后一步 problems.attach(ctx),stop 第一步 problems.detach()
```

`cardFailures`(出图连续失败只提醒一次)全进程一份,在 `postQueue` 的依赖里,B 站动态与拓展作品共用。动态引擎只生产(翻译、抓图),作品经来源上下文的 `reportPost` 交给 `postQueue`(同一身份的遗留重复订阅各发一份,见 subscriptions.md);拓展订阅的作品不经引擎,由 `bindExtensionPosts` 听 `subscription-reported`、翻成信封后交同一个 `postQueue`(见 push.md、subscriptions.md)。

`config-changed` 之后 engines.ts 按 scope 热重载;动态的 cron 不在这里,B 站来源 `start` 时经 `ctx.settings(schema)` 拿到读设置的把手、自己挂了 `onChange`(动态那格、登录检查那格各一个),变了动态走引擎的 `updateConfig`、登录检查走 `loginCheck.setHealthCheckMs`;「全局特性开关变了」也不在这里列举,来源上下文把 `subscription-changed` 与 `globals` 档的 `config-changed` 都转成一声「名单可能变了」,来源自己对比新旧名单;作品的模板 / 版式 / 皮肤 / 图集 / 过滤不在引擎里,`deliverPost` 每条作品现折,改了立即生效;渲染器与 AI 上下线只换外层变量,`deliverPost` 经 `image()` / `ai()` 每次现取(live 走 `setImageRenderer` / `setCommentary`)。

## 独立端模块图(`apps/`)

四个子包共用根 pnpm workspace:`apps/server`(Hono HTTP + WS;`vp pack` 出 `lib/`,`build:bundle` 出自包含的 `dist/`(入口 + hash 分块))、`apps/web`(Vite + React 19 + Tailwind 4 + tanstack-query + zustand + react-router-dom;图表是手绘 SVG,无图表库;prod 由 `apps/server` 当静态资源服务)、`apps/contract`(`@bilibili-notify/contract`,独立端 REST/WS wire 契约)、`apps/desktop`(Tauri 壳 + 启动页,装的是同一份 bundle 载荷)。

### `apps/contract`

独立端两端共同消费的 **wire 契约**:REST 响应 DTO(SubscriptionDTO / history / fans / logs / live / health)+ WS channel 注册表与 envelope。只放纯类型与纯常量、零运行时依赖 —— web 端 `import type` 零成本,server 端可 import 值(CHANNELS / LOG_LEVELS);zod 校验 schema 是服务端职责,留在 apps/server,用契约类型注解防漂移。注意它在 `apps/` 下、不在 `./packages/*` glob 内 —— 根脚本的 packages 预构建过滤器要显式带上 `--filter '@bilibili-notify/contract'`(dev / build:update-payload / dev:desktop / build:desktop 已配)。

### `apps/server`

```
src/
  index.ts              CLI / bootstrap 入口
  app.ts                Hono app 组装 + 鉴权 + 路由挂载
  compose.ts            组装根(3a-28 提前建,原定 3a-40):整个核心只有它登记内置集成。今天做四件事 —— `registerAdapters` 登记并启动 OneBot / QQ 官方机器人 / webhook 三个内置适配器(适配器在 `composeBuiltinIntegrations` 被调时就造好,3a-40 第一块;入口在引擎之前调它;核心里只有这个文件能 import `platforms/`,`scripts/__tests__/import-boundaries.test.mjs` 钉着)、`registerSources` 造 B 站来源并登记(引擎建好之后调;入口递进来的登录口 `sourceAuth` 挂到来源的 `auth` 上)、`provideDevtools` 认领 B 站那组开发场景(过了开发版两道门才会调)、造大航海徽章图(自带一个不带 cookie 的请求客户端,登记成图库「来源声明的图」这一家引用方,造好当场经 `AppRuntime.attachGuardIcons` 交给运行时,3a-40);另有模块级常量 `BUILTIN_INTEGRATION_SETTINGS`(各内置集成的设置段,入口建运行时时交给 `createAppRuntime`,3a-40)。日志器也在这里开:B 站的上报器与舰长图标用 B 站那一格,三个适配器各用按适配器键开的,来源登记项带 `dynamic` 标签、跟 B 站那一格的日志器(见下面 `runtime/log-levels.ts` 一行)。交回入口 `BuiltinIntegrations`,`bilibili` 那一格只剩 `problems`(入口读不到 B 站来源的任何句柄:`status` 读登记表里各来源自己说的那一行,`Source.health()`,3a-40),入口从它拿 B 站的分层上报器(3a-30:`composeBuiltinIntegrations` 里先造,给来源与给入口的是同一个,入口递给 `createEngines` 的 `biliProblems`,直播引擎用)。登录装配(`createAuthSystem`)没有进来,仍由入口造,留到 3b(主人 10-12 定,3a-40 没做)。只许放登记与开发场景的过渡接线:出口由入口咽喉守卫(`scripts/__tests__/entry-throat.test.mjs`,3a-40)钉着,里面长没长登记以外的逻辑仍靠审查;进程内对拍(守卫 21b,3a-42)在测试里 `vi.mock("../compose.js")` 包一层真的 `compose.ts`(`apps/server/src/__tests__/support/in-process-source.ts` 的 `wrapCompose`):设置段后面追加假来源的一段,`registerSources` 里真的登记完之后对假来源调同一个 `engines.registerSource`,不改 `compose.ts` 本身;进 B 站替身守卫的白名单
  subscriptions/        来源这一侧的核心宿主(类型 `Source` / `SourceContext` / `SourceDescriptor` 住 packages/internal/src/source.ts):registry.ts(来源登记表 `SourceRegistry`:认领键 → `start(ctx)` → 回撤销把手;`get` / `list`;对外的视图除 `descriptor` 外带来源的 `auth` 与 `health`(来源交了才有这一格;放进视图时绑着 `this`,3a-40;`status` 指令读它)、source-context.ts(`createSourceContext`:公共五格逐格列出 + `subscriptions()` / `onSubscriptionsChanged` / `reportPost` / `reportProblem` / `resolveProblem`;问题的上报在这里校形状、按身份展开成每条订阅,写进问题表,3a-30)、source-subscriptions.ts(名单的唯一算法 `sourceSubscriptionViews`,与按特性取订阅的 `subscriptionsOfFeature`)、builtin-sources.ts(`registerBuiltinSource`:建上下文 + 登记 + 订阅来源的 `auth.onChange` 并发 `subscription-auth-changed` + 合成撤销把手;撤登记与登记失败时 `clearReporter`,3a-30)、source-status.ts(`SourceStatusReader.running`)、membership-tiers.ts(`MembershipTierReader`:卡片路由与皮肤预览按来源描述符里的会员体系找档)
  auth/                 只剩面板自己的鉴权(九个文件):bare-auth-policy / cookie / dashboard-auth / desktop-token / ip-rate-limit / origin / safe-equal / session / ws-ticket。B 站的登录系统原来也住这里,3a-29 B 站半起在 `bilibili/auth/`
  config/               loader(bootstrap 配置加载)+ ConfigStore(原子写 <数据根>/config/*.json,emit config-changed)+ schema;3a-39 起读设置逐格:core-settings.ts(核心设置逐格解析 `parseCoreSettings`、落盘前把仍被隔离的格盖回盘上原文 `withRawSettings`,纯函数)、integration-settings.ts(集成段设置逐格解析 `parseIntegrationCells`,复用上一个的 `parseCell` 与 `withRawSettings`)、settings-problems.ts(核心坏格表 → 问题表里报的人 `core`、码 `settings_invalid` 的那一条,几格合成一条、不私聊;由 `runtime/bootstrap.ts` 把仓的 `onInvalidSettingsChanged` 接过来);ai-secrets.ts 多一个 `isSearchSecretKey`(密钥袋的键属于搜索域还是实例域,袋里被隔离的 `ai` 子格名下的旧键重算时留着);核心设置文件只有 `persistGlobals` 一个落盘口(`scripts/__tests__/core-settings-single-writer.test.mjs` 钉着);坏格表住仓里,读口 `getInvalidSettings()` / `readIntegrationSettings(key)` 带盘上原文、不许接到路由、日志或备份上
  migration/            0.x → 数据代的一次性迁移:第 0 代(宿主根上 0.x 的文件)只读,先按代布局搬进 <序号>.partial,再逐族把 0.x 各版本的形状改写成 0.x 最新的形状(connections.ts 连接与目标、settings.ts 设置、subscriptions.ts 订阅,history.ts 推送历史,stats.ts 统计的文件名与行,roast-drafts.ts 锐评草稿,skins.ts 界面皮肤,conversations.ts 女仆对话,secrets.ts 加密袋,bili-login.ts B 站登录(0.x 的 secrets/cookies.json → secrets/bilibili/secrets.enc),features.ts / ai.ts / link-parsing.ts / templates.ts 是各组老形状的变换,files.ts 共用的读写);旧格式的知识只住这里,各个 store 只认最新形状(ADR-0022)
  runtime/
    bootstrap.ts          AppRuntime 容器(api/storage/push/store/engines/fansPoller/...,另有 `adapterRegistry` 与 `sourceRegistry` 两张登记表;`createAppRuntime` 的第三个参数 `integrationSettings` 必填 —— 各内置集成的设置段由入口从 `compose.ts` 的 `BUILTIN_INTEGRATION_SETTINGS` 递进来,这里不 import `bilibili/settings`;`attachGuardIcons` 收组装根造好的舰长图标,没交进来就读 `guardIcons` 会抛,3a-40);宿主根取配置的 dataDir,数据根由开机选代交进来(构造期不碰盘)
    roots.ts              宿主根(versions/ logs/ generations/)与数据根(一代)的目录表 + hostPath / dataPath;本文写的 <数据根>/… 就是选中的那一代 <dataDir>/generations/<序号>/
    generations.ts        数据代:选代(格式版本 ≤ 我里序号最大的)、在 <序号>.partial 里开代再原子改名;迁移修订号对不上就重开(ADR-0022)
    service-context.ts    NodeServiceContext(pino + setInterval/setTimeout + 分段的 onDispose / track / signal,见下「关停」;`forSubsystem(标签, 等级键)` 开子上下文,同一对(标签, 键)交回同一个实例,`applyLogLevels` 把整张等级表推下去,见下「日志等级」)
    log-levels.ts         `bindLogLevels`(3a-40):把核心设置里 `logging.level` 与 `logging.levels` 接到 `NodeServiceContext.applyLogLevels` 上 —— 绑上当场推一次,之后这两格变了再推,别的核心设置变了不推;入口在配置读完之后立刻调、挂在 `stop` 段摘掉
    message-bus.ts        NodeMessageBus(mitt 风格,事件表 BusEvents)
    engines.ts            引擎热重载接线;消费 config-changed;建作品入口 `PostQueue` 并接上它的依赖(作品设置现折 `postSettingsOf` / `makePostSettingsReader`,「来源还在跑吗」问来源登记表);对外有 `registerSource`(给内置来源建上下文并登记即启动,关停时先停登记过的来源再关作品入口);把发送钉到订阅上(`boundPostPush` / `boundLivePush`)
    extension-push-common.ts 拓展作品与拓展直播共用的作者 / 名字 / 还该推吗(拓展作品那一路本体已搬进 posts/extension-post.ts)
    sub-runtime-store.ts  资料缓存 <数据根>/runtime/sub-runtime.json;拓展报的资料经 reported-profiles.ts 落进来,头像存进图库、这里只放引用(资料缓存是图库的一家引用方,`listImageRefs()` 交名单)
    fans-poller.ts        FansPoller —— 问 B 站、写 <数据根>/stats/followers/<订阅 id>.jsonl,emit fans-refreshed(首页粉丝面板的快照,拓展订阅那几行从统计写的时序算)
    generation-usage.ts   旧版本数据(代)的列表、两个大小、删除(能不能删在这里判)与开机收残骸;/api/system/generations
    storage-usage.ts      系统页「存储占用」:按类量大小、整类清空、手动图库清扫;/api/system/storage
    master-notifier.ts    engine-error 转 master 私聊(组件告警,按 `source` 节流 60 秒;3a-30 起**只听 engine-error**,不再听 `auth-lost`;问题表里的事归 `problems/` 的通知器,两家各有各的节流表)
    puppeteer.ts          puppeteer-core 适配器(卡片预览)
  problems/             问题表(3a-30):problem-table.ts(`createProblemTable`:各集成报上来的「主人该知道的事」,全在内存;同键只换文案、`since` 不动;报的人自己清可补「已恢复」,宿主清 `clearReporter` / `clearSubscription` 不补;按报的人 250ms 尾沿合并后经 `onChanged` 发 `problems-changed`,表不碰总线)+ problem-notifier.ts(`createProblemNotifier`:听表的变化,`notify` 为真的问题私聊主人;按节流键(报的人 + code)对账:同键上一句问题私聊送到后 60 秒内不再发,同键每清掉一条后 5 秒沉淀内也不发;`notifyMaster` 回 ok 才算真私聊过;稍后可重试的失败按 10 秒 / 30 秒 / 60 秒 / 5 分钟 / 15 分钟再送五次(档位记在键上,结果不明的不重发);清掉时对真私聊过的发这条问题自带的恢复说法,「已恢复」不受窗口与沉淀管、不限流);`Problem` 类型住 `packages/internal/src/problem.ts`。表建在 `runtime/bootstrap.ts`(`AppRuntime.problems`),通知器在 `runtime/engines.ts` 里与 `MasterNotifier` 并排建,写口是来源上下文的 `reportProblem` / `resolveProblem`,读口是 `routes/problems.ts`
  util/keyed-coalescer.ts 按键合并、窗口到了尾沿发一次(`createKeyedCoalescer`):问题表的 `problems-changed`、拓展状态变化、拓展上报出入、拓展报的资料、拓展在播表五处共用一份(3a-30 抽的,窗口长度各自定)
  posts/                作品这一段的核心,B 站动态与拓展作品共用:post-queue.ts(`PostQueue`,来源交作品的唯一入口)、deliver-post.ts(`deliverPost` 装配)、post-filter.ts、post-text.ts、post-push.ts、extension-post.ts(拓展作品上报 → 信封交入口)、post-from-report.ts(上报 → `Post`)
  live/                 直播这一段的中立件(3a-40 从 `bilibili/live/` 搬来,B 站的直播间与拓展订阅的直播共用,不认 uid、不认房间数据):live-notify.ts(`pushLiveNotify`:出卡 → 分组 → 发送)、live-text.ts(直播文案模板 `DEFAULT_LIVE_TEMPLATES`、占位符替换 `applyTemplate`、`renderLiveText`,特别弹幕、特别进场两句的渲染,以及下播总结的 `renderLiveSummary`)、special-users.ts(3b-15 从 B 站的直播会话抽来:`pushSpecialDanmaku` / `pushSpecialUserEnter`,开关 → 名单按观众 id 判 → 套文案 → 交一句文字给绑到订阅上的发送)、interaction-gates.ts(醒目留言与会员的两条门槛函数)、superchat.ts(3b-17:`pushSuperchat`,过门槛 → 确定要出卡才取观众头像 → 出卡 → 出不了卡发兜底文字)、membership.ts(3b-18:`pushMembership`,过门槛 → 自定义文案 / 出卡 / 兜底三支)、live-types.ts(推送类型 `LivePushType`、特性键、订阅上的直播卡样式与「特别用户」两块设置的形状、`PickLiveCover`)、live-settings.ts(一条订阅折好的直播设置 `LiveWorkSettings`,B 站的订阅视图 `SubItemView` 继承它;断流接续等待分钟数与封面轮换 `rotateLiveCover`)、content-builder.ts(`LiveContentBuilder`:宿主给的内容构造口)、recap/(3b-19:下播后的回顾 —— 按订阅 id 记账的弹幕收集器、词云生成、AI 总结请求器与停用词,以及 recap-anchors.ts 的 `recapAnchors`:下播时取弹幕快照、按订阅额外的停用词再滤、词云与总结各起各的、各交一个附加项锚点)、拓展订阅直播的一组(3b-20 从 `runtime/` 搬来):live-table.ts(`LiveTable`:在播表,首页「正在直播」里拓展那几行,表变了发 `extension-live-changed`)、live-sessions.ts(`LiveSessionEngine`:每条订阅这一场从哪开始、到哪结束,含断流接续,推送与统计共用)、live-push.ts(`bindLivePush`:开播 / 正在直播 / 下播卡的推送与周期计时器)、live-card-input-from-report.ts(把在播表里的原件翻成中立的 `LiveCardInput`,图经 `runtime.liveImages` 存进图库)
  link-preview/         群里链接自动出卡片的中立门(3b-27 / 3b-28):link-parser.ts(`createLinkParser`,门;文件名暂时没改,职责已是通用的门:通用网址正则挑候选、按登记先后问解析器认不认、取前三个被认领的、两把冷却键、出卡回复)、url-candidates.ts(`extractUrlCandidates`,通用网址正则)、registry.ts(`LinkResolverRegistry`:解析器的登记表,一个来源键一个主人;来源在自己的 `start(ctx)` 里经 `ctx.registerLinkResolver` 登,停下时随来源上下文自动撤)、link-scope.ts(逐群答案:默认行加逐群例外对上入站帧里的群)、link-reply.ts(回到来源群的发送口,经 `sendToAddress`)。`LinkResolver` / `LinkPreview` 两个类型住 `packages/internal/src/link-preview.ts`;B 站的解析器在 `bilibili/link-resolver.ts`。说明见 commands.md 末尾「链接解析」
  followers/store.ts    粉丝时序(<数据根>/stats/followers/<订阅 id>.jsonl):按订阅排队追加,满 8 天的由 stats/compaction.ts 那趟压缩成每小时末值与同值段,读口把段展开回点
  stats/                统计仓(<数据根>/stats/{posts,live,recording}/<订阅 id>.jsonl,行格式中立;recording 是「在记」按小时的账)+ 记录器与各来源适配(bili-source.ts 把 uid 换成订阅 id)+ 聚合 + 锐评(ADR-0020 / 0027);enabled.ts 是统计总开关 stats.enabled 的缓存读口;compaction.ts 那趟(开机一次、每 6 小时)压粉丝样本与账;0.x 的文件与老行由迁移器一次改好(migration/stats.ts、recording.ts、followers.ts)
  uptime/               运行记录(<数据根>/uptime/hours.jsonl:每个 UTC 整点小时 BN 跑了多少分钟;不算统计、不受统计总开关管);0.x 的由 migration/uptime.ts 从粉丝样本回填
  history/              HistoryStore(<dataDir>/history/<日期>.jsonl,一行 = 一次推送 × 一个目标,追加写补丁行读时并回;配图与头像快照存的是图库引用)+ retention(文字不删,重推原件按水位线清,图由图库按引用清扫;`listHistoryImageRefs` 是历史这一家的引用方名单)+ repush-store(重推原件,图也在图库)+ view(REST / WS 共用投影)
  logs/                 LogStore + retention + redact(凭据脱敏)+ sink
  skins/                皮肤库(<数据根>/skins/dashboard/<id>/skin.json + assets/)+ CSS 白名单 + 聊天里的 create_skin
  maid-skills/          女仆技能(<dataDir>/maid-skills/<name>/SKILL.md)+ 内置表 + 聊天里的 load_skill
  routes/               REST(ADR-0036:顶层是资源,只属于它的才下沉;文件名跟路径走):health / settings / subscriptions / targets(含 `:id/test`)/ connections(含 `:id/probe`)/ history / live / stats(+ stats-followers)/ cards(+ cards-skins)/ ai(+ ai-skills)/ dashboard-skins / system(+ system-logs / system-update / system-backup)/ session / ws(`/api/ws/ticket`,无条件挂在登录闸后面)/ sources(来源的登录口:`GET|POST|DELETE /:sourceKey/auth`,直接问来源登记表,3a-29 B 站半;`/api/auth` 已退役)/ adapters(`connectionAuth` 的三个扫码口,3a-29;`/api/qq` 已退役)/ problems(`GET /` 一次给全问题表,3a-30,面板第 4 期才读)/ commands
                        / ext(拓展清单与每个拓展的面板数据)
  ws/                   server(ws upgrade + 按连接 channel 过滤)+ channels + log-channel
  push/                 `target-dispatcher.ts`:TargetDispatcher 分发(PushTarget.id → 平台适配器)+ `registry.ts` 的**活注册表**(拓展注册的推送源往这里进,按分发键认领,占了就抛)+ `dispatch.ts`(按连接找适配器)
  platforms/            OneBot v11(HTTP / ws / ws-reverse)+ QQ 官方机器人 + Webhook(飞书 / 钉钉 / 企微 / 未指明,同一个 adapter 的四个方言分支)三个**直连** adapter;推送源契约在 internal/push-source.ts,连接平台词表在 internal/constants.ts(`CONNECTION_PLATFORMS`,**只管直连**),schema 在 internal/schema/targets.ts
  bilibili/             B 站的代码:settings.ts(B 站设置)+ context.ts(B 站的上下文 `BiliContext`:集成上下文加请求客户端与 cookie 罐的把手;来源上下文建在它之上,`http` / `cookies` 仍只在这里,3b 公共上下文开放 `http` 时才能并)+ source.ts(B 站来源 `createBiliSource`:`start(ctx)` 经 `ctx.settings(schema)` 各读各的格(动态那格、登录检查那格)、挂名单回调与两个 `onChange`:动态那格读得懂才造并起动态引擎(读不懂就不造、报 `dynamic_settings_invalid`),登录检查那格读得懂就经 `deps.loginCheck` 挂定时的登录检查(读不懂就停、报 `login_check_settings_invalid`),`stop()` 同步停干净,`dynamic()` 交回引擎句柄(动态停着时是 `undefined`);`health()` 交 `status` 里 B 站那一行的话(上次抓取 / 还没抓过 / 动态停着设置读不懂,文案在 `health-texts.ts`,3a-40);`start` 最后一步把分层上报器 `attach` 到来源上下文、`stop` 第一步先 `detach`)+ problem-layers.ts(3a-30:`ProblemLayers`,B 站报错按因果分三层,问题表里同时只留最上面一层 —— 未登录 `auth_lost`(只看 `AuthState.status`)→ 风控 `risk_controlled`(按「路」记:`dynamic`、`live:<uid>`)→ 各项请求失败(`dynamic_fetch_failed`、`live_monitor_stopped`、`live_room_restricted`);动态与直播共用一个,`compose.ts` 先造、来源登记之后才接上核心,接上前开着的先记着、接上时整份补报;方法都不往外抛)+ problem-texts.ts(3a-30:`PROBLEM_TEXTS`,给主人看的每句话集中在这里,每个条目带 `text` / `notify` / `recovery`,女仆口吻)+ api/(Api / ApiClient / WBI)+ auth/(登录这一套,3a-29 B 站半从 `api/` 与顶层 `auth/` 搬来:`index.ts` 的 `createAuthSystem` 交回 `{ api, integration, auth, healthCheckNow, setHealthCheckMs, dispose }`,其中 `auth` 就是 B 站来源挂在 `Source.auth` 上的 `SourceAuth`;`login-flow.ts` 的 `LoginFlow` 是状态机,内部状态是带类型的 `BiliLoginState`;`login-state.ts` 里 `authStateFromLoginState` 把它算成中立的 `AuthState`;登录系统**不再读 B 站设置**(3a-39):`LoginFlow` 以间隔 0 起步、不挂定时的登录检查,间隔由 B 站来源 `start` 读了设置后经 `setHealthCheckMs` 挂上或停下(`<= 0` 是停,之后扫码成功、恢复备份、登录恢复都挂不回来);账号头像由它抓进图库)+ dynamic/(DynamicEngine,只生产 / postFromDynamic,吃名单)+ live/(根上:翻译函数 membership-event / superchat-event / live-card-input、徽章图标 guard-icons、以后搬去核心的 live-notify / template-renderer / content-builder;protocol/ 弹幕连接的协议层 client / codec / events / parser,说明在它的 README.md;session/ LiveEngine / ListenerManager / RoomSession;下播后的回顾 `recap/` 已在 3b-19 搬进核心的 `live/recap/`)+ 链接解析这一组(3b-27 / 3b-28):link-resolver.ts(`createBiliLinkResolver`:B 站的链接解析器,由来源 `start(ctx)` 经 `ctx.registerLinkResolver` 登记;认链接、查视频、封面在这里抓进图库、交一份作品与原生分享的中立描述)、video-links.ts(`extractVideoLinks`:视频链接的认法,「同一个视频」的判据 `videoLinkKey`)、video-card.ts(`videoToPost`:视频信息翻成作品)、link-resolver-texts.ts(解析器失败结果的文案)
  integration-store/    集成的 state / secrets 存储宿主本体(`createIntegrationStore`,在 `runtime/bootstrap.ts` 建、挂在 `AppRuntime.integrationStore`,构造期不碰盘):key-value-store(内存里的一袋键值 + 校验:保留前缀、限额、值得是 JSON、`batch` 先验后写)、files(`state.json` / `secrets.enc` 的读写与路径,读盘三态)、store(按集成键开 / 关 / 删、备份的 `exportSecrets` / `restoreSecrets`、写道与关停的 `flush` 段关门)。每个集成拿到的把手有集成一面与宿主一面(宿主一面只许 `http.` 开头的键)。`IntegrationContext` 的 `state` / `secrets` 引用它
  integrations/         集成宿主(内置集成与拓展共用):http(`createIntegrationHttp`:替集成造请求客户端、cookie 罐与浏览器身份,罐子自动存、闸、`commit`;B 站是第一个调用方)、registry(通用登记表 Registry,按键认领、只撤自己那行;`entries()` 按认领先后列,3a-28 补)、stop-quietly(`stopQuietly`:调 `stop()` 不等它、失败交回调,适配器登记表与来源登记表共用)、settings-reader(3a-39:`createSettingsReader`,给一个集成造「读自己设置」的把手 `SettingsReader`:`get()` 每次现读现判、回 `Result`、永不抛;`onChange` 只在这一份真变了、或读得懂与读不懂之间翻了才叫,去重游标只有一个、住在把手里;由 `subscriptions/source-context.ts` 的 `ctx.settings(schema)` 用,读口与通知口由 `runtime/engines.ts` 的 `registerSource` 按登记项的键接到配置仓)、context(集成上下文的工厂 createIntegrationContext:日志、停止信号、收尾钩子,外加宿主握着的名册与收尾;类型 IntegrationContext 住 packages/internal;拓展上下文与内置平台适配器的上下文都建在它上面)
  extensions/           拓展宿主:discover(扫多根)/ loader(按开关装载 + 失败记账)/ context(窄面 ctx)/ mount(`/ext/:id/*` 活路由表)/ upgrade(WS upgrade 分发)/ config-fields(两份声明对表)
```

#### 开机

开机分两段(ADR-0022 决策 2 与它下面的 🔗),桌面壳 30 秒等的只是健康检查:

1. **先 listen**:读启动配置、选代(只读盘;新装的空代当场开)、开机清扫(只扫 `versions/` 与要用的那一代,第 0 代与旧代是备份不碰)、建运行时(**构造期不碰盘** —— 要开新代时数据根还是一条没改名的路径,构造里一写就撞)、挂日志钩子(从这一刻起进归档与 WS 的环形缓冲)、鉴权策略、会话签名(要迁的话,密钥从第 0 代只读地取),然后 listen。这时由 `createStartupApp` 应答:健康检查照答(模块全是 false),别的 `/api/*` 与拓展挂载点回 503 `unavailable`。它和完整的 app 同出 `createAppShell`,鉴权闸是同一套(`__tests__/boot-listen-first-e2e.test.ts` 钉着)。HTTP 排空紧跟着 listen 登记。
2. **再读数据、起引擎**:要开新代的话先迁(`migration/zero-generation.ts`,503 那句话带进度),再统计采集 `start()`、配置、鉴权子系统、引擎、拓展……建完完整的 app,请求切过去,再挂拓展的 upgrade 分发与 WS。`__tests__/boot-generations-e2e.test.ts` 钉着:迁完之前那一代不存在、第 0 代一个字节不变、迁移期间登录的 cookie 迁完照样有效。

`startServer` 等第 2 段做完才返回。第 2 段抛错就关掉 HTTP 再抛:冻住的 boot.mjs 会在同一进程里起预装的那一版,端口必须已经放掉。往开机里加一步时先想清楚放哪一段:碰数据、会慢、要联网的放第 2 段;和数据无关、又得在 listen 之前定下来的(比如鉴权)才放第 1 段。

#### 关停

`close()` 只给预算(默认 8 秒,每个宿主的硬杀时限都比它长,`scripts/__tests__/shutdown-budget.test.mjs` 钉着)。收尾全靠各部件装配时往 serviceCtx 登记的钩子,按 `DisposePhase` 分段跑,同一段里后登记的先跑;一个钩子抛错只记一条,不连累后面的。

| 段 | 放什么 |
| --- | --- |
| `stop` | 生产者:来源、拓展、引擎、平台连接、定时任务、鉴权。`serviceCtx.signal` 在这段之前就中止,挂着的 ctx 定时器也清掉 |
| `drain` | HTTP 排空,最多占预算的 30%,到点强断剩下的连接(含不回关闭帧的 WS);B 站请求客户端的连接池也在这段收(`createBiliContext` 登记:`client.dispose()` 会让在途请求失败,所以不放进 B 站上下文自己的收尾,那个收尾整个在 `stop` 段跑) |
| (段间) | 等 `track()` 登记的后台活落定 |
| `flush` | 统计补下播帧;各写道(含集成存储宿主 `integrationStore.close()`)落盘并关门,关门后再交进来的写一律 `queue_closed` 拒绝、不碰盘 |
| `dispose` | 其余:浏览器;日志归档排最后,关停期打的日志都赶得上它 |

- 新加一个存盘的仓:写道用 internal 的 `createSerialQueue`,给仓一个 `close()`,在创建它的地方登记进 `flush` 段。它若往别的仓写,它的等待要登记在下游的 close **之后**(同段后登记的先跑),资料处理链与图库 / 资料缓存仓就是这样排的,有接线测试钉着。
- 发出去不管的写入不许裸 `void`:交给 `serviceCtx.track(...)`,交进去的 promise 要把那笔写包在里面、失败自己接住;长跑的(重试退避、下载)接 `serviceCtx.signal` 叫停,别指望预算硬等。
- 守卫 8(`__tests__/data-dir-still-after-close-e2e.test.ts`):关停返回以后数据目录不再变化。它把关停开始时还在路上的写入垫慢,没被等到的写一定落在关停之后;加了新的晚到写入,就在它的场景里补一步。

#### 日志等级

**一行日志是谁的代码打的,就跟谁那一格**(3a-40,主人 10-11 定:一个集成当成一个整体)。等级住设置里的 `logging.level`(总等级)与 `logging.levels`(按键覆盖,开放字符串键):键是核心的三格 `core` / `image` / `ai`,或集成键 —— B 站的 `bilibili`、三个内置适配器各自的适配器键(`onebot` / `qq-official` / `webhook`)、每个拓展的 id;没写的键跟总等级;写了没有对应集成的键不报错、留在盘上、不起作用,那个集成出现时生效。`image`、`ai` 与 `core` 一样是拓展不许用的 id(`RESERVED_EXTENSION_IDS`),免得拓展与核心共用一格。

- **机制**:`createNodeServiceContext` 有一个基础日志器(跟 `core` 那一格),每对(标签, 键)另开一个 pino 实例:`forSubsystem(标签, 键)`,同一对交回同一个。**标签**是日志行的 `name` 字段(日志页「来源」筛选项的出处),**键**只管等级,所以两个同名标签跟不同键是正常用法(`live` 既有跟 `core` 的、也有跟 `bilibili` 的)。等级表只有 `bindLogLevels`(`runtime/log-levels.ts`)一处推、`applyLogLevels` 一处收;全仓没有第二处据 `logging.levels` 定等级的服务端代码。入口在配置读完之后立刻绑,所以登录系统与引擎装配起步时日志器已经是设置里那一格;热更不重启。表里没有的键、`toString` 这类原型上有的名字一律跟总等级。拓展热装时子上下文按记下的等级表起步,停了再起拿回同一个实例,它停着时改它那一格,再起来已是新值。
- **谁用哪一对**:核心其余一切用基础日志器(`core` / `core`);作品队列、作品装配与拓展作品的接入 `posts` / `core`;替拓展跑的直播场次与推送 `live` / `core`;AI `ai` / `ai`、出图 `image` / `image`;B 站直播引擎 `live` / `bilibili`(引擎装配里剩下的唯一一处读 B 站那一格,3b 直播并进来源时随之走);B 站来源与动态引擎(来源上下文的 `ctx.logger`)`dynamic` / `bilibili`,由 `compose.ts` 造好随登记项递进去;B 站登录系统、接口客户端、登录流程、集成上下文 `bilibili` / `bilibili`,`bilibili/auth/index.ts` 开头自己开;B 站分层上报器与舰长图标 `bilibili` / `bilibili`(`compose.ts`);三个内置适配器与它们的集成上下文,标签与键都是适配器键(`compose.ts` 的 `loggerOf`);每个拓展,标签与键都是它的 id(入口把 `loggerOf` 递给装载器);宿主在集成的「上下文」层替它写的日志(来源上下文、拓展上下文、集成上下文、来源登记表那几行)跟那个集成那一格;装载器自己的行(`[ext] <id> …`)是核心的代码,跟 `core`。
- **面板**:系统页只有 `core`、`bilibili`、`image`、`ai` 四行,适配器与拓展的入口第 4 期才有;在那之前单独调它们只能调总等级,或手发 `PATCH /api/settings`(`logging.levels.<键>`,清掉发 `null`)。

### `apps/web`

```
src/
  pages/        Dashboard / Subs / Targets / History / Rules / Cards / Ai / System / Logs
  components/   共享原子组件 + 图标
  hooks/        useAuthChannel / use-source-auth(登录态的唯一读口:`["source-auth", 来源键]` 查询缓存,读的地方各自点名要哪个来源;`store/auth.ts` 已删)/ usePushEventsChannel / useAlertChannel / useLogChannel / useStateChannel / ...
  services/     HTTP client(api.ts)+ 类型化封装(dashboard.ts,wire 类型 re-export 自 @bilibili-notify/contract)
  store/        zustand 管瞬态 UI 状态;tanstack-query 缓存管服务端状态
  types/domain.ts  域类型门面:类型 `import type` 自 internal/contract(编译期擦除),值级常量走
                   `@bilibili-notify/internal/constants` 零依赖子路径(不含 zod,bundle 零增量);
                   本地只剩 UI 文案 / 工厂函数。手维护镜像与 conformance 护栏测试已随之退役。
```

页面级状态归 tanstack-query;WS push 帧经 `setQueryData` 打补丁,实时更新无需额外 HTTP 往返。

## 拓展(`extensions/`)

一个拓展 = 一个目录 + 一份 `extension.json` 清单 + 一个导出 `activate(ctx)` 的入口。定案见
`docs/adr/0012-extensions.md`;第一个(也是眼下唯一一个)是**机器人框架桥接**
`extensions/bridge/`,它对外的线上协议在 `extensions/bridge/PROTOCOL.md`。

- **一切副作用都从 `ctx` 过** —— 定时器、HTTP 挂载点、WS upgrade、推送源、入站、面板数据。
  裸 `setInterval`、裸挂端点是禁止的:那是「停用得干净」的唯一承重条件。
- **一扇门**:拓展只从 `@bilibili-notify/extension` 拿 BN 的东西(见 CLAUDE.md 硬约束),
  反方向核心也不 import 拓展。两条都有可执行守卫。
- ⛔ **本体一个拓展都不带。** 拓展只有两条来路:下载,或者主人自己放进
  `<数据根>/extensions/<id>/`。载荷里没有 `extensions/`,装载器也**没有那个根** ——
  这一条是结构性的,不是约定(主人 2026-09-09 推翻了 ADR-0012 决策 34 的「随载荷预装」)。
- **只有一个根**:`<数据根>/extensions/`,入口只认 `index.mjs`。曾经还有个仓里的源码根,
  2026-09-10 去掉了 —— 开发时改由 **devtools 把仓里构建好的 `dist` 链进那个根**
  (左下角 dock 的「拓展」一组:装 / 卸 / 重载)。一个根意味着没有优先级、没有「同一个 id
  有两份」,开发时跑的东西与手放的、日后市场下载的**形状一模一样**。清单里**没有 `entry`
  字段** —— 入口固定,宿主自己判。
- **开箱即有 ≠ 默认开着**:`globals.extensions.<id>.enabled` 缺失就是关着。关着的拓展
  **一行代码都不 import**,但列得出来。
- **两个 URL 前缀,分开它们的是鉴权域**:`/ext/<id>/*`(拓展自己的 HTTP 与 WS,**刻意在
  dashboard 鉴权之外** —— 对家手里只有 URL、没有会话)与 `/api/ext`(清单(含 descriptor 与
  config 字段表)、`/api/ext/<id>/status` 面板数据、`/api/ext/<id>/bots` 现在能借来当连接的 bot、
  `POST /api/ext/<id>/swap` 只重载这个拓展,吃 dashboard 会话鉴权;`/api/ext/marketplace` 拓展市场的索引与从市场装,见 `extension-marketplace.md`)。代码与配置面一律写全称(`globals.extensions` / `loadExtensions`)。
- **推送源的分发键由宿主按拓展 id 填**,拓展自报的那份会被覆盖 —— 否则一个拓展声明
  `"onebot"` 就能把内置连接的推送整个截走。
- **打包 = 清单 + 一个自包含 `index.mjs`**:每个拓展自己 `vp pack` 出 `dist/`,第三方**全内联**
  —— 装它的地方旁边没有 node_modules,留一个裸依赖是「构建全绿、主人拨开关那一刻才
  `ERR_MODULE_NOT_FOUND`」。那个 `dist/` **就是拓展包本身**:拷进 `<数据根>/extensions/<id>/`
  就能跑,日后的下载分发发的也是它。开发时由 devtools 把它**链**进去(`vp pack -w` 一改
  就重打包,链着的那份当场是新的)。
- **换代码走显式「重载」**:收摊 → 换一个按指纹定的 URL 重新 `import` → 重新 `activate`。
  ESM 的模块缓存删不掉,但**URL 不一样就是一份新模块**;代价是旧模块回收不掉(每重载一次漏
  一份)。开发版的 devtools 随时能按(代码没变 URL 也不变,不白漏);生产上**只在有新版等着
  换上时**给(`swap()`,见下一条),与「重启 BN」并排由主人选(ADR-0012 决策 47)。**刻意不挂在
  开关上** —— 拨开关保持生产语义,否则「拓展模块顶层存了状态」这种 bug 只会在真机上露面。
- **拨开关即热装卸**:`globals.extensions` 一动,装载器 `sync()` 一遍 —— 关掉当场收回它
  注册的一切(定时器 / 挂载点 / upgrade / 推送源,连着的会话跟着断),打开就地 `activate`。
  判据是**开关变没变**,不是「现在跑没跑」:按后者写的话,一个加载失败的拓展会在每次保存
  全局设置时重试一次,几下就把失败记账烧到自动停用。
- **装 / 卸也是热的**:`rescan()` 再扫一遍装载目录 —— 新出现的按开关装上,消失的当场收摊。
  装载器**按入口文件的指纹认代码**(ADR-0012 决策 47):这个进程见过的那一份复用原 URL,
  从没 import 过这个 id 的走文件本身,**见过别的、没见过这一份**(删了再装、覆盖安装)就不跑,
  那一行标上 `staged`(「新版等着换上」)。**跑着的代码不偷偷换**:重扫时旧的照跑、标上等着换。
  触发它的是**显式的动作**,不是 `sync()` —— 扫盘不该挂在「每次保存全局设置」那条高频路径上。
  今天按它的只有 devtools 的装 / 卸,以及**拓展页那个上传口**(`POST /api/ext/install`:白名单
  拆包 → staging 落盘 → `rescan()`)与市场装。装完的回话照重扫之后那一行说 `staged`;有新版
  等着换上时,装完那句话与详情页头卡**并排给两个出口**:「重启 BN」(拉不起自己的机器上换成
  为什么)与「只重载这个拓展」(`swap()`,别的不断,代价写在按钮旁边)。面板上没有常驻的重启
  入口,没有新代码时也不给只重载。主人手放进去的包仍要重启。
- 眼下**还做不到的**:干净地换代码(ESM 换不掉已加载的模块 —— 只重载是换一个 URL 再 import,
  旧模块留在内存里;第二次启用跑的只有 `activate`,所以拓展的模块顶层不许存状态);**按需下载(签名镜像链)还没建** ——
  所以今天要在构建产物上跑桥,只有「自己 `vp pack` 出包、手放进
  `<数据根>/extensions/bridge/`」这一条路。

## 女仆技能(Agent Skill)

**只在独立端 dashboard 的聊天里存在**,群聊那条路拿不到 —— 群里没有权限门,而技能正文是「从网上抄一份贴进来」的提示词注入面。

一条技能 = 一份 `SKILL.md`(YAML frontmatter + Markdown 正文),住在
`<dataDir>/maid-skills/<name>/`。**单文件、不带附件、不跑脚本**:这台 server 攥着
B站 cookie、推送目标与 AI key,给它开脚本口子等于给面板开 RCE。

- **名字 = 目录名 = 斜杠命令**,kebab-case ASCII。白名单里没有 `.` `/` `\`,`..` 在
  构造上就拼不出来 —— 这条是安全闸,不是口味(皮肤库那次审计的教训)。
- **盘是权威。** 主人可以手放一份进去,`GET /api/ai/skills` 每次现读;读不进来的
  经 `problems` 显示给他看,不静默消失。
- **内置那几条写在 `maid-skills/builtin.ts`**,只读、跟版本走,同名一律拒。
  `builtin.test.ts` 钉住它们声明与提到的工具名真的存在。
- **两条触发路**:模型读目录自选(`load_skill`,经 AiTool 注入,**绝不进
  `TOOL_DEFINITIONS`**),或主人打斜杠(请求带 `skill`,服务端取正文追加进 system
  并当场收窄工具面)。两条路都在消息流里留一枚 `load_skill` 痕迹胶囊。
- **`allowed-tools` 只减不加。** 收窄是对现有工具表做交集(`narrowTools`),写一个
  不存在的名字长不出工具来 —— 用户可写的数据永远不能扩大能力面。收窄只活一次请求。
- **正文追加在人格之后**,不顶掉它:主人要的是「按这套步骤做事」,不是换个女仆。

### 聊天里的工具与痕迹(3b-32 起)

- **工具类型叫 `AiTool`**(`packages/ai/src/tools.ts`):`definition`、必填的 `label`(给人看的名字)、可选的 `labelArg`(小条上补哪一格入参:`keys` 是候选参数名、按顺序取第一个有值的,`format` 把那一格的值翻成给人看的样子,如卡种 `live` → 「直播卡」)、`execute`。`execute` 与核心自带那几把的 `executeTool` 都**按结果形状返回**(`Result`):预期内的失败(参数不对、接口回错、未知工具)是失败结果带一句话,不再是一句夹在正文里的字符串。生成器把这句话原样喂回给模型,痕迹里记成失败;`execute` 抛出来的只剩 bug,记一条错误日志,话照旧喂回模型。
- **标签的字**集中放:核心自带工具(含联网搜索、看图)在 `packages/ai/src/tool-label-texts.ts`(`coreToolLabelOf` 取,小条上补的入参 = 文案表里单独写的格接上工具定义里 `required` 的格),服务端注入的几把(读技能、做皮肤、卡片工坊)在 `apps/server/src/ai/tool-label-texts.ts`;认不出的工具(模型编的名字)不带标签。
- **痕迹事件**(生成器的 `onToolEvent`):开始事件带 `label` 与 `argText`(完整文字,截短是界面的事);结束事件带 `ok`,失败时带 `message`(与喂回模型的是同一句);慢工具中途的进度事件不落盘。`label`、`argText`、`message` 都随消息落盘(`ai/conversation-store.ts` 的 `StoredToolTrace`,存下来的字不跟着以后改名),也都经聊天 SSE 的 `tool` 事件过线;主人打斜杠点名技能时服务端手工补的那枚 `load_skill` 痕迹同样带 `label` 与 `argText`。
- **`GET /api/ai/skills`** 在 `tools` 之外多一格 `toolLabels`(工具名 → 标签,`routes/ai-skills.ts`)。技能编辑器的勾选框今天还显示工具名,没用上这一格。
- **面板没有按工具名查的表**:聊天里那一行小条只读痕迹自带的 `label` / `argText`(`apps/web/src/components/ai-chat/tools.ts` 的 `describeTool` 只管拼成「标签「入参」」与截短),没带标签就显示工具原名。存下来时还没有标签的老痕迹,由读会话的回应现补(`apps/server/src/ai/trace-labels.ts` 的 `withTraceLabels`,用今天在册的工具,不改写盘上的文件);已经下架的工具名补不出来,显示原名。失败的 `message` 面板接住了、还没显示。
