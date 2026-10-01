# 1.0 拓展契约 v3

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 ～ 0031。

写拓展的人读这份：清单里能声明什么、ctx 里能用什么、上报长什么样、有哪些规矩、从 v2 怎么过渡。中立接口全集见 [subscription-sources.md](./subscription-sources.md)；上报的数据形状对应 [data-model.md](./data-model.md) 的 `Post` / `LiveDetails`；拓展的平台适配器怎么进推送链见 [push.md](./push.md)。

## 一句话

**拓展只从 `@bilibili-notify/extension` 这一扇门拿 BN 的东西**，宿主把它交的东西转成和 B 站、内置平台同一组中立接口。契约是中立接口族的**子集**：1.0 开 `subscription`、`push`、`devtools` 三口；`activate(ctx)` 拿到它的 `IntegrationContext`（日志、`state`、`secrets`、`redact`、`settings`、`http`、`fetchImage`、`storeImage`、问题上报、`signal`、`onDispose`）加各登记方法。**拓展只认人、不认订阅**：上报只带 externalId，BN 内部的订阅 id 拓展看不到。**请求回结果，上报不回话**：存状态、存凭据、取图返回结果形状；上报一律 `void`，被拒记在宿主那边。

## 版本

| 项 | 1.0 |
| --- | --- |
| 契约版本 | v3 |
| 宿主认的最低版本 | 3 —— v1、v2 的退路删掉（`legacy-v1.ts` 连同过时注释一起删） |
| v2 拓展 | 装不上：按现成机制不加载、说清楚原因（「这个拓展是给旧契约写的，请更新」），不会加载后再炸；数据迁移时照拷，列进升级后的首访页，给一键更新 |
| 以后加口 | 清单里多一个可选键，不抬大版本 |

v3 与 v2 不兼容：ctx 改成 `IntegrationContext`，推送口改成平台适配器，上报从「被拒时 reject」改成 `void`。第三方拓展重发之前装不上 1.0。桥和 1.0 同批迁到 v3。

## 清单与 contributes

| `contributes` 键 | 宿主登进 | 1.0 |
| --- | --- | --- |
| `subscription` | `subscriptionSources`（键就是拓展 id，不加前缀） | 开 |
| `push` | 平台适配器登记表 `PlatformAdapterRegistry`（键就是拓展 id，也就是连接上的 `adapterKey`） | 开。与内置的 OneBot、QQ 官方机器人、webhook 同一个接口、同一张表 |
| `devtools` | `devtoolsProviders` | 开。独立入口文件，宿主只在开发版 `import()` 它 |
| `linkResolver` | `linkResolvers` | 暂不开，写抖音拓展时再定 |
| `commands` | —— | 暂不开。1.0 不造 `CommandProvider` 登记表：`login` 改成核心的通用指令后没有实现者；等第一个要自带指令的拓展，连同重名规矩一起定 |
| `aiTools` | `aiToolProviders` | 暂不开，写抖音拓展时再定 |

- 宿主启用拓展时以拓展 id 登进对应的表（`bilibili` 与三个内置平台适配器的键 `onebot`、`qq-official`、`webhook` 是保留 id，拓展不许用），撤销把手交给生命周期；停用、卸载即撤，不用重启。登记表的键类型叫 `IntegrationKey`，来源的 `SourceKey` 是它的一部分。
- 注册的口必须是清单开了的口；清单是面板能按哪些钮、能画哪些口的全集。
- 清单只装静态的描述（脸、叫法、设置字段）。推送侧能挑哪些平台不住清单，由运行期的连接候选给，所以新建连接要拓展在跑。
- 以后开 `linkResolver` 时：清单声明网址模式，拓展只拿到匹配上的那一个链接。
- 核心里 `linkResolvers`、`aiToolProviders` 两张表照做、B 站照用，只是先不对拓展开。

## ctx 能用的全部

`activate(ctx)` 拿到的 ctx 分三层：

1. **`IntegrationContext`**：每个集成（B 站、每个拓展、每个内置平台适配器）拿的都是这一种，下表逐个列。
2. **拓展特有的窄面**：v2 已有的照留 —— 可回收定时器、`mount`、`onUpgrade`、`publishView`、`statusChanged`、面板动作 `onAction`，以及 `id` / `hostApiVersion` / `hostVersion`。
3. **登记方法**：`registerSubscriptionSource`、`registerPlatformAdapter`（见各节）。

