# 1.0 架构：中立核心

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023，以及 ADR-0024 ～ 0031。

分层、目录地图、接口族与登记表、集成与 ctx、装配根、总线、守卫、施工原则。类型与字段见 [data-model.md](./data-model.md)；各接口的细节见 [subscription-sources.md](./subscription-sources.md)；推送链见 [push.md](./push.md)；拓展能拿什么见 [extension-contract.md](./extension-contract.md)；盘上布局见 [data-and-migration.md](./data-and-migration.md)；施工分期见 [construction-plan.md](./construction-plan.md)；类型名的后缀见 [naming.md](../agents/conventions/naming.md)。

## 一句话

**核心里出现「B 站」这个概念就算越界。** B 站的东西要么搬回 `bilibili/`，要么变成核心的一个中立概念、由 B 站去实现。B 站和拓展都只是来源：B 站直接实现中立接口，拓展由宿主转成同一组接口。推送侧同理：OneBot、QQ 官方机器人、webhook 与拓展实现同一个 `PlatformAdapter`。**没有后门。**

## 三层

| 层 | 是什么 | 包括 |
| --- | --- | --- |
| 一等：中立核心 | 名字、类型、数据形状、文档都不带平台味；来源只往里交东西 | 订阅、推送路由与闸、投递（`TargetDispatcher`）、出卡与皮肤、AI、统计与锐评、历史与重推、粉丝、链接预览、指令框架、账号、问题表与健康、面板；醒目留言、会员、特别弹幕、特别进场、词云、直播总结 |
| 二等：B 站 | 内置来源，住服务端 `bilibili/`，直接实现 `Source` 等中立接口 | B 站接口、弹幕通道、动态与直播信号、扫码登录、关注同步、B 站链接解析器；给醒目留言 / 会员 / 特别弹幕 / 特别进场 / 词云 / 总结填数据 |
| 2.5 等：拓展 | 外部来源，只从 `@bilibili-notify/extension` 这扇窄门进，由宿主转成同一组中立接口 | 订阅源拓展（如抖音）、桥、推送适配器 |

```
B 站（信号 · 接口 · 扫码）──Source 等接口──┐
                                                    ├─→ 中立核心 ─→ 推送 · 出卡 · 历史 · 统计
拓展 ──窄门契约──→ 宿主（extensions/）──转成同一组接口──┘            │
                                                                  │ 只经 TargetDispatcher
                                                                  ▼
                                   PlatformAdapter 登记表 ─→ 内置适配器（platforms/）· 拓展的适配器（如桥）
```

- **中立接口族是全集，拓展契约是它的子集。** 两边的区别只在谁写、住在哪、开放多宽。
- 推送侧的内置平台（OneBot、QQ 官方机器人、webhook）也是内置的、直接实现中立接口：住服务端 `platforms/`，和拓展提供的适配器是同一个 `PlatformAdapter`、同一张登记表（ADR-0024 决策 1）。`CONNECTION_PLATFORMS` 这个闭集删掉。
- `bilibili/`、每个拓展、每个内置平台适配器各是一个**集成**，拿同一种 ctx、走同一套生命周期（见下「集成与 ctx」）。
- 产品名 bilibili-notify 与包作用域 `@bilibili-notify/*` 是品牌，不改。
- 机器人框架（Koishi / AstrBot）不当核心的宿主，引擎层不给它们留钩子。以后要做完整插件，走「薄插件 + 插件托管一个 BN 进程（吃同一份更新载荷）+ 桥借 bot」；还缺的零件：桥 token 自动配对、AstrBot 侧的 Node 运行时。

## 方向原则

| 方向 | 用什么 | 例子 |
| --- | --- | --- |
| 来源 → 核心：「发生了什么」 | 事件（经 `SourceContext` 上报） | 作品、直播信号、资料、问题 |
| 核心 → 来源：「帮我做什么并给结果」 | 接口调用，结果用结果形状（见「wire 契约」） | 搜人、拉资料、查直播状态、解析链接、调工具、预览 |

理由：把请求 / 回应做成事件，就要手工重造函数调用自带的东西（对号、超时、取消、报错、类型）；来源没实现某个请求时，事件只能干等超时，接口在登记那一刻就知道有没有。拓展的事件由宿主转进 MessageBus，**拓展拿不到总线本身**，所以伪造不了核心事件。

推送侧同理：入站消息经 `ctx.inbound` 交给宿主（内置适配器也一样，宿主核归属、平台取自连接），发送、探活、列候选是核心调适配器。

## 施工原则

- **不整体重写，以改造为主**（ADR-0021 决策 58）。判据：某个模块的核心逻辑从头到尾是 B 站的形状、改造要动每一行时，才对着中立接口局部重写，旧测试当规格书；否则改造。各期哪块用哪种方式，见 [construction-plan.md](./construction-plan.md) 分期表的「方式」一列。
- **没有实现者的接口先不造**：`CommandProvider` 就是这样删的（ADR-0031 决策 1）。
- **起名先对后缀表**：[naming.md](../agents/conventions/naming.md)；表里没有的概念先加一行再用（加行、改行要主人拍板）。新写或重写的代码直接用新名，第 5 期只清扫没被动到的旧名。
- **失败一律用结果形状、抛错只留给 bug**（ADR-0026），见「wire 契约」。

## packages/

判据：**中立的留在 `packages/`，B 站、内置平台适配器与宿主装配进服务端。** `packages/` 物理上 import 不到 `apps/server/src/bilibili/` 与 `platforms/`，中立性由目录结构直接守住。

| 包 | 层 | 放什么 | 相对现在的变化 |
| --- | --- | --- | --- |
| `internal` | 一等 | 域模型（订阅、身份、作品 / 直播模型、特性键表）、schema、失败标准码表（ADR-0026 决策 3）、零依赖工具（显示名、计数与时间格式、身份索引、串行队列、重试等）。零依赖工具走子路径——根入口带 zod，面板拿不到 | 工具收成一份，面板与服务端共用；`CONNECTION_PLATFORMS`、平台信息表与各平台的连接 / 目标设置 schema 搬出，归各平台适配器（ADR-0024 决策 1） |
| `http` | 一等 | 请求客户端、cookie 罐、浏览器身份；`websocket(url, opts?)` 只管用集成的身份建连、集成停下时自动关 | **新包**（第 2 期）：从 B 站的实现里抽出、去掉 B 站前缀；每个集成一个客户端，经 `ctx.http` 拿；BN 自己的请求不用它（ADR-0025 决策 6）。为避免包之间成环，请求客户端对外的接口类型住核心包，实现留在 `packages/http`；websocket 能发文本帧、能读连接状态，请求体收 `FormData`，单次请求可选「不带浏览器身份、不碰 cookie 罐」那一档（内置三个适配器全用）；cookie 罐按公共后缀表（引 `tldts`，`packages/http` 加运行时依赖）拒 `Domain=com` 这类 |
| `push` | 一等 | `PushRouter`：按订阅 id 路由、闸、附加项 | 类名改掉；按平台名判断的（如 @全体）改成问适配器能力 |
| `image` | 一等 | 作品卡、直播卡、榜单等中立卡种 + 皮肤；附加块按 card / video / goods 直接渲染；醒目留言按档取色、金额按币种；不联网，只内联图库引用 | 解析 B 站 JSON 的代码、B 站域名白名单、大航海等级表搬走 |
| `ai` | 一等 | 生成器、人格、核心中立只读工具；看图（`describe_image`）与联网搜索照留核心 | 删掉对 B 站包的 import；来源专有工具经 `AiToolProvider` 登记；中立工具参数统一叫 `creator`；看图只收 `ImageRef`、字节由宿主注入的读图函数读，`packages/ai` 不碰磁盘（ADR-0030） |
| `storage` | 一等 | 持久化底层（原子写、写道）、主密钥与加密 | `CookieStore` / `StorageManager` 已退役（3a-26）：cookie 罐进 `http`，由宿主存进 B 站这个集成的 `secrets`（0.x 的 `cookies.json` 由迁移转成 `secrets/bilibili/secrets.enc`，ADR-0025 决策 9） |
| `subscription` | 一等 | 订阅仓、身份唯一的规则 | 去掉 `findByUid` |
| `ui` | 一等 | 纯展示组件 | 新增统一的密钥输入框、素材选择器 |
| `extension` | 2.5 的门 | 拓展契约 v3 | 见 [extension-contract.md](./extension-contract.md) |
| `api`、`blive`、`dynamic`、`live` | 二等 | — | 搬进 `apps/server/src/bilibili/` 各成子目录（`blive` 并进 `live` 那个子目录），包删掉；中立部分进服务端 `posts/` 与 `live/`；api 删掉 7 个没人调的方法；api 里的请求客户端、cookie 罐、浏览器身份抽进 `http` |

`apps/contract` 是一等：服务端与面板之间所有请求、响应、WS 帧的唯一来源；叫法函数（单个来源用它自己的叫法、混着的用「创作者」「作品」，ADR-0027 决策 6）也住这里，面板与服务端共用。

搬 B 站四个包（约 8,800 行、43 个测试文件）之前先断开别的使用方：面板的登录态类型改从 contract 取，image 的大航海等级表归 B 站，ai 的 B 站查询工具改由 B 站登记。第三方依赖（cron、md5、qrcode、protobufjs、luxon）并进服务端；`ws` 随 `websocket()` 进 `packages/http`。

### 共享件归位

| 东西 | 进哪 |
| --- | --- |
| 两个及以上包或应用要用的纯逻辑、常量、中文名表 | internal（零依赖子路径） |
| 失败标准码表 | internal |
| wire 上的形状、叫法函数 | contract |
| 请求客户端、cookie 罐、浏览器身份 | http |
| 纯展示组件 | ui |
| B 站专属 | 服务端 `bilibili/` |
| 某个推送平台专属（平台表、设置 schema、协议细节） | 服务端 `platforms/` 里那个适配器 |
| 持久化底层 | storage |

internal 不当杂物间。已扫出、要在 1.0 收掉的重复（🔴 = 几份之间已经有行为分歧，在它所属那一期里最先收；各项归哪一期见 [construction-plan.md](./construction-plan.md)）：

- 🔴 卡种中文名 5 张表、两套键（dyn / dynamic）→ internal
- ✅ 3b-14 已落：「要不要开直播监听」原来的 3 套判据（首页「直播」那一格读未合并的 routing，服务端读合并后的开关，面板的「不会被监听」自留一份键表）并成 internal 的零依赖子路径 `@bilibili-notify/internal/live-monitor` 里的 `needsLiveMonitor`（连同 `LIVE_ROOM_CREATOR_KEYS`、`specialUserFlagsOf`），全仓唯一判定；「开着」只看开关、不看有没有目标（ADR-0027 决策 1）。直播引擎（`RoomContext`）、统计（`recordingSwitches`）、首页「直播」那一格（`getModuleState`）、面板「没开直播推送」那句都读它；服务端「订阅 → 入参」的折法只有 `stats/recording-switches.ts` 的 `liveMonitorInputOf` 一处
- ✅ 3b-09 已落（10-16）：多语言的核心（`mergeDict` / `translate` / `createI18n`，连同 `LOCALES`）在 internal 的零依赖子路径 `@bilibili-notify/internal/i18n`；服务端的字典 store 在 `apps/server/src/i18n/`（`i18n` 与 `t`，译文放 `locales/`，指令回话原 `runtime/command-texts.ts` 的字是第一批键）。面板的 store 在 `apps/web/src/i18n/`（`i18n` 与 `useT()`，译文眼下为空，随第 4 期收）。✅ 3b-10 已落（10-17）：服务端的语言与口吻跟设置走（`i18n/bind-settings.ts`）；面板登录前读浏览器里记的（`i18n/preference.ts`，没记过按浏览器语言猜），登录后跟设置走（`i18n/use-text-settings.ts`），设置缺语言时把在用的那个写进去一次
- 🔴 「N 分钟前」4 份 → `formatAgo`（⛔ 首页「正在直播」不写「N 分钟前开播」：面板只列在播的，「开播」多余，`dashboard-live-now.test.tsx` 钉着，收的时候别顺手加上）；带正负号的增量 4 份（负号两种、零两种写法）→ 并进 `formatCount`
- 🔴 B 站动态转纯文字两个同名函数（AI 工具那份丢掉转发）、B 站风控码集合（-412 各处不一，已定：一张共用的「数字码 → 标准码」翻译表，见 subscription-sources「B 站怎么实现」；3b-18 已落拉动态、直播预检、上舰观众头像、cookie 续期，粉丝轮询那几处归 3b-24）与响应解包（手写约 5 处）→ `bilibili/`
- 🔴 过滤、AI、出图各拼各的作品文字 → `posts/` 里唯一一个取段函数（ADR-0028 决策 1）：`text` 只放正文，标题、视频标题、转发的原作品各有位置
- 串行队列至少 11 处手写 → `createSerialQueue`（含按键分队）；两个同名不同义的 `createSerialGate`（internal、live 各一）拆成 `createSerialQueue` 与 `createRenderGate`（3a-27 先落了一半：两把合成 `packages/internal` 里的一把 `createSerialGate`，加了 `run`，live 那把删了；改名拆分仍没做）
- `isPlainObject` 15 份、两种判据，internal 正本没导出 → internal 零依赖子路径
- 深比较（稳定序列化 2 份、键序敏感的比较 5 处）、重试 3 套、本地日键 / 日轴 / 时区参数（`tzOffset` 与 `tz` 两种写法）→ internal
- 时刻显示至少 7 份 → internal（精度差异有的是刻意的，逐条确认，别一刀切）
- 字节数写法约 12 处、woff2 提示句抄 4 份 → internal
- 生效特性：面板 3 处以写死的默认值为底 → internal 零依赖入口；`SubItemView` 由它产出
- 原子写：服务端三份逐字相同的私有副本 + 约 8 种各写各的临时文件写法 → storage 的 `atomicWriteJson`；`update/durable-json.ts` 并进来（见 data-and-migration「持久化底层与关停」）
- 资产存储三份 → 一份 `createAssetStore`；两个皮肤库 → 一份 `createSkinStore`
- 漏在 contract 外的 wire 类型：`/api/health` 在面板手抄 5 份（④d 已收）、备份格式两份且 PIN 只在面板校验（服务端不验）、登录态 4 种形状（中立的只有 `AuthState`）→ contract
- 密钥打码：服务端 `maskSecret`、contract 的 `MaskedSecret`、面板 `SecretChip` 已成套，面板组件进 ui
- 零碎：webhook URL 打码两份、`LogLevel` 两份（只在 internal 留一份，contract 转口）、`PushKind` 同名不同义（⑬b、⑬f 已解决：作品推送的部件叫 `PostPushPart`，历史行直接记特性键，`PushKind` 删了）、`escapeRegExp` 两份、HTML 去标签两份（一个解实体一个不解，合并前先定解不解）
- 大航海等级表与等级名、`GuardLevel` → `bilibili/`
- internal 里放错的：B 站视频链接识别 → `bilibili/`；B 站形状的登录态类型删掉，中立一侧只有 `AuthState`（`bilibili/` 内部若还要一个原形，叫 `BiliLoginState`）；`BiliEvents` / `DynamicDetectedEvent` 改成中立事件、留在核心（`DynamicDetectedEvent` 已在 3a-27 由 `PostEvent` 取代并删掉）；链接预览的闸门配置（`LINK_REPLY_FORMS` / `LINK_LIMITS`、`linkPreview` 的 schema）是核心的，留 internal；没人用的 `withLock` 删；`deterministic-uuid` 搬回唯一的使用方（`config/store.ts`）；更新镜像前缀搬进 contract

