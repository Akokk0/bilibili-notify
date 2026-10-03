# 1.0 订阅来源与横切接口

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 ～ 0031（集成与 ctx 见 0025，失败规矩见 0026，监听、统计与面板读描述符见 0027，作品文字与模板变量见 0028，链接预览见 0029，AI 见 0030，指令与 devtools 见 0031，`sendToAddress` 见 0024）。

`SubscriptionSource` 全接口、来源的自我介绍与面板怎么读它、登录与账号、核心递给来源的 ctx、问题与健康、资料与直播怎么拉、横切接口（链接预览、指令、AI 工具、devtools 场景），以及 B 站怎么实现它们。数据类型（`Post`、`LiveSignal`、`Identity`……）见 [data-model.md](./data-model.md)；登记表与装配根见 [architecture.md](./architecture.md)；拓展能用其中哪些见 [extension-contract.md](./extension-contract.md)。

## 一句话

**`SubscriptionSource` 只管「订阅一个人」。** 链接预览、AI 工具、调试场景跟订阅无关，各是一个小接口；指令 1.0 没有来源自带的（见「指令」）。B 站直接实现它们，拓展由宿主经契约转一道。B 站、每个拓展、每个内置的平台适配器各是一个**集成**，各拿一份 `IntegrationContext`；登记表的键类型叫 `IntegrationKey`，来源的 `SourceKey`（`"bilibili"` 或拓展 id，不加前缀）是它的一部分；分派一律按 `identity.sourceKey` 查登记表。**来源只认人、不认订阅**：上报只带 externalId，BN 内部的订阅 id 来源永远看不到。

**结果形状**：来源、横切接口与 ctx 的方法，一次操作的结果一律是 `{ ok: true, … } | { ok: false, code, message, upstreamCode? }`（ADR-0026）。`code` 取 `internal` 里那张标准码表（`not_found`、`invalid`、`unauthorized`、`rate_limited`、`unavailable`、`timeout`、`unsupported`、`conflict`、`indeterminate`、`unknown`）；上游平台自己的错误码放 `upstreamCode`，不占 `code`。抛错只留给 bug，宿主在边界接住、按 `unavailable` 处理并记错误日志。下文的 `Result<T>` 是本文的简写：成功那一支带着 `T`；不带 `T` 的 `Result` 就是 `{ ok: true }`。通用类型的正式名字、成功那一支装 `T` 的格名，施工时定。

## SubscriptionSource

```ts
interface SubscriptionSource {
  descriptor: SourceDescriptor;
  // 必备
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
  searchCreators(query: string, signal: AbortSignal): Promise<Result<CreatorCandidate[]>>;   // 解析门：链接 / id / 名字原样交进来
  fetchProfile(identity: Identity, signal: AbortSignal): Promise<Result<CreatorProfileReport>>;   // 也就是「按 id 取人」
  // 可选
  auth?: SourceAuth;
  fetchLiveStatus?(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult>;
  liveInteractions?: LiveInteractions;     // 弹幕、SC、会员、进场
  health?(): SourceHealth;                 // 健康卡与 status 指令的一行字
  fetchPreview?(identity: Identity, kind: "post" | "live", signal: AbortSignal)
    : Promise<Result<PostReport | LiveCardInput>>;
}

interface SourceHealth { summary: string }
```

| 成员 | 必备？ | 谁调、什么时候 | 要点 |
| --- | --- | --- | --- |
| `descriptor` | 是 | 面板、锐评、模板随时读 | 见下一节 |
| `start` / `stop` | 是 | 开机、关停、拓展启停 | `start` 拿到 ctx；`stop` 后不许再上报。收尾时宿主先调 `stop()`，再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾。`start` 期间读设置失败可以抛错中止启动（生命周期闸，唯一的例外），宿主接住记成 `settings-invalid`，见「设置」 |
| `searchCreators` | 是 | 新建订阅弹窗打字时 | 「解析门」：输入框里是链接、id 还是名字都原样交进来，来源自己认；最多回 10 个 `CreatorCandidate`。失败回结果形状、不再靠抛：风控 `rate_limited`、没登录 `unauthorized`，文案由来源给、原话到面板；面板按 `code` + `message` 读一处（今天风控和没登录都报成 404） |
| `fetchProfile` | 是 | 核心按资料刷新 cron 定时调；按 id 取人也是它 | 头像先 `ctx.fetchImage` 再交引用。失败：`not_found` 记成关于这条订阅的 `creator_not_found` 问题；其余当暂时失败，下一轮再来；整轮要不要刹车（撞了风控，本轮剩下的不再打）由来源自己决定。`creator_not_found` 记在谁名下、什么时候清，施工时定。原先设计的 `lookupCreator` 与它重复，删掉 |
| `auth` | 否 | 系统 → 账号、`login` 指令 | 见「登录与账号」 |
| `fetchLiveStatus` | 否 | 核心按场次定时调 | 返回结果形状，成功分 `live` / `offline`，见「直播」 |
| `liveInteractions` | 否 | 直播中 | 走能力回调还是总线施工时定 |
| `health` | 否 | 健康卡、`status` 指令 | 只交一行字 `{ summary }`（原 `status()`）；订阅卡的「暂停 / 不可用」不看它，见「健康与运行状态」 |
| `fetchPreview` | 否 | 卡片页预览 | 没实现就用示例数据。返回结果形状是按失败规矩（ADR-0026 决策 4）推出来的；失败时回落示例数据还是报错，施工时定 |

`SubscriptionSource` 共 10 个成员：descriptor、必备 4 个、可选 5 个。没有单独的「新建 / 启用订阅」钩子（原 `onSubscriptionAdded`，一度改名 `onSubscriptionActivated`）：它和 ctx 的 `onSubscriptionsChanged` 重复，删掉。来源要在订阅变化时做事，一律用 `onSubscriptionsChanged` 自己对比新旧名单。

新建订阅弹窗只有一套流程：选平台 → 一个输入框搜索 → 预填资料；去重用 identity（同一身份只能有一条订阅，见 [data-model.md](./data-model.md)）。搜人接口是 `GET /api/sources/:sourceKey/creators?q=`，提示文字由 contract 的叫法函数按 `descriptor.searchAccepts` 拼（B 站三种都收，拼成「UID、主页链接或名字」；没声明就是「搜索{creatorNoun}」）。B 站的实现：纯数字按 UID 精确查、主页链接先抽出 UID、其余按名字搜。候选头像也是图库引用，没被订阅用上的由图库按引用清扫。

## SourceDescriptor