订阅侧特有的（名单、`report*`）属于 `SourceContext`，推送侧特有的（`inbound`、自己的连接等）属于 `PlatformAdapterContext`，都不在 `IntegrationContext` 里。这两份特有的和内置的一样，经所登记实现的 `start(ctx)` 递进来（def 里的 `start` 拿到的就是 `SourceContext` / `PlatformAdapterContext`）；登记交回的把手只管注销，不再像 v2 那样挂上报方法（ADR-0025 决策 1）。

⛔ **`bus` 永远不在 ctx 里**：拓展的事件由宿主转进 MessageBus，拓展伪造不了核心事件。

| `IntegrationContext` 成员 | 变化 | 规矩 |
| --- | --- | --- |
| `logger` | 改 | 拓展 id 写进日志行的 `name` 字段，不再拼进正文；面板按来源筛；级别键就是拓展 id，可单独调 |
| `state` | 新增 | `KeyValueStore`：游标、分页令牌、小索引。见「state 与 secrets」 |
| `secrets` | 新增 | 同一个 `KeyValueStore`：cookie、token。见「state 与 secrets」 |
| `redact(value)` | 新增 | 还没存进 `secrets` 的临时凭据（比如扫码刚拿到的 token）先登记，日志落盘前按值遮掉；存进 `secrets` 的值自动覆盖，不用再登记 |
| `settings(schema)` | 改 | 读取把手改名 `SettingsReader<T>`（`get` 与 `onChange`）；运行中的 `get()` 不抛。见「设置」 |
| `http` | 新增 | 集成自己的请求客户端，1.0 对拓展整套开放。见「ctx.http」 |
| `fetchImage(url, { headers?, signal? })` | 新增 | 返回结果形状。见「图」 |
| `storeImage(bytes, { signal? })` | 新增 | 返回结果形状。见「图」 |
| `reportProblem` / `resolveProblem` | 新增 | 返回 `void`；这一层的签名不带对象，关于哪个人、哪条连接由特有的那一层加。见「问题上报」 |
| `signal` | 新增 | 集成停下（停用、卸载、关停）时中止；手上的请求、轮询接着它停 |
| `onDispose(fn)` | 照留 | 收摊钩子，后注册的先跑 |

收尾的先后（ADR-0025 决策 5）：宿主先调来源或适配器自己的 `stop()`，收掉它自己的活；再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾，替它收掉经 ctx 拿到的东西（websocket、定时器）。

其余从 v2 来的变动：

| 成员 | 变化 | 规矩 |
| --- | --- | --- |
| `subscriptions()` / `onSubscriptionsChanged` | 改形状（`SourceContext` 特有） | 条目从 `{ id, externalId, enabled }` 改成 `SourceSubscriptionView { externalId, features }`：只列启用中的订阅、不带订阅 id，`features` 是这个人开着的特性；同一人遗留的重复订阅合成一条、`features` 取并集。拓展只上报名单里的人；开着哪些特性决定它干哪些活，关着的就不查 |
| `registerPushSource` / `PushSourceHandle` / `PushExtensionDef`（`adapter`、`configSchema`、`listBots`） | 改 | `registerPlatformAdapter` / `PlatformAdapterHandle` / `PlatformAdapterDef`，成员见「推送：平台适配器」 |
| `settings` 交回的 `ExtensionSettings<T>` | 改名 | `SettingsReader<T>` |
| `publishStatus`（v1 老口）、`LegacyPushExtensionDef` | 删 | 随 v1 退路一起删 |
| 积木 `qrLogin` | 删 | 从没实现；登录走系统账号（`SourceAuth`） |
| `ctx.dataDir` | 不给 | 撤回的草案；拓展没有自己的文件目录 |

ctx 各成员的完整语义与 B 站共用，见 [subscription-sources.md](./subscription-sources.md)「SourceContext」。

### state 与 secrets

两者是同一个接口，差别只在保管：

```ts
interface KeyValueStore {
  get<T extends Json>(key: string): T | undefined;   // 同步：宿主在 activate 之前读进内存
  set(key: string, value: Json): Promise<{ ok: true } | { ok: false; code: string; message: string }>;   // 宿主原子落盘
  delete(key: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}
```