## apps/server/src/

按功能分目录，B 站的全部放顶层 `bilibili/`，内置平台适配器放 `platforms/`。

```
compose.ts         组装根：登记内置集成（B 站、三个内置平台适配器）与拓展宿主（整个核心只有它能 import bilibili/ 与 platforms/）
subscriptions/     订阅、资料刷新、身份唯一闸、Source 登记表与来源上下文宿主（`Source` 一族的类型住 `packages/internal`，3a-28 已建登记表、上下文宿主、名单算法、「来源在跑」与会员档位两个读口）
accounts/          账号：系统 → 账号、排序、汇总各来源登录态（**第 4 期**，3a-29 没造：今天只有 B 站一个有登录的来源，读者都在第 4 期；B 站的登录系统已在 `bilibili/auth/`）
images/            图库：fetchImage / storeImage 的落点、按引用清扫（引用方含历史、重推原件、资料缓存、AI 会话、账号头像）
push/              路由、闸、免扰、TargetDispatcher（含 sendToAddress）、PlatformAdapterRegistry 与按连接分发、notifyMaster
platforms/         内置平台适配器：OneBot、QQ 官方机器人、webhook，各带描述、设置 schema 与模板候选
posts/             作品装配：推一条 Post，不管来自哪里；作品文字唯一的取段函数
live/              中立场次引擎（场次、断流接续、定时、在播表）、直播装配与附加项生产
link-preview/      链接预览：闸门、候选挑选、回复（经 sendToAddress）、LinkResolver 登记表
commands/          指令框架 + 通用指令（help / mute / report / status / login [来源] 等）；没有来源指令的登记表
roast/             锐评：生成、审批、定时、投递（从 stats/ 拆出）
stats/             统计仓与聚合（含粉丝时序；「在记」按特性算，热力图也读它；能回最近几条作品）
history/ ai/ skins/ library/ maid-skills/
process/           进程基础件：puppeteer、资源采样、宿主看护（孤儿自检与 stdin 关停、重启能力）
integration-store/ 集成的小存储宿主本体：每个集成一份 state.json 与加密的 secrets.enc、读盘三态（文件不在 / 内容不认 / 在但读不了）、限额与保留前缀、写道与原子写、关停时关门、备份的导出与恢复（IntegrationContext 上的 state / secrets 引用它）
integrations/      集成宿主：IntegrationContext 的构造、内置集成与拓展共用的生命周期与运行状态、通用登记表 Registry、集成的请求客户端装配（http.ts：身份、cookie 罐与它的自动存和闸）
extensions/        拓展特有的：装载、市场、安装、设置、视图 + 收件口
bilibili/          B 站：Source 实现、auth/（扫码登录）、LinkResolver、AiToolProvider；原四个包各成子目录
bilibili/devtools/ B 站的 DevtoolsProvider，只在开发版登记
runtime/           只留 service-context、message-bus、引擎编排（engines.ts 拆三份）
routes/ ws/ config/ backup/ update/ devtools/ logs/ types/ util/
```

- 中立装配住服务端，不开新包：作品装配在 `posts/`，直播装配与直播附加项的生产在 `live/`。装配把来源交来的 `PostEvent` / 直播信号做成要发的消息，步骤见 [push.md](./push.md)「装配」。
- 原 `runtime/extension-*` 那批文件按功能归 `posts/`、`live/`（中立场次引擎）、`subscriptions/`、`stats/`。🔗 10-13（3b-20）拓展直播的几件已搬进 `live/`：在播表 `live-table.ts`、场次引擎 `live-sessions.ts`、推送 `live-push.ts`，出卡输入翻译 `live-card-input-from-report.ts` 一并过去（原在 `runtime/`）；`runtime/` 里只剩作品与直播共用的 `extension-push-common.ts`。
- `platforms/` 只放内置适配器的实现。原先放在里面的登记表与分发是中立件，3a-14 已和 `sink/` 一起挪进 `push/`（`push/registry.ts`、`push/dispatch.ts`、`push/target-dispatcher.ts`）。核心不许 import `platforms/`，只有 `compose.ts` 能（推送守卫①）。
- `link-preview/` 由 `runtime/link-parser.ts` 与 `link-scope.ts` 改来（原定的 `link-cards/` 作废，ADR-0029）。🔗 10-13（3b-27、3b-28）：解析器登记表 `link-preview/registry.ts` 与通用网址正则 `extract-urls.ts` 已加；B 站视频链接的认法 `video-links.ts`（原在 `packages/internal/src/util/`）与视频翻成作品的 `video-card.ts`（原在 `runtime/`）搬进了 `bilibili/`，B 站的解析器是 `bilibili/link-resolver.ts`。
- 集成宿主住 `integrations/`（10-07 主人定）：`IntegrationContext` 的构造、内置集成与拓展共用的生命周期与运行状态、通用登记表 `Registry<T>`。各张具体的登记表住各自的功能目录（`subscriptions/`、`push/`、`link-preview/`、`ai/`），来源与适配器专用的那一层 ctx 也住那里；`extensions/` 只留拓展特有的（装载、市场、安装、设置页、视图）。被否的备选：留在 `extensions/`（B 站的启停会住在一个叫「拓展」的目录里）；放 `runtime/`（它最后只留总线与编排）。问题表放哪 3a-28 开工时定。
- jieba 的 wasm 跟着 `live/` 进打包清单，改完要跑 `vp run build:update-payload`。
- 被否的备选：适配文件散进各功能目录（B 站代码散在十几处，守卫只能靠文件名约定）；`sources/bilibili/` + `sources/extension/`（多一层，还把 BN 自己的中立逻辑挂成了「对接拓展」）。
- `bilibili/devtools/` 被否的备选：放 `src/devtools/bilibili/`、B 站句柄从外面注入。

面板（`apps/web`）：

- 页面私有的件回到 `pages/<页>/`，`components/` 只放至少两处复用的件。
- 文件名全部 kebab-case（组件与 hook 也改；要改名的连测试 172 个，其中 52 个只改大小写，得用两步 `git mv`）。
- 每个接口只在 `services/<域>.ts` 写一次，类型从 contract 取；纯逻辑进 `utils/`，不另开 `lib/`。
- **来源的信息只从描述符拿**（ADR-0027 决策 6）：`GET /api/sources` 进来拉一次进缓存、`extension-status-changed` 时失效，按 `identity.sourceKey` 取；叫法走 contract 的叫法函数；描述符只装叫法、能力清单与会员档位，不装界面句子；集成的设置字段在登记集成时交，不挂在描述符上（ADR-0025 决策 3），面板从哪个路由拿施工时定。面板代码里不出现 `bilibili`，所有 `isBili` 分叉删掉，档位色表、「UID」「B 站」「UP 主」「舰长 / 提督 / 总督」这些写死的字一并删掉。拓展卸载后遗留的订阅：平台名显示来源键、叫法用中性词、不露特性开关，卡上标「来源没装」。
- **推送连接与目标的表单由适配器的描述驱动**：新建连接走「挑一个候选，再填字段」一条路（`/api/adapters`）；已有连接的脸与目标编辑器读连接上的 `platformSnapshot`，适配器不在场也画得出来（ADR-0024 决策 4、8）。面板代码里不按平台名分叉。
- **系统页按集成开 tab**（ADR-0025 决策 3）：声明了 `settingsFields` 的内置集成各开一个（今天只有 B 站，tab 名取它的 `label`），用通用的设置表单与对表门；拓展的设置只在拓展页，功能页面放指过去的入口；「运行」tab 只留核心参数。
- 健康卡（「系统状态 · 各模块」）第 4 期先出设计稿，主人认了再照稿重做。

## 接口族与登记表

核心只认一组中立接口。每种接口一张登记表，键都是 `IntegrationKey`：集成的键，就是 `"bilibili"`、拓展 id 或内置平台适配器的键，不加前缀（ADR-0025 决策 1）。来源的 `SourceKey`（`"bilibili"` 或拓展 id）是它的一部分，分派仍读 `identity.sourceKey`。订阅侧接口全文见 [subscription-sources.md](./subscription-sources.md)，推送侧见 [push.md](./push.md)。

| 接口 | 管什么 | 登记表 |
| --- | --- | --- |
| `Source` | 订阅一个人：搜人、拉资料、直播状态、登录、预览。共 10 个成员（descriptor、必备 4 个、可选 5 个）；没有「新建 / 启用订阅」钩子，订阅变化只经 ctx 的 `onSubscriptionsChanged`；`searchCreators`、`fetchProfile` 返回结果形状（ADR-0026 决策 4）；`health()` 只交一行字。🔗 现状（3a-42，10-12）：`packages/internal/src/source.ts` 里 `Source` 今天只有 5 个成员（`descriptor`、`health?`、`start`、`stop`、`auth?`）；`searchCreators`、`fetchPreview`（第 4 期）与 `fetchProfile`、`fetchLiveStatus`、`liveInteractions`（3b）接口上还没有，各随第一个使用者落地（「没有实现者的接口不造」），逐项去处见下「第三层：对拍」21b 的「这版不开」名单 | `subscriptionSources` |
| `LinkResolver` | 群里的链接 → `LinkPreview { post, canonicalId, nativeShare? }`；带 `label`，`resolve` 返回结果形状（ADR-0029） | `linkResolvers` |
| `AiToolProvider` | 来源专有的只读 AI 工具与技能（B 站：总播放、获赞、视频列表与 B 站版周报） | `aiToolProviders` |
| `DevtoolsProvider` | 开发版的造状态 / 造事件场景：`{ scenarios: DevScenarioDef[] }`；场景 id 由宿主加前缀（`bilibili.xxx`、`<拓展 id>.xxx`），参数按提供方收窄，`run` 返回结果形状（ADR-0031 决策 2） | `devtoolsProviders`（只在开发版） |
| `PlatformAdapter` | 推送侧：一种连接怎么真发出去。描述 `PlatformAdapterDescriptor` 与 `settingsSchema`；必备 `start(ctx)` / `stop()`、`send`、`isAvailable`、`probe`、`listConnectionCandidates`；可选 `capabilities` / `probeCapabilities`（含 `atAll`、`inbound`）、`listAddressCandidates`、`connectionAuth`（ADR-0024 决策 3；`connectionAuth` 三个方法 `begin` / `state` / `takeDraft`，回 `AuthState`、状态不带草稿，3a-29 QQ 半已落；QQ 只发 `awaiting-scan` / `logged-in` / `error` 三种，不发 `expired`（`connectionAuth` 没有「已经登着的登录」，码过期报 `error` 并带一句话，10-11 回头改）也不发 `confirming`）。这两个可选成员对拓展不开放（决策 11），类型上排除、宿主登记拓展适配器时运行时也摘掉。内置三个与拓展提供的同一个接口；`send` 只有 `TargetDispatcher` 能调 | `platformAdapters`（`PlatformAdapterRegistry`） |

- **指令没有登记表**：1.0 没有来源自带的指令，`CommandProvider` 先不造（ADR-0031 决策 1）；指令全是核心的，以 `CommandDef` 交给指令框架。来源自带指令与重名的规矩等第一个真要自带指令的拓展。
- `PlatformAdapterDescriptor` 描述一个适配器（它的脸与设置字段）；`PlatformDescriptor` 描述一个聊天平台（名字、目标形状、地址叫法），由连接候选带来。

```ts
interface Registry<T> {             // 住 integrations/registry.ts（3a-08 已由 extensions/claim-table.ts 搬来改名，工厂 createRegistry）；entries() 3a-28 已补，第一个读者是会员档位读口（经来源登记表的 list()），不是 /api/sources
  get(key: IntegrationKey): T | undefined;
  claim(key: IntegrationKey, value: T): { dispose(): void };   // 一个键一个主人；只撤自己那行；撤了能再登
  entries(): Iterable<[IntegrationKey, T]>;
}
```

键为什么不需要前缀：不带点的拓展 id 本就只留给官方源（第三方必须写成 `<命名空间>.<名字>`），`ExtensionIdSchema` 再把 `bilibili`、内置平台适配器的键（`onebot`、`qq-official`、`webhook`）与 `core`、`image`、`ai`（核心自己的名字：`core` 是日志等级的键与设置文件名，`image`、`ai` 是日志等级里出图与 AI 那两格的键）列为保留 id，手动放进目录的拓展也撞不上内置集成与核心。`core`、`image`、`ai` 只在「拓展不许用的 id」那张表 `RESERVED_EXTENSION_IDS` 里，不进内置集成的键表 `RESERVED_INTEGRATION_KEYS`。原先按订阅 `kind` 分派认不出是哪个拓展的问题，由身份摊平成 `{ sourceKey, externalId }` 解决；连接上原先的 `kind`、`connector` 删掉，`extensionId` 并进 `adapterKey`（ADR-0024 决策 7）。

## 集成与 ctx

**集成**是「归属方」的统称：`bilibili/` 是一个集成，每个拓展是一个，三个内置平台适配器各是一个（ADR-0025）。