来源的自我介绍。面板与锐评只读它（经 `GET /api/sources` 下发，见下一节），所有 `isBili` 分叉删掉。拓展清单的 `contributes.subscription` 直接写这些同名字段（见 [extension-contract.md](./extension-contract.md)）。

```ts
interface SourceDescriptor {
  label: string; shortLabel?: string; color?: string;
  icon?: string;                   // 平台图标，对齐推送侧 PlatformDescriptor.icon
  postNoun?: string;               // 这个平台管作品叫什么；缺省「作品」，B 站「动态」
  creatorNoun?: string;            // 这个平台管创作者叫什么；缺省「创作者」，B 站「UP主」
  externalIdNoun?: string;         // 这个平台管外部 id 叫什么；B 站「UID」
  searchAccepts?: ("id" | "link" | "name")[];   // 搜人输入框收哪几种输入；提示句由叫法函数拼，B 站三种都收；缺省「搜索{creatorNoun}」
  supportedFeatures: FeatureKey[]; // 支持哪些特性（开关、规则节按它铺）；订阅上「开没开」才叫 features
  supportedExtras?: ExtraKey[];    // 支持哪些附加项
  featureHints?: Partial<Record<FeatureKey, string>>;   // 特性开关下的小字；唯一允许写自由文字的一格
  membershipPrograms?: MembershipProgram[];   // 会员体系
}

// 会员档位的全形状见 data-model；在 key / name / rank / icon 之外加两格：
interface MembershipTier {
  key: string; name: string; rank: number; icon?: PostImage;
  color?: string;                  // 档色：面板与出图共读，面板自己的档位色表删掉
  announcement?: string;           // 宣告语，可用 {viewer}、{name}、{tier}；没声明就不画
}
```

- 特性开关、附加项、规则节、平台徽章、CSV 平台列、锐评平台名全从 descriptor 取，逐项对照见下一节。
- B 站那一行的平台徽章，只在装了第二个订阅源时才画。
- `icon` 的取值怎么解释（面板图标库里的名字还是一张图；拓展加不了图标库的名字），施工时定。
- **外部 id**：身份标签写「{externalIdNoun} {externalId}」（B 站「UID 123」），没声明就写「{label} · {externalId}」，由一个函数生成（显示名链 `displayNameOf` 的最后一环）；「复制 UID」随之变成「复制 {externalIdNoun}」或「复制 ID」。
- `postNoun` 进模板变量 `{postNoun}`（与提示词变量同名），默认文案「{name}发布了一条{postNoun}」，保留「一条」（ADR-0028 决策 3）。B 站用户的推送文字一字不差；盘上还是老默认的，面板亮「默认文案有更新」，主人点了才换，不静默改写。视频那条「{name}发布了新视频」不变。模板名、AI 提示词、屏蔽提示、面板标签都跟着 `postNoun` 走（缺省从「动态」改成「作品」）。
- 特别关注这项设置只在 `supportedFeatures` 含 `specialDanmaku` 或 `specialUserEnter` 时露出。
- `liveStreaming` 开关只在 `has.liveStatus` 为真（来源提供了 `fetchLiveStatus`，宿主推算、随 `/api/sources` 下发），且 `supportedFeatures` 同时含 `liveStart` 与 `liveEnd` 时显示。

## 面板怎么读描述符

面板里不再有来源分叉：事实放描述符，句子由核心拼，来源只填几个词；加一个来源不用改面板。

- `GET /api/sources` 回每个来源一条 `{ key, descriptor, has, status }`：
  - `descriptor` 由服务端备好：B 站的写在 `bilibili/` 的代码里，由 `compose.ts` 静态登记完整的 `SourceDescriptor`，B 站设置坏了（集成没起）照样下发；拓展的取清单 `contributes.subscription`；装上就有，停用、启动失败、设置不合法时照样有。
  - `has { auth, liveStatus, preview }`：来源实现了 `auth` / `fetchLiveStatus` / `fetchPreview` 中的哪些，由宿主推算，不让来源自报。
  - `status`：该集成运行状态的取值（内置集成只取 `running` / `failed` / `settings-invalid`，见「健康与运行状态」）。
- 面板进来拉一次进缓存，订阅按 `identity.sourceKey` 取；`extension-status-changed` 时缓存失效。加载中「不知道」不等于「没有」，按中性默认画。

**从描述符直接拿**：

| 面板上哪儿（例子） | 描述符哪格 | 没填时 |
| --- | --- | --- |
| 平台名与徽章：新建弹窗的「B 站」按钮、订阅卡与在播徽章、统计 / CSV / 锐评的平台列 | `label` `shortLabel` `color` `icon` | 只显示 `label` |
| 创作者叫法：导航「订阅 UP 主」、「添加 UP 主」、「全部 UP 主」、空态、历史搜索框、模板变量说明「UP 主名字」 | `creatorNoun` | 「创作者」 |
| 作品叫法：特性分组「动态」、规则节「动态过滤 / 图集 / 消息」、推送种类、统计列、雷达「动态量」、皮肤分类 | `postNoun` | 「作品」 |
| 外部 id：卡上「UID 123」、「复制 UID」、「该 UID 已在订阅中」、单人页身份、特别关注「纯数字 UID」 | `externalIdNoun` | 「{label} · 123」、「复制 ID」 |
| 搜人输入框提示 | `searchAccepts`（只声明收哪几种输入，句子由叫法函数拼） | 「搜索{creatorNoun}」 |
| 露出哪些特性开关、规则节、特别关注节 | `supportedFeatures` | — |
| 露出哪些附加项（词云、总结）；「词云与总结只有 B 站有」这类小贴士也改看它（`BILI_ONLY_EXTRAS` 删掉） | `supportedExtras` | 不露 |
| 特性开关下的小字 | `featureHints`（B 站写回「投稿 / 转发 / 专栏」「Super Chat 提醒」） | 能推导的推导：会员行 = 档名连起来，下播行 = 「下播卡片」加上挂在下面、且 `supportedExtras` 里有的附加项名；其余用核心的中性默认（「开播提醒」「醒目留言提醒」…） |
| 会员：档名、档序、档色，每档文案与图片设置，`{tier}` 的说明，卡片页示例 | `membershipPrograms[].tiers[]` 的 `name` `rank` `icon` `announcement` `color`；体系名做规则节标题 | 没有会员体系，整节不露 |

面板的档位色表 `guard-levels.ts` 删掉，色表搬进 `bilibili/` 的描述符。

**不从描述符拿**：