| | `state` | `secrets` |
| --- | --- | --- |
| 放什么 | 游标、分页令牌、小索引 | cookie、token |
| 落盘 | 明文，`runtime/extensions/<id>/state.json` | 主密钥加密，一个集成一个文件 `secrets/extensions/<id>/secrets.enc` |
| 限额 | 单键 64KB、每个集成 1MB | 每个集成 256KB |
| 备份 | 不进 | 只进完整备份（普通备份抹掉） |
| 日志脱敏 | 不脱敏 | 值里的每一段字符串都按原文脱敏（很短的不遮） |
| 保留的键 | `http.` 开头的归宿主（`ctx.http` 的浏览器身份） | `http.` 开头的归宿主（`ctx.http` 的 cookie 罐） |
| 什么时候清 | 卸载、全新开始；跟数据代走 | 卸载、全新开始 |

- `set` / `delete` 不抛错：超上限或写了保留前缀回 `invalid`，磁盘写失败回 `unavailable`（码见 ADR-0026）。
- 代价：cookie 里不机密的值（比如登录账号的 uid）也会在日志里被遮掉。

### ctx.http

- **1.0 对拓展整套开放**：请求、`websocket(url, opts?)`、默认头、cookie 自动存、浏览器身份宿主自管。每个集成一个客户端，出自中立包 `packages/http`（从 B 站的实现里抽出来的，B 站用的是同一套）。
- **cookie** 由宿主自动存进该集成 `secrets` 的 `http.` 前缀；拓展自己写这个前缀回 `invalid`（`state` 同理）。
- **浏览器身份**生成一次、存进该集成 `state` 的 `http.` 前缀，重启照用；只在发版把版本区间前挪、存的低于下限时升级，只升不降。UA 与 `sec-ch-ua` 永远配套，没有自定义 UA。
- **`websocket`** 只负责用集成的身份建连、集成停下时自动关；帧、心跳、重连归拓展。
- **不加别的协议**：要 SSE 时给请求加「原样交出响应流」的选项；出站代理以后挂在这里。
- **不拦内网**（局域网里的 RSSHub 要连得上）；拦内网只在 `fetchImage` 上。
- **重试、退避、限流归拓展**，BN 不替它做。
- BN 自己的请求不走集成的客户端：客户端带着集成的身份与 cookie，BN 不该冒用。
- 施工时定：默认头怎么设。

### 图

```ts
fetchImage(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal })
  : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
storeImage(bytes: Uint8Array, opts?: { signal?: AbortSignal })
  : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
```

- **`fetchImage`** 走集成自己的客户端（同一套 cookie、身份与默认头）；平台要的请求头（Referer、签名）由拓展自己传。拦内网地址防 SSRF、单张 8MB、按内容嗅探格式、超时，这一层只在 `fetchImage` 上，每一跳重定向都查。按 sha256 存进图库。
- **`storeImage`** 给手里已是字节的图（本地生成的二维码、要自带客户端才抓得到的签名 / TLS 指纹 / POST 图、接口内嵌 base64）；同一套格式嗅探与单张 8MB，存进同一图库。
- 上报一律只收 `ImageRef`，上报里不再出现 `Uint8Array`。

| code | 什么时候 |
| --- | --- |
| `not_found` | 取图 404 |
| `invalid` | 超 8MB、不是图、内网地址 |
| `timeout` | 超时 |
| `unavailable` | 网络出错、上游 5xx |

抛错只留给 bug：宿主在边界接住，按 `unavailable` 处理并记错误日志。

## 不许读写文件

- **拓展不读写文件**：写进契约。状态走 `ctx.state`，凭据走 `ctx.secrets`，设置走 `ctx.settings`，请求走 `ctx.http`，图走 `fetchImage` / `storeImage`，上报里只交 `ImageRef`。
- **官方市场**发布时做静态检查：打包产物 import 了 `fs`（`fs`、`node:fs`、`fs/promises`）就不收。
- **手动安装**的第三方拓展，安装时警告。
- **真正的强制要等沙箱**：拓展与 BN 同进程，1.0 拦不住。以后用 SES 的 `lockdown` 加每个拓展一个 `Compartment`，先做兼容性小试验再定。

理由：宿主认不得的文件，拓展就得自己保证原子写、自己管备份与回收——宿主落盘的初衷（ADR-0012 决策 14）正是不让拓展背这些。1.0 把它延伸到运行状态。