| 项 | 规矩 |
| --- | --- |
| ctx | 每个集成一个 `IntegrationContext { logger, state, secrets, redact, settings(schema), http, fetchImage, storeImage, reportProblem, resolveProblem, signal, onDispose }`；`SourceContext`、`PlatformAdapterContext` 在它上面加各自特有的；拓展的 `activate(ctx)` 拿到它加各登记方法。🔗 现状（3a-30，10-11）：`reportProblem` / `resolveProblem` 今天**只造在 `SourceContext` 上**（`packages/internal/src/source.ts`；带 `externalId?`，`reportProblem` 多可选的 `notify` 与 `recoveryMessage`，`resolveProblem` 多可选的 `notify`），`IntegrationContext` 与 `PlatformAdapterContext` 上还没有（三层同一个签名、`Problem.about` 加连接那一支随 3b-38 造，见 extension-contract.md「问题上报」），3a-39 是下一个要报的。🔗 现状（3a-39，10-11）：3a-39 报了问题、**没有造这一格**：核心设置的那条（`settings_invalid`，报的人 `"core"`）由 `runtime/bootstrap.ts` 把配置仓的通知接到问题表直接写，B 站设置那两条走 `SourceContext`；`IntegrationContext` 上的 `reportProblem` 仍留着，等第一个在 `start(ctx)` 之外要报的集成（没有点名）。`settings(schema)` 同理**今天只造在 `SourceContext` 上**，`get()` 回结果形状 `Result<{ settings: T }>`、不抛（见 ADR-0025 决策 2 下的 🔗）。🔗 现状（3b-41 C4，10-17）：`settings(schema)` 已上提到 `IntegrationContext`（见 subscription-sources.md「`settings(schema)`」行的现状） |
| 生命周期 | 内置集成与拓展同一套：`start(ctx)`、`AbortSignal` 中止、`onDispose` 收尾。收尾的先后：宿主先调来源或适配器自己的 `stop()`，再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾（ADR-0025 决策 5）。运行状态：内置集成只取 `running` / `failed` / `settings-invalid`；拓展照 `ExtensionRunStatus` 的全部取值，外加 `settings-invalid`；系统页、健康卡、`status` 指令都读它。🔗 现状（3a-39）：内置来源的运行状态读口没造（今天没有读者），`bilibili` 设置读不懂时来源仍是在册的，停着的那一样在问题表里；`settings-invalid` 只有拓展装载器在产生，再看的时机是 3a-40 的 `health()`。🔗 现状（3a-40，10-12）：`Source.health()` 造出来了，但它是同步、可选、只交一句话（`status` 指令读它，见 [commands.md](../agents/commands.md)），**不是**运行状态读口：`running` / `failed` / `settings-invalid` 的读口仍没造，`SourceStatusReader.running` 的判据仍是「在册就算在跑」，再看的时机待定（等第一个要读运行状态的人，如第 4 期的健康卡） |
| 设置 | 只有一个词 `settings`：`connection.config` → `settings`、`configSchema` → `settingsSchema`、`configFields` → `settingsFields`；`config` 只指存储（`config/`、`ConfigStore`、`config-changed`、`bn.config.yaml`、`BN_CONFIG`）。`ctx.settings(schema)` 给 `get` 与 `onChange` |
| 设置坏了 | 只停那一处，不挡开机（ADR-0025 决策 4）：拓展段、`bilibili` 段校验不过只停那个集成（`settings-invalid`，面板显示原值与原因、进问题框，改对当场起）；`core` 段逐格校验，坏的那格在内存里用默认值、盘上原文不动、问题表记一条；只有信封坏了才挡开机。只有 `start` / `activate` 期间读设置失败可以抛错中止启动，运行中的 `get()` 不抛。🔗 现状（3a-39，10-11）：挡开机的是核心那一份设置文件整份解析不了、连接外壳坏、订阅文件与推送目标文件读坏（数据不是设置）；`bilibili` 段逐格，哪格坏停读那一格的那一样（动态 / 定时的登录检查），整个文件读不懂两样都停，来源照常在册，各有一条问题；拓展设置文件不是合法 JSON 只停那一个拓展；内置来源读设置拿到的是结果、不抛，「`start` 期间可以抛、宿主接住转成 `settings-invalid`」对内置来源没造 |
| `state` / `secrets` | 同一个 `KeyValueStore { get, set, delete, batch }`（`batch(ops)` 一批里可以有写有删，整批一起成或一起不成）：`get` 同步（宿主在 `start` 前读进内存），写由宿主原子落盘。`state` 明文、不进备份、不脱敏，单键 64KB、每个集成 1MB，`http.` 开头的键归宿主（浏览器身份）；`secrets` 主密钥加密、一个集成一个文件、只进完整备份、值里每段字符串按原文脱敏（很短的不遮），每个集成 256KB，`http.` 开头的键归宿主（cookie 罐） |
| `http` | `packages/http` 的客户端，每个集成一个：cookie 由宿主自动存进该集成的 `secrets`；浏览器身份生成一次存进 `state`、重启照用，只在发版把版本区间前挪、存的低于下限时升级（只升不降）；重试、退避、限流归集成；整体不拦内网（局域网里的 RSSHub 要连得上）；1.0 对拓展整套开放（cookie 罐那组口除外，第 3 版不对拓展开；不开「默认请求头」的口） |
| `fetchImage` | 走集成自己的客户端（同一套 cookie、身份与默认头）；拦内网、8MB、嗅探、超时这一层只在这条路上，每一跳重定向都查 |
| 调用被拒或失败 | 上报类（`report*`、`reportProblem`、`resolveProblem`）保持 `void`：被拒或丢格记进该集成的 `reportDiscrepancies` 表并打 warn 日志（内置集成被拒就是 BN 的 bug，只打错误日志）；请求类（`state` / `secrets` 的写与删、`fetchImage`、`storeImage`）返回结果形状、不抛错 |

ctx 各成员的完整语义见 [subscription-sources.md](./subscription-sources.md)「SourceContext」与 [extension-contract.md](./extension-contract.md)。

## compose.ts 装配

整个核心只有 `compose.ts` 能 import `bilibili/` 与 `platforms/`；`index.ts` 只管启动。**内置集成和拓展走同一条路**（ADR-0024 决策 1、ADR-0025 决策 1、5）：

| 内置集成 | 键 | 登进哪些表 |
| --- | --- | --- |
| B 站（`bilibili/`） | `bilibili` | `subscriptionSources`、`linkResolvers`、`aiToolProviders`；开发版另登 `devtoolsProviders` |
| OneBot（`platforms/`） | `onebot` | `platformAdapters`（一个模板候选） |
| QQ 官方机器人（`platforms/`） | `qq-official` | `platformAdapters`（一个模板候选） |
| webhook（`platforms/`） | `webhook` | `platformAdapters`（飞书、钉钉、企业微信、通用四个模板候选） |

- `compose.ts` 为每个内置集成登记键、脸（名字、图标等，取自它的描述）与 `settingsFields`；宿主给它建 `IntegrationContext`、调 `start(ctx)`，集成在里面读设置、经 ctx 上的登记方法把各接口的实现登进对应的表——和拓展的 `activate(ctx)` 是同一组登记方法。撤销把手交给生命周期，集成停下时撤掉它登的全部行。登记口与工厂的名字施工时定。
- 登进表的接口再由宿主起：`Source.start` 拿 `SourceContext`，`PlatformAdapter` 登记即 `start`（晚登记的也收得到）、拿 `PlatformAdapterContext`。来源与适配器特有的那一层（名单、上报、入站、自己的连接）内置与拓展一样都经 `start(ctx)` 递进来，登记交回的把手只管注销（ADR-0025 决策 1）。
- B 站段设置校验不过时，B 站这个集成不起（`settings-invalid`）：来源、链接解析器、AI 工具都不登记，订阅显示来源不可用；改对了当场起。`/api/sources` 的描述符不受影响：`compose.ts` 静态登记 B 站完整的 `SourceDescriptor`，设置坏了照样下发。🔗 3a-39 落成与这一条不同（主人 10-11 定，哪坏停哪样）：B 站来源**照常 `start`、照常在册**，不会「不登记」；只停读不懂的那一样（动态那格坏停动态，登录检查那格坏停定时的登录检查，整个文件读不懂两样都停），停着的那一样在问题表里；链接解析器与 AI 工具的登记还没搬进集成（原写 3a-40；3a-40 也没做，它们的登记表 3b 才有），不受这一条影响。
- `compose.ts` 里 `bilibili/` 的东西只能作登记的参数；核心拿不到 B 站客户端（今天的 `engines.api` 删掉，见「守卫」入口咽喉）。🔗 现状（3a-40，主人 10-11 定）：`engines.api` 这一片没删，改成入口咽喉守卫钉住核心里叫 `api` 的槽位、按文件记数只降不涨，读者清掉的那一天（3b；卡片真实预览与旧搜人两口第 4 期）才删。

🔗 **现状（3a-28 起，主人 10-11 定提前建，原定 3a-40）**：文件已在，今天只做两件事 —— 造 B 站来源并登记（`registerSources`，在引擎建好之后调，经 `engines.registerSource` 建来源上下文、登记即 `start`），与认领 B 站那组开发场景（`provideDevtools`）。B 站集成的上下文仍由登录那套建好递进来（`AuthSystem.integration`），来源另外还直接拿着事件总线、给主人私聊的口、配置仓三样（各归 3a-29、3a-30、3a-39）。上面各项里这一片没做的：三个内置适配器的造与登记、B 站设置的登记、登录装配、链接解析器与 AI 工具的登记、删 `engines.api`，以及「内置集成在 `start(ctx)` 里用同一组登记方法登记」这个终点，都留给 3a-40（落成见下面「现状（3a-40）」那一条：登录装配与 `engines.api` 没做、留到 3b）。

🔗 **现状（3a-29 B 站半，10-11）**：登录这套搬进了 `bilibili/auth/`，仍由入口造（`createAuthSystem`）；`compose.ts` 只多收一格登录口 `sourceAuth`，挂到 B 站来源的 `auth` 上（登记表的视图带着它），**登录装配没有进 `compose.ts`**：要进就得把 `api`、集成上下文等句柄交回入口，入口的 B 站替身数不降反升，等于提前做 3a-40「删 `engines.api` 句柄」的本体，所以随 3a-40（3a-40 又量过一次，仍留在入口，改留到 3b，主人 10-12 定）。上一条里「来源直接拿着的三样」中的事件总线，3a-29 没清：`auth-lost` / `auth-restored` 这两个边事件不换（主人 10-11 定），私聊主人那一处随 3a-30，直播与统计随 3b。

🔗 **现状（3a-30，10-11）**：上面「来源直接拿着的三样」里**给主人私聊的口已删**（`BiliSourceDeps.push` 与 `compose.ts` 递私聊口的那一格没了，动态引擎、直播引擎不再有任何私聊口）；来源现在另外拿着一个**分层上报器**（`bilibili/problem-layers.ts` 的 `ProblemLayers`，`compose.ts` 在 `composeBuiltinIntegrations` 里造，早于 `createEngines`）：交回入口的 `bilibili` 多一格 `problems`，入口原样递给 `createEngines` 的 `biliProblems`，给直播引擎用；来源 `start(ctx)` 最后一步 `attach(ctx)` 把此刻该在表里的整份报上去，`stop()` 第一步 `detach()`。事件总线那一样还在（引擎仍听 `auth-restored` / `auth-lost`）。这条「先造后接」的过渡接线随 3b 直播并进来源而拆（入口 `index.ts` 的替身数 3 → 5、`runtime/engines.ts` 18 → 20 是它的代价，见「守卫」表）。

🔗 **现状（3a-40 第一块，10-11）**：上面「三个内置适配器的造与登记留给 3a-40」这一项已落：三个内置适配器在 `composeBuiltinIntegrations` 被调时造好，`registerAdapters`（入口在引擎之前调）负责登记并启动，推送守卫① 同时开张（`scripts/__tests__/import-boundaries.test.mjs`）。`compose.ts` 今天做三件事：登记 B 站来源、认领 B 站开发场景、造并登记三个内置适配器；B 站设置的登记、登录装配、链接解析器与 AI 工具的登记、删 `engines.api` 仍留给 3a-40 的后续。

🔗 **现状（3a-39，10-11）**：上面「来源另外还直接拿着事件总线、给主人私聊的口、配置仓三样」里**配置仓已不拿了**：`BuiltinIntegrationsDeps.configStore` 与 `BiliSourceDeps.configStore` 删了，来源在 `start(ctx)` 里经 `ctx.settings(schema)` 读自己的设置（动态那格、登录检查那格各交一份 zod）；换成两样新依赖：`compose.ts` 多收一格 `setHealthCheckMs`（入口递 `(ms) => authSystem?.setHealthCheckMs(ms)`，现转，因为登录系统在入口里是个会清掉的 `let`），转成来源的 `loginCheck`。**登录系统不再读 B 站设置**：`createAuthSystem` 删了 `configStore` 选项与开头读间隔、后面听变化的两处，`LoginFlow` 以间隔 0（不挂心跳）起步，`AuthSystem` 多一个 `setHealthCheckMs(ms)`，由来源 `start` 读了设置后挂上或停下、`stop` 里停掉。后果：定时的登录检查第一次挂上的时刻，从登录系统建好那一刻晚到来源 `start`。`compose.ts` 仍不 import `bilibili/settings`（设置读者棘轮表仍是空的，白名单只有 `runtime/bootstrap.ts` 登记设置段那一处）。

🔗 **现状（3a-40，10-12）**：`compose.ts` 现在做四件事 —— 登记 B 站来源、认领 B 站开发场景、造并登记三个内置适配器、造大航海徽章图；另有模块级常量 `BUILTIN_INTEGRATION_SETTINGS`。上面各 🔗 里「留给 3a-40」的几项：**B 站设置的登记**已进来（入口把 `BUILTIN_INTEGRATION_SETTINGS` 交给 `createAppRuntime` 的必填第三参数，运行时不再 import `bilibili/settings`，守卫 12 的白名单随之换成 `compose.ts`、棘轮表仍是空的）；**舰长图标的建造**已进来（自带的无 cookie 请求客户端、图库「来源声明的图」那一家引用方、造好经 `attachGuardIcons` 交给运行时；它的类型仍住 B 站目录，所以守卫 1 的计数没有因此降，中立的会员档位图标口记在 construction-plan 的「以后再说」）；**`status` 不再读动态引擎的句柄**（交回入口的 `bilibili` 只剩 `problems`，`status` 读登记表里各来源的 `health()`）。**没有进来的**：登录装配（主人 10-12 定留到 3b，随读者消失一起进集成的 `start`；入口那 1 条越界 import 由守卫 1 的棘轮钉着）、删 `engines.api`（见上，入口咽喉守卫钉着只降）、链接解析器与 AI 工具的登记、「在 `start(ctx)` 里用同一组登记方法登记」这个终点（登记表 3b 才有）。日志等级也按这条路给：各集成的日志器在这里或它自己的装配里按键开，见 [agents/architecture.md](../agents/architecture.md) 的「日志等级」。

拓展在清单的 `contributes` 里按需声明，宿主启用时以拓展 id 登进对应的表、把撤销把手交给生命周期；停用、卸载即撤，不用重启。1.0 对拓展开放哪些键见 [extension-contract.md](./extension-contract.md)。

## 核心功能怎么接集成

分派按 `identity.sourceKey` 查登记表，不再点名 B 站。来源上报只带 externalId，核心按身份展开到订阅；来源看不到订阅 id。推送侧按连接的 `adapterKey` 找适配器，不按平台名。