| 面板上哪儿 | 从哪拿 |
| --- | --- |
| 露不露账号页与扫码、直播开关、卡片页的真实预览 | `/api/sources` 的 `has`（宿主推算） |
| 集成自己的设置页（系统页的集成 tab、拓展页的设置） | 集成登记时交的 `settingsFields`，不挂在描述符上，见「设置」；面板从哪个路由拿，施工时定 |
| 「扫码登录 B 站」「暂未登录 B 站账号」 | `AuthState`，平台名取 `label` |
| 健康卡 | 运行状态与 `health()` 的 `SourceHealth`，见「健康与运行状态」 |
| 订阅卡的「暂停 / 不可用」 | 运行状态与问题表 |
| 「未关注该 UP —— 收不到动态」 | 问题表，文案由来源给 |
| 头像兜底色（今天的 `colorFromUid`） | 核心的中立函数按身份算 |
| 推送目标与连接 | 推送侧的 `PlatformDescriptor` / `platformSnapshot`（见 [push.md](./push.md)） |
| AI 工具标签 | `AiTool.label` |
| 链接预览设置 | 核心的中性文案，加上列出各链接解析器的 `label` |
| 关于页、启动页、备份里的「B 站」 | 固定文案改中性，或按「叫法」列出装了的来源 |

### 叫法

- 只涉及一个来源的地方用它自己的叫法；混着多个来源的地方用「创作者」「作品」「会员」「ID」；只装了 B 站时，混用处也用 B 站的。
- 规矩只写一份：一个函数放在 `apps/contract`，面板与服务端（提示词变量、模板）都调它，默认词也只在那里定义；进守卫 4 的点名表。
- 面板与核心自己拼的句子绕开量词：「新{postNoun}」「{n} 位{creatorNoun}」（「位」对人通用），不给描述符加量词字段。主人可改的文案模板不受这条限制，默认文案保留「一条」（ADR-0028 决策 3）。
- 描述符不变成界面文案表：只装叫法、能力清单与会员档位（设置字段在登记集成时交，不挂在描述符上，见「设置」）；`featureHints` 是唯一的自由文字格；想加界面句子，由核心按已有字段拼。
- 统计 CSV 的「UID」与「外部 ID」合成一列，放在「平台」旁边，列名走叫法函数（只装 B 站叫「UID」、混着叫「ID」）；「UP 主」列同理；平台列的值取 `label`，兜底的「B 站」删掉。「投稿」「动态」不动（ADR-0021 决策 50）。

### 来源没装

拓展卸载后遗留的订阅：平台名显示来源键，叫法用中性词，不露特性开关，卡上标「来源没装」。不存描述符快照、不进问题表：订阅侧的描述是静态的，拓展装着就拿得到，只有卸载会缺（推送侧不同，连接上存 `platformSnapshot`）。

## 登录与账号

登录是一个中立状态机，面板只写一套扫码弹窗、状态、退出登录。

```ts
interface SourceAuth {
  methods: ("qr" | "cookie")[];
  beginLogin(method: "qr" | "cookie"): Promise<Result>;
  logout(): Promise<Result>;        // 不碰主密钥
  state(): AuthState;
  account?(): { name: string; avatar?: ImageRef } | null;
}

type AuthState =                   // 状态值用 kebab
  | { status: "logged-out" }
  | { status: "awaiting-scan"; qr: { image: ImageRef; expiresAt: string } }
  | { status: "scanned" }                  // 手机上已扫，等确认
  | { status: "logged-in"; loggedInAt: string }
  | { status: "expired" | "error"; message: string };
```

- `beginLogin` / `logout` 返回结果形状是按失败规矩（ADR-0026 决策 4）推出来的：今天拿二维码失败只打 warn、路由却回 `ok: true`。各自回哪些码，施工时定。
- ⚠️ `logout()` 不许碰主密钥：主密钥同时加密 AI key 等全部密钥，轮换它会让别的密文解不开。
- **系统 → 账号**为每个声明了 `auth` 的来源列一行。
- **排序**：主人拖动，存 `core.accounts.order`（进备份）。默认按登记顺序，B 站在前；新来源追加在末尾。
- **头部**显示排第一的账号；有多个账号时加小三角下拉。AI 对话里主人的头像同头部。
- **新手引导**的登录步由声明了 `auth` 的来源生成。
- 私聊指令 `login [来源]` 也读 `AuthState`，把二维码发回会话，见「指令」。推送侧连接的 `connectionAuth` 用同一个 `AuthState`（ADR-0024）。
- 面板登录态按 `SourceKey` 分开存。登录状态变化上总线 `subscription-auth-changed`。
- 核心账号模块住 `accounts/`；B 站原来的 AuthSystem 进 `bilibili/auth/`。
- 拓展积木 `qrLogin` 退役（从没实现过）。
- 凭据的备份与恢复全归宿主：备份信封按集成分格 `integrationSecrets`（内容就是各集成的 `ctx.secrets`），恢复回 `restoredIntegrations`。来源不再自己导入导出（原先设计的 `SourceAuth.secrets` 删掉）。
- 日志落盘前按当前全部密钥的真实值脱敏：`secrets` 值里的每一段字符串都按原文遮（很短的不遮）；还没存进 `ctx.secrets` 的临时凭据（比如扫码刚拿到的 token）由来源用 `ctx.redact(value)` 先登记。写死的 cookie 名正则删掉。代价：cookie 里不机密的值（比如登录账号的 uid）也会被遮掉。

## SourceContext

核心在 `start(ctx)` 时递给来源。ctx 分两层：每个集成都拿一份 `IntegrationContext`（日志、状态、凭据、设置、请求客户端、抓图、问题上报、生命周期）；`SourceContext` 在它上面加来源特有的名单与上报，推送侧的 `PlatformAdapterContext` 同理（见 [push.md](./push.md)）。拓展的 `activate(ctx)` 拿到的就是它的 `IntegrationContext` 加各登记方法；来源特有的那一层和内置的一样，经所登记实现的 `start(ctx)` 递进来，登记交回的把手只管注销（ADR-0025 决策 1）。**B 站与拓展用同一个 `SourceContext`**：类型统一，实例按集成各一个。上报只带 `externalId`，`sourceKey` 由核心按 ctx 补，所以拓展冒充不了 B 站。

