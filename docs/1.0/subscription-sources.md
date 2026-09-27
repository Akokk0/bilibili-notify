# 1.0 订阅来源与横切接口

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

`SubscriptionSource` 全接口、来源的自我介绍、登录与账号、核心递给来源的 ctx、资料与直播怎么拉、四个横切接口，以及 B 站怎么实现它们。数据类型（`Post`、`LiveSignal`、`Identity`……）见 [data-model.md](./data-model.md)；登记表与装配根见 [architecture.md](./architecture.md)；拓展能用其中哪些见 [extension-contract.md](./extension-contract.md)。

## 一句话

**`SubscriptionSource` 只管「订阅一个人」。** 链接解析、指令、AI 工具、调试场景跟订阅无关，各是一个小接口。B 站直接实现它们，拓展由宿主经契约转一道；分派一律按 `identity.sourceKey` 查登记表（键是 `"bilibili"` 或拓展 id，不加前缀）。**来源只认人、不认订阅**：上报只带 externalId，BN 内部的订阅 id 来源永远看不到。

## SubscriptionSource

```ts
interface SubscriptionSource {
  descriptor: SourceDescriptor;
  // 必备
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
  searchCreators(query: string, signal: AbortSignal): Promise<CreatorCandidate[]>;   // 解析门：链接 / id / 名字原样交进来
  fetchProfile(identity: Identity, signal: AbortSignal): Promise<CreatorProfileReport | null>;   // 也就是「按 id 取人」
  // 可选
  auth?: SourceAuth;
  fetchLiveStatus?(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult>;
  liveInteractions?: LiveInteractions;     // 弹幕、SC、会员、进场
  health?(): SourceHealth;                 // 健康页与 status 指令的一行；订阅卡的「暂停 / 不可用」
  fetchPreview?(identity: Identity, kind: "post" | "live", signal: AbortSignal)
    : Promise<PostReport | LiveCardInput | null>;
}
```

| 成员 | 必备？ | 谁调、什么时候 | 要点 |
| --- | --- | --- | --- |
| `descriptor` | 是 | 面板、锐评、模板随时读 | 见下一节 |
| `start` / `stop` | 是 | 开机、关停、拓展启停 | `start` 拿到 ctx；`stop` 后不许再上报 |
| `searchCreators` | 是 | 新建订阅弹窗打字时 | 「解析门」：输入框里是链接、id 还是名字都原样交进来，来源自己认；最多回 10 个 `CreatorCandidate`；错误文案由来源给，原话到面板 |
| `fetchProfile` | 是 | 核心按资料刷新 cron 定时调；按 id 取人也是它 | 头像先 `ctx.fetchImage` 再交引用；原先设计的 `lookupCreator` 与它重复，删掉 |
| `auth` | 否 | 系统 → 账号 | 见「登录与账号」 |
| `fetchLiveStatus` | 否 | 核心按场次定时调 | 三态，见「直播」 |
| `liveInteractions` | 否 | 直播中 | 走能力回调还是总线施工时定 |
| `health` | 否 | 健康页、`status` 指令 | 交一行状态（原 `status()`） |
| `fetchPreview` | 否 | 卡片页预览 | 没实现就用示例数据 |

`SubscriptionSource` 共 10 个成员：descriptor、必备 4 个、可选 5 个。没有单独的「新建 / 启用订阅」钩子（原 `onSubscriptionAdded`，一度改名 `onSubscriptionActivated`）：它和 ctx 的 `onSubscriptionsChanged` 重复，删掉。来源要在订阅变化时做事，一律用 `onSubscriptionsChanged` 自己对比新旧名单。

新建订阅弹窗只有一套流程：选平台 → 一个输入框搜索 → 预填资料；去重用 identity（同一身份只能有一条订阅，见 [data-model.md](./data-model.md)）。搜人接口是 `GET /api/sources/:sourceKey/creators?q=`，提示文字取 `descriptor.searchPlaceholder`（B 站「UID、主页链接或名字」）。B 站的实现：纯数字按 UID 精确查、主页链接先抽出 UID、其余按名字搜。候选头像也是图库引用，没被订阅用上的由图库按引用清扫。

## SourceDescriptor

来源的自我介绍。面板与锐评只读它（经 `GET /api/sources` 下发），所有 `isBili` 分叉删掉。拓展清单的 `contributes.subscription` 直接写这些同名字段（见 [extension-contract.md](./extension-contract.md)）。