## 订阅源

### 拓展这一侧交什么

宿主把拓展的订阅源转成一份 `SubscriptionSource`。注册口沿用 `registerSubscriptionSource(def: SubscriptionSourceDef): SubscriptionSourceHandle`，和推送侧的 `registerPlatformAdapter(def: PlatformAdapterDef): PlatformAdapterHandle` 一一对齐；下面是 def 里各成员与中立接口的对应。

| `SubscriptionSource` 成员 | 拓展这一侧 | 状态 |
| --- | --- | --- |
| `start(ctx)` / `stop()` | def 里的 `start` 拿到 `SourceContext`（名单与 `report*` 都在它上面）；`stop` 后不许再上报。收尾时宿主先调 `stop()`，再中止 `ctx.signal`、跑 `onDispose` | 定了 |
| `descriptor` | 清单 `contributes.subscription` 直接写 `SourceDescriptor` 的同名字段：`label`、`shortLabel?`、`color?`、`icon?`、`postNoun?`、`creatorNoun?`、`externalIdNoun?`、`searchAccepts?`、`featureHints?`、`supportedFeatures`（不收 `supportedExtras` 与 `membershipPrograms`，见下）；原来的 `display{ … }` 这一层与 `events` 删掉，宿主的 `SUBSCRIPTION_EVENT_FEATURES` 对照表删掉 | 定了 |
| `searchCreators` | 现有的解析门 `lookup(query, signal)` 改名，返回结果形状（失败不再靠抛）；`lookupPlaceholder` 删掉，改成声明式的 `searchAccepts`（提示句由核心拼）。候选 `{ externalId, name, avatar?: ImageRef, bio?, followers? }`（原 `{ id, avatar: data URL, fans }`），最多 10 个 | 定了（按 id 取人用 `fetchProfile`，没有 `lookupCreator`） |
| `fetchProfile` | 可选；不实现就靠主动报资料。返回结果形状：`not_found` 记成 `creator_not_found` 问题，其余当暂时失败；整轮要不要刹车由拓展自己定 | 宿主适配补齐 |
| `fetchLiveStatus`、`fetchPreview`、`health`、`auth` | 可选；`health()` 只交一行字 `{ summary }`，给健康卡与 `status` 指令 | 形状同中立接口 |
| `liveInteractions` | 不开 | 这版不开醒目留言、会员、特别弹幕、特别进场等事件 |

描述符里 09-28 新加的几格：

- `externalIdNoun?`：这个平台管外部 id 叫什么（B 站「UID」）。身份标签写「{externalIdNoun} {externalId}」，没声明就写「{label} · {externalId}」；「复制 UID」随之变成「复制 {externalIdNoun}」或「复制 ID」。
- `icon?`：平台图标，与推送侧 `PlatformDescriptor` 对齐。清单里没有图库，这一格在清单里怎么写，施工时定。
- `featureHints?`：唯一允许写自由文字的一格，覆盖特性开关下的小字。其余格只填词；描述符不装界面句子，句子由核心拼。
- 清单**不收** `membershipPrograms` 与 `supportedExtras`：1.0 拓展声明不了会员与直播互动类特性（见下，ADR-0021 决策 38），这两格填了也用不上。会员档位（含 `color?` / `announcement?`）这一格等开放会员类特性时再加。
- 拓展实现了哪些可选能力（`auth`、`fetchLiveStatus`、`fetchPreview`）由宿主推算、随 `/api/sources` 下发，不在清单里自报。
- 拓展卸载后遗留的订阅：平台名显示来源键、叫法用中性词、不露特性开关，卡上标「来源没装」。

没有「新建 / 启用订阅」钩子：拓展要在订阅变化时做事，一律用 `onSubscriptionsChanged`，自己对比新旧名单。

**能声明的特性**：1.0 拓展的 `supportedFeatures` 只能是 `post`、`liveStart`、`liveStreaming`、`liveEnd`；声明了 `liveStreaming` 就必须实现 `fetchLiveStatus`。宿主装载时校验，不合规就拒收并说明原因。

`signal` 的规矩照旧：超时（`TimeoutError`，宿主已回了面板「超时」）与拓展停用 / 收摊（`AbortError`）两种时候中止，手上的请求要接着它停。

### 上报