```ts
interface IntegrationContext {
  logger: Logger;
  state: KeyValueStore;             // 游标、分页令牌、小索引；明文
  secrets: KeyValueStore;           // cookie、token；主密钥加密
  redact(value: string): void;      // 还没进 secrets 的临时凭据先登记，日志按值遮掉
  settings<T>(schema: ZodType<T>): { get(): T | undefined; onChange(fn: () => void): Disposable };
  http: HttpClient;                 // packages/http 的客户端（原 BiliHttpClient 去掉前缀），一个集成一个
  fetchImage(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal })
    : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
  storeImage(bytes: Uint8Array, opts?: { signal?: AbortSignal })   // 手里已是字节的
    : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
  reportProblem(p: { code: string; message: string; notify?: boolean }): void;
  resolveProblem(p: { code: string }): void;
  signal: AbortSignal;              // 集成停下时中止
  onDispose(fn: () => void): void;  // 集成停下时收尾
}

interface KeyValueStore {           // state 与 secrets 同一个接口，差别只在保管
  get<T extends Json>(key: string): T | undefined;   // 同步：宿主在 start 前读进内存
  set(key: string, value: Json): Promise<{ ok: true } | { ok: false; code: string; message: string }>;   // 宿主原子落盘
  delete(key: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

interface SourceContext extends IntegrationContext {
  subscriptions(): readonly SourceSubscriptionView[];   // 名单：只列启用中的，不带订阅 id
  onSubscriptionsChanged(fn: () => void): Disposable;   // 订阅变化的唯一通知；要做事就自己对比新旧名单
  reportPost(externalId: string, report: PostReport): void;
  reportLive(externalId: string, signal: LiveSignalReport): void;
  reportProfile(externalId: string, profile: CreatorProfileReport): void;   // 推送式平台主动报
  reportProblem(p: { externalId?: string; code: string; message: string; notify?: boolean }): void;
  resolveProblem(p: { externalId?: string; code: string }): void;
}

interface SourceSubscriptionView {  // 原拓展契约的 ExtensionOwnSubscription{ id, externalId, enabled }
  externalId: string;
  features: ReadonlySet<FeatureKey>; // 这个人开着的特性（只看开关，不看有没有目标）
}
```

| 成员 | 规矩 |
| --- | --- |
| `subscriptions` / `onSubscriptionsChanged` | 名单只列启用中的订阅，条目 `{ externalId, features }`、不带订阅 id；同一人遗留的重复订阅合成一条、`features` 取并集。**开了开关才干活**：单个订阅开了作品或直播类开关，来源才去监听（没开直播就不连弹幕、没开作品就不拉也不抓图），统计也只记开着的；「开着」只看开关、不看有没有目标（ADR-0027 决策 1）。来源只上报名单里的人。B 站也用这份名单，不再拿完整的订阅对象 |
| `reportPost` | 核心按身份展开成每条订阅一份 `PostEvent`（正常一条，老数据里的重复各一份），再发 `post-detected` 进作品装配；查不到或已停用就丢弃、记 debug 日志。判新、去重、限流归来源。来源交完就前移自己的锚点，投递失败由核心按目标重试（见 [push.md](./push.md)） |
| `reportLive` | 同样按身份展开，喂场次引擎 |
| `reportProfile` | 推送式平台主动报资料；按资料刷新的间隔限密 |
| `reportProblem` / `resolveProblem` | 见下「问题上报」 |
| 上报被拒 | 上报类（`report*`、`reportProblem`、`resolveProblem`）一律 `void`：被拒（种类没声明、id 不合法、形状坏）或被丢格，记进该集成的 `reportRejections` 表并打 warn 日志，来源不知道；报的人不在名单里照旧静默忽略。被拒都是来源自己的 bug，运行时改不了，回结果只会诱导它重报；拓展契约从 v2 的 reject 改成这样。内置集成（B 站与内置适配器）的上报被拒就是 BN 的 bug，只打错误日志、靠对拍守卫兜，不进 `reportRejections` 的展示面 |
| `fetchImage` | 走集成自己的客户端（同一套 cookie、身份与默认头），来源带着自己要的请求头去抓；拦内网地址防 SSRF（每一跳重定向都查）、单张 8MB、按内容嗅探格式、超时，这一层只在 `fetchImage` 上；按 sha256 存进图库，交回 `ref`。失败：404 回 `not_found`；超 8MB、不是图、内网地址回 `invalid`；超时回 `timeout`；网络或上游 5xx 回 `unavailable`。默认头怎么设，施工时定。被否的备选：来源在上报里直接交字节；来源声明 `imageFetch { hosts, headers, rewrite }` 由核心代抓 |
| `storeImage` | 手里已是字节的图走它（本地生成的扫码二维码，B 站也用；要来源自带客户端才抓得到的签名 / TLS 指纹 / POST 图；接口内嵌 base64）。同一套格式嗅探与单张 8MB，存进同一图库；超 8MB、不是图回 `invalid`。上报一律只收 `ImageRef` |
| `state` | 宿主托管的小键值存储，明文、不脱敏。单键 64KB、每个集成 1MB。落 `runtime/bilibili/state.json` 或 `runtime/extensions/<id>/state.json`；跟代走、不进备份、卸载与全新开始时清。`http.` 开头的键归宿主（`ctx.http` 的浏览器身份） |
| `secrets` | 用主密钥加密，一个集成一个文件：`secrets/bilibili/secrets.enc` 或 `secrets/extensions/<id>/secrets.enc`（B 站原来的 `cookies.enc` 改名并入）；每个集成 256KB；仅完整备份（普通备份抹掉）；卸载与全新开始时清掉；值里的每一段字符串按原文脱敏（很短的不遮）。`http.` 开头的键归宿主（`ctx.http` 的 cookie 罐） |
| `state` / `secrets` 的写与删 | 返回结果形状、不抛：超上限或写了 `http.` 前缀回 `invalid`，磁盘写失败回 `unavailable` |
| `redact` | 临时凭据按值登记脱敏；存进 `secrets` 的值自动覆盖，不用再登记 |
| `settings(schema)` | 和拓展同一个用法（`get` 与 `onChange`）：B 站拿 `bilibili` 段，拓展拿 `extensions.<id>` 段；校验就发生在这一步，见「设置」。交回的读取把手叫 `SettingsReader<T>`（原拓展契约的 `ExtensionSettings<T>`） |
| `http` | 见下「请求客户端」 |
| `signal` / `onDispose` | 集成停下时 `signal` 中止在途调用、`onDispose` 的回调收尾；先后是宿主先调实现自己的 `stop()`，再中止 `signal`、跑 `onDispose` 登记的收尾（ADR-0025 决策 5）；内置集成与拓展走同一套生命周期 |
| `logger` | 来源名写进日志行已有的 `name` 字段（`bilibili` 或拓展 id），不拼进正文；面板日志页可按来源筛 |