```ts
interface SourceDescriptor {
  label: string; shortLabel?: string; color?: string;
  postNoun?: string;               // 这个平台管作品叫什么；缺省「作品」，B 站「动态」
  creatorNoun?: string;            // 这个平台管创作者叫什么；缺省「创作者」，B 站「UP主」
  searchPlaceholder?: string;      // 搜人输入框的提示；B 站「UID、主页链接或名字」
  supportedFeatures: FeatureKey[]; // 支持哪些特性（开关、规则节按它铺）；订阅上「开没开」才叫 features
  supportedExtras?: ExtraKey[];    // 支持哪些附加项
  membershipPrograms?: MembershipProgram[];   // 会员体系
}
```

- 特性开关、附加项、规则节、平台徽章、CSV 平台列、锐评平台名全从 descriptor 取。
- B 站那一行的平台徽章，只在装了第二个订阅源时才画。
- **用词**：只涉及一个来源的地方用它的 `creatorNoun`；混着多个来源的地方用「创作者」；只装了 B 站时混合处也用 B 站的叫法。
- `postNoun` 进模板变量 `{noun}`，默认文案「{name}发布了一条{noun}」。B 站用户的推送文字一字不差；盘上还是老默认的，面板亮「默认文案有更新」，主人点了才换，不静默改写。
- 特别关注这项设置只在 `supportedFeatures` 含 `specialDanmaku` 或 `specialUserEnter` 时露出。
- `liveStreaming` 开关只在来源提供了 `fetchLiveStatus`、并且同时上报开播与下播时显示。

## 登录与账号

登录是一个中立状态机，面板只写一套扫码弹窗、状态、退出登录。

