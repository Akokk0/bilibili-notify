# 1.0 拓展契约 v3

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 ～ 0031。

写拓展的人读这份：清单里能声明什么、ctx 里能用什么、上报长什么样、有哪些规矩、从 v2 怎么过渡。中立接口全集见 [subscription-sources.md](./subscription-sources.md)；上报的数据形状对应 [data-model.md](./data-model.md) 的 `Post` / `LiveDetails`；拓展的平台适配器怎么进推送链见 [push.md](./push.md)。

## 一句话

**拓展只从 `@bilibili-notify/extension` 这一扇门拿 BN 的东西**，宿主把它交的东西转成和 B 站、内置平台同一组中立接口。契约是中立接口族的**子集**：1.0 开 `subscription`、`push`、`devtools` 三口；`activate(ctx)` 拿到它的 `IntegrationContext`（日志、`state`、`secrets`、`redact`、`settings`、`http`、`fetchImage`、`storeImage`、问题上报、`signal`、`onDispose`）加各登记方法。**拓展只认人、不认订阅**：上报只带 externalId，BN 内部的订阅 id 拓展看不到。**请求回结果，上报不回话**：存状态、存凭据、取图返回结果形状；上报一律 `void`，被拒记在宿主那边。🔗 现状（3b-45，10-25）：`devtools` 只表示开发版可以来找固定入口，不算进 `provides`，也不算「至少开一口」；单开这一口的拓展在发行版里不做事。

## 版本

| 项 | 1.0 |
| --- | --- |
| 契约版本 | v3 |
| 宿主认的最低版本 | 3 —— v1、v2 的退路删掉（`legacy-v1.ts` 连同过时注释一起删）。🔗 现状（3b-03，10-13）：第 1 版的退路已删，第 1 版清单现在被判「版本太旧、不兼容」；最低版本眼下是 2，抬到 3 在 3b-44 🔗 现状（3b-44，10-25）：`EXTENSION_API_RANGE` 已是 `{ min: 3, current: 3 }`，第 1、2 版清单都判「版本太旧、不兼容」 |
| v2 拓展 | 装不上：按现成机制不加载、说清楚原因（「这个拓展是给旧契约写的，请更新」），不会加载后再炸；数据迁移时照拷，列进升级后的首访页，给一键更新 |
| 以后加口 | 清单里多一个可选键，不抬大版本 |

v3 与 v2 不兼容：ctx 改成 `IntegrationContext`，推送口改成平台适配器，上报从「被拒时 reject」改成 `void`。第三方拓展重发之前装不上 1.0。桥和 1.0 同批迁到 v3。

契约的改动逐片就地改：不留新旧并存的过渡；3b-38 新加的成员当场对拓展开。

## 清单与 contributes

| `contributes` 键 | 宿主登进 | 1.0 |
| --- | --- | --- |
| `subscription` | `subscriptionSources`（键就是拓展 id，不加前缀） | 开 |
| `push` | 平台适配器登记表 `PlatformAdapterRegistry`（键就是拓展 id，也就是连接上的 `adapterKey`） | 开。与内置的 OneBot、QQ 官方机器人、webhook 同一个接口、同一张表 |
| `devtools` | `devtoolsProviders` | 开。独立入口文件，宿主只在开发版 `import()` 它。🔗 现状（3b-45，10-25）：清单只写 `"devtools": {}` 开口，文件名固定为 `devtools.mjs`，不能指定路径；入口不进发行包，打包与装包两道白名单都拒收 |
| `linkResolver` | `linkResolvers` | 暂不开，写抖音拓展时再定 |
| `commands` | —— | 暂不开。1.0 不造 `CommandProvider` 登记表：`login` 改成核心的通用指令后没有实现者；等第一个要自带指令的拓展，连同重名规矩一起定 |
| `aiTools` | `aiToolProviders` | 暂不开，写抖音拓展时再定 |

- 宿主启用拓展时以拓展 id 登进对应的表（`bilibili`、三个内置平台适配器的键 `onebot`、`qq-official`、`webhook` 与 `core` 是保留 id，拓展不许用），撤销把手交给生命周期；停用、卸载即撤，不用重启。登记表的键类型叫 `IntegrationKey`，来源的 `SourceKey` 是它的一部分。
- 注册的口必须是清单开了的口；清单是面板能按哪些钮、能画哪些口的全集。
- 清单只装静态的描述（脸、叫法、设置字段）。推送侧能挑哪些平台不住清单，由运行期的连接候选给，所以新建连接要拓展在跑。
- 以后开 `linkResolver` 时：清单声明网址模式，拓展只拿到匹配上的那一个链接。
- 核心里 `linkResolvers`、`aiToolProviders` 两张表照做、B 站照用，只是先不对拓展开。

## ctx 能用的全部

`activate(ctx)` 拿到的 ctx 分三层：

1. **`IntegrationContext`**：每个集成（B 站、每个拓展、每个内置平台适配器）拿的都是这一种，下表逐个列。
2. **拓展特有的窄面**：v2 已有的照留 —— 可回收定时器、`mount`、`onUpgrade`、`publishView`、`statusChanged`、面板动作 `onAction`，以及 `id` / `hostApiVersion` / `hostVersion`；1.0 新加 `i18n`（`ExtensionI18n`，见「译文与 `ctx.i18n`」）。
3. **登记方法**：`registerSource`、`registerPlatformAdapter`（见各节）。

订阅侧特有的（名单、`report*`）属于 `ExtensionSourceContext`，推送侧特有的（`inbound`、自己的连接等）属于 `PlatformAdapterContext`，都不在 `IntegrationContext` 里。这两份特有的和内置的一样，经所登记实现的 `start(ctx)` 递进来（def 里的 `start` 拿到的就是 `ExtensionSourceContext` / `PlatformAdapterContext`）；登记交回的把手只管注销，不再像 v2 那样挂上报方法（ADR-0025 决策 1）。

⛔ **`bus` 永远不在 ctx 里**：拓展的事件由宿主转进 MessageBus，拓展伪造不了核心事件。

| `IntegrationContext` 成员 | 变化 | 规矩 |
| --- | --- | --- |
| `logger` | 改 | 拓展 id 写进日志行的 `name` 字段，不再拼进正文；面板按来源筛；级别键就是拓展 id，可单独调 |
| `state` | 新增 | `KeyValueStore`：游标、分页令牌、小索引。见「state 与 secrets」 |
| `secrets` | 新增 | 同一个 `KeyValueStore`：cookie、token。见「state 与 secrets」 |
| `redact(value)` | 新增 | 还没存进 `secrets` 的临时凭据（比如扫码刚拿到的 token）先登记，日志落盘前按值遮掉。**一次登记一个，只增不减，直到集成停下**（宿主在收摊的最后撤掉；连续登记不会互相冲掉，停下之后再登记不生效，空串与不是字符串的忽略）。存进 `secrets` 的值、cookie 罐里的每条 cookie 一到就自动登记，不用再登记；设置里标了机密的格（清单 `secret` / `generate`）宿主也自动登记，同样不用调。日志按值打码：核心里写死 B 站 cookie 名的正则删掉，只留 AI 服务商密钥的 `sk-`、`Bearer` 两条；少于 8 个字符的值不遮；登录账号自己的 uid 照遮、不豁免 |
| `settings(schema)` | 改 | 交回的读取把手与内置集成是同一个 `SettingsReader<T>`（`get` 与 `onChange`），`get()` 回结果形状、不抛，拓展不再有自己的一份读取把手。见「设置」 |
| `http` | 新增 | 集成自己的请求客户端，1.0 对拓展整套开放。见「ctx.http」 |
| `fetchImage(url, { headers?, signal? })` | 新增 | 返回结果形状。见「图」 |
| `storeImage(bytes, { signal? })` | 新增 | 返回结果形状。见「图」 |
| `reportProblem` / `resolveProblem` | 新增 | 返回 `void`；这一层的签名是 `{ code, message, notify?, recoveryMessage? }` / `{ code, notify? }`，关于哪个人、哪条连接由特有的那一层加一格。见「问题上报」（3a-30 的现状注记在那一节末尾：今天只造在内置来源的 `SourceContext` 上，拓展还没有） |
| `signal` | 新增 | 集成停下（停用、卸载、关停）时中止；手上的请求、轮询接着它停 |
| `onDispose(fn)` | 照留 | 收摊钩子，后注册的先跑 |