核心收到上报后**兜底再查一次名单**：名单变化和上报之间可能有时间差（主人刚停用某条订阅），来源自己也可能有 bug。

没有 `reportSubscriptionsChanged`：B 站的「关注同步」是 BN → B 站单向（订阅了谁就补关注谁，因为动态从关注流里拉），全在 B 站内部，挂在 `onSubscriptionsChanged` 回调、开机、重新登录之后；仓里从来没有「平台那头关注列表变了反过来改 BN 订阅」的功能。

**来源不读写文件**：状态与凭据全由宿主托管，请求走 `ctx.http`，来源拿不到任何文件路径。B 站由守卫强制（`bilibili/` 里 import `fs` 就红）；拓展这边见 [extension-contract.md](./extension-contract.md)。

### 请求客户端

- 新中立包 `packages/http`：从 B 站的实现里抽出请求客户端、cookie 罐与浏览器身份。宿主给每个集成建一个客户端，经 `ctx.http` 拿（`bilibili/` 整块共用一个，一个拓展一个）。BN 自己的请求不用它：客户端带着集成的身份与 cookie，BN 自己的请求不该冒用。
- cookie 由宿主自动存进该集成的 `secrets`（`http.` 前缀）。
- `websocket(url, opts?)` 只负责用集成的身份建连、集成停下时自动关；帧、心跳、重连归集成。
- 不加别的协议：SSE 需要时给请求加「原样交出响应流」的选项；出站代理以后挂在这里。
- 重试、退避、限流归集成，BN 侧不替它限流。
- 整体不拦内网（局域网里的 RSSHub 要连得上）；拦内网只在 `fetchImage` 那条路上。
- 浏览器身份生成一次、存进该集成的 `state`（`http.` 前缀），重启照用；只在发版把版本区间前挪、存的低于下限时升级，只升不降。UA 与 `sec-ch-ua` 永远配套，没有自定义 UA。
- 1.0 对拓展整套开放（请求、websocket、默认头、cookie 自动存、身份自管）；第 6 期的抖音拓展是第一个拓展用户。

### 设置

- 设置只有一个词 `settings`；`config` 只指存储（`config/` 目录、`ConfigStore`、`bn.config.yaml`）。
- **按集成放**：声明了 `settingsFields` 的内置集成在系统页各开一个 tab（今天只有 B 站；tab 名取它的 `label`，面板代码里不出现 `bilibili`），用通用的设置表单与对表门；拓展的设置只在拓展页，功能页面放指过去的入口；「运行」tab 只留核心参数。设置字段挂在集成的登记上，不挂在 `SourceDescriptor` 上（一个集成可能同时提供来源与适配器，ADR-0025 决策 3、ADR-0027 决策 6）：B 站的 `settingsFields` 在 `compose.ts` 登记集成时交（脸取来源的描述符），拓展的写在清单里。面板从哪个路由拿集成的设置字段，施工时定。
- **坏了只停那一处**：`bilibili` 段、拓展段校验不过，只停那一个集成，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起；BN 照常开机。校验发生在 `start` 里调 `settings(schema)` 时：只有 `start` / `activate` 期间读设置失败可以抛错中止启动，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。
- 理由：BN 起不来时，桌面壳连续失败几次就把这一版判死、自愈退回 0.12，而且进不去面板改设置；Docker 则反复重启。

### 问题上报

- 问题一律进面板问题框；`notify: true` 再私聊主人。严重度与文案由来源定。
- 核心只守一条底线：同一报的人（`reporter`）、同一 code 的私聊 60 秒内只发一次。
- 核心收到每条问题自动记一行日志。问题上报不设「只记日志」档，只想记日志就用 `ctx.logger`，两者不合并。
- **问题表只有一种形状，全在内存**：`Problem { reporter: IntegrationKey | "core", about?: { subscriptionId } | { connectionId }, code, message, since }`。来源不填 `externalId` 就是来源本身的问题（如登录失效）；填了由宿主换成订阅 id。`since` 记第一次出现，重复报只更新文案。平台适配器带 `connectionId`，宿主核它是不是这个适配器的；核心自己直接写，code 表明是哪个模块（如 `renderer_unavailable`）。
- **一条生死规矩**：报的人 `resolveProblem` 按 code 清；报的人停下，它报的全清；对象删了，关于它的全清。订阅运行态不再存问题。
- **谁看**：订阅卡、连接卡看关于自己的，问题框看全部；来源本身的问题只在问题框与健康卡，不在每张订阅卡重复。`GET /api/problems` 一次给全；变了发总线事件 `problems-changed`（只带键），经 `state` 频道、250ms 合并。
- 代价：重启后的头几秒，订阅卡上的问题红字会先消失，等来源重报（开机时关注同步与第一轮资料刷新几秒内就会重报）。
- code 用 snake：`follow_failed`、`login_expired`、`creator_not_found`。
- B 站也走它：比如「登录失效」以 `notify` 上报、文案自己写。B 站内部按因果分层，只报最上面那一条开着的根问题：未登录 → 风控 → 各项请求失败，下面的只记日志；根问题按状态报（开机就没登录也报），清掉后下一层照常报、停掉的监听拉起来；不同报告方互不遮挡（ADR-0025 决策 11 下 10-03 的 🔗）。关注同步失败照旧报 `follow_failed`，文案沿用现在的「未关注该 UP —— 收不到动态（原因）」（原因就是原来的 `followError`），补关注成功就 `resolveProblem` 清掉；订阅卡上的红色警告文字不变。它和别的问题一样只在内存、不再存盘，重启后由下一轮关注同步重报。
- 来源级问题不再走 `engine-error`。

### 健康与运行状态

- 内置集成的运行状态只取 `running` / `failed` / `settings-invalid`；内置集成与拓展走同一套生命周期（`start(ctx)`、`AbortSignal` 中止、`onDispose` 收尾；收尾时先调 `stop()`，再中止 `signal`、跑 `onDispose`）。系统页、健康卡、`status` 指令与 `/api/sources` 的 `status` 都读它。
- `health?()` 交 `SourceHealth = { summary: string }`，只给健康卡与 `status` 指令一行字。
- **订阅卡的「暂停 / 不可用」不看 `health()`**：看运行状态（「{label} 没在跑」）与问题表里关于这条订阅的条目。
- 健康卡分两排：核心（持久化、订阅、推送、卡片、AI）与集成（每个集成一格；推送适配器有连接才占格；同时供来源与适配器的拓展也只占一格）。集成格的灯按运行状态与问题分四色（绿正常、黄有问题、红失败或设置不合法、灰停用）；小字取 `health().summary`，没实现就写运行状态，登录态由宿主从 `AuthState` 补。
- 数据放 `/api/health/details`；短版 `/api/health` 只留存活探测要的 `status`、`version`、`startedAt`、`uptime`（应用内更新靠 `version` 与 `startedAt` 认新进程），B 站的格子删掉。卡片的界面第 4 期先出设计稿再重做。