```ts
interface SourceAuth {
  methods: ("qr" | "cookie")[];
  beginLogin(method: "qr" | "cookie"): Promise<void>;
  logout(): Promise<void>;          // 不碰主密钥
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

- ⚠️ `logout()` 不许碰主密钥：主密钥同时加密 AI key 等全部密钥，轮换它会让别的密文解不开。
- **系统 → 账号**为每个声明了 `auth` 的来源列一行。
- **排序**：主人拖动，存 `core.accounts.order`（进备份）。默认按登记顺序，B 站在前；新来源追加在末尾。
- **头部**显示排第一的账号；有多个账号时加小三角下拉。AI 对话里主人的头像同头部。
- **新手引导**的登录步由声明了 `auth` 的来源生成。
- 面板登录态按 `SourceKey` 分开存。登录状态变化上总线 `subscription-auth-changed`。
- 核心账号模块住 `accounts/`；B 站原来的 AuthSystem 进 `bilibili/auth/`。
- 拓展积木 `qrLogin` 退役（从没实现过）。
- 凭据的备份与恢复全归宿主：备份信封按来源分格 `sourceSecrets`（内容就是各来源的 `ctx.secrets`），恢复回 `restoredSources`。来源不再自己导入导出（原先设计的 `SourceAuth.secrets` 删掉）。
- 日志落盘前按当前全部密钥的真实值脱敏；还没存进 `ctx.secrets` 的临时凭据（比如扫码刚拿到的 token）由来源用 `ctx.redact(value)` 先登记。写死的 cookie 名正则删掉。

## SourceContext

核心在 `start(ctx)` 时递给来源。上报通道都是事件（来源 → 核心），另有名单、抓图、状态、凭据、日志几样工具。**B 站与拓展用同一个 `SourceContext`**，只是命名空间不同。上报只带 `externalId`，`sourceKey` 由核心按 ctx 补，所以拓展冒充不了 B 站。

```ts
interface SourceContext {
  subscriptions(): readonly SourceSubscription[];   // 名单：只列启用中的，不带订阅 id
  onSubscriptionsChanged(fn: () => void): Disposable;   // 订阅变化的唯一通知；要做事就自己对比新旧名单
  reportPost(externalId: string, report: PostReport): void;
  reportLive(externalId: string, signal: LiveSignalReport): void;
  reportProfile(externalId: string, profile: CreatorProfileReport): void;   // 推送式平台主动报
  reportProblem(p: { externalId?: string; code: string; message: string; notify?: boolean }): void;
  resolveProblem(p: { externalId?: string; code: string }): void;
  fetchImage(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<ImageRef>;
  storeImage(bytes: Uint8Array, opts?: { signal?: AbortSignal }): Promise<ImageRef>;   // 手里已是字节的
  state: {                          // 游标、分页令牌、小索引
    get<T>(key: string): T | undefined;
    set(key: string, value: Json): Promise<void>;   // 宿主原子写
    delete(key: string): Promise<void>;
  };
  secrets: SecretsStore;            // cookie、token
  redact(value: string): void;      // 还没进 secrets 的临时凭据先登记，日志按值遮掉
  logger: Logger;
}

interface SourceSubscription {      // 原拓展契约的 ExtensionOwnSubscription{ id, externalId, enabled }
  externalId: string;
  features: ReadonlySet<FeatureKey>; // 这个人开着的特性
}
```

| 成员 | 规矩 |
| --- | --- |
| `subscriptions` / `onSubscriptionsChanged` | 名单只列启用中的订阅，条目 `{ externalId, features }`、不带订阅 id；同一人遗留的重复订阅合成一条、`features` 取并集。来源只上报名单里的人，开着哪些特性决定它干哪些活（没开直播就不连弹幕、没开作品就不拉也不抓图）。B 站也用这份名单，不再拿完整的订阅对象 |
| `reportPost` | 核心按身份展开成每条订阅一份 `PostEvent`（正常一条，老数据里的重复各一份），再发 `post-detected` 进作品装配；查不到或已停用就丢弃、记 debug 日志。判新、去重、限流归来源 |
| `reportLive` | 同样按身份展开，喂场次引擎 |
| `reportProfile` | 推送式平台主动报资料；按资料刷新的间隔限密 |
| `reportProblem` / `resolveProblem` | 见下「问题上报」 |
| `fetchImage` | 拦内网地址防 SSRF、单张 8MB、按内容嗅探格式、超时；按 sha256 存进图库，交回引用。来源带着自己要的请求头去抓 |
| `storeImage` | 手里已是字节的图走它（本地生成的扫码二维码，B 站也用；要来源自带客户端才抓得到的签名 / TLS 指纹 / POST 图；接口内嵌 base64）。同一套格式嗅探与单张 8MB，存进同一图库。上报一律只收 `ImageRef` |
| `state` | 宿主托管的小键值存储。单键 64KB、总 1MB，超了拒收。落 `runtime/bilibili/state.json` 或 `runtime/extensions/<id>/state.json`；跟代走、不进备份、卸载与全新开始时清 |
| `secrets` | 主密钥加密，存 `secrets/bilibili/` 或 `secrets/extensions/<id>/`；仅完整备份（普通备份抹掉）；卸载清掉 |
| `redact` | 临时凭据按值登记脱敏；存进 `secrets` 的值自动覆盖，不用再登记 |
| `logger` | 来源名写进日志行已有的 `name` 字段（`bilibili` 或拓展 id），不拼进正文；面板日志页可按来源筛 |

核心收到上报后**兜底再查一次名单**：名单变化和上报之间可能有时间差（主人刚停用某条订阅），来源自己也可能有 bug。

没有 `reportSubscriptionsChanged`：B 站的「关注同步」是 BN → B 站单向（订阅了谁就补关注谁，因为动态从关注流里拉），全在 B 站内部，挂在 `onSubscriptionsChanged` 回调、开机、重新登录之后；仓里从来没有「平台那头关注列表变了反过来改 BN 订阅」的功能。

**来源不读写文件**：状态与凭据全由宿主托管，来源拿不到任何文件路径。B 站由守卫强制（`bilibili/` 里 import `fs` 就红）；拓展这边见 [extension-contract.md](./extension-contract.md)。

### 问题上报

- 问题一律进面板问题框；`notify: true` 再私聊主人。严重度与文案由来源定。
- 核心只守一条底线：同一来源、同一 code 的私聊 60 秒内只发一次。
- 核心收到每条问题自动记一行日志。问题上报不设「只记日志」档，只想记日志就用 `ctx.logger`，两者不合并。
- 不填 `externalId` 就是来源本身的问题（如登录失效）；填了由核心展开到对应订阅，存进 `SubscriptionState.problems[code]`（订阅卡显示为什么收不到东西），`since` 记第一次出现，重复报只更新文案，`resolveProblem` 按 code 清除。
- code 用 snake：`follow_failed`、`login_expired`。
- B 站也走它：比如「登录失效」以 `notify` 上报、文案自己写；关注同步失败也经这里上报。
- 来源级问题不再走 `engine-error`。

## 资料刷新与 seen

**资料**：

- 核心按 `core.profileRefreshCron`（由 `fansCron` 原值迁来）定时调 `fetchProfile`。
- 对同一来源**串行**调用；防风控的间隔由来源自己管（B 站那个 200ms 留在 `bilibili/`）。
- 来源主动 `reportProfile` 的，按同一个间隔限密。
- 粉丝数就在资料里，粉丝轮询并进这项必备能力，不另占能力位。涨粉的增量、时序、首页粉丝面板由核心算，上总线 `followers-refreshed`。
- 头像：来源先 `ctx.fetchImage` 抓进图库，再交 `ImageRef`。B 站在 `bilibili/` 里带 Referer 下载，图链没变不重抓。面板一律走同源地址、出卡一律从本地内联，删掉 `no-referrer` 绕行。
- 动态轮询不在此列：B 站拉的是整条关注流，没法按订阅逐个拉。

**seen**（「那天有没有在看」）：

- 核心每次成功联系到来源——拉资料成功、收到作品或直播信号——就给该订阅记当天一条 seen，B 站与拓展同一规则。
- 统计的热力图与「在记」标记只看 seen；在播状态与当前粉丝数取在播表与资料缓存。
- 统计记录全部作品，另外记其中带视频的那些；面板与 CSV 里仍叫「投稿」「动态」。

## 直播

两套场次引擎合成一套：原先拓展那套（本就中立）去掉 `Extension` 前缀升格为核心 `live/`，B 站的 `room-session-base` 删掉。来源只有两种输入：

| 输入 | 形状 | 谁用 |
| --- | --- | --- |
| 推送式信号 | `ctx.reportLive(externalId, LiveSignalReport)`：`start` / `status` / `end` | 拓展照现在的上报走；B 站在 `bilibili/` 把弹幕通道的开播、下播、状态翻成这三种 |
| 拉取式 | 核心按场次定时调 `fetchLiveStatus` | 提供了它的来源 |

`fetchLiveStatus` 三态（判别键 `type`）：

| 结果 | 核心怎么做 |
| --- | --- |
| `live` | 推「正在直播」卡 |
| `offline` | 此刻没在播：当成漏收的下播，走 `end` 同一条路（含断流宽限与私聊主人） |
| `unavailable`（带 `code` + `message`） | 跳过这一轮、记一条问题；**不再停止监听** |

- 计时按每一场的开播时刻各自起算（`LiveSession.nextTickAt`），不全局同时拉。间隔是 `liveStreaming.streamingIntervalHours`。
- 同一来源串行调用；超时与中止复用 `searchCreators` 那套外壳；拓展停用时用 signal 取消在途调用。
- **重启**后核心对每条开着直播推送的订阅调一次 `fetchLiveStatus` 重建场次；要不要补推一张正在直播卡由 `liveStart.catchUpOnBoot` 统一决定。
- 断流：收到 `end` 先进 `pendingEnd` 等宽限，宽限里又开播就 `resume` 接着同一场；等满了才 `end`。
- 场次的每次变化是一条 `LiveSessionChange`，推送、统计、总线（`live-session-changed`）吃同一份。
- ⛔ 场次身份按开播时刻认、排在闩之前；统计 `current` 与 `isLive` 的语义不动。
- 「这条订阅会不会被监听」全仓只有一处判定（在 internal），首页与服务端共用。
- **验收**：先在旧引擎上用端到端测试钉住开播、下播、断流接续、漏收下播兜底四种行为，再换新引擎跑同一组。

## 预览

- 预览请求带 `subscriptionId`；裸 uid / 房间号输入框删掉，改成「从订阅里挑一条」。
- 来源实现了 `fetchPreview` 就用真数据，没实现就用示例数据。
- SC、会员卡的付款人取该来源 `auth.account()`，没有就用示例名字。
- 「按订阅覆盖」卡片皮肤与旋钮对所有订阅开放。

## 横切接口

```ts
interface LinkResolver { matches(url: string): boolean; resolve(url: string, signal: AbortSignal): Promise<LinkCard | null> }
interface CommandProvider { commands: CommandDef[] }            // 名字、参数、处理函数、帮助文案
interface AiToolProvider {
  readOnly: AiTool[];              // 可以挂在推送路径上
  chat?: AiTool[];                 // 只开给聊天
  skills?: MaidSkill[];            // 连同工具带来的技能
}
interface DevtoolsProvider { scenes: DevtoolsScene[] }           // 只在开发版登记
```

| 接口 | 核心负责 | 来源负责 |
| --- | --- | --- |
| `LinkResolver` | 闸门：开关、群表、冷却、硬上限、失败不出声、一条最多三个、从分享卡取链接；出口：图片卡、小程序卡、文字 | 认链接、解析成链接卡（出的是 `Post`）。小程序卡是解析器可选提供的「原生分享」（appid + 页面路径），连接签不了就回落成图片卡 |
| `CommandProvider` | 框架：入站链路、鉴权门、确认流、参数、错误反馈、近似建议；通用指令 `help`、`mute`、`report`、`status` | 自己的指令（B 站：`login`）；`status` 里的那一行由 `health()` 交 |
| `AiToolProvider` | 生成器、人格；中立只读工具 `list_subscriptions`、`get_creator_profile`（读资料缓存）、`get_creator_posts`（读统计仓）、`get_live_status`（读在播表）、`search_creators`（转给来源的 `searchCreators`）；6 个内置技能改用这些工具、跨来源可用 | 专有工具（如 B 站视频详情）与技能 |
| `DevtoolsProvider` | 只认接口与登记表，不认识任何一家来源 | 自己的造状态 / 造事件场景 |

- 缺工具的女仆技能面板自动隐藏；面板里找不到工具的 3 条死标签（`subscribe_user`、`unsubscribe_user`、`update_subscription`）删掉。
- 技能的 `allowedTools` 在迁移时按新工具名变换。
- 这四个接口的登记表在核心照做、B 站照用；1.0 只对拓展开 `devtools`，其余三个见 [extension-contract.md](./extension-contract.md)。

## B 站怎么实现

`apps/server/src/bilibili/` 放 B 站的全部：

| 子目录 / 件 | 内容 |
| --- | --- |
| 原 `api` / `blive` / `dynamic` / `live` 四包 | 各成子目录；B 站接口响应类型（Dynamic、RichTextNode、LiveData）只住这里 |
| `SubscriptionSource` 实现 | 拉动态翻成 `PostReport`（附加块翻成 card / video / goods）、弹幕通道翻成 `LiveSignalReport`、关注同步、资料拉取、`searchCreators`、`fetchLiveStatus`、`liveInteractions` |
| `auth/` | 扫码登录（原 AuthSystem）、`LoginSnapshot`；cookie 存 `ctx.secrets` |
| `LinkResolver` | B 站视频链接识别与解析 |
| `CommandProvider` | `login` |
| `AiToolProvider` | B 站专有查询工具 |
| `devtools/` | `DevtoolsProvider`，只在开发版登记 |
| 翻译表 | 大航海等级表与等级名（`guard_level` 反向换算）、风控码集合、响应解包、CDN 缩放后缀与 Referer、「大航海舰队」文案 |

- **只经中立接口进核心**，在 `compose.ts` 登记（见 [architecture.md](./architecture.md)）。
- **只报 uid**：B 站按 uid（即 `externalId`）上报，由核心展开成订阅 id；B 站不知道订阅 id，只用 `ctx.subscriptions()` 的名单决定拉谁。
- **进门换 ISO**：`live_time` 是不带时区的北京时间，在这里转。
- **禁 fs**：B 站的状态（`roomId`、`followed`、`followError` 等）只走 `ctx.state`，cookie 只走 `ctx.secrets`；动态游标仍只在内存。
- **设置**：B 站段 `settings.bilibili`（`dynamicCron`、`userAgent`、`loginCheckIntervalMinutes`）由 `bilibili/` 定义，核心不许读。
- **补关注**（BN → B 站单向）：在 `onSubscriptionsChanged` 回调、开机、重新登录后各跑一次。整份名单先批量查关系、只补缺的（稳态写请求为零）；失败按「问题上报」报 `follow_failed`。登录态失效时跳过；批量查询回 -101 按「没登录」整批跳过，订阅卡上的关注状态不动，等登录恢复再跑；其他失败码仍走降级。停用的订阅不在名单里，自然不补；从停用改回启用时名单变化，那一轮就补上。
- **开机不碰 B 站**：`start()` 不预取 ticket（WBI 签名时现取）；未登录开机不补关注。开机那一刻连不上 B 站、或 ticket 接口回风控码，都不许拦住 BN 起来（第 0 期测试拦外网时查出：预取失败曾让整台 BN 起不来）。
- **风控码**：-412 在拉粉丝时算风控、刷 cookie 时算登出，各处不一，先验证再定。
- **失败码**：B 站接口的数字错误码放在 `upstreamCode`，不占错误体的 `code`。
- 验收检查点：「接口先行」那一期完成时，B 站全经中立接口运行、行为不变。