收尾的先后（ADR-0025 决策 5）：宿主先调来源或适配器自己的 `stop()`，收掉它自己的活；再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾，替它收掉经 ctx 拿到的东西（websocket、定时器）。

其余从 v2 来的变动：

| 成员 | 变化 | 规矩 |
| --- | --- | --- |
| `subscriptions()` / `onSubscriptionsChanged` | 改形状（`ExtensionSourceContext` 特有） | 条目从 `{ id, externalId, enabled }` 改成 `SourceSubscriptionView { externalId, features }`：只列启用中的订阅、不带订阅 id，`features` 是这个人开着的特性；同一人遗留的重复订阅合成一条、`features` 取并集。拓展只上报名单里的人；开着哪些特性决定它干哪些活，关着的就不查 |
| `registerPushSource` / `PushSourceHandle` / `PushExtensionDef`（`adapter`、`configSchema`、`listBots`） | 改 | `registerPlatformAdapter` / `PlatformAdapterHandle` / `PlatformAdapterDef`，成员见「推送：平台适配器」 🔗 现状（3b-44，10-25）：三个新名已落；`PlatformAdapterDef` 已摊平、自带 `settingsSchema`，`PlatformAdapterHandle` 只剩 `dispose()` |
| `settings` 交回的 `ExtensionSettings<T>`（`get(): T \| undefined`） | 并成一个 | 删掉，与内置集成共用 `SettingsReader<T>`（`get()` 回 `Result<{ settings: T }>`、不抛）。读不懂的拓展仍不起（ADR-0019 决策 36 不变） |
| `publishStatus`（v1 老口）、`LegacyPushExtensionDef` | 删 | 随 v1 退路一起删。🔗 现状（3b-03，10-13）：`publishStatus` 与 `LegacyPushExtensionDef` 已随第 1 版删掉 |
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
  batch(ops: readonly KeyValueOp[]): Promise<{ ok: true } | { ok: false; code: string; message: string }>;   // 一批改动一起成或一起不成
}

type KeyValueOp =                  // batch 的一步；判别键叫 kind，取值就是方法名
  | { kind: "set"; key: string; value: Json }
  | { kind: "delete"; key: string };
```

| | `state` | `secrets` |
| --- | --- | --- |
| 放什么 | 游标、分页令牌、小索引 | cookie、token。**只放凭据**：`secrets` 里的每一段字符串（不分是不是真机密）都会在整个进程的日志里被遮成 `***`，核心和别的集成的日志也一样；存了普通词（比如平台名、主机名），日志里的同名字样就都被抹掉 |
| 落盘 | 明文，`runtime/extensions/<id>/state.json` | 主密钥加密，一个集成一个文件 `secrets/extensions/<id>/secrets.enc` |
| 限额 | 单键 64KB、每个集成 1MB | 每个集成 256KB |
| 备份 | 不进 | 只进完整备份（普通备份抹掉） |
| 日志脱敏 | 不脱敏 | 值里的每一段字符串都按原文脱敏（很短的不遮） |
| 保留的键 | `http.` 开头的归宿主（`ctx.http` 的浏览器身份） | `http.` 开头的归宿主（`ctx.http` 的 cookie 罐） |
| 什么时候清 | 卸载、全新开始；跟数据代走 | 卸载、全新开始 |

- `set` / `delete` / `batch` 不抛错：超上限、写了保留前缀、值不是 JSON 回 `invalid`，磁盘写失败回 `unavailable`（码见 ADR-0026）。
- `batch` 保证一起成或一起不成：先整批校验（任何一步不合规矩，整批回 `invalid`、一步都不做），再按顺序应用、一次原子写落盘；同一个键出现几次，后面的盖前面的；空批直接回成功。要同时改几个键、不想落成「只改了一半」时用它。
- 读得到的永远是落了盘的：`await` 回来之前 `get` 还是旧值。文件在但读不了（权限、IO）时，这个集成的这一份读一律空、写一律回 `unavailable`，盘上原文件不动。
- 代价：cookie 里不机密的值（比如登录账号的 uid）也会在日志里被遮掉。

### ctx.http

- **1.0 对拓展整套开放**：请求、`websocket(url, opts?)`、cookie 自动存、浏览器身份宿主自管。每个集成一个客户端，出自中立包 `packages/http`（从 B 站的实现里抽出来的，B 站用的是同一套）。
- **cookie** 由宿主自动存进该集成 `secrets` 的 `http.` 前缀；拓展自己写这个前缀回 `invalid`（`state` 同理）。
- **浏览器身份**生成一次、存进该集成 `state` 的 `http.` 前缀，重启照用；只在发版把版本区间前挪、存的低于下限时升级，只升不降。UA 与 `sec-ch-ua` 永远配套，没有自定义 UA。
- **`websocket`** 只负责用集成的身份建连、集成停下时自动关；能发文本帧、能读连接状态；帧、心跳、重连归拓展。给错地址（地址不合法、协议不收）回结果形状 `invalid`，不再同步抛（`failure-results.md` 第 8 条）。
- **请求体**除原有的几种外收 `FormData`：每一跳由运行时现序列化，307 / 308 原样重发、303 降 GET 丢体；boundary 由运行时补，调用方别写 `Content-Type`。`FormData` 不能和 `addressCheck` 同用（那条路不认全局的 `FormData`），回 `invalid`。
- **跨源重定向剥凭据头**：重定向那一跳的协议、主机、端口任一与起点不同，调用方给的 `authorization`、`proxy-authorization`、`cookie`（含客户端默认头里的）这一跳起不再带，绕回起点也不补回来，与 fetch 规范一致；别的头照发。罐子按目标现取的 `Cookie` 不受影响。
- **单次请求可选「不带浏览器身份、不碰 cookie 罐」那一档**：`fetch` 与 `websocket` 的选项里写 `bare: true`。这一档不补身份那四样、不带客户端的默认头、不带 `Cookie`、不收 `Set-Cookie`（重定向的每一跳也一样），调用方这一次自己写的头照发。内置三个适配器全用这一档，拓展的适配器调官方接口也用它。
- **包之间不成环**：请求客户端对外的接口类型住核心包，实现留在 `packages/http`。
- **cookie 罐那组口第 3 版不对拓展开**：B 站照旧由宿主单独递它那份把手；以后有真实现者（比如要扫码登录的拓展）再加宽。罐子按公共后缀表（引 `tldts`，`packages/http` 加运行时依赖，加完走装配自检）拒 `Domain=com`、`com.cn`、`co.uk` 这类。
- **不加别的协议**：要 SSE 时给请求加「原样交出响应流」的选项；出站代理以后挂在这里。
- **不拦内网**（局域网里的 RSSHub 要连得上）；拦内网只在 `fetchImage` 上。
- **重试、退避、限流归拓展**，BN 不替它做。
- BN 自己的请求不走集成的客户端：客户端带着集成的身份与 cookie，BN 不该冒用。
- 默认头：B 站（3a-26 已落）是在建上下文时按身份交一个函数、给出一张头表（头里要用身份的值，头序也归集成定）。给拓展的不开「默认请求头」的口，拓展每次请求自己带头。

🔗 现状（3b-39 落成，2026-10-19）：上面的客户端已接到每个集成（B 站、三个内置适配器、每个拓展、对拍假来源）的上下文上，共用的开集成函数叫 `openIntegration`，一个集成一个客户端，身份存它自己的 `state`、罐子存它自己的 `secrets`。`websocket()` 回 `Result<{ socket }>`；`WebSocketLike` 能发文本帧（字符串即文本帧）、读 `readyState`（WHATWG 0–3）；错地址回 `invalid`。`bare: true`、`FormData`、跨源剥凭据头与公共后缀（含私有段）都已落成；`HttpResponse` 没有 `statusText`，内置适配器按 `node:http` 的 `STATUS_CODES` 补。

### 图

```ts
fetchImage(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal })
  : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
storeImage(bytes: Uint8Array, opts?: { signal?: AbortSignal })
  : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
