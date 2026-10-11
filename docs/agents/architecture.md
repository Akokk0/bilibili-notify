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
| `packages/internal` | `@bilibili-notify/internal` | Zod schema(Subscription —— 一种形状、带 identity,见 subscriptions.md —— / PushTarget / GlobalConfig / HistoryEntry)+ 平台接口(ServiceContext / MessageBus / TargetDispatcher / NotificationPayload)+ 工具(withLock / retry / interpolate / **串行闸 `createSerialGate`**:全仓唯一一把,`run` 按发起次序跑异步活、带低优先级车道,直播房间推送、作品入口、拓展作品与拓展直播、渲染都用它)+ 作品模型与信封(`Post` / `PostReport` / `PostEvent`;取段函数 `postText` 在服务端 `posts/`)+ 按版式装配消息组 `assembleMessageGroups`(动态与直播共用) |
| `apps/server/src/bilibili/api` | 不是包(3a-24 搬进服务端) | `Api`(HTTP + WBI 签名)+ `LoginFlow`(扫码 + cookie 状态机) |
| `packages/storage` | `@bilibili-notify/storage` | 持久化底层与密钥:原子写 / 追加 / 隔离 / 清扫等文件原语、`KeyManager` 与 `KeyProvider`(主密钥或口令派生)、GCM 加解密。没有 `StorageManager` / `CookieStore` 了(3a-26):B 站的 cookie 与令牌住在它这个集成自己的 `secrets` 里,由服务端的 `integration-store/` 管 |
| `packages/http` | `@bilibili-notify/http` | 集成的请求底座,通用、不带任何平台的默认值:`HttpClient`(`fetch` 回 `Result<HttpResponse>`:手动逐跳跟重定向并收 Set-Cookie、每跳之前可否决,非 2xx 不抛,网络断 / 超时 / 被中止 / 被否决回失败结果)、`CookieJar`(RFC 6265 子集,`load` / `clear` 原地换、`onChange` 通知、`epoch` 挡迟到响应)、浏览器身份(`generateBrowserIdentity` / `upgradeBrowserIdentity`)。B 站经 `bilibili/api` 里的 `ApiClient` 薄包用它,保住「非 2xx 抛错、JSON 自动解析、-101 探测」。出网点名表的白名单是它的 `http-client.ts` |
| `packages/push` | `@bilibili-notify/push` | `PushRouter` —— 经 `PushLike` 适配器做推送路由;一次推送整个交给 `push(push)`(按顺序排好的锚点,订阅 / 总开关 / 静音 / 免扰在交进来时判一次);只把**启用的**目标当候选,每个锚点对每个目标收完一段序列回调一次 `onSend`(带 `pushId` / `feature` / 逐条结果,被静音 / 免扰挡下的消息带 `isSilenced`),一个可用目标都没有时以 `target: null` 回调一次(见 events.md「推送历史的行模型」) |
| `packages/subscription` | `@bilibili-notify/subscription` | `SubscriptionStore` —— `Subscription[]` 内存 CRUD + `subscription-changed` diff。B 站与拓展的订阅同一份列表;`findById` 按订阅 id 找,`listByIdentity` 按身份(来源 + 外部 id)列出全部(遗留重复订阅是多条;作品那一路用它),`findByIdentity` 按身份找第一条(直播那几处仍用它,随 3b) |
| `apps/server/src/bilibili/dynamic` | 不是包(3a-24 搬进服务端) | `DynamicEngine` —— 动态轮询 cron + 时间线闸 + 翻译(`postFromDynamic`)+ 抓图,**只生产**:作品经来源上下文的 `reportPost` 交给核心入口,过滤 / 出卡 / 点评 / 推送都不在这里。**由 B 站来源(`bilibili/source.ts`)在 `start(ctx)` 里造并起、`stop()` 里停**,不再由 `createEngines` 造;吃名单(`subscriptions()` 与 `syncSubscriptions()`),不再有 `getSubs` / `applyOps` 那套订阅操作。作品装配与过滤住 `apps/server/src/posts/`(见下)。见 push.md ① |
| `apps/server/src/bilibili/live` | 不是包(3a-24 搬进服务端) | `LiveEngine`(拆分:ListenerManager / DanmakuCollector / WordcloudGenerator / LiveTemplateRenderer / LiveSummaryRequester)。另有**中立直播装配** `pushLiveNotify`(吃 `LiveCardInput`,不认 uid)、B 站房间数据 → `LiveCardInput` 的翻译 `liveCardInputFromRoomInfo`(串行闸 `createSerialGate` 不在这里,住 `packages/internal`) |
| `apps/server/src/posts` | 不是包 | **作品这一段的核心**(B 站动态与拓展作品共用,不认 uid、不读平台原始数据):`post-queue.ts` 的 `PostQueue` 是来源交作品的唯一入口(`enqueue`,同步、无返回值;按订阅一道串行闸、同步发 `post-detected`)、`deliver-post.ts` 的 `deliverPost`(过滤 → 出卡 → AI 点评 → 回问 → 模板 → 版式装配 → 图集 → 推送;含 `PostSettings`、出图失败计数 `createCardFailureTracker`)、`post-filter.ts` 的 `filterPost`、`post-text.ts` 的 `postText`(作品文字唯一的取段函数)、`post-push.ts`(推送的锚点与段、`FilteredPost`)、拓展作品那一路的 `extension-post.ts`(`bindExtensionPosts`:上报翻成信封交入口)与 `post-from-report.ts`(上报 → `Post`)。见 push.md |
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
live   (恒造)                     → LiveEngine({ api, push, contentBuilder, imageRenderer?, commentary?, emitLiveState, emitViewers, pickCardBackground, onRoomIdResolved, ... })
拓展作品(给了 extensionSources 才接)→ bindExtensionPosts({ subscription, profileName, postNoun, postImages, enqueue: postQueue.enqueue, ... })
B 站来源(createEngines 之后)        → compose.ts: createBiliSource({ api, bus, push(只剩给主人私聊), imageFetcher, configStore, setTimeout })
                                   → engines.registerSource({ sourceKey, source, integration }):建来源上下文、登记表 `await source.start(ctx)`
                                   → B 站来源 start(ctx) 里 new DynamicEngine({ logger, api, push, imageFetcher, reportPost: ctx.reportPost, subscriptions: ctx.subscriptions, config })
