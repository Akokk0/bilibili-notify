# 命名

**一个概念只用一个词。** 起名、改名之前先对下面两张表：类型名的后缀表、词表；表里没有的概念，先加一行再用，不许随手造新词。我们写的代码都管：核心、内置集成（`bilibili/`、内置平台适配器）、面板、官方拓展；第三方写的管不到。这是活规范，可以直接改，但加行、改行要主人拍板；为什么定这套见 [ADR-0023](../../adr/0023-neutral-naming.md) 决策 15。

选词时先数代码里各候选的现有用法（`git grep -h -o -P "\b[A-Z][A-Za-z]*<后缀>\b"`），看它实际装的是什么，别凭一两个新名定。

## 后缀表

| 概念 | 用这个 | 不再用 |
| --- | --- | --- |
| 交给登记表、带行为的一整包 | `Def` | `Spec`、`Definition` |
| 注册或启动后拿回的把手；宿主握着、用来收回一个上下文的那一面也用它（`IntegrationContextHandle`，10-09 主人定） | `Handle` | — |
| 回调函数的类型 / 一包回调 | `Handler` / `…Handlers` | `Sink` |
| 登记表 | `Registry` | 当登记表用的 `Table` |
| 宿主或运行时递进来的环境（带生命周期、日志、signal） | `Context` | `Ctx`；跟着一次调用走的一包字段也不叫它 |
| 注入的协作者包（构造或函数的依赖；不混配置值） | `Deps` | — |
| 可插拔、可枚举的东西的静态自我介绍；`Def` 去掉行为后过线的那份纯声明 | `Descriptor` | 这层意思的 `Meta` |
| 附在一条数据旁边的元数据 | `Meta` | — |
| 纯数据的规格 / zod 校验 schema | `Spec` / `Schema` | — |
| 按参数规格解析出来的一组值（用户填进来、解析好的） | `Values` | 当它用的 `Options` |
| 操作的结果 | `Result` | `Outcome`、`Verdict`，当结果用的 `Check`、`Read`、`Parse`、`Acceptance` |
| 别人交上来的（上报） | `Report` | 报表类的东西（按装的内容取后缀：设置叫 `Settings`，结果叫 `Result`，算出来的叫 `View`） |
| 由真源算出来、给某个读者用的只读形状（面板、模板、引擎） | `View` | `DTO` |
| 模板吃的输入 / React 组件的属性 | `Input` / `Props` | 当参数包用的 `Input` |
| 一个接口或外部协议的整个请求体 / 回应体 | `Request` / `Response` | — |
| 函数或构造的参数包 | `Options` | `Opts`、`Params`、`Args`，当参数包用的 `Config` |
| 设置的值，包括设置的切片与生效值 | `Settings` | 当设置值用的 `Config`（`Config` 只指存储：`config/`、`ConfigStore`、`bn.config.yaml` 对应的 `BootstrapConfig`） |
| 状态对象 / 状态的取值 | `State` / `Status` | 用反了的 |
| 存下来、以后拿来比对或重放的副本 | `Snapshot` | 当「当前状态」用的（那是 `View` 或 `State`） |
| 一条消息、事件或令牌里装的内容 / 包在它外面、带路由或元数据的那一层 | `Payload` / `Envelope` | — |
| 发生了一件事 / 某样东西的状态变了 | `Event` / `Change` | — |
| 事件名 → 载荷的对照表（总线的、WS 帧的） | `Events`（`BusEvents`、`WsEvents`） | `EventMap`、当它用的 `Table` |
| 列表、日志、账本里的一条 | `Entry` | `Record`、`Row` |
| 时序里的一个采样点 | `Sample` | — |
| 负责存盘的仓库 | `Store` | 不存盘的（按职责改名，如 `…Cache`） |
| 内存里按键查的表（不存盘、不是登记表） | `Table` | — |
| 登记表或映射的键 | `Key` | — |
| 按名取用的一组格子（表单的一组字段、一份数据里挑出来读的那几格） | `Fields`（`RoastScheduleFields`、`LiveRoomFields`） | — |
| 指向别处一份东西的引用（只装认出它要的那几格，不装内容本身） | `Ref`（`ImageRef`、`VideoRef`）；装引用的**字段**按装的是什么起名（`avatar`、`cover`），不另挂 `Ref` | 不是引用的东西用 `Ref` |
| 供人挑选、还没成为实体的候选 | `Candidate` | — |
| 富文本里的一段（文字、链接、表情、提及……） | `Segment`（`RichTextSegment`） | `Node`、`Part`、`Chunk` |
| 把别处的形状翻成领域实体的函数 | `<实体>From<来处>`（`postFromDynamic`、`postFromReport`） | `to…`、`convert…`、`build…` |
| 从作品取文字的唯一一处 | `postText(post, 形式)`（形式 `plain` / `labeled`）；别处不许自己拼 | 各处手拼的 `extract…Text` |
| 种类的取值；说「是哪一种」的判别键叫 `kind`，说「处在什么状态」的判别键叫 `status`（状态对象里装取值的那一格） | `Kind` | `Type`（只留给外部协议里的原名） |
| 发出去的改动 / schema 的全可选版 / 按订阅覆盖的那一层 / 一步操作 | `Patch` / `Partial` / `Overrides` / `Op`（`SubscriptionOp`、`KeyValueOp`） | `Operation` |
| 一个过程里先后排开的一段（一段里可以有多个动作，如关停的 `DisposePhase`） | `Phase` | `Stage`（面板里是动画舞台 `CardMotionStage`）、当它用的 `Step`（`Step` 只指一个动作：引导的一步、装载卡在哪一步） |
| 为了解耦写的第三方窄接口 | `…Like` | 自己领域里的 `…Like` |
| 装配根交出来的一组运行中部件 | `Runtime` | 别的意思 |
| 长期运行的部件 | 按职责起名（`Engine`、`Poller`、`Runner`、`Dispatcher`、`Flow`、`Queue`、`Cache`，以及各种 `-er` / `-or` 角色名）；说不出具体职责的叫 `Service` | `Manager`、`Info`、`Data`（太虚） |