```

- **`fetchImage`** 走集成自己的客户端（同一套 cookie 与身份）；平台要的请求头（Referer、签名）由拓展自己传。拦内网地址防 SSRF、单张 8MB、按内容嗅探格式、超时，这一层只在 `fetchImage` 上，每一跳重定向都查。按 sha256 存进图库。
- **`storeImage`** 给手里已是字节的图（本地生成的二维码、要自带客户端才抓得到的签名 / TLS 指纹 / POST 图、接口内嵌 base64）；同一套格式嗅探与单张 8MB，存进同一图库。
- 上报一律只收 `ImageRef`，上报里不再出现 `Uint8Array`。
- **集成抓的图算「在途」**：ctx 上的 `fetchImage` / `storeImage` 一个集成一个写口，挂在一家名单恒空的「在途」引用方下；图活不活看引用落在哪（上报进历史 / 重推、资料缓存、在播表、登录状态、来源描述）。**只攥在集成自己手里、没交给宿主的引用，过了 24 小时宽限期不保。**「来源声明的图」的名单改成宿主从在册来源的描述里现算；B 站徽章的保活施工时另设计。

| code | 什么时候 |
| --- | --- |
| `not_found` | 取图 404 |
| `unauthorized` | 401 / 403 |
| `rate_limited` | 429 |
| `invalid` | 超 8MB、不是图、内网地址 |
| `timeout` | 超时 |
| `unavailable` | 网络出错、上游 5xx |
| `indeterminate` | 调用方中止 |

抓图失败的码共七个，以代码为准。

🔗 现状（3b-39 落成，2026-10-19）：`fetchImage` / `storeImage` 已挂到每个集成的上下文上，底下的客户端就是该集成的 `ctx.http`；写口是图库「集成在途」那一家（`IMAGE_REFERRERS.inTransit`，运行时叫 `AppRuntime.transitImages`），名单恒空、靠 24 小时宽限期活到被引用；B 站来源与直播引擎已改读上下文的 `fetchImage`，账号头像、订阅资料头像、卡片真实预览、旧搜人、大航海徽章五处仍走旧路。

抛错只留给 bug：宿主在边界接住，按 `unavailable` 处理并记错误日志。

## 不许读写文件

- **拓展不读写文件**：写进契约。状态走 `ctx.state`，凭据走 `ctx.secrets`，设置走 `ctx.settings`，请求走 `ctx.http`，图走 `fetchImage` / `storeImage`，上报里只交 `ImageRef`。
- **官方市场**发布时做静态检查：打包产物 import 了 `fs`（`fs`、`node:fs`、`fs/promises`）就不收。
- **手动安装**的第三方拓展，安装时警告。
- **真正的强制要等沙箱**：拓展与 BN 同进程，1.0 拦不住。以后用 SES 的 `lockdown` 加每个拓展一个 `Compartment`，先做兼容性小试验再定。

理由：宿主认不得的文件，拓展就得自己保证原子写、自己管备份与回收——宿主落盘的初衷（ADR-0012 决策 14）正是不让拓展背这些。1.0 把它延伸到运行状态。

## 订阅源

### 拓展这一侧交什么

宿主把拓展的订阅源转成一份 `Source`。注册口沿用 `registerSource(def: SourceDef): SourceHandle`，和推送侧的 `registerPlatformAdapter(def: PlatformAdapterDef): PlatformAdapterHandle` 一一对齐；下面是 def 里各成员与中立接口的对应。🔗 现状（3b-42，10-24）：已落成 `registerSource` / `SourceDef` / `SourceHandle { dispose }`；`ctx.registerSource` 同步交回把手，登记在后台异步完成，装载器等 `start` 落定，`start` 抛了就是这次加载失败。推送口的改名在 3b-44，两侧名字到那时才对称。🔗 现状（3b-44，10-25）：推送口的新名已落，两侧的 def 与只带 `dispose()` 的把手已对称。

| `Source` 成员 | 拓展这一侧 | 状态 |
| --- | --- | --- |
| `start(ctx)` / `stop()` | def 里的 `start` 拿到 `ExtensionSourceContext`（名单与 `report*` 都在它上面）；`stop` 后不许再上报。收尾时宿主先调 `stop()`，再中止 `ctx.signal`、跑 `onDispose` | 定了 |
| `descriptor` | 清单 `contributes.subscription` 直接写 `SourceDescriptor` 的同名字段：`label`、`shortLabel?`、`color?`、`icon?`、`postNoun?`、`creatorNoun?`、`externalIdNoun?`、`searchAccepts?`、`featureHints?`、`supportedFeatures`（不收 `supportedExtras` 与 `membershipPrograms`，见下）；原来的 `display{ … }` 这一层与 `events` 删掉，宿主的 `SUBSCRIPTION_EVENT_FEATURES` 对照表删掉 | 定了<br>🔗 现状（3b-44，10-25）：订阅段已摊平，清单与视图已收 `supportedFeatures`、`searchAccepts`、`creatorNoun`、`icon`；`featureHints` 按主人 10-25 定随第 4 期读者一起收<br>🔗 现状（4-12，10-27）：`SourceDescriptor` 已补齐清单收的这几格，拓展的描述符就是清单订阅段（去掉 `cardSkin`），停着的拓展也经 `GET /api/sources` 照清单下发；`featureHints` 的读者是规则页按描述符露节那一片，清单与描述符都到那时再加（主人 10-27 定） |
| `searchCreators` | 现有的解析门 `lookup(query, signal)` 改名，返回结果形状（失败不再靠抛）；`lookupPlaceholder` 删掉，改成声明式的 `searchAccepts`（提示句由核心拼）。候选 `{ externalId, name, avatar?: ImageRef, bio?, followers? }`（原 `{ id, avatar: data URL, fans }`），最多 10 个 | 定了（按 id 取人用 `fetchProfile`，没有 `lookupCreator`）<br>🔗 现状（3b-42，10-24）：面板 `GET /api/ext/:id/lookup` 已改经引擎的 `searchCreators`，与取资料、查直播状态共用同一来源的串行闸；回应是 `CreatorCandidateView`，头像读回 data URL，路径不改名（N01 第 4 期）。拓展没实现 `fetchProfile` 时宿主补一个回 `unsupported` 的<br>🔗 现状（3b-44，10-25）：`lookupPlaceholder` 已删，`searchAccepts` 已随清单与视图下发；拓展支先统一用 `GENERIC_LOOKUP_PLACEHOLDER`，按它拼提示句的叫法函数随第 4 期 |
| `fetchProfile` | 可选；不实现就靠主动报资料。返回结果形状：`not_found` 记成 `creator_not_found` 问题，其余当暂时失败；整轮要不要刹车由拓展自己定 | 宿主适配补齐 |
| `fetchLiveStatus`、`fetchPreview`、`health`、`auth` | 可选；`health()` 只交一行字 `{ summary }`，给健康卡与 `status` 指令 | 形状同中立接口<br>🔗 现状（3b-42，10-24）：主人 10-24 定 `auth` 这一版不对拓展开（类型排除、运行时带了也不认），等第一个要登录的拓展；`health()` 当外来数据收：只收同步对象的字符串 `summary`，空白收成一行，按 `SOURCE_HEALTH_SUMMARY_MAX_CHARS`（120）截断且不劈代理对，坏了就显示「状态读不到」，同一原因只 warn 一次<br>🔗 现状（3b-50）：`fetchLiveStatus` 拉回的形状与上报同一套规矩：多一格 / 必填坏了回 `invalid`，选填坏了丢那一格并记进「上报出入」 |
| `liveInteractions` | 不开 | 这版不开醒目留言、会员、特别弹幕、特别进场等事件 |

🔗 现状（3b-46，10-25）：守卫 21a 已落在 `apps/server/src/__tests__/extension-contract-parity-e2e.test.ts`，用仓里的假源拓展逐成员走 `SourceDef`（成员表 `apps/server/src/extensions/extension-source.ts` 的 `SOURCE_DEF_MEMBERS`）与清单订阅段每一格。

描述符里 09-28 新加的几格：

- `externalIdNoun?`：这个平台管外部 id 叫什么（B 站「UID」）。身份标签写「{externalIdNoun} {externalId}」，没声明就写「{label} · {externalId}」；「复制 UID」随之变成「复制 {externalIdNoun}」或「复制 ID」。🔗 10-23（3b-24）：宿主已认这一格并用于服务端显示；拓展清单仍不收。🔗 10-23（主人定）：清单收这一格随 3b-42 一起做。🔗 现状（3b-42，10-24）：拓展清单已收这一格，与 `postNoun` 同尺子；`postNoun` / `externalIdNoun` 纯空白都拒。
- `icon?`：平台图标，与推送侧 `PlatformDescriptor` 对齐。清单里没有图库，这一格在清单里怎么写，施工时定。🔗 现状（3b-44，10-25）：清单里写图片 data URL，判据与设置项选项图标相同（`EXTENSION_IMAGE_DATA_URL_RE` / `EXTENSION_IMAGE_MAX_CHARS`），不可译；面板本片不读
- `externalIdRegex?`（10-15 主人定，3b-58）：外部 id 长什么样，写正则的源码字符串，宿主按整串匹配，核新建订阅的外部 id 与特别关注名单的 id。可以不写（只做中立校验）。写在清单订阅源那一段的 `display` 里（与 `postNoun` 同处）。编译不过（或疑似灾难性回溯）的正则让清单校验不过、拓展装不上；正则源码最长 200 字（同内容过滤的 `blockRegex`），被核的值最长 256 字（同外部 id 本身的上限）。
- `creatorNoun` 与 contract 里的叫法函数 3b 造（面板上的叫法仍第 4 期）。🔗 现状（3b-35，10-24）：描述符的 `creatorNoun` 与叫法函数已落，清单收 `creatorNoun` 仍随清单那几片。
- `searchCreators` 3b 造、B 站实现、只给 AI 的搜人工具用；`GET /api/sources/:sourceKey/creators` 与面板仍第 4 期。
- `featureHints?`：唯一允许写自由文字的一格，覆盖特性开关下的小字。其余格只填词；描述符不装界面句子，句子由核心拼。
- 清单**不收** `membershipPrograms` 与 `supportedExtras`：1.0 拓展声明不了会员与直播互动类特性（见下，ADR-0021 决策 38），这两格填了也用不上。会员档位（含 `color?` / `announcement?`）这一格等开放会员类特性时再加。
- 拓展实现了哪些可选能力（`auth`、`fetchLiveStatus`、`fetchPreview`）由宿主推算、随 `/api/sources` 下发，不在清单里自报。
- 拓展卸载后遗留的订阅：平台名显示来源键、叫法用中性词、不露特性开关，卡上标「来源没装」。

没有「新建 / 启用订阅」钩子：拓展要在订阅变化时做事，一律用 `onSubscriptionsChanged`，自己对比新旧名单。

**能声明的特性**：1.0 拓展的 `supportedFeatures` 只能是 `post`、`liveStart`、`liveStreaming`、`liveEnd`；声明了 `liveStreaming` 就必须实现 `fetchLiveStatus`。宿主装载时校验，不合规就拒收并说明原因。🔗 现状（3b-42，10-24）：清单 v2 先按 `events` 推出周期直播，声明了却没实现 `fetchLiveStatus` 就在登记时拒、这次加载失败；推送侧的周期计时与 `skipped` 出入已删（主人 10-24 R3）；3b-44 换读 `supportedFeatures`。🔗 现状（3b-44，10-25）：清单已换读 `supportedFeatures`，声明 `liveStreaming` 必须同时声明开播与下播；没声明 `liveStreaming` 的不再有周期直播。

`signal` 的规矩照旧：超时（`TimeoutError`，宿主已回了面板「超时」）与拓展停用 / 收摊（`AbortError`）两种时候中止，手上的请求要接着它停。

### 上报

上报表是核心 `Post` / `LiveDetails` 的窄化推导：`ExtensionPostReport` / `ExtensionLiveDetails`；进门转成 `Post` 的收件口在服务端 `extensions/`。🔗 现状（3b-42，10-24）：第 3 版上报已落。拓展这一侧的 `ExtensionSourceContext` 从核心 `SourceContext` 白名单挑成员，只替换作品与直播两种上报的参数，`reportLiveInteraction` / `registerLinkResolver` / `registerAiToolProvider` 不开放；进门 zod 在 `packages/internal/src/schema/extension-report.ts`。外来数据只在 `extensions/extension-source.ts` 的 `createExtensionSource` 收：外部 id → 清单声明的种类 → 形状；图库引用读回字节补宽高与动图标记；作者缺名按资料名 → 身份标签补；下播缺 `endedAt` 取到达时刻；每个来源一条串行队，置停后队里还没交的丢、记 debug。视频作品不再由宿主写「投稿了视频」（主人 10-24）。🔗 现状（3b-49，10-25 主人改判；原为整数毫秒）：上报时刻已改成带时区的 ISO，和核心一样；宿主进门只统一成 UTC。

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
| 作品上的 `id` / `url` | 挪到 `ExtensionPostReport` 信封上：`postId` / `url` |
| 表格积木 `count` | `showCount` |

正文：拓展必交纯文本 `text`，可选交片段列表 `richText`（09-27 拍板，推翻 09-26 精简时无声改成的「交完整片段」，也不是 Q3 原来的「只交纯文本」）。`text` 只放正文，标题、视频标题、转发的原作品各有自己的位置（ADR-0028 决策 1）。契约只开放五种片段：文字、@人、话题、链接、表情，是中立 `RichText` 的子集，宿主一对一转成中立片段；中立片段以后加种类不影响契约，开放新种类是一次明确的加宽。选片段不选「纯文本 + 位置」：各平台的位置单位互不兼容（Bluesky UTF-8 字节、Telegram / YouTube UTF-16、X 码点），片段让作者按自己平台的单位切，调研见施工记录。`text` 是用户在平台上看到的字，平台私有标记（小红书 `#x[话题]#`、Discord `<@id>`、X 的 `&amp;` 转义）由拓展剥掉。片段字段与中立 `RichText` 完全相同（见 data-model「正文片段」）：`mention` 的 `externalId` 可选，`link` 带 `url` 与可选图标，图标和表情图都先用 `ctx.storeImage` / `ctx.fetchImage` 存成 `ImageRef`。