## 资料刷新与「在记」

**资料**：

- 核心按 `core.profileRefreshCron`（由 `fansCron` 原值迁来）定时调 `fetchProfile`，只调启用中的订阅（09-27 拍板；和名单只列启用中一致，也少打平台接口）。停用的订阅资料缓存停在停用那一刻，面板照常显示最后一次的名字与头像，重新启用后下一轮刷新。
- 对同一来源**串行**调用；防风控的间隔由来源自己管（B 站那个 200ms 留在 `bilibili/`）。失败怎么算见「SubscriptionSource」表里的 `fetchProfile`：`not_found` 记问题，其余下一轮再来，整轮刹车归来源。
- 来源主动 `reportProfile` 的，按同一个间隔限密。
- 粉丝数就在资料里，粉丝轮询并进这项必备能力，不另占能力位。涨粉的增量、时序、首页粉丝面板由核心算，上总线 `followers-refreshed`。
- 资料另有中立的可选字段 `fanClubName`（粉丝团名，平台没有就空），模板变量 `{fanclub}`（原 `{mdn}`）取它。
- 头像：来源先 `ctx.fetchImage` 抓进图库，再交 `ImageRef`。B 站在 `bilibili/` 里带 Referer 下载，图链没变不重抓。面板一律走同源地址、出卡一律从本地内联，删掉 `no-referrer` 绕行。
- 动态轮询不在此列：B 站拉的是整条关注流，没法按订阅逐个拉。

**统计只记开着的**：单个订阅开了作品开关才记作品，开了直播类开关才记场次；关了就不查也不记（ADR-0027 决策 1）。

**「在记」按特性分**（ADR-0027 决策 2），核心自己算：

- 作品：那天作品开关开着，且来源在跑；
- 直播：那天直播类任一开关开着，且来源在跑；
- 粉丝：那天拉资料成功。

每张图（热力图也是）读自己的「在记」，关着的日子显示「没在记」、不画成 0；锐评与榜单跳过没在记的日子。seen（「那天有没有联系上来源」）不再单独当判据。在播状态与当前粉丝数取在播表与资料缓存。每天的开关与运行状态怎么记下来（统计仓里原来的 `seen/` 留不留、改装什么），施工时定。

统计记录开着作品的订阅的全部作品，另外记其中带视频的那些。面板与 CSV 仍叫「投稿」「动态」：投稿 = `videoPosts`，动态 = `posts − videoPosts`（面板相减）；锐评提示词同样这么算。

## 直播

两套场次引擎合成一套：原先拓展那套（本就中立）去掉 `Extension` 前缀升格为核心 `live/`，B 站的 `room-session-base` 删掉。

删 B 站的 `room-session*` 之前，先把醒目留言、会员、特别弹幕、特别进场的装配从 `room-session.ts` 抽进 `live/`（它们是核心中立特性的装配，不跟着 B 站引擎走）。

来源只有两种输入：

| 输入 | 形状 | 谁用 |
| --- | --- | --- |
| 推送式信号 | `ctx.reportLive(externalId, LiveSignalReport)`：`start` / `status` / `end` | 拓展照现在的上报走；B 站在 `bilibili/` 把弹幕通道的开播、下播、状态翻成这三种 |
| 拉取式 | 核心按场次定时调 `fetchLiveStatus` | 提供了它的来源 |

`fetchLiveStatus` 返回结果形状（ADR-0026 决策 4）：`{ ok: true, kind: "live" | "offline", … } | { ok: false, code, message }`，成功那一支的判别键是 `kind`：

| 结果 | 核心怎么做 |
| --- | --- |
| `ok: true, kind: "live"` | 推「正在直播」卡 |
| `ok: true, kind: "offline"` | 此刻没在播：当成漏收的下播，走 `end` 同一条路（含断流宽限与私聊主人） |
| `ok: false`（带 `code` + `message`） | 跳过这一轮、记一条问题；**不再停止监听** |

- 计时按每一场的开播时刻各自起算（`LiveSession.nextTickAt`），不全局同时拉。间隔是 `liveStreaming.streamingIntervalHours`。
- 同一来源串行调用；超时与中止复用 `searchCreators` 那套外壳；拓展停用时用 signal 取消在途调用。
- **重启**后核心对每条开着直播推送的订阅调一次 `fetchLiveStatus` 重建场次；要不要补推一张正在直播卡由 `liveStart.catchUpOnBoot` 统一决定。补报不 @全体、历史记成开播，见 data-model「特性键」。
- 断流：收到 `end` 先进 `pendingEnd` 等宽限，宽限里又开播就 `resume` 接着同一场；等满了才 `end`。
- 场次的每次变化是一条 `LiveSessionChange`，推送、统计、总线（`live-session-changed`）吃同一份。
- ⛔ 场次身份按开播时刻认、排在闩之前；统计 `current` 与 `isLive` 的语义不动。
- 「这条订阅会不会被监听」全仓只有一处判定（在 internal），首页与服务端共用：单个订阅开了直播类开关就监听，只看开关、不看有没有目标。面板的「不会被监听」与直播就绪判断都用它（今天面板只看有没有目标，还自抄一份路由键，是一句假话）。
- **醒目留言**：`SuperchatEvent` 带可选的 `tier { rank, durationSec? }`，由来源按平台规矩算；卡按档取色（默认配色照今天六档，皮肤可按档换色），有留言时长就显示。
- **验收**：先在旧引擎上用端到端测试钉住开播、下播、断流接续、漏收下播兜底四种行为，再换新引擎跑同一组。
- 被否的备选：拓展自己计时上报（每个拓展都得重写一遍计时）；BN 发事件要数据、拓展再另报（对不上是哪一轮要的，拓展还能自己触发推送）。

## 预览

- 预览请求带 `subscriptionId`；裸 uid / 房间号输入框删掉，改成「从订阅里挑一条」。
- 来源实现了 `fetchPreview`（`/api/sources` 的 `has.preview`）就用真数据，没实现就用示例数据。
- SC、会员卡的付款人取该来源 `auth.account()`，没有就用示例名字。
- 「按订阅覆盖」卡片皮肤与旋钮对所有订阅开放。

## 横切接口