## 表外的几条规矩

- **领域实体用本名**：`Post`、`Creator`、`Subscription`、`Problem`、`Connection`。从实体现算出来给某个读者看的投影加 `View`（`SourceSubscriptionView`）。
- **核心接口用角色名，交进登记表的那一整包叫 `…Def`**：`PlatformAdapter` 对 `PlatformAdapterDef`，`Source` 对 `SourceDef`。
- **订阅来源就叫 `Source`，不加 `Subscription` 前缀**（主人 2026-10-10 定）：接口 `Source`、交进登记表的 `SourceDef`、上下文 `SourceContext`、键 `SourceKey`、描述 `SourceDescriptor`、登录 `SourceAuth`，一族同一个词头。拓展契约里今天还叫 `registerSubscriptionSource` / `SubscriptionSourceDef` / `SubscriptionSourceHandle` 的三个，随契约第 3 版改成 `registerSource` / `SourceDef` / `SourceHandle`。
- **核心里的 `Source` 只指订阅来源**：读数据的口子，类型一律叫 `…Reader`（一包几个读法的也是，不加复数）；`lookup` 是「查一下」这个动作，只用在函数名上，不当类型名的后缀（`…Lookup` / `…Lookups` 都不用，主人 10-10 定）。「市场源」是主人在界面上看得到的叫法，算例外。
- **「内置的那一组」交回的对象用复数名词、不带后缀**（主人 2026-10-11 定）：`BuiltinAdapters`、`BuiltinIntegrations`。
- **`Summary` 只用于「一个东西的缩略版」**，并且要和 AI 的直播总结（`liveSummary`）错开。
- **缩写写成 `Ai`、`Api`**（ADR-0023 决策 4）。**别的词不缩写**：`Msg` 写 `Message`，`Sub` / `Subs` 写 `Subscription` / `Subscriptions`（10-07 主人定；后缀表里已点名的 `Opts`、`Ctx`、`Args` 同理）。**例外只有 `Op`**：「一步操作」就叫 `Op`（`SubscriptionOp`、`KeyValueOp`、`WsOp`），不写 `Operation`（10-10 主人定：全仓用法一致、没有歧义）。
- **不用 TS `enum`**：一组取值写成 `as const` 的常量对象，类型取它的值的联合（`type GuardLevel = (typeof GuardLevel)[keyof typeof GuardLevel]`）。`enum` 的值面板引用不了，两头就得各写一份再钉住（10-07 主人定）。
- **外部接口的回应**：外壳叫 `…Envelope<T>`（B 站的 `{ code, message, data }` 叫 `BiliEnvelope<T>`）；某个接口回的内容叫 `…Response`（`UserCardResponse`）；回应里嵌套的结构用名词、不加后缀（`DynamicItem`、`ModuleAuthor`）。`Data`、`Info` 在这里也不用；`Result` 只指我们自己操作的结果。
- **外部协议的原字段名只留在回应上**：`mid`、`face`、`uname` 这类只准出现在描述那份数据的类型上，以及直接读它的代码里；我们自己定义的形状（事件、状态、函数参数、返回值）用下面词表里的词。