时刻与核心同为带时区的 ISO，进门只统一 UTC（3b-49，10-25 主人改判；原为拓展交整数毫秒、进门换 ISO）：

| 处理 | 拓展交 | 宿主换成 |
| --- | --- | --- |
| 时刻 | 带时区的 ISO 8601 | `Z` 结尾的 UTC ISO |

图没有差异：和 B 站一样，先用 `ctx.fetchImage` / `ctx.storeImage` 存进图库，上报里只交 `ImageRef`。

上报方法在 `ExtensionSourceContext` 上，**一律返回 `void`**（v2 返回 Promise、被拒时 reject）：

| v2 的把手方法 | v3 | 进核心后 |
| --- | --- | --- |
| `reportPost(externalId, post)` | `reportPost(externalId, ExtensionPostReport): void` | 核心按身份展开成每条订阅一份 `PostEvent` → `post-detected` |
| `reportLiveStart` / `reportLiveEnd` / `reportLiveStatus` | 合成 `reportLive(externalId, ExtensionLiveSignalReport): void`（`start` / `status` / `end`） | 展开成 `LiveSignal`，喂场次引擎 |
| `reportProfile(externalId, profile)` | `reportProfile(externalId, CreatorProfileReport): void` | 资料缓存 |

上报种类（原 `SubscriptionReportKind` 五种）收成 `post` / `live` / `profile`。

**被拒不回话**：报了没声明的种类、外部 id 不合法、形状坏了，整条拒；认识的选填格值坏了只丢那一格。被拒与丢格都记进该拓展的 `reportDiscrepancies`（拓展详情页 `InstalledExtensionView` 上的那个框）并打 warn 日志，拓展自己不知道；报的人不在名单里照旧静默忽略。`reportDiscrepancies` 与拓展自报的问题是两张表。理由：被拒都是拓展自己的 bug，运行时改不了，回结果只会诱导它重报。🔗 现状（3b-42，10-24）：出入种类是 `post` / `live` / `profile` / `problem`；拓展三层问题上报被拒也进出入表（3b-38 的尾巴）。

照旧不变的规矩：