上报表就是 `Post` / `LiveDetails` 的上报版，**同义同名**；进门转成 `Post` 的收件口在服务端 `extensions/`。

附加块 `attachment` 这版不对拓展开：ADR-0021 决策 38 的开放清单没有它，v3 的上报 schema 也就没有这一格（照「多交一格宿主不认识的，整条拒」处理）。

和 v2 相比改名的字段：

| v2 | v3 |
| --- | --- |
| `author`（`SubscriptionAuthor`） | `creator`（`SubscriptionCreator`） |
| `video.plays` | `video.views` |
| `video.duration` | `video.durationSec` |
| 直播 `viewers`（此刻在线） | `currentViewers` |
| 直播状态 `live` | `isLive` |
| 资料 `fans` | `followers`；资料补 `bio` |
| 作品 `topics[]` | `topic` |
| 作品上的 `id` / `url` | 挪到 `PostReport` 信封上：`postId` / `url` |
| 表格积木 `count` | `showCount` |

正文：拓展必交纯文本 `text`，可选交片段列表 `richText`（09-27 拍板，推翻 09-26 精简时无声改成的「交完整片段」，也不是 Q3 原来的「只交纯文本」）。`text` 只放正文，标题、视频标题、转发的原作品各有自己的位置（ADR-0028 决策 1）。契约只开放五种片段：文字、@人、话题、链接、表情，是中立 `RichText` 的子集，宿主一对一转成中立片段；中立片段以后加种类不影响契约，开放新种类是一次明确的加宽。选片段不选「纯文本 + 位置」：各平台的位置单位互不兼容（Bluesky UTF-8 字节、Telegram / YouTube UTF-16、X 码点），片段让作者按自己平台的单位切，调研见施工记录。`text` 是用户在平台上看到的字，平台私有标记（小红书 `#x[话题]#`、Discord `<@id>`、X 的 `&amp;` 转义）由拓展剥掉。片段字段与中立 `RichText` 完全相同（见 data-model「正文片段」）：`mention` 的 `userId` 可选，`link` 带 `url` 与可选图标，图标和表情图都先用 `ctx.storeImage` / `ctx.fetchImage` 存成 `ImageRef`。

只留一处传输差异，在进门处换掉：

| 差异 | 拓展交 | 宿主换成 |
| --- | --- | --- |
| 时刻 | 毫秒时间戳 | ISO 字符串 |

图没有差异：和 B 站一样，先用 `ctx.fetchImage` / `ctx.storeImage` 存进图库，上报里只交 `ImageRef`。

上报方法与 `SourceContext` 同名同形，**一律返回 `void`**（v2 返回 Promise、被拒时 reject）：

| v2 的把手方法 | v3 | 进核心后 |
| --- | --- | --- |
| `reportPost(externalId, post)` | `reportPost(externalId, PostReport): void` | 核心按身份展开成每条订阅一份 `PostEvent` → `post-detected` |
| `reportLiveStart` / `reportLiveEnd` / `reportLiveStatus` | 合成 `reportLive(externalId, LiveSignalReport): void`（`start` / `status` / `end`） | 展开成 `LiveSignal`，喂场次引擎 |
| `reportProfile(externalId, profile)` | `reportProfile(externalId, CreatorProfileReport): void` | 资料缓存 |

上报种类（原 `SubscriptionReportKind` 五种）收成 `post` / `live` / `profile`。

**被拒不回话**：报了没声明的种类、外部 id 不合法、形状坏了，整条拒；认识的选填格值坏了只丢那一格。被拒与丢格都记进该拓展的 `reportRejections`（拓展详情页 `InstalledExtensionView` 上的那个框）并打 warn 日志，拓展自己不知道；报的人不在名单里照旧静默忽略。`reportRejections` 与拓展自报的问题是两张表。理由：被拒都是拓展自己的 bug，运行时改不了，回结果只会诱导它重报。

照旧不变的规矩：