```

`cardFailures`(出图连续失败只提醒一次)全进程一份,在 `postQueue` 的依赖里,B 站动态与拓展作品共用。动态引擎只生产(翻译、抓图),作品经来源上下文的 `reportPost` 交给 `postQueue`(同一身份的遗留重复订阅各发一份,见 subscriptions.md);拓展订阅的作品不经引擎,由 `bindExtensionPosts` 听 `subscription-reported`、翻成信封后交同一个 `postQueue`(见 push.md、subscriptions.md)。

`config-changed` 之后 engines.ts 按 scope 热重载;动态的 cron 不在这里,B 站来源 `start` 时自己挂了 `watchSettings`,变了走引擎的 `updateConfig`;「全局特性开关变了」也不在这里列举,来源上下文把 `subscription-changed` 与 `globals` 档的 `config-changed` 都转成一声「名单可能变了」,来源自己对比新旧名单;作品的模板 / 版式 / 皮肤 / 图集 / 过滤不在引擎里,`deliverPost` 每条作品现折,改了立即生效;渲染器与 AI 上下线只换外层变量,`deliverPost` 经 `image()` / `ai()` 每次现取(live 走 `setImageRenderer` / `setCommentary`)。

## 独立端模块图(`apps/`)

四个子包共用根 pnpm workspace:`apps/server`(Hono HTTP + WS;`vp pack` 出 `lib/`,`build:bundle` 出自包含的 `dist/`(入口 + hash 分块))、`apps/web`(Vite + React 19 + Tailwind 4 + tanstack-query + zustand + react-router-dom;图表是手绘 SVG,无图表库;prod 由 `apps/server` 当静态资源服务)、`apps/contract`(`@bilibili-notify/contract`,独立端 REST/WS wire 契约)、`apps/desktop`(Tauri 壳 + 启动页,装的是同一份 bundle 载荷)。

### `apps/contract`

独立端两端共同消费的 **wire 契约**:REST 响应 DTO(SubscriptionDTO / history / fans / logs / live / health)+ WS channel 注册表与 envelope。只放纯类型与纯常量、零运行时依赖 —— web 端 `import type` 零成本,server 端可 import 值(CHANNELS / LOG_LEVELS);zod 校验 schema 是服务端职责,留在 apps/server,用契约类型注解防漂移。注意它在 `apps/` 下、不在 `./packages/*` glob 内 —— 根脚本的 packages 预构建过滤器要显式带上 `--filter '@bilibili-notify/contract'`(dev / build:update-payload / dev:desktop / build:desktop 已配)。

### `apps/server`

```
src/
  index.ts              CLI / bootstrap 入口
  app.ts                Hono app 组装 + 鉴权 + 路由挂载
  compose.ts            组装根(3a-28 提前建,原定 3a-40):整个核心只有它登记内置集成。今天只做两件事 —— `registerSources` 造 B 站来源并登记(引擎建好之后调)、`provideDevtools` 认领 B 站那组开发场景(过了开发版两道门才会调);交回入口 `BuiltinIntegrations`,入口还从 `bilibili.dynamic()` 读「上次抓取」。只许放登记与开发场景的过渡接线,在入口咽喉守卫(3a-40)开张前靠审查;进 B 站替身守卫的白名单
  subscriptions/        来源这一侧的核心宿主(类型 `Source` / `SourceContext` / `SourceDescriptor` 住 packages/internal/src/source.ts):registry.ts(来源登记表 `SourceRegistry`:认领键 → `start(ctx)` → 回撤销把手;`get` / `list`)、source-context.ts(`createSourceContext`:公共五格逐格列出 + `subscriptions()` / `onSubscriptionsChanged` / `reportPost`)、source-subscriptions.ts(名单的唯一算法 `sourceSubscriptionViews`)、builtin-sources.ts(`registerBuiltinSource`:建上下文 + 登记 + 合成撤销把手)、source-status.ts(`SourceStatusReader.running`)、membership-tiers.ts(`MembershipTierReader`:卡片路由与皮肤预览按来源描述符里的会员体系找档)
  auth/                 经 bilibili/api 的 LoginFlow 的扫码 + cookie 状态(`createAuthSystem` 先建 B 站的上下文 `bilibili/context.ts`:开它的存储、读存着的登录与浏览器身份,再建 `Api`;登录的提交只走 `api.commitLogin`);bare-auth-policy / session / ws-ticket
  config/               loader(bootstrap 配置加载)+ ConfigStore(原子写 <数据根>/config/*.json,emit config-changed)+ schema
  migration/            0.x → 数据代的一次性迁移:第 0 代(宿主根上 0.x 的文件)只读,先按代布局搬进 <序号>.partial,再逐族把 0.x 各版本的形状改写成 0.x 最新的形状(connections.ts 连接与目标、settings.ts 设置、subscriptions.ts 订阅,history.ts 推送历史,stats.ts 统计的文件名与行,roast-drafts.ts 锐评草稿,skins.ts 界面皮肤,conversations.ts 女仆对话,secrets.ts 加密袋,bili-login.ts B 站登录(0.x 的 secrets/cookies.json → secrets/bilibili/secrets.enc),features.ts / ai.ts / link-parsing.ts / templates.ts 是各组老形状的变换,files.ts 共用的读写);旧格式的知识只住这里,各个 store 只认最新形状(ADR-0022)
  runtime/
    bootstrap.ts          AppRuntime 容器(api/storage/push/store/engines/fansPoller/...,另有 `adapterRegistry` 与 `sourceRegistry` 两张登记表);宿主根取配置的 dataDir,数据根由开机选代交进来(构造期不碰盘)
    roots.ts              宿主根(versions/ logs/ generations/)与数据根(一代)的目录表 + hostPath / dataPath;本文写的 <数据根>/… 就是选中的那一代 <dataDir>/generations/<序号>/
    generations.ts        数据代:选代(格式版本 ≤ 我里序号最大的)、在 <序号>.partial 里开代再原子改名;迁移修订号对不上就重开(ADR-0022)
    service-context.ts    NodeServiceContext(pino + setInterval/setTimeout + 分段的 onDispose / track / signal,见下「关停」)
    message-bus.ts        NodeMessageBus(mitt 风格,事件表 BusEvents)
    engines.ts            引擎热重载接线;消费 config-changed;建作品入口 `PostQueue` 并接上它的依赖(作品设置现折 `postSettingsOf` / `makePostSettingsReader`,「来源还在跑吗」问来源登记表);对外有 `registerSource`(给内置来源建上下文并登记即启动,关停时先停登记过的来源再关作品入口);把发送钉到订阅上(`boundPostPush` / `boundLivePush`)
    extension-push-common.ts 拓展作品与拓展直播共用的作者 / 名字 / 还该推吗(拓展作品那一路本体已搬进 posts/extension-post.ts)
    extension-live.ts     拓展订阅的在播表(首页「正在直播」)
    extension-live-push.ts 拓展直播的推送与周期计时器;live-card-input-from-report.ts 把在播表里的原件(封面与事件头像是字节、开播时刻是毫秒)翻成中立的 LiveCardInput(图经 `runtime.liveImages` 存进图库)
    sub-runtime-store.ts  资料缓存 <数据根>/runtime/sub-runtime.json;拓展报的资料经 reported-profiles.ts 落进来,头像存进图库、这里只放引用(资料缓存是图库的一家引用方,`listImageRefs()` 交名单)
    fans-poller.ts        FansPoller —— 问 B 站、写 <数据根>/stats/followers/<订阅 id>.jsonl,emit fans-refreshed(首页粉丝面板的快照,拓展订阅那几行从统计写的时序算)
    generation-usage.ts   旧版本数据(代)的列表、两个大小、删除(能不能删在这里判)与开机收残骸;/api/system/generations
    storage-usage.ts      系统页「存储占用」:按类量大小、整类清空、手动图库清扫;/api/system/storage
    master-notifier.ts    engine-error 转 master 私聊
    puppeteer.ts          puppeteer-core 适配器(卡片预览)
  posts/                作品这一段的核心,B 站动态与拓展作品共用:post-queue.ts(`PostQueue`,来源交作品的唯一入口)、deliver-post.ts(`deliverPost` 装配)、post-filter.ts、post-text.ts、post-push.ts、extension-post.ts(拓展作品上报 → 信封交入口)、post-from-report.ts(上报 → `Post`)
  followers/store.ts    粉丝时序(<数据根>/stats/followers/<订阅 id>.jsonl):按订阅排队追加,满 8 天的由 stats/compaction.ts 那趟压缩成每小时末值与同值段,读口把段展开回点
  stats/                统计仓(<数据根>/stats/{posts,live,recording}/<订阅 id>.jsonl,行格式中立;recording 是「在记」按小时的账)+ 记录器与各来源适配(bili-source.ts 把 uid 换成订阅 id)+ 聚合 + 锐评(ADR-0020 / 0027);enabled.ts 是统计总开关 stats.enabled 的缓存读口;compaction.ts 那趟(开机一次、每 6 小时)压粉丝样本与账;0.x 的文件与老行由迁移器一次改好(migration/stats.ts、recording.ts、followers.ts)
  uptime/               运行记录(<数据根>/uptime/hours.jsonl:每个 UTC 整点小时 BN 跑了多少分钟;不算统计、不受统计总开关管);0.x 的由 migration/uptime.ts 从粉丝样本回填
  history/              HistoryStore(<dataDir>/history/<日期>.jsonl,一行 = 一次推送 × 一个目标,追加写补丁行读时并回;配图与头像快照存的是图库引用)+ retention(文字不删,重推原件按水位线清,图由图库按引用清扫;`listHistoryImageRefs` 是历史这一家的引用方名单)+ repush-store(重推原件,图也在图库)+ view(REST / WS 共用投影)
  logs/                 LogStore + retention + redact(凭据脱敏)+ sink
  skins/                皮肤库(<数据根>/skins/dashboard/<id>/skin.json + assets/)+ CSS 白名单 + 聊天里的 create_skin
  maid-skills/          女仆技能(<dataDir>/maid-skills/<name>/SKILL.md)+ 内置表 + 聊天里的 load_skill
  routes/               REST(ADR-0036:顶层是资源,只属于它的才下沉;文件名跟路径走):health / settings / subscriptions / targets(含 `:id/test`)/ connections(含 `:id/probe`)/ history / live / stats(+ stats-followers)/ cards(+ cards-skins)/ ai(+ ai-skills)/ dashboard-skins / system(+ system-logs / system-update / system-backup)/ auth / session / ws / adapters(`connectionAuth` 的三个扫码口,3a-29;`/api/qq` 已退役)/ commands
                        / ext(拓展清单与每个拓展的面板数据)
  ws/                   server(ws upgrade + 按连接 channel 过滤)+ channels + log-channel
  push/                 `target-dispatcher.ts`:TargetDispatcher 分发(PushTarget.id → 平台适配器)+ `registry.ts` 的**活注册表**(拓展注册的推送源往这里进,按分发键认领,占了就抛)+ `dispatch.ts`(按连接找适配器)
  platforms/            OneBot v11(HTTP / ws / ws-reverse)+ QQ 官方机器人 + Webhook(飞书 / 钉钉 / 企微 / 未指明,同一个 adapter 的四个方言分支)三个**直连** adapter;推送源契约在 internal/push-source.ts,连接平台词表在 internal/constants.ts(`CONNECTION_PLATFORMS`,**只管直连**),schema 在 internal/schema/targets.ts
  bilibili/             B 站的代码:settings.ts(B 站设置)+ context.ts(B 站的上下文 `BiliContext`:集成上下文加请求客户端与 cookie 罐的把手;来源上下文建在它之上,`http` / `cookies` 仍只在这里,3b 公共上下文开放 `http` 时才能并)+ source.ts(B 站来源 `createBiliSource`:`start(ctx)` 造并起动态引擎、挂名单回调与 B 站设置的监听,`stop()` 同步停干净,`dynamic()` 交回引擎句柄)+ api/(Api / LoginFlow / ApiClient / WBI)+ dynamic/(DynamicEngine,只生产 / postFromDynamic,吃名单)+ live/(根上:翻译函数 membership-event / superchat-event / live-card-input、徽章图标 guard-icons、以后搬去核心的 live-notify / template-renderer / content-builder;protocol/ 弹幕连接的协议层 client / codec / events / parser,说明在它的 README.md;session/ LiveEngine / ListenerManager / RoomSession;recap/ 下播后的回顾:弹幕收集、词云、AI 总结的请求器)
  integration-store/    集成的 state / secrets 存储宿主本体(`createIntegrationStore`,在 `runtime/bootstrap.ts` 建、挂在 `AppRuntime.integrationStore`,构造期不碰盘):key-value-store(内存里的一袋键值 + 校验:保留前缀、限额、值得是 JSON、`batch` 先验后写)、files(`state.json` / `secrets.enc` 的读写与路径,读盘三态)、store(按集成键开 / 关 / 删、备份的 `exportSecrets` / `restoreSecrets`、写道与关停的 `flush` 段关门)。每个集成拿到的把手有集成一面与宿主一面(宿主一面只许 `http.` 开头的键)。`IntegrationContext` 的 `state` / `secrets` 引用它
  integrations/         集成宿主(内置集成与拓展共用):http(`createIntegrationHttp`:替集成造请求客户端、cookie 罐与浏览器身份,罐子自动存、闸、`commit`;B 站是第一个调用方)、registry(通用登记表 Registry,按键认领、只撤自己那行;`entries()` 按认领先后列,3a-28 补)、stop-quietly(`stopQuietly`:调 `stop()` 不等它、失败交回调,适配器登记表与来源登记表共用)、context(集成上下文的工厂 createIntegrationContext:日志、停止信号、收尾钩子,外加宿主握着的名册与收尾;类型 IntegrationContext 住 packages/internal;拓展上下文与内置平台适配器的上下文都建在它上面)
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
- **两条触发路**:模型读目录自选(`load_skill`,经 ExtraTool 注入,**绝不进
  `TOOL_DEFINITIONS`**),或主人打斜杠(请求带 `skill`,服务端取正文追加进 system
  并当场收窄工具面)。两条路都在消息流里留一枚 `load_skill` 痕迹胶囊。
- **`allowed-tools` 只减不加。** 收窄是对现有工具表做交集(`narrowTools`),写一个
  不存在的名字长不出工具来 —— 用户可写的数据永远不能扩大能力面。收窄只活一次请求。
- **正文追加在人格之后**,不顶掉它:主人要的是「按这套步骤做事」,不是换个女仆。