| 功能 | 核心负责 | B 站实现 | 拓展 |
| --- | --- | --- | --- |
| 推送 | 按订阅 id 路由、闸、附加项；中立装配；按身份把上报展开成每条订阅一份 | 按名单的 `features` 决定拉谁（开了开关才监听，ADR-0027 决策 1）；拉动态、把弹幕通道翻成直播信号，按 externalId 上报 | 报订阅事件（同样只带 externalId），宿主翻好交装配 |
| 投递 | `TargetDispatcher` 是唯一能发送的口；按目标逐个投递、只重试失败的那个（`rate_limited` / `unavailable` / `timeout` 退避，`indeterminate` 与其他码不重试），出卡或 AI 失败就降级、不整条重来，每个目标一行历史、失败带 code；`sendToAddress` 给链接预览与指令回复用（不进路由、不过闸、不落历史）；`notifyMaster` 收文字或消息体、返回结果形状；连接设置按适配器的 `settingsSchema` 校验，坏的只隔离那一条（ADR-0024 决策 10、13–15） | —（内置的是 `platforms/` 的三个适配器，与拓展同一个接口） | 清单 `contributes.push` 只装描述；`PlatformAdapterDef` 经 `registerPlatformAdapter` 交；`listAddressCandidates`、`connectionAuth`、描述里的条件显示与键值表字段这版不开 |
| 直播 | 唯一的场次引擎、定时调 `fetchLiveStatus`、在播表、「会不会被监听」的唯一判定（只看开关） | 直播信号 + `fetchLiveStatus` + `liveInteractions` | 直播信号，可选 `fetchLiveStatus` |
| 出卡 | 中立卡种、皮肤、卡种注册表；图只认图库引用；醒目留言按 `tier.rank` 取色、金额按币种；会员卡宣告语取 `MembershipTier.announcement`（ADR-0028 决策 4） | 动态翻成 `Post`（UP 自己的视频进 `post.video`，番剧、合集、课程进附件的视频卡）、附加块翻成三种中立数据、用 `ctx.fetchImage` 抓图；醒目留言按 B 站规矩算 `tier` | 宿主把作品翻成作品卡 |
| 文案模板 | 全仓唯一的模板引擎；`{tier}`（原 `{guard}`）、`{fanclub}`（原 `{mdn}`）；迁移改写主人的文案，出来的字不变（ADR-0028 决策 3） | 资料里填 `fanClubName`（粉丝牌名） | 有就填，没有就空 |
| 搜人 | `GET /api/sources/:sourceKey/creators?q=`，去重用 identity；按 id 取人不另开路由，搜索已认 id（09-27 拍板）。🔗 `searchCreators` 来源方法 3b 造（B 站实现，只给 AI 的搜人工具用），路由与面板第 4 期 | `searchCreators`（UID、主页链接、名字都认；返回结果形状） | `searchCreators`（契约的 `lookup` 改名） |
| 链接预览 | 闸门（开关、群表、冷却键「群 + 解析器 + canonicalId」、上限）；先用通用网址正则挑候选再问各解析器 `matches`；回复经 `sendToAddress` 发回原会话；原生分享卡里的链接不回预览 | `LinkResolver`；原生分享交中立描述，由 OneBot 适配器去签，签不了回图片 | 1.0 暂不开 |
| 指令 | 框架与 `help` / `mute` / `report` / `status` / `login [来源]`；`run` 返回结果形状，`reply` 经 `sendToAddress` 回到发指令的会话；失败回「『{指令名}』没办成：{message}」，抛错回「出错了，详情在日志里」（ADR-0031 决策 1）。🔗 现状（3a-40）：`status` 里「上次抓取」换成在册来源各一行「<label>：<该来源 `health()` 说的话>」，见 [commands.md](../agents/commands.md) | 没有自带指令；`login` 从它的 `AuthState` 取二维码；`health()` 交一行 | 没有自带指令；`health()` 交一行 |
| AI | 生成器、人格；六把中立只读工具，参数统一叫 `creator`（「来源键:外部 id」）；六个内置技能跨来源、只用中立工具；看图读图库、聊天附件存进图库；提示词里的平台叫法用 `{creatorNoun}` / `{postNoun}` / `{sources}`（ADR-0030）。🔗 现状（3a-42，10-12）：核心里读来源上报的作品叫法 `postNoun` 的，今天是拼 AI 提示词那一处（作品模板还只传 `{name}`，见 21b 不开名单 N08），来源没给时缺省叫「作品」（原先代码缺省是「动态」，与定案写的缺省「作品」不一致，3a-42 改了），B 站来源自己声明「动态」 | `AiToolProvider`（专有只读工具与 B 站版周报技能） | 1.0 暂不开 |
| 资料、头像与粉丝 | 定时调 `fetchProfile`（只调启用中的）；`not_found` 记成 `creator_not_found` 问题，其余当暂时失败；增量、时序、头像进图库、显示名链 | `fetchProfile` | `fetchProfile` 或主动 `reportProfile` |
| 统计与锐评 | 中立统计仓与聚合；开了开关才记；「在记」按特性分、核心自己算（作品 / 直播 / 粉丝，ADR-0027 决策 2），热力图也读它、seen 不再单独当判据；关着的日子显示「没在记」、锐评与榜单跳过；多收来源已交到手的现成字段；CSV 的「UID」与「外部 ID」合成一列 | 开播公告动态直接丢掉、不上报 | — |
| 账号 | 系统 → 账号、头部、新手引导登录步；登录态只有中立的 `AuthState`（推送侧的 `connectionAuth` 也用它）。🔗 3a-29 B 站半：`auth` 已挂到 `Source.auth`，面板各处（头部、AI 对话、引导、概览、系统页账号卡）已改读 `GET /api/sources/:sourceKey/auth`，数据面是 `["source-auth", 来源键]` 的查询缓存；`accounts/`、账号排序、多账号下拉、按来源生成的引导登录步仍在第 4 期 | `auth`（`bilibili/auth/`，3a-29 B 站半已落，仍由入口造） | 可选 `auth` + `ctx.secrets` |
| 设置 | 按集成放；`core` 段逐格校验、坏格退默认；集成段坏了只停那一个 | `bilibili` 段经 `ctx.settings(schema)` 读，系统页一个 tab；自定义 UA 设置删掉（老配置里这格由迁移丢掉、新 schema 不留），改成「换一个身份」按钮（ADR-0025 决策 7） | `extensions.<id>` 段，设置只在拓展页 |
| 请求 | `packages/http`：每个集成一个客户端 | `ctx.http`（请求与弹幕通道的 `websocket`） | `ctx.http` 整套开放 |
| 预览 | 卡片页预览、按订阅覆盖 | `fetchPreview` | 可选 `fetchPreview` |
| 健康与问题 | 见下「问题表与健康」 | `health()` 交一行字；`reportProblem` / `resolveProblem`（有登录口的来源不报登录问题，宿主看 `auth.onChange` 报） | 同左；平台适配器也能报，带 `connectionId`；连接通断由宿主每分钟 `probe` 探、不由适配器报 |
| 备份与日志脱敏 | 备份信封按集成分格 `integrationSecrets`（内容就是各集成的 `secrets`，只进完整备份），恢复回 `restoredIntegrations`，备份里有但没带回来的（集成现在没在运行、或换失败）回 `unrestoredIntegrations`；日志按真实密钥值脱敏 | `ctx.secrets` + `ctx.redact` | `ctx.secrets`、`ctx.redact` 与 secret 字段自动覆盖 |
| 历史与重推 | 全部；每个目标一行，失败带 code，可以手动补发 | — | — |

现在服务端有 22 个非测试文件直接 import B 站的包，其中 routes/subs、routes/auth、routes/cards、routes/health、app.ts 是核心在点名 B 站——这些都要改成经登记表。另有经结构化句柄直调 B 站的：`engines.api` 喂 `routes/subs.ts` 搜人、查人，守卫 1 只看 import 抓不到，靠入口咽喉。

### 问题表与健康

- **问题表只有一种形状，全在内存**（ADR-0025 决策 11）：`Problem { reporter: IntegrationKey | "core", about?: { subscriptionId } | { connectionId }, code, message, since }`。订阅运行态不再存问题。
- 一条生死规矩：报的人 `resolveProblem` 清；报的人停下，它报的全清；对象删了，关于它的全清。
- 谁报：来源带 `externalId`，宿主换成订阅 id；平台适配器带 `connectionId`，宿主核它是不是这个适配器的；核心直接写，code 表明是哪个模块（如 `renderer_unavailable`）；`core` 段某格退回默认也记一条。
- 谁看：订阅卡、连接卡看关于自己的，问题框看全部；集成级的问题只在问题框与健康卡，不在每张订阅卡上重复。`GET /api/problems` 一次给全，变了发 `problems-changed`。
- 私聊：`notify: true` 再私聊主人，同一报的人（`reporter`）、同一 code 60 秒内只发一次（ADR-0021 决策 47）。
- 代价：重启后的头几秒，订阅卡上的问题红字先消失，等来源重报。
- 🔗 **现状（3a-30，10-11）**：表、读口、事件、通知器都已落，面板不读（红色告警条第 4 期之前看不到搬进问题表的 B 站报错，主人定；问题框第 4 期做）。
  - 表在 `apps/server/src/problems/problem-table.ts`，建在 `runtime/bootstrap.ts`、挂在 `AppRuntime.problems`；`Problem { reporter: string, about?: { subscriptionId }, code, message, since }` 住 `packages/internal/src/problem.ts`（`reporter` 是来源键字符串；`about` 只有订阅一支，连接那一支没造；`recoveryMessage` 不在这个对外的形状上）。同一个 报的人 + 对象 + code 一条，再报只换文案、`since` 不动。
  - 写口：`SourceContext.reportProblem` / `resolveProblem`（`subscriptions/source-context.ts`），带 `externalId` 的按身份展开成这个人名下的每一条订阅（遗留的同身份重复订阅各一条）；报的人停下（来源撤登记、登记失败）整批 `clearReporter`，订阅删了 `clearSubscription`，两种都不补「已恢复」；报的人自己 `resolveProblem` 才可能补，`notify: false` 不补。
  - 私聊：`problems/problem-notifier.ts`，`createEngines` 里与 `MasterNotifier` 并排建；「该不该说、什么时候说」只在一处按节流键（报的人 + code，不含对象）对账：同键上一句问题私聊送到之后 60 秒内不再发，同键每清掉一条后 5 秒沉淀内也不发；`notifyMaster` 回 ok 才算真私聊过；没送到而失败码是「稍后可重试」的（目标不可达、超时、限流）按 10 秒、30 秒、60 秒、5 分钟、15 分钟再送五次，档位记在键上，结果不明的失败不再重发；清掉时对真私聊过的发这条问题自带的恢复说法（`recoveryMessage`，没给用通用说法），**「已恢复」不受窗口与沉淀管、不限流**（一批同时恢复同一拍各发一句；没送到只记 warn、不再送）；被节流吞掉而挡住它的是一条已清掉的旧事的，窗口到点时它还开着就补说一次；发送在路上时问题被清了又开的，新开的认领那次发送。清风控分「真解除」（才说「风控已经解除啦」）与「不再适用」，详见 phase-3a-plan.md 的「3a-30 独立审查」。`MasterNotifier` 不再听 `auth-lost`，只听 `engine-error`。
  - B 站的分层（未登录 → 风控 → 各项请求失败，同时只留最上面一层）在 `bilibili/problem-layers.ts`，给主人看的话在 `bilibili/problem-texts.ts`。
- **健康**（ADR-0025 决策 12）：`SourceHealth = { summary: string }`，只给健康卡与 `status` 指令一行字；订阅卡的「暂停 / 不可用」改看运行状态与问题表。健康卡分两排：核心（持久化、订阅、推送、卡片、AI）与集成（每个集成一格；推送适配器有连接才占格；灯按运行状态与问题分四色）。数据放 `/api/health/details`，短版 `/api/health` 见「wire 契约」。🔗 现状（3a-40，10-12）：`SourceHealth` 与 `Source.health?()` 已造，**同步、可选**，`SourceDescriptor` 多了必填的 `label`（`status` 里冒号前的平台名取它）；今天唯一的实现者是 B 站来源（三句话集中在 `bilibili/health-texts.ts`），唯一的读者是 `status` 指令（`readSourceHealth`：没交 `health` 的来源不占行、抛了那一行写「状态读不到」）；健康卡与运行状态读口没造，路由上现有的 `/api/health/details` 是更早的「更详细的报告」，不读 `health()`，也不是上面「分核心、集成两组」的形状。拓展来源 3b 才进登记表、才有 `health`，到时它的返回要当外来数据收（记在 construction-plan 的「以后再说」）。

## 总线事件

MessageBus 仍是唯一的事件通道（「绝不写转发器」那条铁律不变）。1.0 总线只留一套**按订阅 id 发**的中立事件：来源只报 externalId，核心在进门那一刻按身份展开成订阅 id；统计只剩一个适配器（`bindStatsRecorder`）；WS 转给面板的也是中立事件，contract 里的 WS 载荷类型直接从总线事件表推导。事件名一律「名词-过去分词」。

| 事件 | 载荷 | 替掉的 |
| --- | --- | --- |
| `post-detected` | `PostEvent` | `dynamic-detected`；拓展作品也发 |
| `live-session-changed` | `LiveSessionChange` | `live-state-changed`、`extension-live-session`、`extension-live-changed` |
| `live-viewers-changed` | `{ subscriptionId, currentViewers?, totalViewers? }` | 原来的人数文字 |
| `subscription-auth-changed` | `{ sourceKey, state }`，`state` 是那一刻完整的中立 `AuthState`（状态取值在它的 `status` 里） | B 站四个登录事件；原载荷的 `kind` 改叫 `sourceKey` |
| `followers-refreshed` | 按订阅 id 的粉丝刷新条目 | `fans-refreshed`（去掉 uid / extensionId 三格） |
| `problems-changed` | `{ reporter }`：只带报的人、不带问题内容（3a-30 落成，键的形状是报的人）；经 WS 的 `state` 频道推给面板，按报的人 250ms 合并 | 新增：问题表搬进内存以后，面板靠它知道要重拉（ADR-0025 决策 11） |