```ts
interface LinkResolver {
  label: string;                   // 链接解析器的名字，面板「链接预览」页列出来
  matches(url: string): boolean;
  resolve(url: string, signal: AbortSignal): Promise<Result<LinkPreview>>;
}
interface LinkPreview {
  post: Post;
  canonicalId: string;             // 冷却键的一格
  nativeShare?: {                  // 原生分享的中立描述，由推送适配器去签
    appId: string; title: string; description: string;
    imageUrl: string; pagePath: string; webUrl: string; iconUrl?: string;
  };
}
interface AiToolProvider {
  readOnly: AiTool[];              // 可以挂在推送路径上
  chat?: AiTool[];                 // 只开给聊天
  skills?: MaidSkill[];            // 连同工具带来的技能
}
interface DevtoolsProvider { scenarios: DevScenarioDef[] }   // 只在开发版登记
```

| 接口 | 核心负责 | 来源负责 |
| --- | --- | --- |
| `LinkResolver` | 闸门与出口，见「链接预览」 | 认链接（`matches`）、解析成 `LinkPreview`（出的是 `Post`）；可选给原生分享的中立描述 |
| `AiToolProvider` | 生成器、人格、六把中立只读工具与六个内置技能，见「AI 工具」 | 来源独有数据的只读工具与技能 |
| `DevtoolsProvider` | 只认接口与登记表，不认识任何一家来源 | 自己的造状态 / 造事件场景，见「devtools 场景」 |

- 这三个接口的登记表在核心照做、B 站照用；1.0 只对拓展开 `devtools`，其余两个见 [extension-contract.md](./extension-contract.md)。
- 指令没有来源的接口，见「指令」。

### 链接预览

群里贴链接，回一张预览。

- 统一叫「链接预览」（原「链接解析」「链接卡片」「小程序卡」）：目录 `link-preview/`；设置 `linkPreview { enabled, replyForm, byTarget }`，由 `linkParsing` 迁移（原定的 `linkCards` 作废）；解析器仍叫 `LinkResolver`（链接解析器）。
- **闸门在核心**：开关、按目标的表、冷却、硬上限、失败不出声、一条最多三个、从分享卡取链接。冷却键是「群 + 解析器 + `canonicalId`」。
- **挑链接**：核心先用通用网址正则挑出候选，再问各解析器的 `matches`。出口不按平台域名预筛：OneBot 入站的 B 站域名预筛删掉，64KB / 8 层的上限保留。
- **入站链接带来源标记**（正文 / 普通卡 / 原生分享卡），取代 `miniAppCardLinks`；规矩是「原生分享卡里的链接不回预览」。桥帧里那一格进 alpha 之后两步改名的清单；它是插件发给 BN 的入站字段，两步反过来走：BN 先同时认新旧两种写法，插件再改发新的。
- **回复形式** `replyForm` 取 `image` / `nativeShare` / `text`，面板上是「回图片 / 回原生分享 / 回文字」。原生分享由 OneBot 适配器拿中立描述去签，签不了就回图片（签不了原生分享的出口会一直回图片）。施工先查签名接口收不收通用参数，不收就在适配器内部放一张 appId → 预设的对照表。
- **回复**经 `TargetDispatcher.sendToAddress` 发回原会话：不进路由、不过闸、不落历史，但要查 `isAvailable`、结果带 code、由截流统一记，不重试。原先现造的临时目标删掉。

### 指令

- **框架在核心**：入站链路、鉴权门、确认流、参数、错误反馈、近似建议；通用指令 `help`、`mute`、`report`、`status`、`login`。`status` 里每个集成那一行取运行状态与 `health()`。
- 交给登记表的一整包叫 `CommandDef`（代码里的 `CommandSpec` 改名），字段不变。
- `run(values, ctx: { reply(payload), signal })` 返回结果形状（成功 `{ ok: true }`）；`reply` 经 `TargetDispatcher.sendToAddress` 回到发指令的那个会话（原先回到主人目标那条连接），送没送到照返。
- 返回失败时框架回「『{指令名}』没办成：{message}」；抛错回「出错了，详情在日志里」，并记错误日志（今天出错只打日志、不回话）。
- **`login [来源]` 是核心的通用指令**：只装了一个带登录的来源就直接扫它，装了多个就列出来让主人挑；二维码取自 `AuthState`，经 `reply` 发图。B 站不再自带指令。
- 于是 1.0 没有来源自带的指令，`CommandProvider` 登记表先不造：没有实现者的接口先不造。来源自带指令与指令重名的规矩，等第一个真要自带指令的拓展再定。

### AI 工具

- **六把中立只读工具**：`list_subscriptions`、`get_creator_profile`（读资料缓存）、`get_creator_posts`（读统计仓最近几条）、`get_live_status`（读在播表）、`search_creators(source, query)`（转给该来源的 `searchCreators`）、`get_creator_stats(creator, days?)`（读统计仓：作品数、视频作品数、直播场次与时长、涨粉、最后活动）。
- 中立工具的参数统一叫 `creator`，值是「来源键:外部 id」（按第一个冒号切）；核心工具参数里不许出现 `uid`（进 AI 约束守卫）。`list_subscriptions` 与 `search_creators` 的返回带着它。没订阅的人，读缓存类工具答查不到。
- **六个内置技能**全部跨来源、只用中立工具；`find-up` → `find-creator`、`up-pk` → `creator-pk`，旧名留别名。技能的 `allowedTools` 在迁移时按新工具名变换。
- **来源独有的数据**经来源的 `AiToolProvider` 登记只读工具：B 站的总播放、获赞、视频列表；B 站版的周报由 B 站自己以技能提供。
- `AiTool` 加 `label` 与参数标签，面板读下发的，不再写死一张表。缺工具的女仆技能面板自动隐藏；面板里找不到工具的 3 条死标签（`subscribe_user`、`unsubscribe_user`、`update_subscription`）删掉。
- 工具返回的图也是 `ImageRef`；看图时由宿主注入的读图函数读图库，`packages/ai` 不碰磁盘。
- **提示词跟着来源叫**：内置人格、卡片工坊、锐评、内置技能与工具说明里的平台叫法改用 `{creatorNoun}`、`{postNoun}`、`{sources}`，调用时由核心按这次涉及的订阅填（规矩同「叫法」）；主人自己写的不改写，内置预设改版照旧亮「默认文案有更新」；风格性的写法（「B 站弹幕解说员」「B 站梗」）改成中性。

### devtools 场景