- 判新、去重、限流归拓展；BN 报什么收什么。开机第一轮只记基线、别报。
- 按外部 id 报，`sourceKey` 由宿主按 ctx 补（拓展冒充不了别家）；核心按身份查订阅，正常一条，老数据里遗留的重复各分一份，查不到或已停用就丢弃，并兜底再查一次名单。停用的订阅收不到事件与直播状态，也不刷资料：资料缓存停在停用那一刻，重新启用后下一轮刷新（09-27 拍板，改掉 v2 的「资料照样生效」）。
- 多交一格宿主不认识的，整条拒；认识的选填格值坏了只丢那一格；丢了什么记进 `reportDiscrepancies` 与日志。
- 直播 `status` 不触发推送；开播卡 / 下播卡只由事件触发。周期「正在直播」由核心计时、调 `fetchLiveStatus`（见 [subscription-sources.md](./subscription-sources.md)「直播」）。
- 过滤（屏蔽转发 / 文章 / 图集 / 视频、关键词、正则）对拓展作品与 B 站一视同仁：看 `Post` 上有没有，不再只看文字。

### 问题上报

签名分层（ADR-0025 决策 11）：

```ts
// IntegrationContext（activate 拿到的）：不带对象
ctx.reportProblem({ code, message, notify?: boolean, recoveryMessage?: string }): void;
ctx.resolveProblem({ code, notify?: boolean }): void;
// ExtensionSourceContext（订阅源的 start 拿到的）在上面加 externalId?
ctx.reportProblem({ externalId?, code, message, notify?, recoveryMessage? }): void;
ctx.resolveProblem({ externalId?, code, notify? }): void;
// PlatformAdapterContext（平台适配器的 start 拿到的）在上面加 connectionId?
ctx.reportProblem({ connectionId?, code, message, notify?, recoveryMessage? }): void;
ctx.resolveProblem({ connectionId?, code, notify? }): void;
```

三层与内置是同一个签名，只是后两层各多一格。`recoveryMessage` 是清掉且当初真私聊过时补的那句；`resolveProblem` 的 `notify: false` 表示不是修好了、只是不再适用，不补「已恢复」。这两格都不在 `Problem` 上，只在上报时交给通知器。

- 严重度、要不要打扰主人由拓展定：问题一律进面板问题框，`notify: true` 再私聊主人。
- **问题句只说事、平实**：B 站、内置适配器、拓展写的 `message` / `recoveryMessage` 一律平实，不称呼主人、不自称女仆，写「发生了什么」与「平台这一侧自己会怎么做」（如「拉取动态失败（错误码 -352：原话），每 5 分钟会自动重试一次」），**不写宿主的界面与操作**（面板哪一页、哪条指令、哪个开关、重启）。平台的数字错误码写进 `message`，不占 `code`（`code` 是 snake 词）。口吻不交给集成，由宿主按口吻加工。
- **宿主加工话**：私聊时宿主把话说完整 —— 女仆层「主人，刚刚 <名字> 报告：<message>」、平实版「<名字> 报告：<message>」；名字取来源描述符的 `label`、拓展清单的 `name`。恢复句同样补完整：给了 `recoveryMessage` 用「主人，好消息，<名字> 报告：<恢复句>」，没给用一句带名字与集成原句的通用说法（「主人，好消息，<名字>之前报告的「<原句>」已经恢复啦。」，2026-10-20 主人定 R2 乙；只接原句、不套两层引子）。引子按「这句话是谁写的」加，不按报的人：宿主自己写的整句（核心设置读不懂、宿主替拓展报的设置读不懂、宿主替连接报的几条、登录那一条）不加「X 报告」。
- **有登录口的来源不报登录问题，宿主看状态报**：宿主订每个有登录口的来源的 `auth.onChange`，按 `AuthState` 自己报与清（`expired` 进表并私聊、`logged-out` 只进表、`logged-in` 清、扫码中 / 确认中 / 出错保持上一次的结论），记在来源名下，宿主写整句并带指路。契约不为此加成员。
- **适配器不报连接通断**：宿主每分钟调 `probe`，连续两次探不通算断，私聊与清的规矩全在宿主（见 [push.md](./push.md)）。适配器特有、探测看不出来的事仍走 `reportProblem({ connectionId })`。
- 核心只守一条底线：同一报的人（`reporter`）、同一 code 的私聊 60 秒内只发一次。
- 每条问题核心自动记一行日志；只想记日志就用 `ctx.logger`。
- 问题表只有一种形状，**全在内存**：`Problem { reporter: IntegrationKey | "core", about?: { subscriptionId } | { connectionId }, code, message, since }`；同一个报的人、同一个对象、同一个 code 算一条。
    - 不带对象是拓展自己的问题（`about` 空着）；订阅源填了 `externalId`，由宿主换成那个人的订阅 id，订阅卡上说明为什么收不到。
    - 平台适配器报某条连接的问题带 `connectionId`，宿主核它是不是这个适配器的连接，不是就拒收。同时提供订阅源与适配器的拓展，两边各从自己那份 ctx 报，`externalId` 与 `connectionId` 不会出现在同一个签名上。`apps/contract` 的问题类型跟着 `about` 加连接这一支改。
    - 一条生死规矩：报的人 `resolveProblem` 按 code 清；报的人停下，它报的全清（适配器停下，它名下的全清）；对象（订阅、连接）删了，关于它的全清。
    - 宿主替拓展报的一条：拓展设置读不懂，code `settings_invalid`、记在拓展 id 名下、不私聊；改好起来、主人停用、卸载时清。这条是装载器替没起来的拓展报的，「拓展停下就清它名下的问题」不能在启动失败那条路上触发。🔗 现状（3b-41 C2，10-17）：已落，装载器在收摊之后才报、起之前 / 停用 / 卸载 / 盘上换版本时清；话在服务端字典（`extension.settings.problem`，设置文件读不懂是 `extension.settings.fileBroken`）。
    - 不存盘：重启或停用再启用之后，还在的问题要拓展重报一遍（重启后的头几秒，订阅卡上的红字会先消失）。
- code 用 snake（`login_expired`）。
- 🔗 **现状（3a-30，10-11）**：问题表、`GET /api/problems`、`problems-changed` 与核心那头的通知器 3a-30 已落，但 `reportProblem` / `resolveProblem` 只造在内置来源的 `SourceContext` 上；上面第一层（`IntegrationContext`，不带对象）和 `connectionId` 那一支都没造，拓展的 `activate(ctx)` 今天没有这两个成员；`Problem.about` 今天只有 `{ subscriptionId }` 一支。三层签名与 `about` 加连接那一支随 3b-38 落成。多语言（ADR-0037）下问题句的口吻与加工见上。
- 🔗 **现状（3b-51，10-20）**：问题句已中立化。B 站的问题句收进字典 `bilibili.problem.*`，QQ 官方网关两句去掉开头的「QQ」；两族里没有「主人 / 女仆 / 面板 / 指令 / 重启 / login」，由 `i18n/__tests__/integration-sentences-plain.test.ts` 钉着。写者标记 `writtenBy?: string` 加在问题表上报入参与 `ProblemChange` 上，值是给人看的名字；它不上 `Problem`、不进 `GET /api/problems`、不进 `apps/contract`。宿主在三个上下文入口（集成、来源、适配器）逐格抄给问题表，第三方塞不进来：集成上下文与适配器上下文的选项 `label: () => string` 在报问题那一刻取；拓展取当前语言的清单名、走与拓展列表同一条回落链；B 站取来源描述符的 `label`；内置适配器暂用适配器键（`qq-official` 等），第 4 期适配器自带描述后换。宿主直写问题表的那几条（连接探测、拓展设置、核心设置、登录）不盖。引子只在通知器把话交给发送口的那一刻加，账上存的是集成交上来的原句，「不再说」的比较不受影响；字典键 `problem.relay.reported` / `problem.relay.recovered` / `problem.relay.recoveredGeneric` / `problem.recoveredGeneric`，女仆层 `zh-CN.maid.json` 第一次有了这四条。登录问题由宿主看登录状态报：`subscriptions/login-problems.ts` 的 `watchLoginProblems` 按来源键报与清 `auth_lost`，`expired` 私聊、`logged-out` 只进表、`logged-in` 清；句子是宿主写的整句（字典 `problem.login.*`），交的是取字函数，表在换语言或口吻变了时重跑。换语言时问题表重报已随 3b-61 落：宿主的句子交取字函数，表在语言或口吻变了时重跑；B 站与 QQ 官方机器人自己记着、换语言时重报；通知器把「只换了说法」当同一件事。🔗 现状（3b-42，10-24）：拓展订阅源的来源 ctx 写者名也取清单名（`label` 选项），与集成、适配器两层一致。