- 判新、去重、限流归拓展；BN 报什么收什么。开机第一轮只记基线、别报。
- 按外部 id 报，`sourceKey` 由宿主按 ctx 补（拓展冒充不了别家）；核心按身份查订阅，正常一条，老数据里遗留的重复各分一份，查不到或已停用就丢弃，并兜底再查一次名单。停用的订阅收不到事件与直播状态，也不刷资料：资料缓存停在停用那一刻，重新启用后下一轮刷新（09-27 拍板，改掉 v2 的「资料照样生效」）。
- 多交一格宿主不认识的，整条拒；认识的选填格值坏了只丢那一格；丢了什么记进 `reportRejections` 与日志。
- 直播 `status` 不触发推送；开播卡 / 下播卡只由事件触发。周期「正在直播」由核心计时、调 `fetchLiveStatus`（见 [subscription-sources.md](./subscription-sources.md)「直播」）。
- 过滤（屏蔽转发 / 文章 / 图集 / 视频、关键词、正则）对拓展作品与 B 站一视同仁：看 `Post` 上有没有，不再只看文字。

### 问题上报

签名分层（ADR-0025 决策 11）：

```ts
// IntegrationContext（activate 拿到的）：不带对象
ctx.reportProblem({ code, message, notify?: boolean }): void;
ctx.resolveProblem({ code }): void;
// SourceContext（订阅源的 start 拿到的）在上面加 externalId?
ctx.reportProblem({ externalId?, code, message, notify? }): void;
ctx.resolveProblem({ externalId?, code }): void;
// PlatformAdapterContext（平台适配器的 start 拿到的）在上面加 connectionId?
ctx.reportProblem({ connectionId?, code, message, notify? }): void;
ctx.resolveProblem({ connectionId?, code }): void;
```

- 严重度、文案、要不要打扰主人都由拓展定：问题一律进面板问题框，`notify: true` 再私聊主人。
- 核心只守一条底线：同一报的人（`reporter`）、同一 code 的私聊 60 秒内只发一次。
- 每条问题核心自动记一行日志；只想记日志就用 `ctx.logger`。
- 问题表只有一种形状，**全在内存**：`Problem { reporter: IntegrationKey | "core", about?: { subscriptionId } | { connectionId }, code, message, since }`；同一个报的人、同一个对象、同一个 code 算一条。
    - 不带对象是拓展自己的问题（`about` 空着）；订阅源填了 `externalId`，由宿主换成那个人的订阅 id，订阅卡上说明为什么收不到。
    - 平台适配器报某条连接的问题带 `connectionId`，宿主核它是不是这个适配器的连接。同时提供订阅源与适配器的拓展，两边各从自己那份 ctx 报，`externalId` 与 `connectionId` 不会出现在同一个签名上。
    - 一条生死规矩：报的人 `resolveProblem` 按 code 清；报的人停下，它报的全清；对象删了，关于它的全清。
    - 不存盘：重启或停用再启用之后，还在的问题要拓展重报一遍（重启后的头几秒，订阅卡上的红字会先消失）。
- code 用 snake（`login_expired`）。

## 推送：平台适配器

- `registerPlatformAdapter(def: PlatformAdapterDef): PlatformAdapterHandle`。一个拓展一个适配器。
- 内置的 OneBot、QQ 官方机器人、webhook 也是平台适配器：同一个接口、同一张登记表。v2 的 `kind: "extension"` 那一支没有了，核心里也不再有 `CONNECTION_PLATFORMS` 这张平台表。
- `PlatformAdapterDef` 装适配器 + 描述 + `settingsSchema`。`PlatformAdapterDescriptor` 描述一个适配器（它的脸与设置字段），`PlatformDescriptor` 描述一个聊天平台（名字、目标形状、地址叫法）。

| 成员 | 必备？ | 这一版对拓展 | 要点 |
| --- | --- | --- | --- |
| `descriptor { label, shortLabel, color, icon, settingsFields }` | 是 | 开（条件显示与键值表字段不开） | 静态，写在清单 `contributes.push`，见下 |
| `settingsSchema` | 是 | 开 | 连接设置的 zod；与清单的 `settingsFields` 逐格对表（键、类型、默认值），对不上登记当场抛 |
| `start(ctx)` / `stop()` | 是 | 开 | 取代 `reconcile` / `dispose`；登记即 `start`，晚登记的也收得到 |
| `send` | 是 | 开 | 返回结果形状、带标准码；只有 `TargetDispatcher` 调它 |
| `isAvailable` | 是 | 开 | |
| `probe` | 是 | 开 | |
| `listConnectionCandidates(signal)` | 是 | 开 | 原 `listBots`，见「新建连接」 |
| `capabilities` / `probeCapabilities` | 否 | 开 | 新增 `atAll`、`inbound`；原先按平台名判断的改成问能力 |
| `listAddressCandidates(connection, signal)` | 否 | 不开 | alpha 之后桥帧改名时再看 |
| `connectionAuth` | 否 | 不开 | 与订阅侧同一个 `AuthState`，结果是一份连接草稿 |