- 🔗 `subscription-auth-changed` 那一行 3a-29 B 站半已落（10-11）：只有宿主发（订阅来源的 `Source.auth.onChange`，来源不碰总线），WS `auth` 频道只剩这一种帧；被替掉的 `login-status-report` 与 `cookies-refreshed` 都删了（续期落盘成功只记一行日志）。**「B 站四个登录事件」只换了这两个**：`auth-lost` / `auth-restored` 这两条边不换，原样留在总线上（主人 10-11 定：从相邻两次状态推边会多出三种多余的恢复；改成 B 站登录直接回调核心则定案否过 B 站私有通道），谁发、什么条件发、谁收都没动。出口：私聊主人那一处随 3a-30，直播与统计随 3b。
  - 🔗 3a-30 已落（10-11）：私聊主人那一处删了（`MasterNotifier` 不再听 `auth-lost`），登录失效改由问题表说；听 `auth-lost` / `auth-restored` 的是动态引擎、`runtime/engines.ts` 里的直播与 `stats/bili-source.ts` 的统计，随 3b。
- 来源与平台适配器的问题走 `reportProblem`，核心模块自己的问题直接写问题表；`engine-error` 只留流水线错误（如某一次出卡失败），`source` 改成中立的模块名（名字施工时定）。
  - 🔗 现状（3a-30，10-11）：B 站来源的问题已走 `reportProblem`（动态与直播的几处 `engine-error` 都删了）；`engine-error` 今天还有两个发射者：作品投递出图失败（`source` 是 `post-delivery`，文案带降级提示）与直播「重连流程内部异常」（`source` 是 `live-engine`），另有开发场景 `engine.error`；`source` 的中立命名仍没动。核心自己直接写问题表的路没有人走。
- 施工时补一张「现有 22 个事件 → 1.0 去向」的全量表（含 `subscription-reported` 这类宿主内部事件），写进 events.md。
- 直播互动（弹幕、SC、会员、进场）走回调、不走总线（3b 定）；弹幕是高频流，要在 events.md 写清。
- 被否的备选：另开一条 B 站私有总线（违反「MessageBus 是唯一事件通道」）。

## wire 契约

- `apps/contract` 是唯一来源：每个请求体、响应体、WS 帧有且只有一份；服务端的 zod 用契约类型钉住。
- WS 有一张事件表，载荷一律是具名对象（不发裸元组），类型从总线事件表推导。
- **失败只有一种形状**（ADR-0026）：一次操作的结果一律是 `{ ok: true, … } | { ok: false, code, message, upstreamCode? }`，抛错只留给 bug（宿主在边界接住，按 `unavailable` 处理并记错误日志）；HTTP 非 2xx 的错误体是 `{ code, message }`，可选附加只有 `issues` 与 `upstreamCode`；造结果一律用 `ok()` / `fail()`（ADR-0026 决策 6）。管来源、平台适配器、横切接口与 ctx 的方法、HTTP 业务失败与错误体、WS 控制帧、桥回执进门时的翻译；不管事件原因、描述性字段、AI 产出的内容、能力三态。操作结果的 `ok` 保留（布尔前缀规矩的例外）；失败原因只用 `code` + `message`；上游平台的错误码放 `upstreamCode`，不占 `code`。
  - `code` 取 internal 里唯一一张标准码表：`not_found`、`invalid`、`unauthorized`、`rate_limited`、`unavailable`、`timeout`、`unsupported`、`conflict`、`indeterminate`、`unknown`；自定义码算失败、不自动重试；问题表里的 code 另算，只要求 snake。
  - 防撞 B 站那种 `{ code, message, data }`：`code` 只装 BN 自己的错误码（字符串、snake_case，如 `not_found`、`unavailable`），永远不装平台的数字；平台的数字码只放 `upstreamCode`（现 `routes/subs.ts` 两处把 B 站的码塞在 `code` 里，契约骨架时改）；平台的原始响应不直接转给面板，一律在来源那层翻成 BN 的形状。主人 09-27 看过嵌套的 `{ error: { code, message } }`，选回平铺。
- 路由按新名：
  - `/api/subscriptions`、`/api/stats/followers`（10-03 ADR-0036 推翻原定的 `/api/followers`）、`/api/library`。整张路由的新旧对照见 ADR-0036。
  - `/api/sources`：每个来源一份 `{ key, descriptor, has, status }`，`has { auth, liveStatus, preview }` 由宿主按实现推算、不让来源自报，`status` 是运行状态的取值；拓展停用、失败、设置不合法时照样有描述符。（这个列表仍归第 4 期；`/api/sources` 这个前缀已由下一条的登录口先建，照 `/api/adapters` 的先例。）
  - 🔗 3a-29 B 站半已落，来源的登录口三个：`GET /api/sources/:sourceKey/auth`（读，回 `SourceAuthResponse { state, account? }`）、`POST …/auth`（发起扫码；状态是 `awaiting-scan` 时回 `conflict`，`confirming`——包括开机还没向 B 站确认上——放行并换一张新码）、`DELETE …/auth`（退出登录，清掉用 `DELETE`，ADR-0036 决策 2）。路由直接问来源登记表、不持有状态：来源不在回 `unavailable`、没有登录口回 `unsupported`，实现抛了记 error、回 `unavailable`；回包逐格挑，没有 cookie 与令牌；挂在登录闸后面。旧的 `/api/auth/*` 四个口退役，其中「刷新 Cookie」的口直接删、没有后继（主人 10-11 定）。
  - `/api/sources/:sourceKey/creators?q=`（搜人，返回结果形状）。
  - `/api/adapters`：各平台适配器的描述，新建连接时用（这个列表仍归第 4 期）；连接候选的读口归 3b；`listAddressCandidates` 的读口挂在连接底下（`GET /api/connections/:id/addresses`，3a-22 已落）。`connectionAuth` 的三个口 3a-29 已建：`POST /api/adapters/:adapterKey/auth`（发起，回任务号、状态与建议的问询间隔）、`GET /api/adapters/:adapterKey/auth/:taskId`（读状态，不带草稿、不清草稿）、`POST /api/adapters/:adapterKey/auth/:taskId/draft`（取走草稿，取走即清，响应头 `no-store`）；路由直接问适配器登记表、不持有状态。`routes/qq.ts` 已删，`/api/qq/*` 整组退役：QQ 官方机器人的扫码建连接走这三个口，会话地址走连接底下那个口。
  - `/api/problems`（问题表一次给全）。🔗 3a-30 已落（10-11）：`GET /api/problems` 回 `ProblemsResponse { problems }`（`apps/contract/src/rest.ts`），按 `since` 先后、交出去的是拷贝；`routes/problems.ts` 只读内存里的表、没有失败支；挂在登录闸后面，路由按资源挂载的探针表里有这一行。面板这一片不读。
  - `/api/health`：短版只留存活探测与应用内更新要的 `status`、`version`、`startedAt`、`uptime`（应用内更新靠 `version` 与 `startedAt` 认新进程）；B 站的格子（`login`、`dynamicCron`、moduleVersions 里的 api / dynamic / live 等）删掉。`/api/health/details`：分核心、集成两组，给健康卡。
  - `/api/history?feature=`；`?uid=` 删掉（没有调用方），以后要按人查再加 `?identity=`（ADR-0027 决策 7）。
  - `/api/targets/:id/test`（原 `/api/push/test`）、`/api/connections/:id/probe`（原 `/test`）。
- 设置拆进 `config/settings/` 的三类文件以后，系统页的字段路径与 `PATCH /api/settings`（原 `/api/globals`，ADR-0036）跟着改（原 `app.*` 搬进 `core.*` / `bilibili.*`）。⑥f 先只挪 B 站那三格（`bilibili.*`），核心读法与核心那半的路径随第 2、3 期改名再加 `core.`。3a-38 已把 `app` 拆掉：系统页现在读写顶层 `logging.level` / `logging.levels` / `logging.memoryLog.enabled`（模块覆盖四格 `core`、`bilibili`、`image`、`ai`，`logging.levels` 的键是开放字符串；3a-40 起键的全集是核心的 `core` / `image` / `ai`，加上集成键 —— `bilibili`、三个内置适配器的适配器键 `onebot` / `qq-official` / `webhook`、每个拓展的 id，一行日志跟打它的那段代码所属的那一格，面板的系统页仍只画那四格，其余的第 4 期才有入口，见 [agents/architecture.md](../agents/architecture.md) 的「日志等级」），粉丝轮询的 cron 是顶层 `profileRefreshCron`；`PATCH /api/settings` 的核心路径仍不带 `core.` 前缀，随第 4 期。
- 删掉死字段 `SubscriptionDTO.state`；订阅卡上永远不亮的「播」角标改用真实的在播数据。
- `/api/health` 补进契约（`HealthResponse`），面板把 contract 移进 `dependencies`：④d 已落。
- 密钥下发只用 `MaskedSecret`，见 [data-model.md](./data-model.md)「凭据字段标 secret: true」。

## 守卫

每条规矩配一道会变红的门。**扫 TS 源码的守卫一律用共用工具 `scripts/source-scan.mjs` 的语法树（TypeScript 官方解析器的 AST，只解析、不做类型检查），不再用正则扫代码**（主人 09-29 定）：遍历、解析、抠 import、找节点与行号都在它里面，注释与字符串天然不算。新守卫生来就用它；现有的碰到哪道先迁哪道，没碰到的第 5 期迁完（点名见 [construction-plan.md](./construction-plan.md)「零碎施工项」）。扫非 TS 文件（YAML、Rust、Markdown、CSS）与只看文件名的照旧用文本；要靠类型才判得了的走类型层写法（如事件载荷）。白名单与逐行放行标记随用到的守卫补进工具。写法仿拓展边界守卫：判据是纯函数、配样例、真扫目录。

**中立性守卫分三层**（ADR-0021 决策 59）：**咽喉**守一入一出，结构上只留一条路；**静态扫描**抓字面上的越界；**对拍**用假来源、假适配器把 B 站与内置平台用到的每种中立能力走一遍，抓一个平台词都没有的语义后门。

- **棘轮**：开的那一刻记下命中数当上限，只许少不许多，多一处就红；上限随清理调低，到清零期必须是 0。每期都得全绿才出期，所以不能「一开就红」。
- 期次写法同 [construction-plan.md](./construction-plan.md)：「1⑥」是第 1 期切片 ⑥，「3b 末」是 3b 结束时。

### 第一层：咽喉

| 守卫 | 判据 | 什么时候红 | 期 |
| --- | --- | --- | --- |
| 入口咽喉 | `compose.ts` 里 `bilibili/` 的东西只能作登记的参数（按 AST 判）；核心拿到的依赖包里不许有平台客户端。🔗 3a-40（10-12）落地，`scripts/__tests__/entry-throat.test.mjs`，四条判据、各配「算 / 不算」样例、真扫：① `compose.ts` 导出的声明里类型位置上不许出现集成的名字，历史欠账按名字记上限（7 处：开发场景的五个过渡句柄、`DevtoolsProviderRegistry`、`ProblemLayers`）；② 集成的值在 `compose.ts` 里只能被调用或直接作调用的实参，或作导出常量数组的元素，指向集成目录的 `export … from` 等一律不许（上限 0）；③ `BuiltinIntegrations.bilibili` 的成员名集合必须正好等于名单 `["problems"]`，只许少；④ 核心里名字正好是 `api` 的槽位按文件记数只降不涨（10 个文件 55 处）。判据 ① 除类型别名与接口外，也认本地函数的形参与返回类型（含 `ReturnType<typeof 本地函数>`）、本地的类当载体和导出的命名空间（第三次独立审查后补，实数不变）。因为按名字数、不做类型检查，换了名字的同一个句柄它抓不到（靠 B 站替身棘轮与审查）；`compose.ts` 里长出登记以外的逻辑也靠审查 | B 站客户端绕过登记表塞进核心：今天的 `engines.api`（「给路由临时调 B 站用」）。守卫 1 只看 import，这种结构化句柄它抓不到 | 3a |
| 出口咽喉 | 平台适配器登记表对外只给不含 `send` 的视图，`send` 只经 `TargetDispatcher` 的特权句柄；另配源码扫描，白名单只有 `TargetDispatcher` | 有文件拿到可发送的适配器句柄、绕过 `TargetDispatcher` 直接发（今天链接回复现造临时目标直调 `send`，主人通知靠强制私聊的平台分叉） | 3a |
| 咽喉 e2e | 开截流 + 守卫 2，逐条驱动全部发送路径：广播、`notifyMaster`、目标测试、卡片发送、AI 试一句、锐评投递、人工重推、链接预览回复、审批预览、指令回复（含登录二维码）；每条恰好一条截流记录、零外连 | 有人在登记表外构造适配器，或自己开 socket | 3a |
| 出图器零联网 | 渲染页开请求拦截，`data:` 以外的请求一律 abort 并计数（图库引用在进 HTML 之前就已转成 data URL，所以不用给本机图库留口）；图只有地址、没有图库引用时画占位，出网仍是 0；源码那半（`packages/image/src` 里不许有出站原语）归出网点名表，`packages/image` 不在白名单 | 出图器联网（守卫 2 管不到 Chrome 子进程；3a-37 之前出图器运行时从 `s1.hdslb.com` 拉图、按域名白名单预取） | 3a |

### 第二层：静态扫描