## 推送：平台适配器

- `registerPlatformAdapter(def: PlatformAdapterDef): PlatformAdapterHandle`。一个拓展一个适配器。
- 内置的 OneBot、QQ 官方机器人、webhook 也是平台适配器：同一个接口、同一张登记表。v2 的 `kind: "extension"` 那一支没有了，核心里也不再有 `CONNECTION_PLATFORMS` 这张平台表。
- `PlatformAdapterDef` 装适配器 + 描述 + `settingsSchema`。`PlatformAdapterDescriptor` 描述一个适配器（它的脸与设置字段），`PlatformDescriptor` 描述一个聊天平台（名字、目标形状、地址叫法）。

| 成员 | 必备？ | 这一版对拓展 | 要点 |
| --- | --- | --- | --- |
| `descriptor { label, shortLabel, color, icon, settingsFields }` | 是 | 开（条件显示与键值表字段不开） | 静态，写在清单 `contributes.push`，见下。第 3 版契约的适配器**不带描述这一格**：适配器自己的「脸」这一期不造，拓展的描述以清单为准、由宿主填；内置的随第 4 期 🔗 现状（3b-44，10-25）：清单段已形成 `PlatformAdapterDescriptor` 下发；适配器 def 带 `descriptor` 会在登记时被拒 |
| `settingsSchema` | 是 | 开 | 连接设置的 zod；与清单的 `settingsFields` 逐格对表（键、类型、默认值），对不上登记当场抛。官方拓展的 `settingsFields` 由构建从入口导出的 `connectionSettingsSchema` 导出（见「设置」） |
| `start(ctx)` / `stop()` | 是 | 开 | 取代 `reconcile` / `dispose`；登记即 `start`，晚登记的也收得到 🔗 现状（10-27，R3）：`start` 已放宽为 `void \| Promise<void>`（与 `SourceDef.start` 对称），异步初始化可以写 `async start()`；拒了算登记失败，适配器不在册、这次加载失败 |
| `send` | 是 | 开 | 返回结果形状、带标准码；只有 `TargetDispatcher` 调它 |
| `isAvailable` | 是 | 开 | |
| `probe` | 是 | 开 | 宿主每分钟调一次，连续两次探不通算断；适配器自己不报通断（见「问题上报」） |
| `listConnectionCandidates(signal)` | 是 | 开 | 原 `listBots`，见「新建连接」 |
| `capabilities` / `probeCapabilities` | 否 | 开 | 新增 `atAll`、`inbound`；原先按平台名判断的改成问能力。有效结论带 `checkedAt`：带时区的 ISO，宿主统一成 UTC |
| `listAddressCandidates(connection, scope, signal)` | 否 | 不开 | alpha 之后桥帧改名时再看；运行时也摘：宿主登记拓展适配器时把它摘掉，带了也不认（10-11） |
| `connectionAuth` | 否 | 不开 | 与订阅侧同一个 `AuthState`，结果是一份连接草稿；运行时也摘：宿主登记拓展适配器时把它摘掉，带了也不认（10-11） |

对拍逐成员核：要么走通，要么在「不开」名单里写明理由。🔗 现状（3b-46，10-25）：推送守卫③已落在 `apps/server/src/__tests__/extension-contract-parity-e2e.test.ts`；假适配器住假源拓展（`extensions/fake-source/src/adapter.ts`，主人 10-25 定给假源加一口、不另起拓展），一个拓展同时开订阅与推送两口。

### 连接名单要不要管

宿主每次调 `send` / `isAvailable` / `probe` / `capabilities` / `probeCapabilities` 时，都把那条连接递到手上；连接的 `settings` 已经按 `settingsSchema` 解好。`start(ctx)` 的上下文另有 `connections()`（此刻归这个适配器的连接，现读、别缓存）与 `onConnectionsChanged(fn)`。

**只调 HTTP 接口的适配器不用管连接名单**：每次照递进来的连接发即可，`start` 里不用读名单。样板（`adapter-send`）：

<!-- sample: extensions/fake-source/src/adapter.ts#adapter-send -->

```ts
// 发送:只用递进来的 `connection` 与去向,**不查自己记的连接表** —— 这就是「只调 HTTP 接口的适配器
// 不用管连接名单」的样子。记一条账(满 50 条丢最旧的),回成功。
async function send(
	connection: Connection,
	destination: DestinationRef,
	payload: NotificationPayload,
) {
	sentRing.push({
		connectionId: connection.id,
		platform: connection.platform,
		destination: destinationOf(destination),
		segments: segmentsOf(payload),
	});
	if (sentRing.length > SENT_RING_SIZE) sentRing.shift();
	return ok({ latencyMs: 0 });
}
```

假适配器不出网，所以这一段只是记账；真适配器在这里经 `ctx.http` 发请求，形状一样 —— 只用递进来的连接，不查自己的表。

**维持长连接的才要对账**：`start` 里先对一次账、再订 `onConnectionsChanged`；对账必须幂等、够便宜（没变就是空操作），且不写配置、不触发探测。样板（`adapter-start`）：

<!-- sample: extensions/fake-source/src/adapter.ts#adapter-start -->

```ts
start(ctx: PlatformAdapterContext) {
	running = ctx;
	// 先对一次账,再订变更。头一次对账不算「变了」:视图本来就是现取的。
	reconcile();
	ctx.onConnectionsChanged(() => {
		if (reconcile()) hooks.changed();
	});
},
```

对账样板（`adapter-reconcile`）：

<!-- sample: extensions/fake-source/src/adapter.ts#adapter-reconcile -->

```ts
// 对账:读一遍此刻归我的连接,和上次记的表比;没变是空操作,变了换表、喊视图刷新。
// 幂等 —— 同一份名单来多少次都一样;不写配置、不触发探测(会经 `config-changed` 绕回来)。
function reconcile(): boolean {
	if (!running) return false;
	const next = new Map<string, TrackedConnection>();
	for (const connection of running.connections()) {
		next.set(connection.id, { platform: connection.platform, enabled: connection.enabled });
	}
	const unchanged =
		next.size === tracked.size &&
		[...next].every(([id, one]) => {
			const old = tracked.get(id);
			return old?.platform === one.platform && old.enabled === one.enabled;
		});
	if (unchanged) return false;
	tracked = next;
	return true;
}
```

**清单 `contributes.push`**：键名不变，装适配器的描述 —— 原来 `display` 里的 `label`、`shortLabel`、`color`，加上 `icon`；连接配置项 `connection.fields` 改叫 `settingsFields`。`display` 这一层要不要照订阅口摊平、`icon` 在清单里怎么写（清单里没有图库），施工时定。🔗 现状（3b-44，10-25）：现已摊平成 `{ label, shortLabel, color, icon?, settingsFields? }`，`display` 已删，`settingsFields` 缺省按空表读。

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
- **读口**挂在现成的 `/api/adapters/:adapterKey/` 前缀下，内置与拓展同一个口；面板读的旧口 `/api/ext/:id/bots` 在同一个提交里删掉。
- **候选里的完整平台描述**由契约的门给一个造中性描述的函数，住零依赖的子路径；桥用它填、再盖上自己知道的图标。候选的形状与核心同一份。
- **一条连接就是一个借来的 bot**：`platform` 是开放字符串，只来自挑中的候选。
- 原 `ExtensionBotView` 的对应：`config` → `settings`，`platform: string` → `platform: PlatformDescriptor`（`tint` 统一叫 `color`），`boundTo` → `boundConnectionId`，`name` 改必填；没有单独的 `icon`，平台图标在 `platform.icon`。

### 连接