对拍逐成员核：要么走通，要么在「不开」名单里写明理由。

**清单 `contributes.push`**：键名不变，装适配器的描述 —— 原来 `display` 里的 `label`、`shortLabel`、`color`，加上 `icon`；连接配置项 `connection.fields` 改叫 `settingsFields`。`display` 这一层要不要照订阅口摊平、`icon` 在清单里怎么写（清单里没有图库），施工时定。

### 新建连接

新建连接只有一条路：**挑一个候选，再填字段**。

```ts
interface ConnectionCandidate {
  name: string;
  platform: PlatformDescriptor;   // { platform, label, shortLabel, color, icon?, targetKind: "session" | "endpoint", scopes, addressNouns }
  settings: …;                    // 挑中后原样落进连接的 settings；模板候选填默认值
  selfId?: string;
  via?: string;                   // 经由谁借来的（桥：那条接入的名字）—— 两条桥各驮一个同名 bot 时分得开
  boundConnectionId?: string;     // 已经被哪条连接绑着 —— 面板标「已加过」
}
```

- `listConnectionCandidates` 必备：平台固定的拓展返回写死的模板候选，模板可以反复用；桥返回在线的 bot。
- **一条连接就是一个借来的 bot**：`platform` 是开放字符串，只来自挑中的候选。
- 原 `ExtensionBotView` 的对应：`config` → `settings`，`platform: string` → `platform: PlatformDescriptor`（`tint` 统一叫 `color`），`boundTo` → `boundConnectionId`，`name` 改必填；没有单独的 `icon`，平台图标在 `platform.icon`。

### 连接

- 形状 `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot, probeState? }`。
- `adapterKey` 由宿主按拓展 id 填，拓展自报的会被覆盖；分发按它走。`kind`、`connector`、`extensionId` 删掉（`extensionId` 并进 `adapterKey`）。
- `platformSnapshot` 只有宿主写（新建时照候选抄、列候选时按平台名刷新）：拓展停了、桥没连上时，面板照样画得出已有的连接。适配器不读它；快照变了不许触发重连。
- **连接设置的校验**：保存时适配器在场就按 `settingsSchema` 校验，不过回 400 并带原因；不在场先存下。读盘时逐条校验，不过的只隔离那一条（不交给适配器、不投递；面板显示「设置不合法」与原因，进问题框；盘上原文不动），BN 照常开机。
- 接入凭据（如桥的 token）住拓展自己的设置里，不是连接。

### 发送与入站

- **只有 `TargetDispatcher` 能发送**。适配器的 `send` 返回结果形状、失败带标准码（ADR-0026）；投递失败归核心：按目标逐个、只重试失败的那个，`rate_limited` / `unavailable` / `timeout` 退避重试，`indeterminate` 与其他码不重试。BN 不替适配器限流、去重。
- **入站经 `ctx.inbound`**：宿主核连接归属，平台取自连接，不由适配器自报（内置适配器同样）。

## 设置

- 清单里声明 `settings.fields`，`activate` 里交一份 zod，两份对不上当场抛。凭据字段标 `secret: true`（与核心 schema 同一写法），面板打码、备份脱敏、日志脱敏都读这个标记。
- 读取：`ctx.settings(schema)` 交回 `SettingsReader<T>`，`get()` 现读、`onChange(fn)` 在内容真的变了时叫。
- 值存在 `config/settings/extensions/<id>.json`，一个拓展一个文件；开关 `extensions.<id>.enabled` 归宿主，在 `config/settings/core.json` 里。
- **坏了只停这一个拓展，不挡开机**：拓展段校验不过，宿主只停这一个拓展，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起。运行状态：内置集成只取 `running` / `failed` / `settings-invalid`；拓展照 `ExtensionRunStatus` 的全部取值，外加 `settings-invalid`。面板、健康卡与 `status` 指令都读它。
- **只有 `activate` 期间读设置失败可以抛错中止启动**，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。
- 版本号是内容哈希，对不上回 409。
- 卸载删掉这一段。
- 拓展的设置只在拓展页；功能页面（推送目标的连接卡、订阅页）放指过去的入口。
- 连接的设置（`settingsFields` / `settingsSchema`）是另一回事，见「推送：平台适配器」。