| 守卫 | 判据 / 范围 | 什么时候红 | 期 |
| --- | --- | --- | --- |
| 1 边界表 | 核心目录不许 import 服务端 `bilibili/`，例外只有 `compose.ts`；和现有两条拓展边界、推送守卫① 合成一张「谁不许 import 谁」的边界表。🔗 3a-40 按计数开张（`scripts/__tests__/import-boundaries.test.mjs` 的「核心不许 import 服务端的 `bilibili/`」一行，判据按解析后的路径、`import type` 与动态 import 也算）：例外只有 `compose.ts`，其余文件按文件记越界 import 的条数、两头钉（多了红、记多了也红），今天 10 个文件 19 条（开张时 20 条，设置登记搬进 `compose.ts` 后 `runtime/bootstrap.ts` 2 → 1），全在等新接口，3b 末清零；中立小件当片已搬进 `live/`、`posts/` | 核心文件 import 了 `bilibili/` | 3a |
| 推送守卫① | 核心不许 import `platforms/`（内置适配器的实现），例外只有 `compose.ts` | 核心文件 import 了内置适配器。勘察时真越界的是 `app.ts`、`routes/qq.ts`（3a-29 QQ 半已清：路由删了，任务表搬进适配器）、`routes/types.ts`；`sink/`、`engines.ts`、拓展宿主、devtools import 的是 `registry.ts` / `dispatch.ts` 这两个放错目录的中立件，挪进 `push/` 即清。🔗 3a-40 第一块（10-11）已开张：三个内置适配器挪进 `compose.ts`，守卫是 `scripts/__tests__/import-boundaries.test.mjs`（一张「谁不许 import 谁」的表，开张时一行，3a-40 起两行，另一行是守卫 1；例外都只有 `compose.ts`，且钉着例外文件真的在 import 目标） | 3a |
| B 站替身 | 范围核心 + 面板 + contract：裸 `"bilibili"` 字面量（`@bilibili-notify/` 除外）、`Bili*` / `BILIBILI_` 标识符、`"@bilibili"` 哨兵；白名单 `compose.ts`、`bilibili/`、保留 id 表、迁移模块、设置 schema 的组合处。🔗 ⑥d 落地（`scripts/__tests__/bilibili-stand-ins.test.mjs`）：标识符按驼峰段与下划线段切开，有一段是 `bili` / `bilibili` 就算（`isBiliSubscription`、`BILI_ONLY_EXTRAS`、`fromBilibili` 都抓得到，`mobility` 不误中）；字面量正好是 `"bilibili"` / `"@bilibili"` 才算；不扫测试；B 站四包今天算核心、进基线；白名单今天有迁移模块与 `bilibili/` 两个整目录（`bilibili/` 自 ⑥f 起住着 B 站自己的设置），与 `compose.ts` 一个文件（3a-28 起；入口 `index.ts` 的现数 3、`runtime/engines.ts` 的现数 18，都只降不升（**3a-30 获批的一次例外，现数入口 5、`engines.ts` 20**：把 B 站分层上报器经入口递给直播引擎的 `biliProblems` 一格，名字如实带 `bili`，3b 直播并进来源时四处一起消失、数回 3 与 18）；3a-29 B 站半与 3a-31 之后的变化：入口 5 → 3，统计的登录读口改读中立的 `auth.state()`，剩下来源键两处与 `builtins.bilibili` 一处；`engines.ts` 去掉两处 `BiliLoginStatus`、多出名字如实带 `bili` 的局部函数 `biliLoggedIn`（声明一处、开机那道门用一处）仍是 17，3a-31「开关翻开补一次」第二次用到它，主人 10-11 点头 17 → 18，守卫文件里仍注明 3a-38 查出的另外 6 处少报；`routes/subscriptions.ts` 9 → 8；面板 `System.tsx` 29 → 5、`Dashboard.tsx` 6 → 5；服务端 `auth/index.ts`、`auth/login-status-wire.ts`、`routes/auth.ts`、契约 `auth.ts`、面板 `types/auth.ts` 五行随文件搬走或删除而整行摘掉，`hooks/useAuthChannel.ts` 文件还在、数到 0 也摘了行，合计六行；没有任何一行往上涨），保留 id 表暂与 constants 同住、先记棘轮，清零前拆出来再放白名单；开张基线 70 个文件 403 处；🔗 3a-40（10-12）：入口 `index.ts` 5 → 4（`status` 改读登记表的 `health()`、交回入口的 `dynamic` 句柄没了）、`runtime/engines.ts` 20 → 19（日志等级改成按键给，开机取一次、热更取一次那两处与两个局部变量一起消失，剩一处是直播引擎的子上下文，3b 随直播并进来源走），`compose.ts` 白名单的理由改成「出口由入口咽喉守卫钉着，里面长没长登记以外的逻辑仍靠审查」；现数全表 40 个文件 203 处（3a-42 修了锐评「平台」列与历史名字快照两处后门，`runtime/push-history.ts` 清零摘掉、`stats/roast-subject.ts` 6 → 3；开张基线 70 个文件 403 处） | `isBiliSubscription` 删掉以后换个写法回来：`identity.sourceKey === "bilibili"`、`"@bilibili"`、`BILIBILI_*` 常量 | 1⑥ 棘轮开，4 末清零 |
| 存储占用的目录覆盖 | 数据根目录表每个一级目录，要么归存储占用的某一类、要么列在写明理由的不进表清单里（`runtime/storage-usage.ts` 的 `DATA_ROOT_STORAGE_COVERAGE`） | 往数据根加了一级目录而没想它归哪一类（编译不过，测试也红） | 2（㉙ 已落） |
| 11 B 站专有词（修订） | 范围 `packages/` 全部 + 服务端 `bilibili/` 以外 + contract（登录态在 contract 里只有中立的 `AuthState`，没有要进白名单的 B 站文件）；面板、测试、夹具不扫（面板归「B 站替身」与「中文叫法棘轮」）。先剥注释，按词边界匹配。词表自动生成（`bilibili/` 的导出名、B 站接口客户端的方法名、B 站类型的键）再手补：`DYNAMIC_TYPE_`、`RICH_TEXT_NODE_`、`MAJOR_TYPE_`、`ADDITIONAL_TYPE_`、`module_dynamic`、`jump_url`、`id_str`、`guard_level`、`live_time`、`live_status`、`WATCHED_CHANGE`、`roomId` / `room_id`、`bili_user`、`bvid`、`hdslb`、`bilibili.com`、`b23.tv`、风控码等；原始字段按属性访问匹配。不收 `uid`（另有 uid 棘轮）。确实要留的进白名单、附理由。🔗 3a-41（10-12 落地，主人 10-10 定晚开；`scripts/__tests__/bilibili-vocabulary.test.mjs`）：判据走语法树，注释天生不是节点。词表分四组：前缀（`DYNAMIC_TYPE_` 等，标识符以它开头）；整名（`module_dynamic`、`jump_url`、`live_status`、`room_id`、`bili_user` 等，标识符整个正好是它，字符串里按词边界出现，**不按段**，免得误中我们自己起的驼峰名 `jumpUrl`、`SubscriptionLiveStatus`、`guardLevel`）；按段（`roomId`、`bvid`，`resolveRoomIdFromUid` 算）；文字（`bilibili.com`、`b23.tv`、`hdslb`）；另有带负号的风控码 `-352`、`-412`、`-799`（`-403` 与 HTTP 状态码同数，不收）。与定案字面不同的两处：① 词表自动生成只取一样 —— `bilibili/` 里接口与类型字面量的属性签名、枚举成员中全小写带下划线的键，今天 81 个，快照进测试文件并断言与现生成的一致（主人 10-12 定；导出名几乎就是守卫 1 的影子、方法名被 `get` / `start` / `stop` 淹掉、全部类型键命中上万处；数与原因见 ADR-0021 决策 59 下的 🔗）；② 范围多不扫 `platforms/`（定案写的是「`bilibili/` 以外」；内置适配器也在抄外部协议的 snake_case 字段，如 QQ 的 `msg_type`），迁移模块整目录不扫，白名单空。开张时核心 13 个文件 62 处；🔗 独立审查与窄审后的修补（认正则字面量、手补 `live_room` / `roomid` / `SESSDATA` / `bili_jct`）之后现数 **14 个文件 75 处**（`routes/cards.ts` 20、`link-preview/link-previewer.ts` 13、`packages/internal/src/util/video-links.ts` 9、`runtime/engines.ts` 9、`packages/ai/src/tools.ts` 7、`logs/redact.ts` 5 …；`compose.ts` 记 2 处），清零期的字面先不改（见下「uid 棘轮」行的 🔗）。抓不到：不带下划线的 B 站原始字段（`mid`、`uname`、`face`、`aid` …，核心里今天真在读的已手补）、没写成类型声明的原始字段（自动词表有漏，「现生成 = 快照」不证明没漏）、驼峰化的字段、字符串拼出来的词、字符类或分组拆开的词（`b23[.]tv`）、`bilibili/` 导出的名字（归守卫 1 与入口咽喉）；正则字面量与字符串 / 模板写的正则认（还原标点转义）。上面「旧词表现查约 68 处、约 50 处」描述的是一个没进过 dev 的旧版，现数以这一条为准 | 核心里出现 B 站专有词。旧版只有英文词、按子串匹配：会误中 `get_live_status`，剥注释后 `platform.ts` 这类文件零命中，也不扫 contract（旧词表现查：中立包约 68 处、服务端约 50 处） | 3a 棘轮开，3b 末清零；这是中立化的验收线 |
| uid 棘轮 | `bilibili/` 与迁移模块以外出现 `uid`；面板算不算进这道棘轮施工时定（面板的 UID 字样随第 4 期按描述符重画）。🔗 3a-41（10-12 落地，主人 10-10 定晚开；`scripts/__tests__/uid-ratchet.test.mjs`）：「面板算不算」落成**不扫面板**（主人 10-12 定：面板里 uid 是表单字段与显示，第 4 期整页重画时成片消失；面板上的「UID」字样归中文叫法棘轮）。范围：服务端、contract、`packages/<包>/src`，不含测试。判据走语法树：标识符按驼峰段与下划线段切开，有一段是 `uid` / `uids` 就算（`idsByUid`、`BILI_UID_PARAM`；`guid`、`uuid`、`fluid` 不误中）；字符串字面量整个正好是 `uid` / `uids`（`o["uid"]`、`required: ["uid"]`）才算，日志与提示词里带别的字的不算。`bilibili/`、`migration/` 整目录不扫，白名单空（`compose.ts` 不进，记棘轮 4 处）。开张现数 15 个文件 212 处（`packages/ai/src/tools.ts` 49、`runtime/engines.ts` 41、`routes/cards.ts` 33、`runtime/fans-poller.ts` 20 …）；`platform.ts` 与 `schema/subscriptions.ts` 里的 4 处与事件载荷那行是同一批东西的两种记法。抓不到：换了名字的同一个东西（`mid`、`userId`、`bid`）、模板与日志文字里的 `uid`、经类型推断流进核心而核心这头没写出 `uid` 的、面板里的 `uid`。清零期：定案写 3b 末，但 `routes/cards.ts`（33）、`routes/subscriptions.ts`（15）、`apps/contract/src/rest.ts`（2）按守卫 1 与入口咽喉 ④ 的表是第 4 期才消；主人 10-12 定这几格照记、清零期的字面先不改，3b 收尾时再问 | 中立层又拿 `uid` 当身份（中立层只有 `externalId`） | 3a 棘轮开，3b 末清零 |
| 中文叫法棘轮 | 范围核心 + 面板的字符串字面量（不扫注释）：`UP ?主`、`B ?站`、`哔哩`、`舰长`、`提督`、`总督`、`大航海`、`上舰`、`粉丝牌`、`专栏`、`房管`、`UID`、`动态`；白名单 `bilibili/`、迁移模块、ADR-0021 决策 50 的「投稿」「动态」；开张时连 `locales/*.json` 一起扫（字搬进字典以后，源码扫描看不见它们） | 文案、提示词、界面写死 B 站的叫法（守卫 11 只有英文词） | 4 棘轮开，5 末清零 |
| 写死的中文 | 范围 `apps/server/src`、`apps/web/src`、`apps/contract/src`、`packages/<包>/src`，不含测试、`.d.ts`、拓展、桌面壳；单位是逐文件数带汉字的字符串节点（字符串字面量、不带插值的反引号串、带插值的模板算一处、JSX 文字）；日志调用的参数、注释、正则字面量不算；整目录不扫三个开发版调试面板（`devtools/`）。白名单三份：词云停用词表 `live/recap/stop-words.ts`，以及工具回给模型的话 `ai/creator-reader-texts.ts`、`packages/ai/src/tool-texts.ts`（同提示词，不翻，ADR-0037 决策 11）；提示词与给人看的话混放的文件照常记棘轮。涨了一律红、调格前问主人（包与 contract 没有字典，也一样）；少了当场调低，清零整行删。开张时 365 个文件 5601 处（`scripts/__tests__/hardcoded-chinese.test.mjs`，ADR-0037 决策 16） | 给人看的话写死在源码里，而不是进字典（服务端 `t`、面板 `useT()`） | 3b 开，4 期末收完 |
| `.platform` 决定棘轮（推送侧） | 核心里读 `.platform` 的地方只许用来构造身份、显示、记日志。🔗 3a-41（10-12 落地，主人 10-10 定晚开；`scripts/__tests__/platform-decisions.test.mjs`）：机判把这句话翻成「平台值流到会分叉的语法位置就算决定」。平台值 = 属性读 `x.platform`、最后一段叫 `platform` 的名字（全大写常量如 `BILI_PLATFORM` 不算）、点名的取平台函数 `platformOfTarget(…)`、由它们初始化的局部名字（只传一层）；`process.platform` 一类宿主平台不算。决定 = 与非平台值的相等比较、`switch`、当下标或 `in`、当实参喂给不在去处表（今天只有 `neutralPlatformSnapshot`）也不是 `logger.*` / `console.*` 的函数、在上面调 `startsWith` / `includes`。**两个平台值比相等（平台对平台）与问有没有（比 `undefined` / `null` / `""`）不算决定**：定案点名的三个谓词今天一个都不在了（3a-22 改成问适配器能力），而平台对平台的比较正是 ADR-0024 决策 9 明文要求的那种（见那条下的 🔗），这是对定案字面的一种读法。核心不扫 `platforms/`、`migration/`、`bilibili/`，也不扫 `packages/ui`；**面板另记一张表**（主人 10-12 定：这道要抓的形态今天几乎全活在面板）。开张现数：核心 2 个文件 4 处（`packages/internal/src/constants.ts` 3，平台表自己；`devtools/scenarios/bridge.ts` 1，是误伤），面板 5 个文件 29 处（开张时 23 处，窄审后守卫看穿 `??` / `||` 的兜底，`pages/Targets.tsx` 12 → 18；`pages/Targets.tsx` 18、`types/domain.ts` 5、`types/connection-fields.ts` 3 …）。抓不到：别名传了两层以上、按 `adapterKey` 比字面量（核心今天 1 处，在 `isWebhookPlatform` 里，本片不加）、属性不叫 `platform` 的同一个值、类型层面的分叉；别名按名字认、不看作用域 | 核心按平台名做决定：`platformSupportsAtAll`、`platformCanReceiveReply`、`isWebhookConnection` 这类中立名谓词，词棘轮看不见；该改成问适配器能力（`atAll`、`inbound`） | 3a 棘轮开，3b 末清零 |
| 推送守卫②（推送平台专有词） | 范围 `packages/*/src`（ui 除外）+ `apps/server/src` + `apps/contract/src`，排除 `platforms/` 与测试，迁移模块进白名单；先剥注释。词表 `onebot`、`qq-official`、`miniapp`、`guild`、`openid`、`feishu`、`dingtalk`、`wecom`、`napcat`、`send_group_forward_msg`、`user_id`、`group_id`、CQ 码，加宽 `\bQQ[A-Z]`、`ws-reverse`、`transport`、`get_mini_app_ark`、`c2c`（「分享到 QQ」这类说 B 站的语境别误伤）。🔗 3a-41（10-12 落地，主人 10-12 定并进 3a-41 当第四道；`scripts/__tests__/platform-vocabulary.test.mjs`）：判据走语法树（「先剥注释」一句落成注释天生不是节点），节点是标识符、字符串、模板的每一段文字、JSX 文字、正则字面量，一个节点一处。词按「连续几段拼起来正好等于」匹配、不分大小写（`miniAppCard`、`oneBotAdapter` 算，`transportation`、`abc2c` 不算）；`\bQQ[A-Z]` 落成「标识符与长得像标识符的字符串里有一段是 `qq`；自由文本里原样用 `\bQQ[A-Z]`、分大小写」，所以「分享到 QQ」「QQ 官方机器人」不算；`user_id` / `group_id` 连驼峰的 `userId` / `groupId` 一起认（主人 10-12 定；`packages/internal/src/post.ts` 一处是同名不同物，记在表里注明）；**`webhook` 不进词表**（主人 10-12 定：通用技术词）。范围如上再加：`bilibili/` 整目录不扫（定案没写），`compose.ts` 整文件白名单（造并登记三个内置适配器本身）。开张现数 17 个文件 147 处（`schema/targets.ts` 32、`constants.ts` 29、`link-preview/link-previewer.ts` 25、`devtools/scenarios/inbound.ts` 18、`devtools/scenarios/bridge.ts` 12 …；「勘察时约 133 处」那句不动）；平台表与连接设置规则占其中 61 处，等第 4 期面板按适配器的描述画之后搬走，清零期的字面先不改（主人 10-12 定）。抓不到：中文叫法（归中文叫法棘轮）、词表以外的平台名（`telegram`、`discord` …）、`config/store.ts` 里托管 webhook 目标那套逻辑（归推送守卫③）、换了名字的同一个东西、`compose.ts` 里以后长出的登记以外的逻辑 | 核心里出现推送平台的专有词。勘察时核心 + 服务端代码约 133 处，大头随平台表与设置 schema 搬出、原生分享改名消失 | 3a 棘轮开，3b 末清零 |
| 事件载荷 | 总线事件表（`BusEvents`）的载荷类型递归检查（`scripts/__tests__/bus-event-payloads.test.mjs`，走类型检查器，沿属性、索引签名、联合、数组与接口的基类型一路往下；库里的接口如 `Map` 只走它装的类型参数）：不许有 `uid` 键、`Bili*` 类型（类型上留不住名字的别名，如 `z.infer` 出来的 `BiliSubscription`，顺着源码里写的别名认）；平台原始值（如动态类型码）不许以裸 `string` 进载荷。棘轮按事件记路径。看不见的：裸 string 类型上分不出是 id 还是平台原始值，已知的按路径点名（守卫只核它们还在、还是 `string`），新写进去的靠审查 | 总线事件又带上 B 站的形状（今天 `DynamicDetectedEvent` 带 `uid`、`type` 原样装 `DYNAMIC_TYPE_*`，剥注释后守卫 11 零命中）。开张时：带 `uid` 的 7 个事件（订阅变更、历史建行与追加、直播状态、观看人数、粉丝快照、动态）、`Bili*` 1 处（订阅变更里的订阅）、裸 string 2 处（动态类型码、预格式化的观看人数） | 1④c 棘轮开，3b 末清零 |
| 类型名后缀 | 扫我们写的全部类型声明（`packages/`、`apps/` 的服务端 / 面板 / contract / 桌面壳、`extensions/`，含 `bilibili/`），类型名用了 [naming.md](../agents/conventions/naming.md)「不再用」那一列的后缀就红（ADR-0023 决策 15）；第三方库的名字与外部协议定死的字段名不管。那一列里带条件的写法（「当参数包用的 `Input`」「当设置值用的 `Config`」这类）怎么机判施工时定 | 新起或改的类型名不对表；按表该改的名字逐条见 data-model 的改名对照 | 施工时定 |
| 4 名字唯一的家 | 同一个导出名全仓只定义一次；「名字 → 唯一的家」点名表（`isPlainObject`、`formatCount`、`formatDuration`、`formatAgo`、`subscriptionIdentityOf`、`displayNameOf`、`createSerialQueue`、`atomicWriteJson`、`createAssetStore`、`createSkinStore` 等），家以外出现同名定义就红，含不导出的局部函数。点名表补上：直播监听的唯一判定、身份索引、`formatViewers`、`posts/` 里作品文字的取段函数、contract 里的叫法函数（没定名的施工时定）；面板不许自带路由键表（今天首页自抄 4 键 `LIVE_ROUTING_KEYS`）。不扫 extensions/ 与测试夹具，TS 重载不算多次定义。⑪ 开张（`scripts/__tests__/unique-homes.test.mjs`），头一批是 `formatCount`、`formatAgo`、`formatDuration`、`formatClock`、`formatAxisTick`，其余名字随各项补 | 家以外出现同名定义。改了名的抄本拦不住，靠审查 | 随各项 |
| 12 不读 B 站的设置 | 范围同 B 站替身（核心 + 面板 + contract，不扫测试，`bilibili/` 是 B 站自己、不扫）：不许引 `bilibili/settings.ts`，按 import 判，`import type` 也算 —— B 站的设置只有经这个模块才读得到。白名单只有组装处（今天 `runtime/bootstrap.ts`，3a 起 `compose.ts`）；B 站接线（今天 `engines.ts`、`index.ts`）按棘轮记账，3a 随它们搬进 `bilibili/` 清零。拿键名去捞的写法（解构 `const { bilibili } = …`、下标 `settings["bilibili"]`、`BILIBILI_SOURCE_KEY`）由 B 站替身棘轮兜底。🔗 ⑥f 落地（`scripts/__tests__/bilibili-settings-readers.test.mjs`），开张时棘轮两个文件各 1 处。🔗 3a-29 B 站半清零：入口读健康检查间隔、引擎装配听它的变化这两处都搬进了 `bilibili/auth/`（登录系统开机自己读 B 站设置、之后自己听），棘轮表现在是空的（`RATCHET = {}`），守卫留着。🔗 3a-40：白名单换了位 —— 登记设置段这件事搬进了 `compose.ts`（`BUILTIN_INTEGRATION_SETTINGS`），`runtime/bootstrap.ts` 不再 import `bilibili/settings`，现在白名单只有 `compose.ts` 一个文件 | 核心读了 B 站的设置 | 1⑥ 棘轮开，3a 清零 |
| 出网点名表 | 范围是服务端进程里跑的代码：`packages/*/src`（ui 除外）、`apps/server/src`、`extensions/*/src`，不含测试；先剥注释。出站原语：全局 `fetch(`（含 `globalThis.fetch(`，`x.fetch(` 这种自家方法不算）、当客户端用的 `new WebSocket(`、`http` / `https` 的 `request` / `get`、`net.connect` / `createConnection`、`tls.connect`、`http2.connect`、`undici` 的值 import；入站的 `WebSocketServer` 与 `import type` 不算。白名单按文件，只有两类：集成的请求客户端（⑭a 起是 `packages/http/src/http-client.ts`，⑭b 起建 WS 连接的 `packages/http/src/websocket.ts` 也在白名单）；BN 自己的出口（`update/fetch-through-mirrors.ts` 管更新、拓展市场、签名清单，`packages/ai/src/web-search.ts` 管联网搜索，AI 服务商走 OpenAI SDK、不扫第三方）与开发版的 `devtools/fake-bridge.ts`。棘轮按文件计数，白名单外出现新文件就红 | 集成绕过 `ctx.http` 自己发请求，或核心随手长出一个出口（今天出图器拉 `hdslb`、设置页的 AI 连通测试写在路由里）。规矩本身早有（ADR-0025 决策 6、集成副作用规范第 4 条），只是一直靠审查。勘察时白名单外 7 个文件 15 处：`platforms/` 四个文件 12 处、`blive` 的 `new WebSocket`、出图器 1 处、`routes/globals.ts` 的 AI 连通测试 1 处 | 1④ 棘轮开，3b 末清零 |
| 错误体 | 记账式（仿守卫 2，`scripts/error-body-guard.mjs`）：测试进程里把全局 `Response` 换成 Proxy，按构造时的调用栈认出服务端代码（`apps/server/src` 的非测试文件）造的非 2xx 回应，逐个对一遍 `ErrorResponse`（`code` 在码表里、`message` 非空、附加只有 `issues` / `upstreamCode`，`issues` 每条只有 `path` / `message` / `op`），不合的记账、每条测试收尾查账；对服务端的每个文件一视同仁，没有白名单（④b 迁移期的「还没迁的文件」名单已随最后一组路由拿掉）。看不见的：起真 HTTP 服务（`serve()` 会换掉全局 `Response`）之后造的回应，这些路由由 `app.request` 型测试覆盖；失败结果的 `code` 同样只装 snake，平台的数字码只在 `upstreamCode`。不扫源码：扫 `c.json(` 看不准状态码 | 平台的错误码塞进 `code`（今天 `routes/subs.ts` 两处）；路由绕开 `respondFailure` 手写了别的形状 | 1④b |
| 结果不手写 | 范围是 `apps/*/src`、`packages/*/src`、`extensions/*/src`，不含测试（`scripts/__tests__/hand-written-results.test.mjs`）。对象字面量里有一格 `ok`（`ok` / `"ok"` / `["ok"]` 三种写法），值是字面量 `true` / `false`（看穿括号、`as`、`satisfies`），一个字面量算一处；类型里的 `{ ok: true }` 不算。白名单只有 `ok()` / `fail()` 所在的 `packages/internal/src/constants.ts`；棘轮按文件计数，对账与出网点名表共用 `scripts/ratchet-audit.mjs`。看不见的：`{ ok: res.ok, … }` 这类转抄 | 绕开 `ok()` / `fail()` 手写结果（主人 09-29：都统一、不手写）。开张时 46 个文件 275 处：投递与探测结果、皮肤检查的 `errors`、更新与市场的 `reason`、面板登录、桥拓展（拓展包还没有 `ok()` / `fail()`）、devtools 假桥发的 `result` 帧（3b 桥协议统一后改用 `fail()` 展开，ADR-0026 决策 7） | 1④b 棘轮开，5 末清零 |