- 形状 `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot, probeState? }`。
- `adapterKey` 由宿主按拓展 id 填，拓展自报的会被覆盖；分发按它走。`kind`、`connector`、`extensionId` 删掉（`extensionId` 并进 `adapterKey`）。
- `platformSnapshot` 只有宿主写（新建时照候选抄、列候选时按平台名刷新）：拓展停了、桥没连上时，面板照样画得出已有的连接。适配器不读它；快照变了不许触发重连。
- **连接设置的校验**：保存时适配器在场就按 `settingsSchema` 校验，不过回 400 并带原因；不在场先存下。读盘时逐条校验，不过的只隔离那一条（不交给适配器、不投递；面板显示「设置不合法」与原因；盘上原文不动），BN 照常开机。这是宿主替连接报的问题：进问题表、不私聊，记在那条连接所属适配器的名下。
- 接入凭据（如桥的 token）住拓展自己的设置里，不是连接。
- **两层地址这一版只能手填**：拓展适配器没有 `listAddressCandidates`（本版不开，运行时也摘），目标的 `address` 与上一级 `parentAddress`（比如频道所在的服务器与子频道）由主人在面板上手填。对拍 `apps/server/src/__tests__/extension-contract-parity-e2e.test.ts` 有一条「两层地址这一版只能手填」钉着它走得通。

### 发送与入站

- **只有 `TargetDispatcher` 能发送**。适配器的 `send` 返回结果形状、失败带标准码（ADR-0026）；投递失败归核心：按目标逐个、只重试失败的那个，`rate_limited` / `unavailable` / `timeout` 退避重试，`indeterminate` 与其他码不重试。BN 不替适配器限流、去重。
- **入站经 `ctx.inbound`**：宿主核连接归属，平台取自连接，不由适配器自报（内置适配器同样）；适配器停下之后再交来的丢掉并记一行。回调包叫 `InboundHandlers`（原 `InboundSinks`）；私聊的号叫 `address`（原 `userId`），群消息的群号也叫 `address`（原 `groupId`）、发言者叫 `senderId`（原 `userId`，与 `selfId` 成对）。桥协议帧不改名，由桥的适配器映射。
- **入站链接的来源标记**：适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" | "nativeShare" }[]`（取代 `miniAppCardLinks`），正文里的链接仍由核心从 `text` 里挑、核心内部记成 `"text"`；规矩「原生分享卡里的链接不回预览」不变。
- **原生分享**：载荷种类 `"miniapp-card"` 改 `"native-share"`、类型随 `NativeShare…`，能力格 `miniAppCard` 改 `nativeShare`；`appId` 填 B 站 QQ 小程序真实的 appid（施工时从真分享卡里读出来核）。桥帧里的能力名（`miniAppCard`）与载荷种类（`miniapp-card`）照旧，进 alpha 后两步改名。
  - 🔗 2026-10-19（能力格已改名）：宿主侧的 `ConnectionCapabilities.miniAppCard` 已改 `nativeShare`；桥帧线上的能力名 `capabilities.miniAppCard` 照旧，由桥适配器映射到内部那一格，进 alpha 后两步改。
- **OneBot 小程序卡能力的重探**节奏与「探不出来不推翻已探实的答案」由宿主管，契约不加成员。

## 设置

- 清单里声明 `settings.fields`，`activate` 里交一份 zod，两份对不上当场抛。凭据字段标 `secret: true`（与核心 schema 同一写法），面板打码、备份脱敏、日志脱敏都读这个标记。
- **规则只写一份（官方拓展，4-11）**：清单里的设置项不手写。规则上用 `.meta({...} satisfies SettingsFieldMeta)` 写给人看的那几格（标签、说明、占位字、`secret`、枚举选项的标签与图标、列表的标题格与开关格……；类型、默认值、必填、上下限、枚举的取值读规则本身），写了 `label` 的键才出一栏、顺序照键。入口导出 `settingsSchema`（自己的设置）与 `connectionSettingsSchema`（推送那口的连接设置），`vite.config.ts` 挂 `@bilibili-notify/extension/build` 的 `extensionPackageFiles`，构建照规则写进 `dist/extension.json`，导出完过一遍加载时的对表与清单格式；源码清单里还写着这两段就构建失败。拓展的 `src/` 不许 import 构建子路径（守卫在 `extension-import-boundary.test.ts`）。手写清单的拓展照旧，加载时照旧对表。
- 读取：`ctx.settings(schema)` 交回 `SettingsReader<T>`（与内置集成同一个），`get()` 现读、回 `Result<{ settings: T }>`、不抛，`onChange(fn)` 在内容真的变了时叫。从没设过的，拿空对象过规则：过得了是成功拿默认值，过不了回 `not_configured`、拓展照跑。每个拿到上下文的集成都在配置仓登记一段（内置适配器也登记），没设过的照这条读；配置仓对根本没登记的键照旧抛（组装漏了是 bug）。🔗 现状（3b-41，10-17）：C1 已落——拓展的 `ctx.settings(规则)` 交回 `SettingsReader<T>`，`ExtensionSettings<T>` 已删；没设过拿 `{}` 过规则，过得了是成功并带默认值、过不了回 `not_configured`；带异步规则、交进来那一刻判不完回 `unavailable`；跑着时被旁路写坏，`get()` 回 `invalid`（带 `issues`）并叫一次 `onChange`，桥在 `links()` 里记着上一份好的名单。C3 已落——三个内置适配器各登记了一段空段。C4 已落——`settings(规则)` 上提到 `IntegrationContext`，一个集成只有一份实现：拓展把自己的（对表清单、记「设置读不了」）交给集成上下文，推送源 `start(ctx).settings` 与 `activate(ctx).settings` 是同一份。
- 值存在 `config/settings/extensions/<id>.json`，一个拓展一个文件；开关 `extensions.<id>.enabled` 归宿主，在 `config/settings/core.json` 里。
- **坏了只停这一个拓展，不挡开机**：拓展段校验不过，宿主只停这一个拓展，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起。运行状态：内置集成只取 `running` / `failed` / `settings-invalid`；拓展照 `ExtensionRunStatus` 的全部取值，外加 `settings-invalid`。面板、健康卡与 `status` 指令都读它。
- **只有 `activate` 期间读设置失败可以抛错中止启动**，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。读不懂的拓展不起，宿主同时替它报一条 `settings_invalid` 进问题表（见「问题上报」；3b-41 C2 已落）。
- **「读设置的写法简化」不改第 3 版契约的形状**：「规则只写一份、清单字段由打包脚本从规则导出」那一半排到第 4 期，与面板「按描述画」一起做；「规则写在定义里、一行读到」不做。🔗 4-11 已落（10-28）：在构建时导出（不在打 zip 时），线上清单形状不变、修订号不抬，见上一条。
- 版本号是内容哈希，对不上回 409。
- 卸载删掉这一段。
- 拓展的设置只在拓展页；功能页面（推送目标的连接卡、订阅页）放指过去的入口。

### 译文与 `ctx.i18n`（ADR-0037 决策 14）

这一节是对外格式：第三方照着写，定了就改不动（ADR-0037 决策 14 下 2026-10-17 的 🔗）。

- **目录与文件名**：译文放包里的**单独目录** `locales/`（与 BN 自己放译文的目录同名），一种语言一个 `<语言码>.json`，语言码用 BCP 47 写法（`zh-CN` / `en` / `ja`；`zh-TW` 随 3b-10 进来），大小写照 BN 的语言表；`extension.json` 只有一份。装包时只把 BN 语言表里的语言写进盘：写盘的文件名由宿主按表里的常量重建、不取自 zip；不在表里的（如 `ko.json`、大小写写错的 `zh-cn.json`）跳过不写，并在装包结果里说明；读目录时也只读表里的。
- **包里的位置**：带译文时，包目录里要有 `locales/`。BN 仓里两个拓展的构建各自在 `vite.config.ts` 里把清单与 `locales/`（有才拷）拷进 `dist/`；第三方用别的构建工具，也要让装的那个目录里有 `locales/`。
- **普通键**：与 BN 同一个段形，每段是 `[A-Za-z0-9_-]+`、用点分段，例如 `status.connected`。带数量的句子在译文里写成 `键#类别`（类别名照 `Intl.PluralRules` 的 `zero` / `one` / `two` / `few` / `many` / `other`），取字时传 `count`。普通键的段不含 `$`，不会与下面的保留段撞名。
- **清单字段的保留段**：顶层保留键 `$manifest`，值是照清单形状嵌套的对象；设置项按自己的 `key`、选项按自己的 `value`、列表项按 `key` / `value` / `host` 展开成子对象。例如：