## devtools

- 清单 `contributes.devtools` 指向一个独立入口文件，宿主只在开发版 `import()` 它，登进 `devtoolsProviders`。
- 入口交 `DevtoolsProvider { scenarios: DevScenarioDef[] }`；过线给面板的纯声明叫 `DevScenarioDescriptor`。
- **场景 id 由宿主加前缀**（`<拓展 id>.xxx`），不会撞名，也冒充不了别家。
- **参数按提供方收窄**：订阅源用 `creator` 种类（值是自己名单里的 `externalId`）；平台适配器只能挑自己的连接；`sub` / `target` 只给核心。
- **`run` 返回结果形状** `{ ok: true, summary? } | { ok: false, code, message }`：参数不合法回 `invalid`，场景找不到回 `not_found`；原来那两个异常类删掉。`active` / `reset` 不变。
- **场景只用自己集成的 ctx 做事**（造一条作品就调自己的 `reportPost`），核心的句柄不交出去。
- 核心 devtools 不认识任何一家来源。桥的假桥与场景搬进 `extensions/bridge/` 自己的开发入口，直接用桥自己的 `contract.ts`，不再在核心手抄协议帧。

## 从 v2 过渡

| 项 | 做法 |
| --- | --- |
| 市场挑版 `pickPerId` | 改成「在当前 BN 装得了的版本里取最高」 |
| 索引规则 | 从「每个 id 一条正式 + 一条预发布」放宽为「每个契约版本各留最新一条」，这样 0.12 仍拿得到 v2 的桥 |
| 桥 | 与 1.0 同批迁到 v3；1.0 alpha 期间 v3 的桥只进预发布档 |
| 已装的 v2 拓展 | 迁移时拷进新数据代；升级后第一次打开面板的询问页列出「因契约版本不收」的拓展，给一键更新；**不在开机时静默替换** |
| 桥协议线上帧 | alpha 期间不改，1.0.0 之前按两步改完；在那之前内部改名只改到桥的适配器，有快照守卫钉着。要改的见下面的两步改名清单 |
| 桥回执 `result` 帧的 `err` | 进门翻成 `{ code: "unknown", message }`：冻结格式说不清原因，不猜标准码 |

### 桥帧的两步改名清单（alpha 之后、1.0.0 之前）

已经发布的 koishi 与 AstrBot 插件在读写这些帧，握手只比对主版本号，所以分两步改，先后按方向定：

- **BN → 桥**：先发一版插件，同时认新旧两种字段；等大家都升级了，BN 再切过去。
- **桥 → BN**（群入站的 `miniAppCardLinks`）：反过来，BN 先同时认新旧两种写法，插件再改发新的（ADR-0029 决策 2）。
- 双向的 `forward` 两个方向各照上面那条走。

在那之前，由桥的适配器在两种叫法之间映射。

| 帧里的格 | 方向 | 内部已经叫 |
| --- | --- | --- |
| `message.kind: "forward-images"` | BN → 桥 | `"image-group"` |
| `forward`（`forward-images` 的合并转发开关、能力表的键） | 双向 | `mergeForward` |
| `miniapp-card` 的 `desc` / `picUrl` / `path` / `jumpUrl` | BN → 桥 | 原生分享中立描述的 `description` / `imageUrl` / `pagePath` / `webUrl` |
| 群入站的 `miniAppCardLinks` | 桥 → BN | 入站链接带来源标记（正文 / 普通卡 / 原生分享卡），规矩是「原生分享卡里的链接不回预览」 |

- 帧里改成什么名字列在 [construction-plan.md](./construction-plan.md)「alpha 之后、1.0.0 之前」。
- `listAddressCandidates` 对拓展开不开放，随这次一起看。

## 边界

- 拓展底下第三方随便用，我们自己的东西只准从 `@bilibili-notify/extension` 进；反方向核心不 import 拓展。两条都有扫目录的守卫。
- `@bilibili-notify/extension` 只放类型不放实现（拓展会被打成自包含 bundle）；列出来的就是契约的全部，加一格是一次明确的加宽决定。