## 词表

平台特有的概念，在它自己的集成里用平台的叫法，出口翻成中立词；各平台都有的通用概念，全仓只用一个词。「不再用」指我们自己起的名字，外部协议的原字段名照上面那条留在回应上。

| 概念 | 用这个 | 不再用 |
| --- | --- | --- |
| 任意一个 JSON 值的类型（集成往 `state` / `secrets` 里存的值） | `Json`（10-10 主人定，`packages/internal` 的 `key-value-store.ts`） | — |
| 平台前缀 | 集成目录里默认不加（已经限定在那个目录下了：B 站的接口客户端就叫 `Api`，10-07 主人定）；和别处的名字撞了才加，B 站写 `Bili`（`BiliEnvelope`、`BiliLoginState`、`BiliSettings`） | `Bilibili…`、`BA…`、`BL…` |
| 创作者 | 核心里 `creator`；B 站里 `up`（`upUid`、`upName`，开播的也是它） | `master`（只指主人）、`anchor`、`author`（只指皮肤或拓展的作者） |
| 弹幕 | `danmaku` | `danmu`、`dm` |
| 用户 id | 核心里 `externalId`；B 站里 `uid` | `mid`、`vmid`、`fid`、`ruid` |
| 直播间 id | `roomId` | `roomid` |
| 统计「在记」 | `recording`（目录 `stats/recording/`、行 `RecordingEntry`，三项 `posts` / `live` / `followers`） | `seen`、`coverage` |
| BN 跑了多久 | `uptime`（目录 `uptime/`、行 `UptimeEntry { hourStartedAt, minutes }`） | `run…`（和 `runtime` 混） |
| 作品的摘要 | `summary`（取段函数拼出、截过的整条文字） | `excerpt`、`digest`、`desc` |
| 把老数据压小 | `compact`（动作与定时活：`compact(key, now)`、`startStatsCompaction`）；纯函数叫 `compress…` | `prune`、`trim`（那是删）、`sweep`（那是按引用清图） |
| 粉丝样本的一段同值 | 不单起类型：`FollowersSample` 多一格 `lastSampledAt` | `Span`、`Run`、`Interval` |
| 整类清空 | `clear`（各仓的 `clear()`、`DELETE /api/system/storage/:category`）；只清内存里在飞的状态叫 `reset` | `purge`、`dropAll`、`wipe` |
| 存储占用 | `storage`（`/api/system/storage`；类别 `stats` / `historyText` / `historyImages` / `ai` / `generations` / `otherImages` / `logs`） | `usage`（只用于图库的 `usage()`）、`disk` |
| 数据代 | `generation`（`seq` 序号、`formatVersion` 格式版本） | `gen`、`epoch` |
| 名字 | `name` | `uname`、`username`、`mastername` |
| 头像 | 网址叫 `avatarUrl`；存进图库的叫 `avatar: ImageRef`；历史行上「推送那一刻的头像」叫 `avatarSnapshot`（也是 `ImageRef`，与 `nameSnapshot` 成对） | `face`、`userface`、当网址用的 `avatar` |
| 粉丝数 | `followers` | `fans`、`fansNum`、`followerNum` |
| 会员档 | 核心里 `tier`；B 站里 `guard`（大航海） | — |
| 锐评 | `roast`（卡种 `roastBoard` 榜单、`roastSolo` 单人） | — |
| 会员体系（一个平台的一套档位） | `Program`（`MembershipProgram`，订阅上的值叫 `program`） | `System`、`Scheme` |
| 醒目留言 | `superchat`（`SuperchatEvent`、`SuperchatCardInput`） | `sc`、`SC` |
| 金额 | `amount` + `currency`；排好版的字由 `formatAmount` 出 | `price`、当人民币元用的裸数字 |
| 粉丝团 | 核心里 `fanClub`；B 站里 `medal`（粉丝牌） | `badge` |
| 作品 | 核心里 `post`；B 站里 `dynamic`（动态） | `work` |
| 产品形态 | 不加限定词，只剩一种 | `Standalone…`、「独立端」（冻住的 `startStandaloneServer` 除外，见 ADR-0005 决策 4） |
| 镜像或安装包里预装的那一版载荷 | `preinstalled`（预装版本） | `image…`（桌面版没有镜像；环境变量旧名 `BN_IMAGE_*` 只作兜底，随换 Node 大版本那一版删，见 ADR-0005 决策 4） |
| 面板（整个前端）、概览页、页面上的一块区域 | 整个前端叫 `dashboard`（中文照旧「面板」，`BN_DASHBOARD_USER` 说的就是它）；概览页叫 `overview`；页面上框起来的一块叫 `Panel`（`GlassPanel`、`FansPanel`） | 指整个前端的 `panel`、指概览页的 `Dashboard`（剩下的旧名随第 5 期清扫） |
| 外部接口的地址常量 | 名词加 `_URL`（`USER_CARD_URL`、`TICKET_URL`）；只是路径的叫 `_PATH`（10-07 主人定） | 带动词的 `GET_…`、什么都不带的 |
| 下播后的回顾（攒下来的弹幕出词云、请 AI 写总结，这两样合起来） | `recap`（目录 `bilibili/live/recap/`；10-07 主人定） | 拿 `wordcloud` 或 `summary` 代指两样（`summary` 另有用处，见上） |
| 走网络取数 | `fetch…`；`get…` 只留给不走网络的读取（`ctx.state.get`） | 走网络却叫 `get…` 的 |
| 单个 / 一批 | `fetchUserCard` / `fetchUserCards` | `…Batch`、单复数对不上 |
| 一次操作失败的那一支 | `Failure`（`{ ok: false, code, message, … }`）；整个结果 `Result<T>`，标准码 `FailureCode`；HTTP 非 2xx 的回应体 `ErrorResponse`（装的是去掉 `ok` 的 `Failure`） | `err`、`reason`、`why`（只管失败原因，ADR-0026 决策 2） |
| 订阅的标签（主人自己建，一条订阅能挂好几个） | `SubscriptionTag`（中文「标签」）；订阅上那一格叫 `tagIds` | 当它用的 `group` / `Group`（代码里已指群、图集、设置分组）、「分组」（多选是标签的语义，「分组」也是 B 站关注分组的叫法）；光写 `Tag`（`tag` 已是 HTML 标签、日志 tag、`authTag`）。见 ADR-0034 |
| 来源报上来的和 BN 实际处理的不一样的一条（整条拒、丢了几格、这一轮没推） | `Discrepancy`（中文「出入」；`ReportDiscrepancy`、`reportDiscrepancies`，界面上叫「上报出入」；10-09 主人定） | 当它用的 `Problem`（只指问题表里的一条）、`Rejection`（只对整条拒那一种） |
| 一条消息发到哪（交给适配器发送口的那几格） | `Destination`（中文「去向」）；类型 `DestinationRef`，两支是 `SessionRef`（会话）与 `EndpointRef`（端点）；10-09 主人定 | 把整条 `PushTarget` 递给适配器；`SendDestination`、`PushTargetRef` |
| 校验或检查不过的一条原因 | `Issue`（`{ path?, message }`） | 当原因清单用的 `errors: string[]`；`Problem` 只指问题表里的一条 |
| 集成共用的宿主那一层（上下文的构造、生命周期、运行状态、通用登记表）住的目录 | `integrations/`（10-07 主人定）；拓展特有的留在 `extensions/` | 把内置集成的启停放进 `extensions/` 或 `runtime/` |
| HTTP 客户端（`packages/http`，每个集成一个） | `HttpClient`；走网络取数的方法叫 `fetch`，回应叫 `HttpResponse` | 带平台前缀的 `BiliHttpClient`；当它用的 `get` / `request`（`get…` 只留给不走网络的读取）。见 ADR-0025 决策 6 下 10-03 的 🔗 |
| cookie 罐 | `CookieJar`；一条 cookie 的数据形状 `Cookie` | `CookieStore`（`Store` 只指存盘的仓库）、`BACookie`、`BiliCookieJar` |
| 浏览器身份（UA 与 `sec-ch-ua` 那一套，一起生成、永远配套） | `BrowserIdentity` | 单独设一个 `userAgent`（ADR-0025 决策 7） |

## 不管的

- 第三方库自带的名字：`ZodDef` 等。
- 外部协议定死的字段名：B 站接口 JSON 里的 `mid`、`face`，OneBot 帧里的字段。它们是线上的数据，改不了；我们给这些数据写的类型名照表起，原字段名只准留在哪见上面「表外的几条规矩」。
- 第三方写的拓展。
- 面板 zustand 的 `useXxxStore`，这是 React 的惯用写法。