```json
{
  "status.connected": "已连接",
  "$manifest": {
    "name": "示例拓展",
    "settings": {
      "fields": {
        "token": { "label": "令牌" },
        "kind": { "options": { "qq.official": { "label": "QQ 官方" } } }
      }
    }
  }
}
```

- **回落链**：固定为「本语言 → 简中 → 英文 → 清单原字」，不按语言分。运行时取字与清单字段共用前三级；清单字段最后落清单原字，运行时走到链尾仍没有就回键本身。宿主先按这条链为每种语言合成平实版，再交给核心的 `translate` 取字，不给 `fallback`、不改核心。
- **给作者**：带了哪种语言，就把那种语言的 `$manifest` 写全，尤其简中——简中漏写、英文写了的格，简中用户看到的是英文。
- **坏文件与坏条目**：装包时译文不是 JSON 或超过单份上限 → 整包拒收并点名那一份；已经在盘上的（手放的、开发版软链的），以及对不上清单的键 → 只丢那一份 / 那几条、记 warn、拓展页注一句，不拒整个拓展。
- **上限**：单份 256 KB、`locales/` 合计 2 MB；整包上限仍是 10 MB。
- **`ctx.i18n` 的形状**：

```ts
interface ExtensionI18n {
  locale(): string;
  t(key: string, values?: TextValues): string;
  onChange(fn: () => void): Disposable;
}
```

- `locale()` 现读当前语言，返回 `string` 而不是语言码闭集；`t` 的占位符与单复数同 BN 一套规则；`onChange` 只在语言真的变了时叫，收摊时宿主自动摘掉。`TextValues` 从 `@bilibili-notify/extension` 拿（只是类型）。只挂拓展的上下文，不挂 `IntegrationContext`；口吻不交给拓展，`ctx.i18n` 只有平实一层。
- **语言真变时**：宿主替每个在跑的拓展喊一次「面板数据变了」，拓展**不用**自己 `statusChanged()`；`ctx.i18n.onChange` 只用来重算拓展自己缓存的、由译文算出来的东西。
- 想让问题表跟着换语言，就在 `ctx.i18n.onChange` 里把开着的问题重报一遍；同一条再报只换文案，私聊不会重复。
- 连接的设置（`settingsFields` / `settingsSchema`）是另一回事，见「推送：平台适配器」。

## devtools

- 清单 `contributes.devtools` 指向一个独立入口文件，宿主只在开发版 `import()` 它，登进 `devtoolsProviders`。
- 入口交 `DevtoolsProvider { scenarios: DevScenarioDef[] }`；过线给面板的纯声明叫 `DevScenarioDescriptor`。
- **场景 id 由宿主加前缀**（`<拓展 id>.xxx`），不会撞名，也冒充不了别家。
- **参数按提供方收窄**：订阅源用 `creator` 种类（值是自己名单里的 `externalId`）；平台适配器只能挑自己的连接；`sub` / `target` 只给核心。
- **`run` 返回结果形状** `{ ok: true, summary? } | { ok: false, code, message }`：参数不合法回 `invalid`，场景找不到回 `not_found`；原来那两个异常类删掉。`active` / `reset` 不变。
- **场景只用自己集成的 ctx 做事**（造一条作品就调自己的 `reportPost`），核心的句柄不交出去。
- 核心 devtools 不认识任何一家来源。桥的假桥与场景搬进 `extensions/bridge/` 自己的开发入口，直接用桥自己的 `contract.ts`，不再在核心手抄协议帧。

🔗 现状（3b-45，10-25）：入口文件名固定为 `devtools.mjs`，清单 `"devtools": {}` 只开口、不带路径（ADR-0012 决策 35 ⛔）；入口同步导出 `devtools(ctx)`，开发上下文在 `ExtensionContext` 上多一个现取的 `mountUrl()`。拓展已经交回的不带前缀场景由宿主按拓展 id 认领、加前缀，场景表随拓展起停增减；场景 id 撞核心场景会被拒。拓展参数这一版只收 `text` / `number` / `enum`，挑自己连接的种类与 `creator` 种类等第一个使用者出现再造。开发入口不进发行包，打包与装包两道白名单都不收。核心 devtools 不认识任何拓展；「拓展有更新」的拓展 id 默认空，要手填已装的拓展 id。

🔗 现状（4-06，10-28）：`creator` 种类随 B 站的场景造了，拓展同样能用 —— 拓展参数现在收 `text` / `number` / `enum` / `creator`，种类改由登记表在认领时查（B 站一样受管）；挑自己连接的种类仍没造。核心自己的场景也加了前缀 `core.`（`core` 是保留的拓展 id），所以拓展场景撞不上核心的完整 id；描述符多一格宿主填的 `provider`。

## 从 v2 过渡

| 项 | 做法 |
| --- | --- |
| 市场挑版 `pickPerId` | ✅ 3b-04：改成「在当前 BN 装得了的版本里取最高」 |
| 索引规则 | ✅ 3b-04：从「每个 id 一条正式 + 一条预发布」放宽为「每个 id 每个契约版本各留最新一条正式 + 一条预发布」，过渡期里旧契约与新契约的 BN 各挑自己装得了的 |
| 官方索引地址 | ✅ 3b-04：新版 BN 读新的滚动 release `extensions` 上的 `marketplace.json`，用 1.0 的新规矩；旧 release `extension-marketplace` 上那份留给 0.12、从此不动。新 release 不播种，第一次真发拓展时才出现。格式不顺手改：`issuedAt` 仍是秒（进门换 ISO）、`apiVersion` / `apiRevision` 不改名。索引里给人看的字这一期不分语言 |
| 桥 | 与 1.0 同批迁到 v3；1.0 alpha 期间 v3 的桥只进预发布档 🔗 现状（3b-44，10-25）：桥已迁到第 3 版，版本为 `0.1.0-alpha.1`、只进预发布档；第一次真发仍由主人打 tag |
| 已装的 v2 拓展 | 迁移时拷进新数据代；升级后第一次打开面板的询问页列出「因契约版本不收」的拓展，给一键更新；**不在开机时静默替换** |
| 桥协议线上帧 | alpha 期间不改，1.0.0 之前按两步改完；在那之前内部改名只改到桥的适配器，有快照守卫钉着。要改的见下面的两步改名清单 |
| 桥回执 `result` 帧的 `err` | 进门翻成 `{ code: "unknown", message }`：冻结格式说不清原因，不猜标准码。🔗 现状（3b-44，10-25）：BN 已认 1.5 的 `code` / `message` / `upstreamCode`，只带 `err` 的旧回执仍翻成 `unknown`。 |

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
| `miniapp-card` 的 `desc` / `picUrl` / `path` / `jumpUrl` | BN → 桥 | 原生分享中立描述的 `description` / `imageUrl` / `pagePath` / `webUrl`（载荷种类内部叫 `"native-share"`，能力名内部叫 `nativeShare`；帧里的载荷种类是 `miniapp-card`、能力名是 `miniAppCard`） |
| 群入站的 `miniAppCardLinks` | 桥 → BN | `sharedLinks: { url, kind: "card" \| "nativeShare" }[]`，规矩是「原生分享卡里的链接不回预览」 |

- 帧里改成什么名字列在 [construction-plan.md](./construction-plan.md)「alpha 之后、1.0.0 之前」。
- `listAddressCandidates` 与 `connectionAuth` 对拓展开不开放，随这次一起看（10-11 主人认为这两个成员对桥有用，挑群、扫码建连接都用得上；开放要连同拓展契约、桥协议与仓外两个桥插件一起设计，留到这次一次做）。

## 边界

- 拓展底下第三方随便用，我们自己的东西只准从 `@bilibili-notify/extension` 进；反方向核心不 import 拓展。两条都有扫目录的守卫。
- `@bilibili-notify/extension` 只放类型不放实现（拓展会被打成自包含 bundle）；列出来的就是契约的全部，加一格是一次明确的加宽决定。