### 第三层：对拍

| 守卫 | 判据 | 什么时候红 | 期 |
| --- | --- | --- | --- |
| 21a 契约层对拍 | 用仓库里的假源拓展经契约 v3 走作品与直播：带图标的链接片段、直播、资料、问题上报等 | 只有 B 站走得通、拓展走不通 | 3b |
| 21b 进程内对拍 | 在测试用的 compose 里照内置集成的路登记一个假来源：直接实现完整的 `Source`（10 个成员、全部特性与附加项，含 `liveInteractions`、`auth`、`health`、`fetchPreview`）加一个 `AiToolProvider`；断言内容，不只是不报错。清单见表下。🔗 现状（3a-42，10-12，已落）：落在 `apps/server/src/__tests__/in-process-source-parity-e2e.test.ts`（夹具 `support/in-process-source.ts`，假来源键 `acme.inprocess`，经真入口与 `vi.mock` 包一层的真 `compose.ts`，与真 B 站来源并排在册；推送内容读 devtools 的截流记录，零外连）。接口上今天没有「10 个成员」（`Source` 只有 5 个，见上「接口族与登记表」），`AiToolProvider` 与 `LinkResolver` 的登记表也没有，所以今天拍的是 3a 子集 **20 行**（测试文件里 `PARITY_ROWS` 的 P01 至 P20），其余 **18 行**（N01 至 N18）列在同一张表的「这版不开」名单里、逐行写明等哪一期（第 4 期 5 行，3b 13 行），**标 3b 的行在 3b 出期时转成对拍**（见 [construction-plan.md](./construction-plan.md) 3b 的出期条件）。检查点口径是主人 10-12 定的（被否：3a 里先把这些口造出来；检查点挪到 3b）。另有成员棘轮：给 `Source`、`SourceContext`、`SourceDescriptor`、`SourceAuth` 加一个成员，测试文件类型检查就过不去，必须来补一行指向管着它的对拍行 | 语义后门：词表与 import 守卫抓不到，比如照搬 B 站的 `video \| lottery` 图标枚举，一个 B 站词都没有。会员、醒目留言、特别弹幕、特别进场、词云、总结六项契约不开，只有这一层够得着 | 3a 检查点的验收之一 |
| 推送守卫③（假适配器对拍） | 一个假平台适配器（给假源拓展加 `contributes.push`，或另起一个假适配器拓展，施工时定）逐成员走 `PlatformAdapter`：要么走通，要么在「这版不开」名单里写明理由（ADR-0024 决策 11）。必须有的行：`atAll` 为 false 时不 @全体、`inbound`、`endpoint` 目标由连接托管、能力接口列得出拓展连接、登记即 `start`（晚登记的也收得到）、内置与拓展的入站都经宿主校验 | 只有内置适配器走得通的能力（勘察时：单向终点与托管目标、一个实现对多个平台、能力接口跳过拓展连接、晚注册的适配器收不到 `reconcile`） | 3b |
| 模板变量可满足性 | 每个模板变量都映射到中立字段，表外的判红；`{tier}`、`{fanclub}` 进表。🔗 现状（3b-21，2026-10-19）：表是 `@bilibili-notify/internal/template-variables` 的 `TEMPLATE_VARIABLES`（零依赖子路径，面板提示条与服务端探针共用），每条文案登记能用的变量与变量取的中立字段，会员宣告语也收进表。判法两处：默认文案 ⊆ 表、字段以中立类型开头、变量名不在旧名黑名单（`mdn` / `guard` / `mastername` / `uname` / `mname` / `medal`），住 `packages/internal/src/__tests__/template-variables.test.ts`；运行时探针住 `apps/server/src/__tests__/template-variables-satisfiable.test.ts`，每个渲染入口用全表变量加一个表外的 `{zzz}` 调一次，多填少填都红，另有一条断言表里每条文案都有探针。开张零违例。`ViewerChatEvent` / `ViewerEnterEvent` / `LiveSummarySnapshot` 三个根名是暂起的，等 3b-22 定直播互动的中立类型时对齐 | 模板变量只有 B 站填得出（今天的 `{guard}`、`{mdn}`） | 3b |
| AI 工具与技能约束 | 核心工具参数统一叫 `creator`，参数里不许有 `uid`；每把工具必须带 `label` 与参数标签；内置技能的 `allowedTools` 必须是核心中立工具的子集，否则挂到提供者的 `skills` 下；缺工具的技能自动隐藏要有测试 | 工具或技能只对 B 站成立 | 3b |
| 10 出图字节门 | 全部卡种的字节快照长期保留（10-02 查时 23 份，作品、直播、醒目留言、会员、榜单、词云都有），清单机制 ⑩ 已落（`packages/image/src/__tests__/approved-card-diffs.ts`，判官在同目录 `card-diff-check.ts`；三类预批之外的变化记 `master-approved` 带日期）。裁决规则（ADR-0028 决策 2）：中立形状优先；能用通用手段表达的照样逐字节一致；需要通用能力的就加通用能力（如卡片行 `{ text, icon?: ImageRef }`），不许加 B 站专属枚举；B 站纯装饰去掉；剩下的差异进「批准的像素差清单」，预批三类（平台叫法中立化、内联 SVG 换成图库图的残差、B 站纯装饰去掉），每条写样例、变化、类别与依据 | 清单外的像素差。更新快照必须同时补清单 | 2 |