- `DevtoolsProvider { scenarios: DevScenarioDef[] }`，只在开发版登记；过线给面板的纯声明叫 `DevScenarioDescriptor`。
- 场景 id 由宿主加前缀（`bilibili.xxx`、`<拓展 id>.xxx`），不会撞名，也冒充不了别家。
- 参数按提供方收窄：来源用新种类 `creator`（值是自己名单里的 `externalId`）；推送适配器只能挑自己的连接；`sub` / `target` 只给核心。
- `run` 返回 `{ ok: true, summary? }` 或失败：参数不合法回 `invalid`，场景找不到回 `not_found`；原来那两个异常类（`DevParamError`、`DevScenarioNotFound`）删掉。`active` / `reset` 不变。
- 场景只用自己集成的 ctx 做事（B 站「造一条新动态」就调 `ctx.reportPost`），核心的句柄不交出去；B 站现在直捅引擎的场景，搬家时改。

## B 站怎么实现

`apps/server/src/bilibili/` 放 B 站的全部：

| 子目录 / 件 | 内容 |
| --- | --- |
| 原 `api` / `blive` / `dynamic` / `live` 四包 | 各成子目录；B 站接口响应类型（Dynamic、RichTextNode、LiveData）只住这里。请求客户端、cookie 罐与浏览器身份抽进 `packages/http`，不留在这里 |
| `SubscriptionSource` 实现 | 拉动态翻成 `PostReport`（见下「作品映射」）、弹幕通道翻成 `LiveSignalReport`、关注同步、资料拉取、`searchCreators`、`fetchLiveStatus`、`liveInteractions` |
| `auth/` | 扫码登录（原 AuthSystem），对外只交中立的 `AuthState`；内部若还要一个原形，叫 `BiliLoginState`。cookie 由 `ctx.http` 的 cookie 罐存进 `ctx.secrets` |
| `LinkResolver` | B 站视频链接识别与解析；给原生分享的中立描述 |
| `AiToolProvider` | B 站独有数据的只读工具（总播放、获赞、视频列表）与 B 站版周报技能 |
| `devtools/` | `DevtoolsProvider`，只在开发版登记；场景只经 B 站自己的 ctx 做事 |
| 翻译表 | 大航海等级表与等级名（`guard_level` 反向换算）、档色（原面板的 `guard-levels.ts`，进 B 站的描述符）、醒目留言的档位规矩、风控码集合、响应解包、CDN 缩放后缀与 Referer、「大航海舰队」文案 |

- **只经中立接口进核心**，在 `compose.ts` 登记（见 [architecture.md](./architecture.md)）。
- **只报 uid**：B 站按 uid（即 `externalId`）上报，由核心展开成订阅 id；B 站不知道订阅 id，只用 `ctx.subscriptions()` 的名单决定拉谁。
- **请求走 `ctx.http`**：B 站的请求与弹幕 websocket 都经 `ctx.http` 拿，用 B 站这个集成的身份与 cookie；帧、心跳、重连、重试、退避、限流归 `bilibili/`。
- **开了开关才监听**：关注流只能整条拉，名单里没开作品的人，那条不抓图、不上报；没开直播类开关的人不连弹幕。原先为了统计让时间线覆盖每条订阅的做法，随 ADR-0027 决策 1 推翻。
- **进门换 ISO**：`live_time` 是不带时区的北京时间，在这里转。
- **作品映射**：`text` 只放正文（动态正文、图文摘要）；图文标题进 `article.title`，视频标题进 `video.title`，转发的原作品进 `repost`。UP 自己的视频进 `post.video`；番剧、合集、课程进附件的视频卡。附加块翻成 card / video / goods。过滤、AI、出图都经核心 `posts/` 里同一个取段函数读这份字。
- **开播公告直接丢**：开播时生成的那条伪动态不上报，统计也不再记（旧数据照原定不搬）。
- **资料**：`fanClubName` 填粉丝牌名。
- **醒目留言**：`tier` 由 B 站按平台规矩算，卡按档取色。
- **禁 fs**：B 站的状态（`roomId`、`followed`、`followError` 等）只走 `ctx.state`，cookie 只走 `ctx.secrets`；动态游标仍只在内存。
- **设置**：B 站段 `settings.bilibili`（`dynamicCron`、`loginCheckIntervalMinutes`）由 `bilibili/` 定义，核心不许读。系统页为 B 站单开一个 tab，名取它的 `label`（见「设置」）。`bilibili` 段校验不过只停 B 站这一个集成：来源、链接解析器、AI 工具都不登记，订阅卡显示「{label} 没在跑」，B 站 tab 显示原值、「设置不合法」与原因并进问题框，改对了当场起；BN 照常开机。
- **删掉自定义 UA**：身份一律由 `packages/http` 生成，UA 与 `sec-ch-ua` 永远配套；B 站设置页加「换一个身份」按钮，重新生成一套。老配置里的 `userAgent` 这一格由迁移丢掉，新 schema 不留。理由：填了自定义 UA，`sec-ch-ua` 仍是生成的 Chrome 身份，拼出一个自相矛盾的指纹；风控 -352 的第一嫌疑本来就是 TLS 指纹，不是 UA。
- **补关注**（BN → B 站单向）：在 `onSubscriptionsChanged` 回调、开机、重新登录后各跑一次。整份名单先批量查关系、只补缺的（稳态写请求为零）；失败按「问题上报」报 `follow_failed`。登录态失效时跳过；批量查询回 -101 按「没登录」整批跳过，订阅卡上的关注状态不动，等登录恢复再跑；其他失败码仍走降级。停用的订阅不在名单里，自然不补；从停用改回启用时名单变化，那一轮就补上。
- **开机不碰 B 站**：`start()` 不预取 ticket（WBI 签名时现取）；未登录开机不补关注。开机那一刻连不上 B 站、或 ticket 接口回风控码，都不许拦住 BN 起来（第 0 期测试拦外网时查出：预取失败曾让整台 BN 起不来；分期见 [construction-plan.md](./construction-plan.md)）。ticket 请求和别的请求用同一个身份：原先固定用默认 UA 的特例删掉（建仓时从老插件原样搬来，没有留下理由）。
- **风控码**：-412 在拉粉丝时算风控、刷 cookie 时算登出，各处不一，先验证再定。
- **失败码**：B 站接口的数字错误码放在 `upstreamCode`，不占错误体的 `code`；`code` 取标准码表（风控 `rate_limited`、没登录 `unauthorized`……）。
- 验收检查点：「接口先行」那一期（3a，见 [construction-plan.md](./construction-plan.md)）完成时，B 站全经中立接口运行、行为不变。