21b 的清单（按模块，施工时逐条补齐）：

- 规则：四个开关各一条假源作品；关键词、正则、白名单命中正文、视频标题、文章标题、转发原作品；被过滤的作品在历史里留一行 `filtered`；规则节按描述符露出；非人民币醒目留言的门槛、`custom` 会员体系、`minRank`、特别关注按 `viewer.id`。
- 卡片：五种片段、三种附加块、转发嵌套、文章配图、互动数缺几项；零出网；预览走 `fetchPreview`；按订阅的皮肤；会员卡 `custom` + `tier.icon` + 按档换色、非人民币醒目留言、词云与总结卡。
- 智能女仆：点评输入与过滤用同一个取段函数；看图从图库引用；六把中立工具按 `creator` 答得出；只装假源时内置技能可见可跑、依赖 B 站工具的隐藏、工具有中文标签、提示词里没有「B 站」「UP 主」；锐评平台列用 `descriptor.label`；假 `AiToolProvider` 能登记与撤销。
- 模板：`{postNoun}`、`{name}`、`{tier}`、`{fanclub}`、时长与粉丝变量；假源不亮「默认文案有更新」。

🔗 现状（3a-42，10-12）：上面清单各项在 3a 里的去处。**规则**：四个开关，关键词、正则、白名单命中正文 / 视频标题 / 文章标题 / 被转发的原作品，被过滤的作品在历史里留一行 `filtered`，已拍（P07）；规则节按描述符露出（N09），非人民币醒目留言门槛、`custom` 会员体系、`minRank`、特别关注按 `viewer.id`（N10）不开。**卡片**：五种片段、`card` 附加块、转发嵌套、互动数缺几项、零出网已拍（P06）；带封面的 `video` / `goods` 附加块与文章配图（N12）、预览走 `fetchPreview`（N05）、会员卡 `custom` 加 `tier.icon` 加按档换色与词云、总结卡（N11）不开。**智能女仆**：提示词里的作品叫法已拍（P10，缺省叫「作品」）；锐评平台列用 `descriptor.label` 由单元测试钉着（`stats/__tests__/roast-subject.test.ts`）；六把中立工具与技能可见性、假 `AiToolProvider` 登记与撤销（N06）、订阅视图里的平台名（N18）不开。**模板**：`{postNoun}`、`{tier}`、`{fanclub}`、时长与粉丝变量、默认文案有更新（N08）不开，作品模板今天只有 `{name}`。**清单里没有点到去处的**：按订阅的皮肤、点评输入与过滤用同一个取段函数、看图从图库引用 —— 今天既不在对拍 20 行里，也不在不开名单里，主会话定归 3b：看图从图库引用要等来源上下文有存图的口（同 N12），按订阅的皮肤与取段函数随 3b 的对拍补行。
- 事件与契约：`post-detected`、`live-session-changed`、`live-viewers-changed`（具名、带 `subscriptionId`）、`followers-refreshed`；WS 帧快照里没有 `uid`；面板不用认识假源的类型。
- 订阅、历史、统计、概览四个页面各自的清单施工时补。

### 其余守卫

1、4、10、11、12、21 与推送守卫①②③ 见上面三层。

| # | 守卫 |
| --- | --- |
| 2 | 测试进程对外请求一律失败（只放行本机地址）——施工第一片（第 0 期，见 [construction-plan.md](./construction-plan.md)）。已落：`scripts/network-guard.mjs`，挂在根配置的 `test.setupFiles`；拦在 `net.Socket#connect`（fetch、http、ws、WebSocket 都经过它），DNS 查询另拦（`lookup`、`lookupService`、`resolve*`、`reverse`，含 promises 与 `Resolver`；`lookup` 放行 IP 字面量），每条测试收尾查账，被测代码吞掉了报错也判失败。管不到：测试起的子进程（Chrome、脚本；Chrome 那一半由「出图器零联网」补）、在包目录里跑 `vp test`、本机代理转发 |
| 3 | 服务端除了持久化底层（`packages/storage`），不许直接写文件。按 import 认、不按调用名：从 fs 拿了写入口（writeFile、appendFile、rename、copyFile、cp、createWriteStream、truncate 及 Sync 版，带写标志的 open）就点名；mkdir、rm、unlink、link、symlink 不管（只动名字，留不下写了一半的内容）。底层要接住原子写 JSON、追加 JSONL、原子写二进制、整目录替换；没有白名单，config/persist.ts 那份保留注释的 YAML 也走 `atomicWriteFile`。已落：`apps/server/src/__tests__/disk-write-boundary.test.ts`，切片 ② 收尾时清零（迁移期间的待迁名单已删） |
| 5 | 面板里 `"/api/"` 字面量只许出现在 `services/` |
| 6 | 注释里写的仓内路径必须指向真实存在的文件 |
| 7 | 测试只放 `__tests__/`；文件名一律 kebab-case（biome `useFilenamingConvention`）。前半已落：`scripts/__tests__/test-file-layout.test.mjs`，全仓无例外（`scripts/` 也搬进了 `__tests__/`） |
| 8 | 服务关停返回以后，数据目录不再变化（端到端）。已落：`apps/server/src/__tests__/data-dir-still-after-close-e2e.test.ts`，按写入发出的时刻垫延迟（关停开始前在路上的慢），没被关停等到的写一定落在返回之后，每次都红、不靠运气 |
| 9 | 存储层拒收同一身份的第二条订阅，所有写入路径各一条测试。已落：`apps/server/src/__tests__/config-store-identity-unique.test.ts`（逐条写、整体替换、遗留的一对），新建路由两种来源各一条在 `routes/__tests__/subs-extension-create.test.ts`，恢复备份在 `backup-restore` 与 `backup-service` 两份测试里 |
| 13 | 迁移清单完整：以 FeatureKey / ExtraKey / CardKind / CardSkinKind 做键的记录全部钉进迁移清单（前半已落（⑬e）：清单 `apps/server/src/migration/keyed-records.ts`，测试 `migration/__tests__/keyed-records.test.ts`；判定函数在四个存盘的根（`GlobalConfig` / `Subscription` / `HistoryEntry` / `CardSkinManifest`）上找出用这几套词表做键（或当值）的位置，(a) 与清单两头核，(b) 清单上归设置 / 订阅那一族的每一条用冻住的 0.x 词表摆满旧键、跑一遍 1.0 步骤，断言出来的全是活键、旧键一个不剩，(c) 归后面某一片的条目（今天四条全归 ㉔：两处 `cardStyleByKind`、皮肤包的 `cards` / `variablesByKind`）逐条列出。词表是四套：特性键、附加项、卡种 `CardKind`、卡片皮肤的卡种 `CardSkinKind`（前者是后者的子集，两套今天各用各的）。新开一个存盘的仓要自己把它的 schema 加进根列表；消息版式与日志级别的键没有词表、不归这道守卫（版式键必填、漏迁开机即报错，日志级别随 3a 换成开放键））；对数据根的 `join(dataDir, …)` 前缀都必须在目录表里（后半已落：`apps/server/src/__tests__/data-roots.test.ts`，目录表在 `runtime/roots.ts`，登记代的布局；0.x 的布局在迁移模块里只作输入）。加固（随各项）：重推原件的每个载荷 kind（`forward-images`、`miniapp-card`）与字段（`picUrl`、`path`）都要有去向（3a-16 已落图集那一半：`migration/__tests__/repush-snapshot-payloads.test.ts`，冻住的 0.x 载荷种类表 `ZERO_PAYLOAD_KINDS` 每种造一份旧原件走整趟迁移、再用真的原件仓读回来；现行载荷或 0.x 表多一种没交代就编译不过，迁完读不回来或还留着 0.x 的名字就红；`miniapp-card` 登记为 3b 再改） |
| 14 | devtools 换桩表写死两项目录（`src/devtools`、`src/bilibili/devtools`，⛔ 不用通配），隔离测试认两个引用点。构建后自检不动。 |
| 15 | 桥协议的帧形状与通用 webhook 的 JSON 各一条快照守卫；webhook JSON 里的 `private` 写死 `false`（主人目标不可能是 webhook） |
| 16 | 改名收尾：每批改完旧名 grep 为零（桥协议、webhook、`bilibili/` 里 B 站原字段、卡片皮肤包清单的 `author`（指皮肤作者）进白名单） |
| 17 | 集成不读写文件：`bilibili/` 与 `platforms/`（内置平台适配器也是集成，ADR-0025 决策 1）里出现 `fs`、`node:fs`、`fs/promises` 的 import 就红 |
| 18 | 保留 id：`bilibili` 与内置平台适配器的键（`onebot`、`qq-official`、`webhook`）`ExtensionIdSchema` 拒收，同拒绝原型名的写法；另加 `core`、`image`、`ai`（核心自己的名字：日志等级的键，`core` 还是设置文件名），它们只在「拓展不许用的 id」那张表 `RESERVED_EXTENSION_IDS` 里，不进内置集成的键表 |
| 19 | 主人目标必须是私聊目标：`master.targetId` 指向群目标时 schema 校验不过；面板选主人的下拉只列私聊目标。加固（随各项，ADR-0024 决策 14）：PATCH 把主人目标改成群目标直接拒收；`notifyMaster` 发送时复检，不是私聊就拒发（`invalid`） |
| 20 | 拓展清单的 `supportedFeatures` 超出 1.0 开放范围（`post` / `liveStart` / `liveStreaming` / `liveEnd`），或声明 `liveStreaming` 却没实现 `fetchLiveStatus`，装载时拒收并说明原因 |
| 22 | 拓展不裸开定时器、不裸挂服务端：扫 `extensions/*/src`（不含测试），出现不经 ctx 的 `setTimeout` / `setInterval`、`createServer`、自己监听端口的 `WebSocketServer`（不带 `noServer`）就红；第三方拓展的打包产物不扫，库自己会用定时器（ADR-0012 决策 11） |

- 守卫 13 的清单 3a-22-2 加了一条：连接改成 `adapterKey` / `settings` / `platformSnapshot`、`testStatus` 两处都不带过来（修订号 40）。
- 推送侧另有两道数据守卫（ADR-0024 决策 9，3a）：改目标的 `connectionId` 时比新旧连接的平台；整节替换时校验连接身份没变。
- 守卫 17 在 3a（`bilibili/` 在 3a 才出现），守卫 18 的三个内置适配器的键已落（`RESERVED_INTEGRATION_KEYS`）；哪一期改了盘上形状，就在同一期往迁移模块加条目、钉进守卫 13 的清单。各道守卫哪期开、哪期清零，与 [construction-plan.md](./construction-plan.md)「中立性守卫的归期」对不上时以那边为准。

守卫 4 上线前要先清掉现有重名：`BootstrapConfigSchema` 两份（服务端 `config/schema.ts` 那份 `cookieEncryptionKey` 可选、至少 1 位；internal 那份必填且至少 16 位）合一并**按可选**（否则没设密钥的用户开不了机）；`SubscriptionsView` / `ConversationRole` 各两份处理掉（`CommentaryClient` 已在 3a-06 换成 ai 包的 `CommentaryProvider`；`SubscriptionsView` 两份形状不同，3a-25 改名）；`createDevtools` 的 stub 和零 import 文件里的 `isPlainObject` 进白名单并写明理由；`runtime/video-card.ts` 的 `formatDuration(seconds)` 改叫 `formatClock`。

## 明确不改的

- 产品名 bilibili-notify 与包作用域 `@bilibili-notify/*`。
- `bilibili/` 里贴着 B 站接口的原始字段名，以及 B 站内部的 `uid` / `roomId`。
- `bilibili/` 内部名实相符的名字（如 `biliLiveCardInput`）。原先还列了 `BiliSubscription`、`isBiliSubscription`、`BiliStatsSourceOptions`，已被 09-27 的身份摊平与改名取代：订阅不再分 B 站支，`isBiliSubscription` 删掉、按 `sourceKey` 判，统计适配器合成 `bindStatsRecorder`。
- **日志行格式**（`msg`、`ts` 等）：logs 跨代共享、冻住的桌面壳写死了目录。
- **通用 webhook 发出的 JSON**（`forward`、`ts` 等）：读它的是用户自己的接收端，永远不改；`private` 那一格写死 `false`。
- **桥协议的线上帧**（`forward`、`desc`、`picUrl`、能力名 `forward`、`miniAppCard`，载荷种类 `miniapp-card`，入站的 `miniAppCardLinks` 等）：alpha 期间不改，1.0.0 之前按两步改完（09-27 拍板，09-28 补上入站那一格）。已发布的插件在读，握手只比主版本，所以在那之前内部改名只改到桥的适配器。两步按方向分：BN 发出去的格，先发一版插件同时认新旧字段，等大家升上去 BN 再切；插件发进来的格（入站的 `miniAppCardLinks`）反过来，BN 先同时认新旧两种写法，插件再改发新的（ADR-0029 决策 2）。改完之后适配器里的新旧映射整个删掉；改成什么名字见 [construction-plan.md](./construction-plan.md)。
- 拓展契约里的毫秒时刻、签名清单的 `issuedAt`（秒）：已发出的格式，进门换 ISO。
- 已经拍板不动的：import 后缀两套并存；`FRAMES.live` 与 `FRAMES.wordcloud` 不合并；`skin.json` 与 `default.json` 双文件；锐评分数由模型打；`apps/contract` 放在 `apps/` 下。
- 全仓包版本统一 `0.0.0-dev` 是施工项、不是「不动」：现在只有 ui 与 `apps/*` 是 `0.0.0-dev`，其余包排在第 5 期统一（见 [construction-plan.md](./construction-plan.md)）。
- ⛔ 不做：extension 包版本对齐契约档位 + 守卫（兼容看清单 apiVersion 与 EXTENSION_API_RANGE，不看包版本）。
- ⛔ 不做：BN 侧替来源或适配器限流、去重（维持 ADR-0019 决策 53）；投递重试只在核心按目标做。
- alpha 不做、1.0.0 之前做（09-27 改，原定「1.0 之后」）：devtools 换 devframe、新手引导换 driver.js，各自先做小试验再定，见 [construction-plan.md](./construction-plan.md)。devframe 要先查清许可证和维护者，并重新验证 devtools 不会进生产产物；driver.js 要先验证引导锁（聚光灯外不能操作，⛔ 不许放开）、跨页面的步骤与晚挂上的锚点、能不能跟随界面皮肤。真正拦住拓展读写文件也不做（要等沙箱）。
