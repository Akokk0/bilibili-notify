# 1.0 数据模型与字段名

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023，以及 ADR-0024 ～ 0031。

1.0 全部数据模型的正本。字段名一律是定案后的新名字，旧名在文末「改名对照」。文件放在哪、怎么迁，见 [data-and-migration.md](./data-and-migration.md)；接口（谁交这些数据、谁调谁）见 [subscription-sources.md](./subscription-sources.md) 与 [push.md](./push.md)。

## 一句话

**核心只认中立形状**：订阅按身份 `{ sourceKey, externalId }` 认人，作品只有 `Post`，直播只有 `LiveSignal` / `LiveSession`，图只有图库引用 `ImageRef`，失败只有一种结果形状。B 站的原始形状只活在服务端 `bilibili/`，进门就翻。

## 通用规矩

| 规矩 | 写法 |
| --- | --- |
| 时刻 | wire 与盘上一律 ISO 字符串，名字以 `…At` 结尾。老的 `ts` / `at` 与存毫秒的 `…At` 全改 |
| 时长 | 名字带单位：`Ms` / `Sec` 缩写，`Minutes` / `Hours` / `Days` 写全（`cooldownSec`、`chromeIdleSec`、`pollIntervalSec`、`streamingIntervalHours`、`loginCheckIntervalMinutes`、`retentionDays`）；不用 `Min`（会和 `min*` 阈值撞）；cron 字符串叫 `…Cron` |
| 枚举值 | 事件与状态类的值用 kebab（`grace-expired`、`logged-out`、`settings-invalid`）；失败码与问题码用 snake（`invalid_profile`、`follow_failed`），应用内更新的失败原因 `reason` 也从 kebab 改成 snake；特性键保持 camel（`liveStart`）。「此刻没在播」统一叫 `offline`，`end` 只指「下播」这个事件 |
| 判别键 | 说「是哪一种」的判别键叫 `kind`，说「处在什么状态」的判别键叫 `status`（状态对象里装取值的那一格，如 `AuthState.status`、`probeState.status`）；`type` 只留给外部协议里的原名（B 站接口、桥帧） |
| 类型名 | 后缀对 [docs/agents/conventions/naming.md](../agents/conventions/naming.md) 的表：一个概念只用一个词，表里没有的概念先加一行再用。按表改的名字见文末「类型名后缀」 |
| 设置 | 设置的值只叫 `settings`（连接的 `settings`、`settingsSchema`、`settingsFields`）；`config` 只指存储：`config/` 目录、`ConfigStore`、`config-changed`、`bn.config.yaml`、`BN_CONFIG` |
| 计数 | 全程是数字，只在出口（卡片、文案、面板）排一次版，见「数字、时间、不知道」 |
| 开关 | `enabled`，不用 `enable` |
| 布尔 | 带 `is` / `has` / `can` 前缀：`isLive`、`isAnimated`、`isPremium`。例外：表示操作结果的 `ok` 保留；失败原因只用 `code` + `message`，见下「失败」 |
| 回退层 | `defaults` 只表示「按订阅覆盖时缺字段就回退到这里」；订阅覆盖不了的不放进去 |
| 过滤 | `allow*` 与 `block*` 成对 |
| 缩写 | `Ai…` / `Api…`，不用 `AI…` / `API…` |
| 「不知道」 | 缺键。不编成 0 或空串 |

⛔ 日志行格式（`msg`、`ts`）跨代共享、冻结，不在上面这些规矩之内。

### 失败

一次操作的结果只有一种形状（ADR-0026）：成功是 `{ ok: true, … }`，失败是 `{ ok: false, code, message, upstreamCode? }`。通用类型叫 `Result<T>`（失败那一支 `Failure`，码 `FailureCode`，逐条原因 `Issue`），造的时候一律用 `ok()` / `fail()`（ADR-0026 决策 6）。

- **抛错只留给 bug**。宿主在边界接住抛出来的错，按 `unavailable` 处理并记错误日志。
- **上游平台自己的错误码放 `upstreamCode`**，不占 `code`（B 站接口的数字码就放这里）。
- **管**：来源、平台适配器、横切接口与 ctx 的方法，HTTP 业务失败与错误体（`{ code, message }`），WS 控制帧，桥回执进门时的翻译。
- **不管**：事件原因（如下播的 `reason`）、描述性字段、AI 产出的内容、能力三态。「能不能」的预检保留 `can`，原因用 `code` + `message`。
- 面板的错误提示按 `code` + `message` 读一处。

**标准码只有一张表**，住在 `internal`：

| code | 意思 | 自动重试 |
| --- | --- | --- |
| `not_found` | 要的东西不存在 | 否 |
| `invalid` | 输入或形状不对 | 否 |
| `unauthorized` | 没登录或凭据失效 | 否 |
| `rate_limited` | 被限流或风控 | 稍后 |
| `unavailable` | 对端或本地暂时不可用 | 稍后 |
| `timeout` | 超时 | 稍后 |
| `unsupported` | 这个对端不支持这项操作 | 否 |
| `conflict` | 与当前状态冲突（版本号对不上、重复） | 看场合 |
| `indeterminate` | 结果不明，可能已经成功 | 绝不 |
| `unknown` | 原因不明、只有原话 | 否 |

- 自定义码算失败、不自动重试。
- 问题表里的 code 另算，只要求 snake（`follow_failed`、`creator_not_found`、`renderer_unavailable`）。
- `unknown` 只给两种：迁移来的旧记录；冻结格式翻译过来、说不清原因的失败（如桥的回执）。
- **旧数据**：历史里存的旧失败转成 `{ code: "unknown", message: 原话 }`，不按原话猜码（猜错比「原因不明」更坏）；连接的探测状态不迁移，开机重探。

## 键、身份与订阅

**集成**（ADR-0025 决策 1）：`bilibili/` 是一个集成，每个拓展是一个集成，内置的平台适配器也是。集成的键叫 `IntegrationKey`，登记表、设置段、数据目录、问题表的 `reporter` 都用它；订阅来源的键 `SourceKey` 是其中一部分：

```ts
type SourceKey = "bilibili" | ExtensionId;   // 不加前缀；bilibili 是保留 id，拓展清单不许用
type IntegrationKey = SourceKey | "onebot" | "qq-official" | "webhook";   // 后三个是内置平台适配器的键，同样是保留 id；拓展 id 另外不许叫 core（核心自己的名字，不是集成键）

interface Identity {                          // 分派、判重都只看这两格
  sourceKey: SourceKey;
  externalId: string;                         // B 站就是 uid
}

function subscriptionIdentityOf(sub: Subscription): Identity;   // 全仓唯一判断「是谁」的函数

interface Subscription {
  id: string;                                         // uuid，运行期键
  identity: Identity;
  enabled: boolean;
  tagIds: string[];                                   // SubscriptionTag id，见下
  routing: Record<FeatureKey, string[]>;              // 每把特性推到哪些目标（PushTarget id），⑬ 跟着特性键改键
  // 开没开在按订阅覆盖那一层的 features（Partial<Record<FeatureKey, boolean>>）；来源「支持哪些」是 descriptor.supportedFeatures
  // 按目标的附加项三态表叫 extraTargets（原顶层 extras）
  specialViewers?: SpecialViewer[];                   // 公共形状（原 specialUsers）；露不露看 descriptor.supportedFeatures
  // 按订阅覆盖：形状同全局 defaults，对所有订阅开放
}

interface SpecialViewer {              // 特别关注名单的一条；名单仍是一张，条目说「哪个人触发哪种推送」
  id: string;                          // 平台由所挂的订阅决定
  note?: string;
  features: FeatureKey[];              // 装特性键（viewerChat / viewerEnter），必填至少一个；死格 template 退役
}

interface SubscriptionTag {           // 标签登记表的一条；顺序就是登记表里的顺序（ADR-0034）
  id: string;
  name: string;                        // 去掉首尾空白后非空、不重名
}

interface SubscriptionState {          // runtime/subscription-state.json，按订阅 id；存储叫 SubscriptionStateStore
  cachedProfile?: CreatorProfile;      // 只剩资料缓存；问题表全在内存，见「问题表」
}

interface CreatorProfileReport {       // fetchProfile 成功时 / reportProfile 交的；头像先用 ctx.fetchImage 抓好
  name: string; avatar?: ImageRef; bio?: string; followers?: number;
  fanClubName?: string;                // 粉丝团名；B 站填粉丝牌名，平台没有就缺键；模板变量 {fanclub} 取它
}

interface CreatorCandidate extends CreatorProfileReport {   // searchCreators 交的候选，最多 10 个
  externalId: string;
}

interface CreatorProfile {
  name: string; avatar?: ImageRef; bio?: string;
  followers?: number; fanClubName?: string; refreshedAt: string;
}
```

- **身份没有前缀**：`SourceKey` 就是 `"bilibili"` 或拓展 id。不带点的 id 本就只给官方源，`ExtensionIdSchema` 再把 `bilibili`、三个内置适配器的键与 `core` 列为保留 id（后者是核心自己的名字，只在 `RESERVED_EXTENSION_IDS` 里，不进内置集成的键表 `RESERVED_INTEGRATION_KEYS`），手动放进目录的拓展也撞不上。分派读 `identity.sourceKey`，不再有 `sourceKeyOf`；`SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription` 删掉。
- 「identity」在仓里另有 ChatIdentity、inboundIdentity、ExtensionIdentity 等意思，订阅身份的函数一律带 `subscription` 限定词。
- **订阅只有一个文件** `config/subscriptions.json`，B 站与拓展同一数组、行行带 `identity`。「缺 kind 就当 B 站」的默认值删掉。
- **同一身份只能有一条订阅**。在真正写盘的 `writeSubscriptions`（现在是 `ConfigStore.writeSubscriptions`）把关——`packages/subscription` 的 `SubscriptionCache`（原 `SubscriptionStore`）只是写盘之后才同步的内存镜像，在那里拒收已经晚了。判据是「这次写入有没有**新增**重复」（跟当前集合比），不是整份数组有没有重复：否则盘上留着一对遗留重复时，改任何一条不相干的订阅都会被拒。新建、保存、恢复备份，所有写入都要过。开机读到遗留重复只记警告、健康页显示，事件照旧分发给每一条。恢复备份先按 id 对、再按身份并入。
  - 🔗 10-01 ⑥e 落地：闸在 `ConfigStore` 的 `writeSubscriptions` 与 `replaceSections`，规矩在 `packages/subscription`（`findNewIdentityDuplicates`）；守卫 9 是 `apps/server/src/__tests__/config-store-identity-unique.test.ts`。并入的细则：id 留本机的（统计、历史、锐评都挂在本机的订阅 id 上，备份不带这些）、内容用备份的（和按 id 对上的行一个口径），本机每条只认领一次，覆盖与合并两种模式都并。并完还剩的重复只可能是备份自己里面就有一对：**整份拒收、点名是谁**，预览那一步就拒（主人 10-01 定，不悄悄丢设置）。开机的警告已落；健康页显示随第 4 期健康卡；「事件分发给每一条」随 3a（现在按身份只取第一条）。
  - 🔗 10-11 3a-28：作品这一半已做 —— 来源上下文的 `reportPost` 按身份取全部订阅（订阅仓的 `listByIdentity`），每条各交一份给作品入口，推送、统计各记各的；直播那一半仍取第一条（`findByIdentity`），随 3b。
- **核心的订阅运行态里没有 B 站字段**：只留资料缓存（问题表全在内存，不存盘）。B 站的 `roomId`、`followed`、`followError` 在 B 站自己的 `ctx.state` 里。`fansBaseline` 退役，涨粉起点取粉丝时序的第一条样本（粉丝时序压缩后，最早那一小时只留小时末值，起点因此最多挪一小时；这不算截尾，不另存起点，ADR-0027 决策 15）。这份文件丢了只退化，不会重推漏推。⚠️ 以后要给粉丝时序加截尾（保留期）之前，必须先把这个起点另存，否则截尾会悄悄改掉涨粉起点。🔗 10-23（3b-24）：运行时已按第一条样本算「订阅以来」，`fansBaseline` 这一段不动盘；盘上残留由 3b-62 迁移丢弃。🔗 **现状（3b-25，10-23，主人定）**：本片不动盘，B 站 `ctx.state` 里实际只新增 `room:<uid>` 这一种房号缓存；`followed` / `followError` 哪里都不存，关注失败由问题表顶替。0.x 的 `roomId` 拆进 `room:<uid>`、`followed` / `followError` 丢掉，归 3b-62 的迁移；在那之前，盘上 `sub-runtime.json` 里这三格是没人读的残留。🔗 **现状（3b-62，10-24）**：迁移已落，0.x 的 `state/sub-runtime.json` 迁成 `runtime/subscription-state.json`，每条只留 `cachedProfile?: CreatorProfile`；`fansBaseline`、`followed`、`followError` 丢弃；B 站订阅的 `roomId` 写进 `runtime/bilibili/state.json` 的 `room:<uid>`（正整数字符串），拓展订阅与对不上订阅的 `roomId` 丢弃。
- **显示名只有一条链** `displayNameOf()`：事件上的 `creator.name` → 资料名 → 身份标签，收编面板现有的 `historyRowIdentity`。**身份标签**由一个函数生成：来源声明了 `externalIdNoun` 就写「{externalIdNoun} {externalId}」（B 站「UID 123」），没声明就写「{label} · {externalId}」（「抖音 · abc」）；现在还有的裸「123」和「UP 123」一并收掉，「复制 UID」随之变成「复制 {externalIdNoun}」或「复制 ID」。别名退役：现在有 8 处按四种顺序读别名（面板显示资料名，单人锐评的定时推送却写别名），一律改走 `displayNameOf()`。
  - 🔗 10-01 随 ⑥d 落了别名那一半：迁移器丢掉 `name`、schema 删掉这一格，原来读它的地方去掉别名那一环（资料名 → 外部 id，B 站是「UID xxx」），单人锐评的定时推送与生成、投递同走 `roast-subject.ts`。`displayNameOf()` 这一个函数与身份标签（`externalIdNoun`）还没收，随来源描述符做。
  - 🔗 10-23（3b-24）：`displayNameOf()`、`subscriptionIdentityLabel()` 与 `externalIdNoun` 已在 contract 落成；女仆订阅视图、直播卡、互动卡、拓展作品与单人锐评已走这条链。面板的 `historyRowIdentity`、订阅卡裸 id 仍归第 4 期。
- **身份挂在所有行上**：推送历史、统计、在播三种行都带 `identity`，盘上直接是新形状，不留读时映射。
- 现在判「是不是拓展行」有四种写法：只看 `extensionId`（面板 `Dashboard.tsx`、服务端 `stats/roast-subject.ts`）；两格都要有（面板 `utils/up-display.ts`、internal `constants.ts` 的 `upColor`）；只看 `externalId`（`packages/ai/src/tools.ts`）；只有一格就判无效（`runtime/target-scope.ts`、`pages/up/subscription-lookup.ts`）。行带 `identity` 以后四种一律删掉，按 `identity.sourceKey` 判。🔗 10-23（3b-24）：服务端与首页粉丝卡的统一取色已是 `identityColor(identity)`，`upColor` / `UpColorIdentity` 已删；面板其余身份判断仍随第 4 期收。
- **标签是一份单独的登记表，订阅只记 `tagIds`**（ADR-0034，issue 53）：改名只改登记表，没人挂的标签照样留着，删标签时所有订阅上的这个 id 一起去掉；面板上挑标签一律是同一个勾选组件（勾已有的 + 就地新建），没有自由文本框。标签只管面板上的整理（筛选、卡片角标），不参与推送与路由。标签表与订阅住同一个文件 `config/subscriptions.json`（`{ tags, subscriptions }`），读写口是 `GET` / `PUT /api/subscriptions/tags`（整张换；原 `/api/subs/tags`，㉚ 改路径）；订阅只许挂表里有的标签，写盘那一层核。恢复备份时标签先按 id、再按名字并（ADR-0034 决策 3 与后果下 10-02 的 🔗）。
- **特别关注名单**叫 `specialViewers`（条目 `SpecialViewer`，比对文件 `live/special-viewers.ts`；原键 `specialUsers`），条目是 `{ id, note?, features }`，平台由所挂的订阅决定；`features` 装特性键、必填至少一个，死格 `template` 退役。来源在 `descriptor.supportedFeatures` 里声明了 `viewerChat` 或 `viewerEnter`（原 `specialDanmaku` / `specialUserEnter`，推翻 N3 记的「名不变」）才露出这项设置。迁移要有专门的测试钉住老键 `specialUsers` 上的名单一个不少地到新键。
- **要不要监听直播间**：五把直播类开关任一开着，或（`viewerChat` 开着且名单上有人带 `viewerChat`），或（`viewerEnter` 开着且名单上有人带 `viewerEnter`）。看得见的变化：五把直播开关全关、名单上有人、特别关注开关也关着的订阅，升级后不再连直播间、首页说它「不会被监听」、统计不再记它的直播。迁移记账本那里留一份冻住的旧读法（0.x 那时是「名单有人就监听」）。
- internal 里没人写的旧 `SubscriptionStateSchema`（`schema/subscriptions.ts`，连同它导出的同名旧类型 `SubscriptionState` 与测试里钉它「仍 export」的那条）在数据模型期删掉：它和上面的新 `SubscriptionState` 同名，不先删会撞守卫 4，也容易有人把新形状写进这份老 schema。
  - 🔗 10-02 ⑫ 已删：连同测试里钉它「仍 export」的那条、contract 里恒为「未知」的死字段 `SubscriptionDTO.state`、面板上读它的那颗永远不亮的「播」；`FansBaselineSchema` 还有人用，留着。

## 问题表

来源、平台适配器与核心自报的问题（ADR-0025 决策 11）。上报与清除的接口、谁看，见 [subscription-sources.md](./subscription-sources.md)「问题上报」。

```ts
interface Problem {                    // 全在内存，不存盘
  reporter: IntegrationKey | "core";
  about?: { subscriptionId: string } | { connectionId: string };   // 不带就是报的人自己的问题（如拓展设置读不懂）
  code: string;                        // snake；不受标准码表约束
  message: string;
  since: string;                       // 第一次出现的时刻
}
```

- **一种形状、全在内存**：订阅运行态不再存问题。开机时关注同步与第一轮资料刷新几秒内就会重报，所以重启后的头几秒订阅卡上的红字会先消失，等报的人重报。
- **一条生死规矩**：报的人 `resolveProblem` 清；报的人停下，它报的全清；对象（订阅、连接）删了，关于它的全清。
- **`about` 加连接这一支**（主人定）：问题表的键与 `apps/contract` 的问题类型跟着改；连接删了，关于它的全清；适配器停下，它名下的全清。
- **`about` 谁填**：来源带 `externalId`，宿主换成订阅 id；平台适配器带 `connectionId`，宿主核它是不是这个适配器的，不是就拒收；宿主替连接报的几条（连接设置不合法、探测连续两次不通）记在那条连接所属适配器的名下；有登录口的来源，登录问题由宿主看登录状态报、记在来源名下；拓展设置读不懂由宿主替它报（`settings_invalid`，记在拓展 id 名下、不私聊）；核心直接写，`code` 表明是哪个模块（如 `renderer_unavailable`；`core` 段设置坏了记 `settings_invalid`）。
- 同一个报的人、同一个对象、同一个 code 算一条；重复报只更新 `message`、不重置 `since`（照原先「按 code 做键」的规矩延伸，施工时核）。🔗 3a-30 已落并核过：键是 报的人 + 对象 + code，再报只换 `message`（与 `notify`、恢复说法），`since` 不动。
- 🔗 **落成的形状（3a-30，10-11）**：`packages/internal/src/problem.ts` 的 `Problem { reporter: string; about?: { subscriptionId: string }; code: string; message: string; since: string }`。与上面的草稿相比：`reporter` 是字符串（来源键；`IntegrationKey` 类型全仓没有，`"core"` 这个值还没有人用）；**`about` 只有订阅一支**，`{ connectionId }` 那一支随 3b-38 造；**报的人给的 `recoveryMessage`（清掉时怎么说）与 `notify` 不在这个对外的类型上**，它们只存在问题表内部与问题通知器之间，`GET /api/problems` 的回包不带。`since` 是问题进表那一刻；B 站的分层上报器是来源 `start(ctx)` 之后才接上核心，接上时整份补报，所以重启后 `since` 是接上那一刻。表全在内存，不存盘，迁移修订号与备份版本没动。
- 🔗 **设置读不懂的三个码（3a-39，10-11）**，都不带 `notify`（只进表、不私聊，主人定：「面板提示可以吗？私聊尽量少用」）：
  - `settings_invalid`，报的人是 `"core"`（这个值第一次有人用；写死在 `config/settings-problems.ts`，理论上会与一个 id 叫 `core` 的来源撞键）：核心设置有格读不懂退了默认，**几格坏了合成一条**（文案里最多摊三格，用代码路径与 zod 的原话，格数变了只换文案、`since` 不动），不带盘上原文；所有格都好了就清，不补「已恢复」。由配置仓的 `onInvalidSettingsChanged` 经 `runtime/bootstrap.ts` 接到问题表（`config/settings-problems.ts`）。
  - `dynamic_settings_invalid`、`login_check_settings_invalid`，报的人是 `bilibili`：B 站动态那格 / 登录检查那格（或整个文件）读不懂，一样一条，文案点名停的是哪一样、因为哪一格（面板上的叫法加键名）：`bilibili.problem.dynamicSettingsInvalid` 是「{cause}，动态先停着没在拉；登录、登录检查和直播照常」，`bilibili.problem.loginCheckSettingsInvalid` 是「{cause}，定时的登录检查先停着；登录本身、动态和直播照常，登录失效了照样会发现」；`{cause}` 取 `bilibili.problem.settingsCause.cell`（设置「{label}」（{key}）读不懂：{reason}）或 `bilibili.problem.settingsCause.file`（设置文件不是合法的 JSON：{reason}）。不写到哪改、不写面板上那一格显示默认值、不写设置文件路径。由来源经 `ctx.reportProblem` 直接报，不走分层上报器，所以登录掉了时这两条照报、不被压下。
  - `settings_invalid`，报的人是拓展 id：这个拓展存着的设置读不了（设置文件不是合法 JSON、过不了它自己的 zod、跑着时被旁路写坏），没起来或被收掉。**不带 `about`、不私聊**；话是宿主自己写的整句，点名拓展，不加「X 报告」引子；改好起来、主人停用、卸载、盘上换了一版时由装载器清，不补「已恢复」。报的次序要紧：必须在拓展的上下文收摊（`clearReporter`）之后，不然刚记的这一条被一起清掉。🔗 现状（3b-41 C2，10-17）：已落（`extensions/loader.ts`，话在服务端字典 `extension.settings.problem` / `extension.settings.fileBroken`）。
- 与 `reportDiscrepancies` 分开：上报被拒或被丢格记进该集成的 `reportDiscrepancies` 表，不是问题（内置集成被拒就是 BN 的 bug，只打错误日志）。

## 来源描述符

`SourceDescriptor` 的全形状、面板怎么读它、叫法规矩与「来源没装」的兜底，见 [subscription-sources.md](./subscription-sources.md)「SourceDescriptor」与「面板怎么读描述符」。与本文件的数据相关的几格：

- `externalIdNoun?`：外部 id 叫什么（B 站「UID」），决定上面的身份标签。
- `externalIdRegex?`（10-15 主人定，3b-58）：外部 id 长什么样，正则源码、整串匹配。核心照它核新建订阅的 `identity.externalId` 与特别关注名单每一条的 `id`；没声明只做中立校验（非空、限长）。B 站声明纯数字，核心里不再写「B 站 uid 是数字」。
- `icon?`：平台图标，对齐推送侧 `PlatformDescriptor.icon`。
- `featureHints?: Partial<Record<FeatureKey, string>>`：特性开关下的小字，描述符里唯一的自由文字格。
- `membershipPrograms[].tiers[]` 的全形状见下「会员」。

## 作品

渲染器只认中立的 `Post`。B 站动态与拓展作品各自翻过来，B 站动态类型不进核心。`Post` 是纯数据（能 JSON 序列化、不含 JSX），存原始值，排版归核心。**没有形态字段**：有什么画什么，块没数据就收起。

```ts
type ImageRef = string;   // 图库 images/ 里的文件名 <sha256>.<ext>（扩展名按嗅探：png / jpg / gif / webp）；作品图、直播封面、头像、历史快照、聊天附件共用

// 出卡只认 ref；url 只给「查看原图」，出图器不去抓
interface PostImage { ref?: ImageRef; url?: string; width?: number; height?: number; isAnimated?: boolean }

interface Creator { name: string; avatar?: ImageRef; isPremium?: boolean }

interface Post {
  creator: Creator;
  publishedAt: string;
  label?: string;                      // 「投稿了视频」，来源给
  topic?: string;
  article?: { title: string; images?: PostImage[] };   // 有这格就按文章排版；images 是文章配图
  title?: string;                      // 有标题、但不是文章的作品（带标题的图文、笔记）：画在正文上方，排版照普通作品（10-05 主人定）
  text: string;                        // 纯文本，必有：只放正文（用户在平台上看到的字，平台私有标记由来源剥掉）；标题、视频标题、被转发的原作品各在自己的格里
  richText?: RichText;                 // 可选，只用来出卡高亮；片段见下。核心统一校验：片段的 text 拼起来必须等于 text，对不上就丢掉 richText、只用 text（B 站与拓展同一套）
  notice?: string;                     // BN 自己说的一句，画在正文后面
  locked?: { icon?: PostImage; title: string; hint: string };   // 专属内容锁，替掉正文
  images?: PostImage[];                // 只表示图集
  video?: { cover: PostImage; title: string; description: string; durationSec?: number; views?: number; danmaku?: number };   // 时长没有就不画角标（直播回放、首映；10-05 主人定）
  attachment?: Attachment;
  repost?: Post;                       // 被转发的原作品
  stats?: { shares?: number; comments?: number; likes?: number };
}

type Attachment =                      // 封闭联合，出图器按种类直接渲染，不开登记口
  | { kind: "card"; eyebrow?: string; cover?: PostImage; title: string; lines?: { text: string; icon?: ImageRef }[]; button?: { text: string; enabled: boolean } }
  | { kind: "video"; cover: PostImage; title: string; durationSec?: number; subtitle?: string }
  | { kind: "goods"; eyebrow?: string; items: { cover: PostImage; name: string; price?: string }[] };

interface PostReport {                 // 来源交的：reportPost(externalId, report)
  postId: string;                      // 平台上的作品 id，统计要
  url: string;                         // 消息里的链接部件
  post: Post;                          // 图都已是 ImageRef
}

interface PostEvent {                  // 核心按身份展开后、装配入口的信封：每条订阅一份
  subscriptionId: string;              // 核心查出来的，来源不知道
  identity: Identity;                  // sourceKey 由核心按 ctx 补
  postId: string;
  url: string;
  post: Post;
  postNoun?: string;                   // 核心从 descriptor.postNoun 补，缺省「作品」
}
```

- **来源只认人**：来源上报只带 externalId；核心按身份查订阅，正常只有一条，老数据里遗留的重复各分一份；查不到或已停用就丢弃、记 debug 日志。

- **作品的文字只有一种拼法**（ADR-0028 决策 1）：`text` 只放正文，文章标题在 `article.title`（不是文章的作品的标题在 `title`，取段时同一个待遇）、视频标题在 `video.title`、转发的原作品在 `repost`。过滤、AI 点评、统计摘要等要整条作品文字的地方，一律经核心 `posts/` 里唯一的取段函数，所有来源同一个：过滤时各段无前缀、换行拼接；AI 用「标题：」「视频标题：」「（转发自 X：…）」。函数名施工时定；它进守卫 4 的点名表，对拍逐字比。
- B 站的映射：动态正文与图文的摘要进 `text`，图文标题进 `article.title`；UP 自己的视频进 `post.video`，番剧、合集、课程进附件的视频卡。
- `images` 只是图集；文章配图在 `article.images`。`blockImages` 就是屏蔽图集。`blockImages` / `blockVideos` 只看最外层，被转发的原作品里的图集与视频归 `blockReposts` 管。
- `video` 表示「作品本身就是这个视频」，上面只有播放数与弹幕数这两个展示数字，点赞、评论、转发这类互动数不设在视频上（10-05 主人定，ADR-0021 决策 25 的 🔗）；作品里引用别人的视频走 `repost` 或 `attachment` 的 `video`。互动数只在 `Post.stats`，收藏 `stats.saves` 这类等有卡片要画时再加。
- `repost` 是被转发的原作品；OneBot 的「合并转发」叫 `mergeForward`，两者无关。
- 所有图格（封面、附加块、锁图标）都是 `PostImage`。图由来源先用 `ctx.fetchImage`（有链接）或 `ctx.storeImage`（手里已是字节）存进图库、填 `ref`，上报里只交 `ImageRef`；抓失败（两者都返回结果形状）由来源决定跳过这张，或只给 `url`（卡上画占位）。
- **正文片段 `RichText`**（09-27 拍板）只有五种，全中立、核心不认识任何平台：
  - `{ kind: "text", text }`：换行留在 `text` 里当 `\n`，不设单独的换行片段；Unicode 表情也在这里。
  - `{ kind: "mention", text, externalId? }`：平台只给昵称时不带 `externalId`。🔗 现状（3b-50，10-26）：字段由 `userId` 改叫 `externalId`，与命名规范「用户 id」一行一致。
  - `{ kind: "topic", text, name }`：`name` 去掉 `#`。
  - `{ kind: "link", text, url, icon?: ImageRef }`：`text` 是来源给的显示文字（B 站节点的 `text`，视频链接就是标题），`url` 是跳转地址（B 站 `jump_url`）；图标由来源存进图库再给引用，核心不留图标枚举。B 站的网页、视频、抽奖、投票、商品节点都翻成链接。
  - `{ kind: "emoji", text, image?: ImageRef }`：`text` 是「[doge]」这种代码，没图时当文字显示。
  - 卡片只画片段的 `text`（有图标就画图标），BN 不写死任何字；纯文本里本来就写着的网址不识别。
  - 1.0 不收样式（粗体、斜体、引用、剧透）：带样式的原文当普通文字，样式丢、字不丢；平铺的片段表达不了嵌套，等真有来源要再设计加宽（如文字片段加可选 `style`）。
- 附加块的翻译都在 `bilibili/`：B 站预约卡与通用卡翻成 `card`，引用的 UGC 视频与番剧、合集、课程翻成 `video`，商品翻成 `goods`；投票没有附加块，只是正文里的链接片段。`card` 的每行是 `{ text, icon? }`：B 站写死的行图标改由来源存进图库再给引用。
- 名字用 `attachment`：`additional` 是 B 站接口原词、又是形容词；`embed` 撞皮肤 HTML 清洗器拦的 `<embed>`。
- 链接预览出的也是 `Post`，就是作品卡，见下「链接预览」。
- 老的 NeutralWork 上的 link / name / isVideo / postNoun / gallery / commentText，要么在信封上，要么由 `Post` 推出来，不许每条路各拼一个包装。
- 统计仓里一条作品记录叫 `PostEntry`（与同文件的 `LiveSessionEntry` 对称），和装配信封 `PostEvent` 是两样东西，见「统计」。
- 以后：音乐、位置（抖音几乎每条都有）做成 `Post` 上的小标签，不是附加块。

**出图字节门**（ADR-0028 决策 2，中立的形状优先）：

- 能用通用手段表达的照样逐字节一致（比如把链接图标的颜色烤进图库里的图）。
- 需要通用能力的就加通用能力（比如上面 `card` 的行 `{ text, icon? }`），不许加 B 站专属的枚举。
- B 站纯装饰去掉。
- 剩下的差异进「批准的像素差清单」，预批三类：平台叫法中立化、内联 SVG 换成图库图的残差、B 站纯装饰去掉；每条写样例、变化、类别与依据。清单外的差异由守卫 10 判红，更新快照必须同时补清单。
- 守卫 10 的字节快照早已覆盖全部卡种（`packages/image` 的 `card-baseline`，10-02 查时 23 份），清单机制 ⑩ 已补上：`approved-card-diffs.ts` 记起点与每次批准的变化，光 `-u` 不记一条照样红。

## 链接预览

群里贴链接，回一张预览（ADR-0029）。目录 `link-preview/`；设置是「配置」里的 `core.linkPreview`；闸门、回复与入站的规矩见 [subscription-sources.md](./subscription-sources.md)「链接预览」。

```ts
interface LinkPreview {                 // LinkResolver.resolve 成功时交的
  post: Post;                           // 出的就是作品卡
  canonicalId: string;                  // 冷却键是「群 + 解析器 + canonicalId」
  nativeShare?: {                       // 原生分享的中立描述，由 OneBot 适配器去签；签不了就回图片
    appId: string; title: string; description: string;
    imageUrl: string; pagePath: string; webUrl: string; iconUrl?: string;
  };
}
```

- `LinkResolver`（链接解析器）补 `label`，`resolve` 返回结果形状。
- 门叫 `LinkPreviewer`（`createLinkPreviewer`、`LinkPreviewerOptions`，文件 `link-preview/link-previewer.ts`）；解析器仍是 `LinkResolver`。
- **设置 `core.linkPreview` 五格** `{ enabled, isOnByDefault, replyForm, byTarget, cooldownSec }`：总开关 `enabled`（默认关，在逐目标的答案之前看）、默认回不回 `isOnByDefault`、回复形式 `replyForm`、按目标的例外 `byTarget`（键是目标 id，条目里 `isOn` / `replyForm`，只存显式写了的）、`cooldownSec`。全仓的 `enabled` 只表示总开关，所以「默认」不叫 `enabled`；AI 写正文的默认同样叫 `isOnByDefault`。链接预览回卡不走推送链，全局静音与免扰管不到，所以留一个一键全停的总开关。
- 回复形式 `replyForm` 取 `image` / `nativeShare` / `text`，面板上是「回图片 / 回原生分享 / 回文字」。「回文字」发作者名 + 作品文字（经作品取段的那个函数，限长），不带链接。
- 入站链接的来源标记：适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" | "nativeShare" }[]`，取代 `miniAppCardLinks`；正文里的链接仍由核心从 `text` 里挑、核心内部记成 `"text"`；规矩是「原生分享卡里的链接不回预览」。
- 🔗 10-13（3b-27 链接半、3b-28）已落：`LinkResolver` / `LinkPreview` 两个类型住 `packages/internal/src/link-preview.ts`（形状同上）；登记表是 `apps/server/src/link-preview/registry.ts`，来源在自己的 `start(ctx)` 里经 `ctx.registerLinkResolver(…)` 登记、停下时自动撤；门（`link-preview/link-previewer.ts`）用 `link-preview/extract-urls.ts` 的通用网址正则挑候选，按登记先后问解析器认不认，冷却分联网前（链接原文）与解析成功后（规范 id）两把键；B 站的解析器是 `bilibili/link-resolver.ts`，原生分享由解析器交中立描述、门翻成今天的小程序卡载荷。入站来源标记 `sharedLinks` 取代 `miniAppCardLinks`、删 B 站域名预筛，3b-30 已落；3b-29 已落：设置键 `linkParsing` 改成 `linkPreview` 五格（回复形式取值 `miniapp` 叫 `nativeShare`，`text` 一档 3b-31 提交 4 已落；现在盘上的键在核心设置顶层，`core.` 前缀随第 4 期）；本节其余还没动；门已改名 `LinkPreviewer`（3b-28 收尾，行为不变）。

## 直播

```ts
interface LiveDetails {                 // 一场直播的内容
  title?: string; cover?: PostImage; category?: string; url?: string;
  currentViewers?: number;              // 此刻在线
  totalViewers?: number;                // 本场累计观看
  likes?: number; description?: string; creator?: Creator;
}

// ① 推送式信号：来源发生了就报，reportLive(externalId, signal)
type LiveSignalReport =
  | { kind: "start";  startedAt?: string; details: LiveDetails }
  | { kind: "status"; isLive: boolean;    startedAt?: string; details: LiveDetails }
  | { kind: "end";    endedAt: string;    startedAt?: string; details?: LiveDetails };

// 核心按身份展开后喂给场次引擎的：每条订阅一份
type LiveSignal = LiveSignalReport & { subscriptionId: string; identity: Identity };

// ② 拉取式：核心定时问 fetchLiveStatus；返回结果形状（ADR-0026 决策 4）
type LiveStatusResult =
  | { ok: true; kind: "live"; startedAt?: string; details: LiveDetails }
  | { ok: true; kind: "offline" }                              // 此刻没在播，核心当成漏收的下播；时长算到「发现已下播的那一刻」，重连后核对发现已下播也走同一条下播的路
  | { ok: false; code: string; message: string };              // 跳过这一轮、记一条问题，不停止监听

// ③ 核心自己记的一场（时刻都是 ISO）
interface LiveSessionInteractions {
  viewerChatCount?: number;                          // 弹幕条数
  viewerChatSenderCount?: number;                    // 发过弹幕的人数，按观众 id 去重
  superchatCount?: number;                           // 醒目留言条数
  superchatTotals?: Record<string, number>;          // 币种 → 本场醒目留言总额
  membershipCounts?: Record<string, Record<string, number>>; // 体系 → 档 → 新增会员数
}

interface LiveSession {
  subscriptionId: string;
  sourceKey: SourceKey;
  startedAt?: string;         // 场次身份：来源给的开播时刻（B 站就是 live_time）⛔ 语义不动
  detectedAt: string;         // BN 认出这一场的时刻；没开播时刻时拿它当身份
  followersAtStart?: number;  // 下播卡算涨粉的基线
  peakTotalViewers?: number;  // 本场报过的最大累计观看
  interactions?: LiveSessionInteractions;  // 经 noteInteraction 汇总，与推送开关无关
  lastDetails?: LiveDetails;  // 下播卡缺的格从这里补
  pendingEnd?: { endedAt: string; startedAt?: string; details?: LiveDetails }; // 断流等待中
}

type LiveSessionEndReason = "signal" | "grace-expired" | "poll" | "superseded" | "stopped";

// ④ 场次的变化 → 推送、统计、总线 live-session-changed
type LiveSessionChange =
  | { kind: "start";  subscriptionId: string; session: LiveSession; details: LiveDetails; trigger: "start-signal" | "status-signal" | "poll" }
  | { kind: "resume"; subscriptionId: string; session: LiveSession; details: LiveDetails }
  | { kind: "status"; subscriptionId: string; session?: LiveSession; isLive: boolean }
  | { kind: "tick";   subscriptionId: string; session: LiveSession }
  | { kind: "ending"; subscriptionId: string; session: LiveSession }
  | { kind: "end";    subscriptionId: string; session: LiveSession; reason: LiveSessionEndReason; endedAt: string; details?: LiveDetails; reportedStartedAt?: string }
  | { kind: "unmatched-end"; subscriptionId: string; endedAt: string; details?: LiveDetails; reportedStartedAt?: string };

// 出卡输入
interface LiveCardInput {
  status: "start" | "streaming" | "end" | "offline";
  creator: Creator;
  title?: string; category?: string; description?: string; cover?: PostImage;
  startedAt?: string;
  currentViewers?: number; totalViewers?: number; likes?: number;   // 只收精确数，缺了就缺键
  followers?: number; followersDelta?: number;
}
```

- `currentViewers`（此刻在线）与 `totalViewers`（累计观看）是两个含义，**不许互相顶替**。统计里的聚合叫 `maxViewers` / `avgViewers`。
- ⛔ 两条语义不动：场次身份按开播时刻认、排在闩之前；统计的 `current` 是「最后一次观测时还开着」，`isLive` 是「此刻真在播」。
- `LiveSessionChange` 的 `trigger` 与 `reason` 是事件原因，不归失败规矩管。
- 结束原因有五种：`signal`（来源当场报下播）、`grace-expired`（断流宽限等满）、`poll`（核对发现已下播）、`superseded`（没报下播又见另一个开播时刻）、`stopped`（来源停止、订阅停用 / 删除、关机）。推下播卡的是前三种；`stopped` 的起因只进日志。
- 场次引擎按开播时刻分场：在播状态或周期核对带来另一个已知开播时刻时，上一场以 `superseded` 结束并新开一场；断流等待期间不分场。`noteInteraction` 攒互动汇总，会员与醒目留言不开单独的总线事件，汇总随场次结束帧交统计。
- `nextTickAt?: string` 仍是原设计：下一次「正在直播」按这一场自己的开播时刻起算；它没有读者，3b-23 未造。
- 场次引擎的行为（断流、定时、重启重建）见 [subscription-sources.md](./subscription-sources.md)「直播」一节。

🔗 10-21（3b-23）已落：`LiveSession` / `LiveSessionChange` / `LiveSessionEndReason` / `LiveSessionInteractions` 住 `packages/internal/src/live.ts`；对外是 ISO 时刻的纯数据投影，状态判定叫 `isLive`，结束时刻叫 `endedAt`，每支变化都带 `subscriptionId`。

回顾快照在模板变量表里记作 `RecapSnapshot`。今天 `ViewerChatCollector.snapshot()` 直接交 `{ sortedWords, senderRecord, senderCount, viewerChatCount }`：`sortedWords` 是按次数降序的词与次数，`senderRecord` 是观众名到弹幕数，`senderCount` 是不同观众名数量，`viewerChatCount` 是弹幕总数；代码还没有另导出一个同名类型。

## 会员、醒目留言与特别关注

会员按「体系 + 档」表达：各平台档数不一、有的由主播自定，一个升序数字装不下。体系由来源在 `descriptor.membershipPrograms` 里声明。体系 id 在全部在册来源之间唯一，登记时撞了拒收；档 key 只在所属体系内唯一，查找必须带（体系 id, 档 key）。

```ts
interface MembershipProgram {
  id: string;                           // B 站叫 "guard"
  name: string;
  tiers: MembershipTier[] | "custom";   // "custom" = 档位由主播自定
}
interface MembershipTier {
  key: string; name: string;
  rank: number;                         // 从 1 起、1 最低
  icon?: PostImage;                     // 徽章
  color?: string;                       // 档色：面板与出图共读
  colorEnd?: string;                    // 档色的止色：卡的背景从 color 渐变到它；没声明就是单色
  announcement?: string;                // 宣告语，可用 {viewer}、{name}、{tier}；没声明就不画
}

interface MembershipEvent {
  subscriptionId: string;
  viewer: { id: string; name: string; avatar?: ImageRef };
  program: string;
  tier: { key: string; name: string; rank?: number };
  action?: "new" | "renew" | "upgrade";
  months?: number;
  tenure?: string;                      // 时长等级：虎牙的 V 等级、累计月数
  gift?: { gifter: string; count: number };
  amount?: number; currency?: string;
}

interface SuperchatEvent {
  subscriptionId: string;
  viewer: { id: string; name: string; avatar?: ImageRef };
  text: string;
  amount: number; currency: string;
  tier?: { rank: number; durationSec?: number };   // 醒目留言的档，来源按平台规矩算；durationSec 是留言挂多久
}

interface ViewerChatEvent {             // 特别关注名单上的人发了弹幕（特别弹幕）
  subscriptionId: string;
  viewer: { id: string; name: string }; // 名单按 viewer.id 整串认，名字只套文案
  text: string;
}

interface ViewerEnterEvent {            // 名单上的人进了直播间（特别进场）
  subscriptionId: string;
  viewer: { id: string; name: string };
}

// 来源经 ctx.reportLiveInteraction(externalId, report) 上报：形状是对应事件去掉 subscriptionId，
// 核心按身份展开成每条订阅一份、对着那条订阅现折的设置判（特性开关与名单两样都要）
type LiveInteractionReport =
  | ({ kind: "viewerChat" } & Omit<ViewerChatEvent, "subscriptionId">)
  | ({ kind: "viewerEnter" } & Omit<ViewerEnterEvent, "subscriptionId">)
  | ({ kind: "superchat" } & Omit<SuperchatEvent, "subscriptionId"> & { fallbackText?: string })
  | ({ kind: "membership" } & Omit<MembershipEvent, "subscriptionId"> & { fallbackText?: string });
```

醒目留言与会员的 `fallbackText` 是出不了卡时用的那句；没给就用核心的中性默认句。

| 事项 | 规矩 |
| --- | --- |
| B 站体系 | `guard`，档 key 是 `captain` / `commander` / `governor`，rank 1 / 2 / 3。B 站接口的 `guard_level` 1 = 总督，这个反向换算只在 `bilibili/` |
| 徽章 | 图库引用，来源声明档位时给（`tier.icon`） |
| 档色 | `tier.color`，面板与出图共读（留卡片那一套：舰长 `#4ebcec`、提督 `#d8a0e6`、总督 `#f2a053`）；可选的 `tier.colorEnd` 是卡背景渐变的止色，面板不读（B 站三档 `#b494e5` / `#b494e5` / `#ef5f5f`）。面板自己的档位色表（`guard-levels.ts`）已删（㉓e）。3a 之前档位表住 `packages/internal/src/bilibili-guard.ts`（零值级依赖，面板经 `@bilibili-notify/internal/bilibili-guard` 子路径取值），面板里只有 `apps/web/src/config/membership-programs.ts` 一个文件读它，对外给中立的 `MembershipProgram` / `MembershipTier`（规则页门槛的选项、上舰文案每档一块、卡片预览的档位钮都从它铺，不写死三档）；3a 把档位表搬进 `bilibili/` 的描述符、由 `/api/sources` 下发，面板只改这一个文件 |
| 宣告语 | `tier.announcement`，由 `interpolate` 填 `{viewer}` / `{name}` / `{tier}`，没声明就不画；皮肤字段 `membership.announcement`，面板上叫「宣告语」 |
| 文案配置 | `templates.membership[体系 id] = { enabled, default, tiers[key] }`。每档与 default 都是文案加图片（`{ template, imageUrl }`），没单独配的档用 default，图片没填用该档的徽章；`guard` 的 default 出厂值是「{viewer} 成为了 {name} 的{tier}！」；`custom` 体系按档名存；`enabled` = 用不用自定义文案，推不推由特性开关管 |
| 门槛 | 每套体系一个 `minRank`，在 `defaults.membership.minRank[体系 id]`，没配就是全推；逐订阅覆盖按体系合并；没有 rank 的体系只能开或关 |
| SC 门槛 | `defaults.superchat.minAmount`，按人民币，没配就不设门槛；别的币种先放行 |
| SC 的档 | `SuperchatEvent.tier`：卡按 `rank` 取色，默认配色照今天六档，皮肤可以按档换色；有 `durationSec` 就显示留言时长（走 `formatDuration`，写「1分」「30分」）。`rank` 从 1 起；超出默认六色用最后一色，没有档用第一色。皮肤自己定每档的色要加挂点，归 ㉔ |
| 金额 | `formatAmount(amount, currency)`：按币种用 `Intl.NumberFormat` 排版，固定中文环境、不加千分位；人民币整数仍写「¥30」「¥2000」 |
| 出图输入 | 只有一种会员卡。`viewer.name` / `viewer.avatar`；没有房管那一格（㉓ 删，见 ADR-0023 决策 3 的 🔗）；不再有 `captainImgUrl`，改用 `tier.icon`；「大航海舰队」文案在 `bilibili/`。皮肤可以按 `rank` 换色；没有 rank 的体系走默认样式。 |

体系上不标「全平台 / 按主播」：不影响路由，先不加。

## 特性键与推送种类

全部特性与附加项都在核心、用中立名。醒目留言、会员、特别弹幕、特别进场、词云、直播总结在别的平台也有对应，只是现在只有 B 站填数据。来源支持哪些特性由 `descriptor.supportedFeatures` 声明，附加项由 `descriptor.supportedExtras` 声明（ADR-0027 决策 6）。历史行存推送种类的那一格叫 `feature`，值就是特性键；`/api/history?feature=`、按天计数的键、测试推送的种类都直接用特性键。

```ts
const FEATURE_KEYS = ["post", "liveStart", "liveStreaming", "liveEnd", "membership",
  "superchat", "viewerChat", "viewerEnter"] as const;   // 后两把原名 specialDanmaku / specialUserEnter
type FeatureKey = typeof FEATURE_KEYS[number];

// 附加项另一张表（ADR-0016）：词云、直播总结挂在下播底下，不是特性键（10-02 按 ADR-0027 决策 6 更正，原先误列进特性键表）
const EXTRA_KEYS = ["atAllPost", "atAllLiveStart", "wordcloud", "liveSummary"] as const;

// 历史行的推送种类就是特性键：`feature: FeatureKey`，不另列 PushKind

// 作品推送的部件（原 packages/dynamic 里同名不同义的 PushKind，值 "dynamic" / "dynamic-images"），与历史行的推送种类（特性键）不是一回事
type PostPushPart = "post" | "post-images";
```

| 键 | 说明 |
| --- | --- |
| `post` / `atAllPost` | 作品推送与它的 @全体 |
| `liveStart` | 开播。子项 `catchUpOnBoot`：启动时发现正在播就补报一次开播——走 `liveStart` 的路由、历史记成开播（`feature: liveStart`）、**不 @全体**、画直播中的卡。0.x 里这张补报的历史标签是「直播中」，1.0 起记成「开播」（主人看得见的变化），推到哪里不变。只有真正的开播能 @全体（`atAllLiveStart`） |
| `liveStreaming` | 周期「正在直播」，间隔 `streamingIntervalHours`（最小 1）。`has.liveStatus` 为真（来源提供了 `fetchLiveStatus`），且 `supportedFeatures` 同时含 `liveStart` 与 `liveEnd`，面板才显示这个开关（⑬d 已落后半：拓展声明了开播与下播两种事件，`featuresForEvents`，面板与服务端同一份；`has.liveStatus` 那半随 3a） 🔗 现状（3b-44，10-25）：这条规则已挪进清单校验，`liveStreaming` 必须同时声明开播与下播，且声明它才要求 `fetchLiveStatus`；`featuresForEvents` 已删 |
| `liveEnd` | 下播 |
| `membership` / `superchat` / `viewerChat` / `viewerEnter` | 核心中立特性；`viewerChat` / `viewerEnter` 是「特别关注名单上的人发言 / 进场」（原 `specialDanmaku` / `specialUserEnter`），触发看名单条目的 `features` |
| `wordcloud` / `liveSummary` | 下播的附加项（`EXTRA_KEYS`，来源用 `supportedExtras` 声明），不单独成历史行 |

⛔ 命名：`liveNow`（仓里 4 处表示「此刻在播」）、`onAir`（6 处表示状态）、`liveStatus`（95 处，拓展事件名）都撞，所以叫 `liveStreaming`。

卡种七种，全由核心登记：作品 `post`、直播 `live`、醒目留言 `superchat`、会员 `membership`、锐评榜单 `roastBoard`、锐评单人 `roastSolo`、词云 `wordcloud`（直播总结只是一段文字，没有卡）。附加块 card / video / goods 核心直接渲染。历史行状态多一种 `silenced`，见 [push.md](./push.md)。

## 统计

统计仓按订阅记作品、直播场次与粉丝时序（文件布局见 [data-and-migration.md](./data-and-migration.md)）。

- **开了开关才监听、才记**（ADR-0027 决策 1）：单个订阅开了作品或直播类开关，就监听、统计就记；关了就不查也不记。「开着」只看开关、不看有没有目标；面板的「不会被监听」与直播就绪判断用同一个内部判定。直播这一侧的判定：五把直播类开关任一开着，或（`viewerChat` 开着且名单上有人带 `viewerChat`），或（`viewerEnter` 开着且名单上有人带 `viewerEnter`）；五把直播开关全关、名单上有人、特别关注开关也关着的订阅，升级后不再监听（0.x 那时是「名单有人就监听」，迁移记账本留一份冻住的旧读法）。核心里直播一侧的 `danmaku` 换成 `viewerChat` 一族（`ViewerChatCollector`、`recordViewerChat`、`viewerChatCount`）；视频上的弹幕数 `video.danmaku` 不动。（3b-14 已落：全仓唯一的判定是 internal 的 `needsLiveMonitor`，服务端与面板共用。）
- **「在记」按特性分**（ADR-0027 决策 2），核心自己算：作品（那天作品开关开着且来源在跑）、直播（直播类任一开关开着且来源在跑）、粉丝（那天拉资料成功）。每张图（热力图也是）读自己的「在记」，关着的日子显示「没在记」、不画成 0；锐评与榜单跳过没在记的日子。seen（「那天有没有联系上来源」）不再单独当判据。记成每个订阅一份按小时的小账（ADR-0027 决策 13）：某个小时某一项第一次满足条件时追加一行，读时按请求的时区切天，满 8 天的随粉丝样本那趟压缩合成区间，原来的 `seen/` 并进去。
- **开播公告不再记**（决策 3）：B 站来源直接丢掉、不上报；旧数据照原定不搬。旧日子的「在记」按旧规则推：作品看旧数据那天有没有记录，直播用现在的直播开关近似。
- 统计记录全部作品，另外记其中带视频的那些：`posts` 是全部作品，`videoPosts` 是其中带视频的（面板与 CSV 仍叫「投稿」「动态」，见改名对照）。

**多收的字段**（决策 4）：规矩是来源已经交到手、不用多发请求、每条几百字节以内；不存图片字节，不收观众个人数据（只收汇总），字段全部可选。除 `url` 外字段名施工时定，照本文件的通用规矩起。

| 行 | 多收什么 |
| --- | --- |
| 作品行 `PostEntry` | 链接 `url`、标题、摘要（取段函数的 AI 拼法，截 200 字）、话题、视频时长 |
| 场次行 `LiveSessionEntry` | 标题 `title`、分区 `category`（开播帧）；弹幕条数 `viewerChatCount`、发弹幕人数 `viewerChatSenderCount`、醒目留言条数 `superchatCount`、按币种的总额 `superchatTotals`、按档的新增会员数 `membershipCounts`（下播帧的场次互动汇总）；累计观看本来就有（`peakTotalViewers`） |

- 不收：检测时点的互动数、弹幕原文、观众名单。估算 50 条订阅一年约 20MB。
- 统计仓能回最近几条作品，AI 的 `get_creator_posts` 读它（代码里没有过单独的「最近作品小缓存」，ADR-0027 决策 14）。字段分期见决策 12：拓展作品的在 ㉖，B 站作品的随 3a，直播场次的随 3b。
- **CSV**：「UID」与「外部 ID」合成一列，放在「平台」旁边，值取 `identity.externalId`，列名走叫法函数；「投稿」「动态」照 ADR-0021 决策 50 不动。代价：只订 B 站的主人导出的 CSV 少一列空的「外部 ID」，后面的列左移一格。

## AI

AI 跟着来源走（ADR-0030）。工具与技能的全表见 [subscription-sources.md](./subscription-sources.md)「AI 工具」。

- **工具参数 `creator`**：中立工具的参数统一叫 `creator`，值是「来源键:外部 id」（按第一个冒号切，如 `bilibili:123`）；核心工具参数里不许出现 `uid`。`list_subscriptions` 与 `search_creators` 的返回带着它。
- **六把中立工具**：原有五把（`list_subscriptions`、`get_creator_profile`、`get_creator_posts`、`get_live_status`、`search_creators(source, query)`）加第六把 `get_creator_stats(creator, days?)`，读统计仓。B 站独有的数据（总播放、获赞、视频列表）由 B 站的 `AiToolProvider` 登记只读工具。
- `AiTool` 加 `label` 与参数标签，面板读下发的，不再写死一张表。
- **看图读图库**：点评与聊天传 `ImageRef`，宿主注入读图函数读字节、过大先缩、拼 data URL 放进请求；`packages/ai` 不碰磁盘；视觉副模型同路，工具返回的图也是 `ImageRef`。
- **聊天附件存进图库**（不是素材库）：会话里存 `ImageRef`，图库清扫把会话算作引用方；上传仍是单张 5MB、每条 4 张、拒 SVG，另外不收 gif，格式按字节嗅探、不信客户端声明；读走 `/api/images/<ref>`，删会话不直接删图（⑳b 已落）。
- **提示词变量**：内置人格、卡片工坊、锐评、内置技能与工具说明里的平台叫法改用 `{creatorNoun}`、`{postNoun}`、`{sources}`，调用时由核心按这次涉及的订阅填；主人自己写的不改写。

## 皮肤字段

皮肤字段跟 `Post` 一一对应。**同名字段在所有卡种同义，装的就是名字说的东西**。

- 对象照原名：`creator.*`、`viewer.*`、`video.*`、`images.*`、`stats.*`。
- 顶层单值加 `post.` 前缀；「有没有」一律 `post.hasX`。
- 值是排好版的文字，所以名字不带单位；排好版的文字不以 `…At` 结尾。
- 卡种 `dynamic` 改叫 `post`；块名 `pics` → `images`、`additional` → `attachment`、`forwardCount` → `shareCount`；所有卡种的 `*.face` → `*.avatar`。

| 以前 | 现在 |
| --- | --- |
| 所有卡种的 `up.*` 与 `master.*` | `creator.*`；`up.isVip` → `creator.isPremium` |
| `sender.*`、`user.*`（付钱的观众） | `viewer.*` |
| 会员卡（原上舰卡）的积木 `user` | `viewerName`（㉔ 定：块名带上是谁的，全表见 construction-plan「㉔ 开片」） |
| `dynamic.time` / `dynamic.action` | `post.time` / `post.label`（内外层卡都填） |
| `dynamic.topic` / `dynamic.hasTopic` | `post.topic` / `post.hasTopic` |
| `dynamic.isForward` / `dynamic.hasAdditional` | `post.hasRepost` / `post.hasAttachment` |
| `dynamic.hasVideo` / `dynamic.hasPics` | `post.hasVideo` / `post.hasImages` |
| `pics.count` / `pics.first` | `images.count` / `images.first` |
| 作品卡 `stats.forward` / `stats.comment` / `stats.like` | `stats.shares` / `stats.comments` / `stats.likes` |
| 下播卡 `stats.fans` / `stats.popularity`（装的是累计观看 / 点赞） | `stats.totalViewers` / `stats.likes`（块也拆开，一块只显示一样） |
| 直播卡 `live.area`、`stats.area` | `live.category`；`stats.area` 删 |
| 直播中 `stats.popularity`、`stats.fans`、`stats.fansChanged`、`stats.hasFansChanged` | `stats.currentViewers`、`stats.followers`、`stats.followersDelta`、`stats.hasFollowersDelta` |
| `video.desc` | `video.description`；`video.duration` 装排好版的文字；`danmaku` 保留 |
| `dynamic.type` | 删；用 `hasVideo` / `hasImages` / `hasRepost` |
| `sc.*` / `guard.*` | 醒目留言卡 `superchat.{ amount, amountValue, duration, rank, text }`（`sc.level` 0–5 → `superchat.rank` 1–6，1 最低）；会员卡 `membership.{ rank, tierName, icon, announcement }`（`guard.level` 1 = 总督 → `membership.rank` 1 = 舰长，`announcement` 是宣告语）；卡种键 `sc` / `guard` 归 ㉔ |
| 锐评榜单卡的 `master.name`（恒为空串） | 删 |
| `live.title` / `live.time` / `live.description` / `live.cover` / `live.hasCover` / `live.isStreaming` / `live.isEnded`，`video.title` / `video.cover` / `video.views` | 不变 |

老卡片皮肤不适配：皮肤包 schemaVersion 抬版、旧包拒收，卡片只用按 1.0 契约新生成的皮肤。迁移怎么处理老指针见 [data-and-migration.md](./data-and-migration.md)。界面皮肤不受影响。

## 配置

主人填的设置按集成分文件，都在 `config/settings/` 下：`core.json`、`bilibili.json`、`extensions/<拓展 id>.json`，一个文件就是一段（ADR-0021 决策 42 下 10-01 的 🔗）。每段的 schema 由那个集成定义。🔗 现状（3b-41 C3，10-17）：三个内置适配器也各登记了一段（`onebot.json`、`qq-official.json`、`webhook.json`），段里没有任何格，开机时配置仓当场建一份 `{}`；它们让 `GET /api/settings` 顶层（`core` 旁边）多三个空对象、备份的 `integrations` 多三个空键。备份版本没有抬：旧备份缺这三个键，恢复时缺的不动，照常能恢复；只有"新版做的备份回到没有这三段的开发版"会被拒，原因是「没有叫「onebot」的集成设置」。拓展的开关归宿主，在 `core.json` 里；拓展的文件只装它自己的设置。`defaults` 只表示「按订阅覆盖时的回退层」：订阅上能覆盖的才放进去，覆盖不了的一律挤出去。

```ts
interface Settings {
  core: {
    master: { targetId?: string };    // 主人目标必须是私聊目标，见下「主人通知」
    defaults: GlobalDefaults;         // 按订阅覆盖的回退层，订阅上的覆盖与它同形
    templatesSeen: TemplatesSeen;     // 出厂文案账本（原 defaults.templateDefaultsSeen，3a-38 已上提）
    ai: AiSettings;                   // profiles、activeProfileId、search.scenes、聊天、thinking{ enabled, level }、hasVision；人格与提示词只在 presets[] 里一处；writing: AiWritingSettings（AI 写正文按目标选，`{ post, liveSummary }` 各一份 `{ isOnByDefault, byTarget }`，byTarget 的键是目标 id，ADR-0032）
    rankingReport: RankingReportSettings;   // 原全局 roastSchedule（榜单周报）：targetIds、windowDays、requiresApproval
    muteEndsAt?: string;              // 原 mutedUntil；没在静音就缺键
    commands: CommandSettings;
    linkPreview: LinkPreviewSettings; // { enabled, isOnByDefault, replyForm: "image" | "nativeShare" | "text", byTarget, cooldownSec }，byTarget 的键是目标 id、条目 { isOn?, replyForm? }
    accounts: { order: SourceKey[] }; // 头部显示顺序
    onboarding: { isSkipped?: boolean };
    update: UpdateSettings;           // isAutoDownloadEnabled 等
    locale?: Locale;                  // 界面语言 zh-CN / zh-TW / en / ja；缺 = 简中（升级上来的；新装见 ADR-0037 决策 17），默认只写在 textSettingsOf 里、不落盘
    voice?: Voice;                    // 文案口吻 maid / plain；缺 = 跟默认（第 4 期定之前女仆），默认不落盘
    marketplace: MarketplaceSettings;
    logging: { level; levels; retentionDays; memoryLog: { enabled } };   // levels 是开放键：核心模块 + 集成键（3a-38 已落，类型 LoggingSettings，levels 默认空表）
    history: HistorySettings;         // { retentionDays }：图片与重推原件保留天数（90 / 60 / 30 / 15 / 7 / 3 / 1，默认 30），文字不设上限、不在其内（ADR-0022 决策 9 的 🔗；键名 10-04 定）
    stats: StatsSettings;             // { enabled }：数据统计总开关，默认开；订阅覆盖不了，所以不在 defaults 里（ADR-0027 决策 9、16）
    profileRefreshCron: string;       // 资料刷新，由 fansCron 原值迁来（3a-38 已落）
    timezone: string;                 // 卡片时间与服务端切天读它，默认 Asia/Shanghai；IANA 名
  };
  bilibili: { dynamicCron; loginCheckIntervalMinutes };   // 由 bilibili/ 定义
  extensions: Record<ExtensionId, unknown>;   // 一个拓展一个文件，只装它的设置，由拓展自己的 zod 校验；开关在 core.extensions.<id>.enabled（归宿主）
}

interface GlobalDefaults {
  features: FeatureFlags;
  filters: ContentFilters;            // 只放作品过滤（block* / allow*）
  templates: { post; postVideo; membership: Record<string, MembershipTemplate>; … };
  wordcloud: { stopWords: string[] };
  quietHours: { startHour: number; endHour: number }[];
  liveStart: { catchUpOnBoot: boolean };            // 启动时发现正在播就补报一次开播，默认关
  liveStreaming: { streamingIntervalHours: number }; // 周期「正在直播」的间隔，1–24，默认 1；开关在 features.liveStreaming
  liveEnd: { grace: { enabled: boolean; waitSec: number } };
  superchat: { minAmount?: number };
  membership: { minRank?: Record<string, number> };
  ai: { presetId?: string };          // 订阅能覆盖的只有人格预设（目标形状；3a-38 之后代码里 defaults 下还没有这一格，指针 activePreset 暂在顶层 ai 里，随 AI 子键改名那一片造）
  cards: { enabled: boolean; liveCoverImageIds: string[] };   // 不按卡种分层（㉔）；订阅覆盖只有 liveCoverImageIds
  cardSkin; cardSkinKnobs;
  imageGroup: { enabled; mergeForward; … };
}
```

- 🔗 现状（3b-12，10-24，`templatesSeen` 与 `ai`）：`templatesSeen` 只给设置里存着的文字记账，值是在主人第一次改那条时记下的简体出厂指纹；新装是空表，换语言不亮「默认文案有更新」。「默认文案有更新」只在文字仍存着、它与当前简体出厂不同、账本有这条、记录的指纹也与当前简体出厂不同时出现；删掉文字时同步删这一条，词云停用词与图片地址不进账本。`ai` 的内置人格内容不存，设置只留 `ai.removedBuiltinPresets`（缺 = 一份没删）与主人自建的 `ai.presets`；顶层 `persona` / `dynamicPrompt` / `liveSummaryPrompt` 已删。指针落空先取清单第一份、再落空取内置首份，缺少的提示词取内置首份那段；从内置另存的副本不跟语言。备份版本 22 拒绝 21 及以前。

**设置坏了只停那一处，不挡开机**（ADR-0025 决策 4）：

| 段 | 校验不过 | 谁能读 |
| --- | --- | --- |
| `core` | 逐格校验（每个顶层键一格，`defaults` 与 `ai` 再细一层）：坏的那格在内存里用默认值、盘上原文不动，问题表记一条「先按默认值跑」；主人在面板上重存那一格就清掉。🔗 3a-39 的后续（10-12，主人定）：`ai.providers` 再按每一家实例细一层，一家读不懂只那一家在内存里不在（别家与各自的密钥照常，原文落盘时放回），实例 id 不许是原型名，整张表不是对象才整张退默认 | 核心 |
| `bilibili` | 只停 B 站这个集成，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起 | 只有 `bilibili/`（守卫拦核心读它） |
| `extensions.<id>` | 只停那一个拓展，同上 | 宿主与那个拓展；卸载删掉这一段 |

- 只有信封坏了（整份解析不了）才挡开机。理由：BN 起不来时，桌面壳连续失败几次就把这一版判死、自愈退回 0.12，还进不去面板改设置；Docker 则反复重启。面板登录凭据在 `bn.config.yaml`，不在这些段里，退回默认值不会把门打开。
- 生命周期闸是唯一的例外：只有 `start` / `activate` 期间读设置失败可以抛错中止启动，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。
- 代价：`core` 某格退回默认时行为会变（过滤、静音、新手引导），靠问题框亮出来。
- 🔗 **现状（3a-39，10-11，上面表里各段的坏法）**：
  - `core`：就是上表那样，盘上原文在落盘时按路径放回；写口唯一（`persistGlobals`）；重存按比值（保存后那一格的值与内存里跑着的默认值不同才算）。顶层不是对象仍挡开机。
  - `bilibili`：**逐格**，不是「停整个集成」。配置仓读盘不抛：一格坏了那一格在内存里是默认值（盘上原文留着，读它的人经 `readIntegrationSettings` 拿到带原文的那一份、拿自己那格的 zod 判），整个文件不是合法 JSON 或顶层不是对象则整段是默认值；面板读到的全量图里 `bilibili` 键一直在、值一直合法。读它的是 B 站来源：动态那格读不懂停动态，登录检查那格读不懂停定时的登录检查，整个文件读不懂两样都停，各有一条问题（见「问题表」）；来源照常在册，运行状态不会是 `settings-invalid`。读盘本身出错（没权限、路径是个目录）仍挡开机。
  - `extensions.<id>`：文件不是合法 JSON 只停那一个拓展（`settings-invalid`，不 `activate`，拓展的状态说明写「设置文件读不懂（不是合法的 JSON）」，文案见 `extensions/loader.ts`），重存写盘成功才清；卸载时坏文件一起删；读不懂的拓展设置不进备份。
  - 订阅文件、推送目标文件、连接外壳读坏不在这张表里，仍挡开机（规范 `settings-validation.md` 写明）。
- **设置按集成放**：设置字段在登记集成时交，不挂在 `SourceDescriptor` 上（ADR-0025 决策 3）；声明了 `settingsFields` 的内置集成在系统页各开一个 tab（今天只有 B 站，tab 名取它的 `label`）；拓展的设置只在拓展页；「运行」tab 只留核心参数。
- **自定义 UA 删掉**（ADR-0025 决策 7）：浏览器身份一律由 `packages/http` 生成，UA 与 `sec-ch-ua` 永远配套；B 站设置页加「换一个身份」按钮重新生成。老配置里的 `userAgent` 这一格由迁移丢掉，新 schema 不留。
- **并发**：所有写入排在同一条队列里；拓展设置用内容哈希做版本号，对不上回 409；面板普通保存在队里深合并。
- **过滤**：`blockReposts` / `blockArticles` / `blockImages` / `blockVideos` 看最外层 `Post` 上「有没有」，在装配第一步、对所有来源生效；转发的原作品里的图集与视频不算，转发归 `blockReposts` 管。关键词与正则看取段函数拼出来的文字。白名单 `allowKeywords` / `allowRegex` 对 `blockKeywords` / `blockRegex`。特别关注去掉 uid 正则，template 死字段退役。SC 与会员的门槛不在 filters 里。
- **主人通知**（ADR-0024 决策 14）：推送层只有一个 `notifyMaster(payload: string | NotificationPayload)`（合掉 `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg`），返回结果形状，审批预览卡也走它。出口上的 `sendPrivate` 与「强制私聊」标志删掉，因为主人要是选了群目标，强制私聊会把群号当 QQ 号错投。私聊的要求挪到主人目标上：`master.targetId` 必须指向私聊目标（schema 校验，面板下拉只列私聊）；PATCH 把主人目标改成群目标直接拒收；发送时再复检一次，不是私聊就拒发（`invalid`）；迁移时指向群目标的清空，首访页提示重选。
- **图集推送行为** `imageGroup`（全局与逐订阅）只作用于 `Post.images`，子键 `imageGroup.mergeForward`。
- **模板变量**：`{postNoun}` 取自 `descriptor.postNoun`（原定 `{noun}`，与提示词变量同名；从没上过盘，不用迁移），默认文案「{name}发布了一条{postNoun}」；人名变量统一 `{name}` / `{viewer}`；会员事件的档名是 `{tier}`（原 `{guard}`），粉丝团名是 `{fanclub}`（原 `{mdn}`，取资料的 `fanClubName`），两者进模板变量可满足性守卫，迁移改写主人的文案、出来的字不变；弹幕总结的其余缩写不动。回顾快照在模板变量表里记作 `RecapSnapshot`。直播文案的 `-key` 写法统一成 `{key}`，全仓只有一个模板引擎 `interpolate`。live 自己的 `applyTemplate` 删掉，直播改走 internal 的 `interpolate`（单遍替换、不回扫）。

### 连接与目标

`connections.json` 回答「用谁发」，一条连接就是一个 bot（OneBot http / ws / 反向 ws、QQ 官方机器人、一个 webhook 地址、拓展借来的 bot）。`targets.json` 回答「发到哪」。订阅按目标 id 引用。内置平台与拓展实现同一个 `PlatformAdapter`、登记在同一张表，连接按 `adapterKey` 分发（ADR-0024；接口见 [push.md](./push.md)）。

```ts
interface Connection {
  id: string;
  name: string;
  enabled: boolean;
  adapterKey: IntegrationKey;          // 哪个平台适配器负责它：onebot / qq-official / webhook，或拓展 id
  platform: string;                    // 开放字符串，只来自新建时挑中的候选
  settings: unknown;                   // 归适配器的 settingsSchema 校验；OneBot 的 transport 是它私有的一格
  platformSnapshot: Omit<PlatformDescriptor, "platform">;   // 只有宿主写，见下
  probeState?: { status: …; … };       // 连接探测，只有宿主写；每分钟探一次，状态变了才写盘；三态取值在 status 里，取值名与其余格施工时定
}

type PushTarget =
  | { kind: "session"; id: string; name: string; connectionId: string; enabled: boolean;
      scope: "group" | "private" | "channel"; address: string;
      parentAddress?: string;          // 上一级容器的地址（官机子频道所在的频道；论坛话题所在的群）
      reachability?: { changedAt: string; … } }   // 会话级通不通；只在通断翻转时写 changedAt，其余格施工时定
  | { kind: "endpoint"; id: string; name: string; connectionId: string; enabled: boolean;
      managedBy: "connection";         // Webhook 这种连接本身就是终点，目标由连接托管
      reachability?: { changedAt: string; … } };

interface PlatformDescriptor {          // 描述一个聊天平台（不是一个适配器）
  platform: string;
  label: string; shortLabel: string; color: string; icon?: string;
  targetKind: "session" | "endpoint";
  scopes: ("group" | "private" | "channel")[];                         // 会话目标能选的会话种类
  addressNouns: Partial<Record<"group" | "private" | "channel", string>>;   // 地址那一格在这个平台叫什么
}

interface ConnectionCandidate {         // listConnectionCandidates(signal) 交的
  name: string;
  platform: PlatformDescriptor;
  settings: unknown;                    // 模板候选的就是默认值
  selfId?: string;
  via?: string;                         // 经由谁借来的（桥：那条接入的名字）
  boundConnectionId?: string;           // 已被哪条连接用上；模板候选没有这一格，可以反复用
}
```

- **两种描述**：`PlatformDescriptor` 描述一个聊天平台（名字、目标形状、地址叫法）；`PlatformAdapterDescriptor { label, shortLabel, color, icon, settingsFields }` 描述一个适配器（它的脸与设置字段），适配器另交 `settingsSchema`。`tint` 统一改叫 `color`；`inbound`（收不收得到回复）与 `atAll`（能不能 @全体）挪成适配器的运行期能力（`capabilities` / `probeCapabilities`）；`connectors` 随「连接器」这一格删掉。`CONNECTION_PLATFORMS` 闭集与平台信息表搬出 `internal`，由适配器自带。
- **连接上删掉的格**：`kind`、`connector`、`extensionId`（并进 `adapterKey`）。`transport` 留作 OneBot 适配器私有的设置。
- **新建连接只有一条路**：挑一个候选，再填字段。平台固定的适配器返回写死的模板候选（OneBot 一个、QQ 官方机器人一个、webhook 四个：飞书、钉钉、企业微信、通用），模板可以反复用；桥返回在线的 bot。
- **`platformSnapshot`**（`PlatformDescriptor` 去掉 `platform` 那一格）只有宿主写：新建时照候选抄、列候选时按平台名刷新、迁移时填、备份里带回；POST / PATCH 带来的一律忽略（`probeState`、`managedBy` 同样只有宿主写）。读它的是面板上连接的脸与目标编辑器、托管目标同步（看 `targetKind`）、目标的 scope 校验；推送层与适配器不读。快照变了不许触发适配器重连。适配器不在场（拓展停了、桥没连上）时，面板照样画得出已有的连接。
- **目标上没有 `platform`**：它只是连接平台的拷贝，平台一律经 `connectionId` 从连接取。两道守卫：改 `connectionId` 时比新旧连接的平台；整节替换时校验连接身份没变。连接不在了的目标只隔离那一条；作用域键去掉平台前缀。
- **连接设置的校验**（ADR-0024 决策 10）：保存时适配器在场就按 `settingsSchema` 校验，不过回 400 并带原因；不在场先存下。读盘时逐条校验，不过的只隔离那一条（不交给适配器、不投递；面板显示「设置不合法」与原因，进问题框；盘上原文不动），BN 照常开机。只有外壳（`id` / `name` / `adapterKey` / `platform`）坏了才挡开机。撤下的旧形状写成明确的名单。
- 冻结的通用 webhook JSON 里 `private` 写死 `false`（主人目标不可能是 webhook）。
- 探测状态与可达性不迁移，开机重探（ADR-0026 决策 5）。

`platform` 在核心里只指推送 / 聊天平台；订阅来源的平台名叫 `sourceLabel`。

### 凭据字段标 `secret: true`

- 凭据字段在 schema 上标 `secret: true`，与各集成、适配器、拓展的设置字段同一写法。面板打码与备份脱敏都读这个标记，不再按键名猜。
- 下发给面板只有一种打码：契约里的 `MaskedSecret`，固定 8 个点，≥24 字符才露头尾各 4 位。带着打码对象写回一律 400；面板保存时没动过的密钥格不进 PATCH。AI apiKey 的哨兵字符串退役。
- Webhook 的 `url` 算凭据（token 常在路径里）。OneBot 的 `baseUrl` / ws 地址面板照常显示，备份里照旧抹掉。
- 密钥放哪：AI key 在 `secrets/config-secrets.enc`；集成的凭据（B 站 cookie、拓展的 token）一律走各自的 `ctx.secrets`，一个集成一个加密文件（B 站 0.x 的 `cookies.json` 由迁移转成它的 `secrets.enc`），位置见 [data-and-migration.md](./data-and-migration.md)。
- 3a-13 已落：连接的 `accessToken`、webhook 的 `secret` 与 `url`、QQ 的 `appSecret`、AI 的各把 key 与联网搜索 key 都按 `MaskedSecret` 下发，AI 的哨兵字符串退役；拓展连接 `config` 里的密钥仍明文下发，随 3a-22。`packages/ui` 出统一的密钥输入框：显示「已配置」+「更换」，各处都换成它。**例外**：QQ 扫码创建时回传的那一次 `appSecret` 不打码。

## 数字、时间与「不知道」

- **计数排版只有一份** `formatCount`（internal），带正负号的变体也在里面。口径照搬卡片现有的：万和亿都一位小数、保留「.0」、万以下不加千分位；统计表「百万以上取整」是同一函数的紧凑档。统计图轴刻度另有 `formatAxisTick`。统一后看得见的变化（主人已知）：首页的亿从两位小数变一位，万以下去掉千分位（「9,500」→「9500」），统计表「1万」→「1.0万」；统计表和六处内联写法原来没有亿档（3 亿粉写成「30000.0万」），跟着修掉。
- **直播人数传精确数**。B 站存 WATCHED_CHANGE 帧里的 num；「1.2万」的解析只在迁移模块。文字模板的 `{watched}` 缺数时，文字渲染器在出口印「暂未获取到」。缺数就缺键：卡上那一格不画，面板照旧显示「—」，`currentViewers` 不再 `?? 0`（现在缺了会印「人气：0」）。「暂未获取到」只在文字渲染器出口印，不再写回直播数据（现在会写回，下播卡可能印出「累计观看人数：暂未获取到」）。
- **时长只有一种写法** `formatDuration(start, end)`，写成「2小时13分5秒」；文字与卡片、B 站与拓展、有没有配 Chrome 都走它。按秒数排时钟格式的另叫 `formatClock`。⑪ 已落（10-02）：卡片与文字、B 站与拓展都走 internal 的 `formatDuration`；`packages/live` 那份不带秒的兜底与 `getTimeDifference` 钩子已删，B 站的 `live_time` 一律经 `biliLiveTimeToIso` 按北京时间换成 ISO 再算。原先那份兜底按服务所在的时区读北京时间，跑在 UTC 的 Docker 里没开卡片渲染时会写成「-47分钟」；`live_time` 为空时以此刻代替的那句也改成按北京时间拼。B 站 `live_time` 的解析还有两份（`packages/image` 的 `parseBiliLiveTime`、`packages/live` 的 `biliLiveTimeToIso`），3a 搬进 `bilibili/` 时合一。
- **进门换 ISO**：拓展契约的毫秒时刻、签名清单的秒、B 站不带时区的 `live_time`（北京时间），都在进门处换成 ISO。🔗 现状（3b-49，10-25）：拓展交来的时刻已改成带时区的 ISO（主人改判，见 ADR-0019 决策 62 下 3b-49 的 🔗）；签名清单的秒、B 站的 `live_time` 照旧。
- 要算时间差的地方，在用的那一刻 `Date.parse`，wire 与盘上只存 ISO。现在存毫秒、要改的 wire 字段（施工清单）：皮肤 `updatedAt`、资源采样 `ts`、市场 `fetchedAt`、更新状态的 4 个 `checkedAt`；在播列表里 B 站行的 `startedAt` 是原样抄来的 `live_time`、拓展行是 ISO，同名不同格式。
- **不知道就缺键**：外部数据不知道就不写这个键（`muteEndsAt: 0`、内置皮肤的 `updatedAt: 0` 也改成缺键）。只有位置固定的格子（数组、表格）用 `null`。出口不受约束：给皮肤的排好版文字缺了就是空串。头像、bio 都是可选，渲染器缺了显示首字。这条不加守卫，靠审查。

## 改名对照

量大但都是机械替换，每批改完 grep 旧名必须为零。盘上有的键归迁移模块（见 [data-and-migration.md](./data-and-migration.md)「迁移步骤」）。特性键、推送种类、皮肤字段见上文。左列是代码里现有的名字；拷问途中起过、没进代码就被推翻的草案名不列。

**人：up / author / master 统一叫 creator。** 之后 `author` 只指皮肤或拓展的作者，`master` 只指「主人」。

| 以前 | 现在 |
| --- | --- |
| `UpCard`、`UpDialog`、`pages/up/`、`UpStatsRow`、`UpMeta`（面板两份）、`upColor` / `UP_COLORS`、`upName` | `CreatorCard`、`CreatorDialog`、`pages/creator/`、`CreatorStatsView`、`CreatorView`（只留一份）、`creatorColor` / `CREATOR_COLORS`、`creatorName`。🔗 10-23（3b-24）：取色已统一为 `identityColor(identity)`；其余面板类型与文件名仍随第 4 期 |
| `UpColorIdentity`、`colorFromUid` | 删掉 `UpColorIdentity`，取色直接收 `Identity`；`colorFromUid` → `colorFromSeed`（🔗 10-23（3b-24）：两件都已落，统一取色口是 `identityColor`） |
| `SubscriptionAuthor` / `AuthorSchema`；拓展契约 `SubscriptionPost.author`、`SubscriptionLiveDetails.author` | `SubscriptionCreator` / `CreatorSchema`；`creator` |
| `UpDynamicEvent` / `appendDynamic` / `listDynamics` | `PostEntry` / `appendPost` / `listPosts` |
| `AUTHOR_FIELDS`、挂点 `masterAvatar` / `masterName` | `CREATOR_FIELDS`、`creatorAvatar` / `creatorName` |
| 直播内部 `MasterInfo` / `masterInfo` / `getMasterInfo` | 删掉：拆进 `Creator`（名字、头像）、`LiveSession.followersAtStart` 与资料的 `fanClubName`，房号留在 `bilibili/` |
| 直播内部 `masterName` / `masterAvatarUrl` / `LiveMasterFeature` | `creatorName` / `creatorAvatar` / `LiveCreatorFeature` |
| AI 视图的 `uname`；历史行 `unameSnapshot` / `uavatarSnapshot` | `name`；`nameSnapshot` / `avatarSnapshot`（⑳d 已落，装图库引用：拓展行写行时抄资料缓存里的 `avatar`、先续期，B 站行缺着到 3a；旧行存的远端头像地址迁移时丢掉，面板退到订阅现在的头像、再退到首字）；消息的配图 `imageRef` → `image`（装图库引用） |
| 订阅来源的平台名 `platform`（AI 视图、锐评对象） | `sourceLabel` |

**数据字段与平台词。**

| 以前 | 现在 |
| --- | --- |
| `desc` / `descChars`、`area` / `areaName`、`sign`、`isVip`、`price` / `priceValue` | `description` / `descriptionChars`、`category`、`bio`、`isPremium`、`amount` + `currency` |
| 此刻在线义的 `online` / `viewers` | `currentViewers` |
| 累计义的 `watchedNum` / `viewers` / `peakViewers` / `avgPeakViewers` | `totalViewers` / `maxViewers` / `avgViewers`（同名两义，按含义分开改） |
| fans 整族：`fans`、`fansChanged`、`FansStore` / `FansSample` / `FansRefreshEntry` / `FansResponse`、`/api/fans`、`fans-refreshed` | `followers`、`followersDelta`、`Followers…`、`/api/stats/followers`（10-03 ADR-0036 推翻原定的 `/api/followers`）、`followers-refreshed`。🔗 10-23（3b-24）：事件、条目与回应已叫 `FollowersRefreshEntry` / `FollowersResponse`，接口已是 `/api/stats/followers`；资料缓存里的 `fans` 字段仍未改名，归 3b-62。🔗 **现状（3b-62，10-24）**：`CreatorProfile` 里的 `fans` 已改为 `followers` |
| dynamic 整族：`DynamicCounts` / `countDynamics`、`dynamicEnabled`、面板 `DynamicMsg…`、`broadcastOptsForDynamicKind`、AI 视图 `dynamic?` | `PostCounts` / `countPosts`、`postEnabled`、`PostMsg…`、`broadcastOptionsForPostPart`、`post?` |
| `NeutralWork` / `WorkDeliveryConfig` / `deliverWork`、`DynamicWorkSettings` / `LiveWorkSettings`、`extension-post-work.ts`、`generateNeutralLiveCard` / `generateNeutralDynamicCard` | `Post` 系 / `deliverPost`、`PostSettings` / `LiveSettings`、`extension-post.ts`、`generateLiveCard` / `generatePostCard` |
| `Post.forward` / `hasForward` / `blockForward` | `Post.repost` / `hasRepost` / `blockReposts` |
| OneBot 合并转发 `forward`、`imageGroup.forward`、`imageGroupForward`、`forwardMinTimeoutMs` | `mergeForward`、`imageGroup.mergeForward`、`mergeForwardMinTimeoutMs` |
| `GalleryImage`、`ForwardImage`、`NeutralWork.gallery` | `PostImage`；gallery 删掉 |
| 时刻的 `ts` / `at`、存数字的 `…At`、`lastSeenMs` | ISO + `…At`（`createdAt` / `publishedAt` / `sampledAt` / `lastSeenAt`…） |
| `cooldownSeconds`、`chromeIdleSeconds`、秒数的 `interval`、`retryTimes` | `cooldownSec`、`chromeIdleSec`、`pollIntervalSec`、`maxRetries` |
| `enable`、wire 上不带前缀的布尔 `live`、`animated` | `enabled`、`isLive`、`isAnimated` |
| `whitelistKeywords` / `whitelistRegex` | `allowKeywords` / `allowRegex` |

**配置与模板。**

| 以前 | 现在 |
| --- | --- |
| `templates.dynamic` / `dynamicVideo`、`customDynamicTemplate` / `customVideoTemplate` | `templates.post` / `postVideo`、`customPostTemplate` / `customPostVideoTemplate` |
| `templates.guardBuy`；`GuardBundle` / `GuardEntry` / `GuardTierKey`；`minGuardLevel` | `templates.membership.guard`；并进会员体系模型；`defaults.membership.minRank` |
| 模板变量 `{guard}`、`{mdn}` | `{tier}`、`{fanclub}`（资料加 `fanClubName?`）；迁移改写主人的文案，出来的字不变 |
| AI 配置 `dynamicPrompt`、`presets[].dynamicPrompt`、`search.engines.dynamic`、AiScene 的 `dynamic` | `postPrompt`、`presets[].postPrompt`、`search.scenes.post`、`post` |
| `linkParsing`、`LinkParsingConfig`、`LinkParser`（`createLinkParser`）、`runtime/link-parser.ts`；带 `linkParsing` / `LinkParsing` 的名字；`ResolveLinkParsingPoliciesInput` | `linkPreview`、`LinkPreviewSettings`、`LinkPreviewer`（`createLinkPreviewer`、`LinkPreviewerOptions`，文件 `link-preview/link-previewer.ts`；`LinkResolver` 已是解析器接口，不能再给门用）、`link-preview/`；带这个词的名字把 `linkParsing` / `LinkParsing` 换成 `linkPreview` / `LinkPreview`；`ResolveLinkPreviewPoliciesOptions` |
| `CommandConfig` | `CommandSettings` |
| `templates.wordcloudStopWords` | `defaults.wordcloud.stopWords` |
| `fansCron` | `core.profileRefreshCron`（原值迁来；✅ 3a-38 已落） |
| 日志级别键 `dynamic` / `live` | 并成 `bilibili`，键改成开放的（核心模块 + 集成键；✅ 3a-38 已落，两个旧键并键时按生效值取更啰嗦的，取法见 [data-and-migration.md](./data-and-migration.md)） |
| `restartPush`、`pushTime` | `liveStart.catchUpOnBoot`、`liveStreaming.streamingIntervalHours` |
| `app.userAgent` | 删掉：身份由 `packages/http` 生成，B 站设置页加「换一个身份」；老配置里这一格由迁移丢掉，新 schema 不留 |
| bootstrap 的 `cookieEncryptionKey` / `BN_COOKIE_KEY` / `--cookie-key`（实际是所有密钥的主密钥） | 中立名（如 `secretsPassphrase`，名字施工时定），yaml、环境变量、命令行三处同步改；旧名永远继续认，新旧同设且值不同就拒绝启动；两份 BootstrapConfigSchema 合一、按可选处理 |
| `chromeIdleSeconds` / `BN_CHROME_IDLE_SECONDS` / `--chrome-idle-seconds` | `chromeIdleSec` / `BN_CHROME_IDLE_SEC` / `--chrome-idle-sec`，旧名永远继续认 |
| bootstrap 的 `preset.pushTargets`（零读取） | 删掉。其余 bootstrap 名字不动；冻住的桌面壳放行的 5 个环境变量、镜像写死的 5 个永不改名 |

**接口、模块与其他。**

| 以前 | 现在 |
| --- | --- |
| 暂定名 `fetchLiveStreaming` | `fetchLiveStatus` |
| `SubscriptionSource`（09-27 定过把 `Source` 改成它，10-10 主人改回）；拓展契约的 `registerSubscriptionSource` / `SubscriptionSourceDef` / `SubscriptionSourceHandle` | `Source`；`registerSource` / `SourceDef` / `SourceHandle`（契约这三个随第 3 版在 3b 改，在那之前代码里仍是旧名）🔗 现状（3b-42，10-24）：三个新名已落成 |
| `registerPushSource` / `PushSourceHandle` / `PushExtensionDef`（字段 `adapter`、`configSchema`）；`AdapterRegistry`；适配器的 `reconcile` / `dispose` | `registerPlatformAdapter` / `PlatformAdapterHandle` / `PlatformAdapterDef`（内置与拓展同一个：适配器 + 描述 + `settingsSchema`）；`PlatformAdapterRegistry`；`start(ctx)` / `stop()`（登记即 `start`）。`PlatformAdapter` 这个名字不变，目录仍叫 `platforms/`，登记表与分发挪到 `push/`；拆出来的两半 `PlatformDialect` / `Connector` 的新名施工时定 🔗 现状（3b-44，10-25）：新名字与 `PlatformAdapterRegistry` 已落，`PlatformAdapterDef` 已摊平并自带 `settingsSchema`，把手只剩 `dispose()`；桥从 `start(ctx)` 拿到的适配器上下文读自己的连接 |
| 拓展的 `ExtensionPushView`（`display` + `connectionFields`）；v1 的 `configFields` | `PlatformAdapterDescriptor { label, shortLabel, color, icon, settingsFields }`；`settingsFields`（v1 退路删掉） 🔗 现状（3b-44，10-25）：wire 已改成摊平的 `PlatformAdapterDescriptor`，`ExtensionPushView`、`ExtensionDisplay` 与 `connectionFields` 已删 |
| `CONNECTION_PLATFORMS` / `ConnectionPlatform`、`PLATFORM_REGISTRY` | 删掉：平台信息由适配器的候选给，连接上存 `platformSnapshot` |
| `NotificationSink`、多路分发 `MultiplexSink` | `TargetDispatcher` |
| `BilibiliPush` / `bilibili-push.ts` / `BilibiliPushOptions` | `PushRouter` / `push-router.ts` / `PushRouterOptions` |
| `BiliEvents`；事件 `source-auth-changed` / `live-session` / `live-viewers` | `BusEvents`；`subscription-auth-changed` / `live-session-changed` / `live-viewers-changed`（🔗 10-21（3b-23）已落：后两条按订阅 id 发，人数只带来源报了的格） |
| `ExtensionLiveSession`、`fansAtStart`、场次上的 `totalViewers` | `LiveSession`、`followersAtStart`、`peakTotalViewers`（🔗 10-13（3b-20）已落的只有第一个：`ExtensionLiveSession` → `LiveSession`，随场次引擎 `ExtensionLiveSessions` → `LiveSessionEngine` 搬进 `live/live-sessions.ts`、变化类型 `LiveSessionChange` 的判别键 `type` → `kind`；`fansAtStart` 与 `totalViewers` 两格仍是旧名） |
| `SubRuntimeStore` / `SubRuntime`、`SubAvatarStore`、`subId` 系、`/api/subs` | `SubscriptionStateStore` / `SubscriptionState`（与 `subscription-state.json` 同一个词）、头像库删掉并进图库（`SubAvatarStore` 与它的读口 ⑳c 已退役，资料缓存的 `avatar` 装图库引用、B 站的远端网址叫 `avatarUrl`）、`subscriptionId` 系、`/api/subscriptions`。🔗 10-23（3b-24）：资料缓存整族改名**未做，归 3b-62**：`CachedProfile` → `CreatorProfile`、`sign` → `bio`、`fans` → `followers`、`lastRefreshedAt` → `refreshedAt`，`avatarUrl` 退出核心缓存与 `subscription-state.json` 文件改名也在那一片。🔗 **现状（3b-62，10-24）**：已落成 `CreatorProfile` / `CreatorProfileSchema`、`SubscriptionState` / `SubscriptionStateStore`（`createSubscriptionStateStore`、`apps/server/src/runtime/subscription-state-store.ts`）与常量 `SUBSCRIPTION_STATE_FILE`，盘上文件叫 `runtime/subscription-state.json`，孤儿清理叫 `pruneOrphanSubscriptionState`；`sign` / `fans` / `lastRefreshedAt` 已改为 `bio` / `followers` / `refreshedAt`，`avatarUrl` 退出核心资料缓存，B 站头像来源地址只住 `ctx.state` 的 `profile:<uid>` |
| `identityOf`（草案名） | `subscriptionIdentityOf` |
| 会员 `tiers: "dynamic"`（草案名）；`packages/dynamic` 的 `PushKind`（命名批中途叫过 `DynamicPushPart`） | `tiers: "custom"`；`PostPushPart`（`post` / `post-images`） |
| 错误体 `{ error, message }`、`{ ok: false, err }` | `{ code, message }`、`{ ok: false, code, message, upstreamCode? }` |
| 应用内更新失败原因 `reason` 的 kebab 取值 | snake |
| `AIOverride` / `AISettings` / `AIScene` / `APIFlavorId`；`WordCloud` / `wordCloud` / `Wordcloud` | `Ai…` / `Api…`；`WordCloud` / `wordCloud`（特性键仍是 `wordcloud`） |
| `formatWan` / `formatSignedWan` / `formatAxisWan`；`pigeon` / `diligent` | 并进 `formatCount`、`formatAxisTick`；`leastActive` / `mostActive`（连同提示词与草稿） |
| `DailyHistoryCount.d`、`Opts`、`Img`、`normaliseAvatarUrl` | `day`、`Options`、`Image`、`normalizeAvatarUrl` |
| `HistoryPatch.patch`、`PickCardBackground`、table 积木的 `count` | `rowId`、`PickLiveCover`、`showCount` |
| 两个 `createSerialGate` | `createSerialQueue`（串行队列）、`createRenderGate`（渲染闸） |
| `PushLike`、`SubItemView`（动态、直播、AI 各一份） | 各合成一份；推送出口收成 `broadcast(subscriptionId, messages, feature)`；`SubItemView` 由 internal 的「生效特性」解析器产出 |
| 拓展积木 `qrLogin` | 删掉 |
| `CommandSpec`；B 站自带的 `login` 指令 | `CommandDef`（字段不变）；核心的通用指令 `login [来源]`；1.0 不造 `CommandProvider` |
| contract 的 `DevScenario`（过线给面板的纯声明）；`DevParamError` / `DevScenarioNotFound` | `DevScenarioDescriptor`；删掉（`run` 返回结果形状，回 `invalid` / `not_found`）。🔗 现状（3b-45，10-25）：`DevScenarioDescriptor` 及场景族住 `packages/internal/src/devtools.ts`，`@bilibili-notify/extension` 与 contract 都只转类型，不另造一份 |
| AI 工具参数 `uid`；内置技能 `find-up` / `up-pk` | `creator`（「来源键:外部 id」）；`find-creator` / `creator-pk`，旧名留别名 |
| 聊天附件目录 `assets/chat` | 进图库，会话里存 `ImageRef`；被会话引用的逐张复制进去，孤儿不搬。🔗 修订：0.x 的女仆对话与聊天附件不迁（见 [data-and-migration.md](./data-and-migration.md)），这一行只管 1.0 新产生的附件 |
| 特别关注名单 `specialUsers`（盘上的 0.x 形状 `{ uid, kinds, template? }`）、特性键 `specialDanmaku` / `specialUserEnter`；条目上的死格 `template` | `specialViewers`（条目 `SpecialViewer { id, note?, features }`，比对文件 `live/special-viewers.ts`）、`viewerChat` / `viewerEnter`；`template` 退役。迁移专门有测试钉老键上的名单一个不少 |
| 核心里直播一侧叫 `danmaku` 的名字（观众在直播间里说的话）：收集器、记录函数、计数字段 | `ViewerChatCollector`（`viewer-chat-collector.ts`）、`recordViewerChat`、`viewerChatCount`；视频上的弹幕数 `video.danmaku` 不动；B 站目录里仍叫 `danmaku` |

**订阅与来源（09-27 字段名专项审查）。**

| 以前 | 现在 |
| --- | --- |
| `Identity` 判别联合 `{ kind, uid }` / `{ kind, extensionId, externalId }`；`SourceKey` 的 `ext:<id>`；`sourceKeyOf` | `{ sourceKey, externalId }`；`bilibili` 或拓展 id，不加前缀；读 `identity.sourceKey` |
| `SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription`；`EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX` | 删掉，按 `sourceKey` 判；`EXTERNAL_ID_MAX` |
| 拓展契约 `lookup` / `lookupPlaceholder`；草案的 `lookupCreator`；`/api/subs/search` 与 `/api/subs/lookup`；候选 `ExtensionSubscriptionCandidate{ id, avatar, fans }`、面板 `UpProfileLookup` / `SearchResponse` | `searchCreators`（返回结果形状）/ `searchAccepts`（提示句改由核心拼）；删掉（用 `fetchProfile`）；`GET /api/sources/:sourceKey/creators?q=`；`CreatorCandidate`，面板本地类型删掉 🔗 现状（3b-44，10-25）：`lookupPlaceholder` 已删，`searchAccepts` 已随清单与视图下发；面板拓展支先统一用通用提示，按 `searchAccepts` 拼句的叫法函数随第 4 期。🔗 现状（4-15，10-28）：`/api/subs/search`、`/lookup` 的后身与 `/api/ext/:id/lookup` 都删了，面板本地的 `UpProfileLookup` / `SearchResponse` 删了，叫法函数是 contract 的 `creatorSearchHint` |
| `fetchProfile` 查无此人回 `null` | 返回结果形状：`not_found` 记成 `creator_not_found` 问题，其余当暂时失败 |
| `ExtensionOwnSubscription{ id, externalId, enabled }` | `SourceSubscriptionView{ externalId, features, monitorsLive }`（从订阅现算、给来源看的只读形状；只列启用中，同一人的 `monitorsLive` 取或） |
| `reportSubscriptionsChanged` | 删掉（关注同步是 BN → B 站单向） |
| `PostEvent.id`；`reportPost(externalId, SubscriptionPost)`、`reportLiveStart` / `End` / `Status`；上报种类五种 | `postId`；`reportPost(externalId, PostReport)`、`reportLive(externalId, LiveSignalReport)`；收成 `post` / `live` / `profile` |
| `ctx.report("problem" / "problem-resolved")` 与 `level`；`SubscriptionState.problem` | `reportProblem` / `resolveProblem` 与 `notify?: boolean`；问题表 `Problem`，全在内存，订阅运行态不再存 |
| `SourceAuth.secrets{ export, import, redactPatterns }` | 删掉；临时凭据用 `ctx.redact(value)` |
| `descriptor.features` / `extras`；清单 `display{ … }` + `events` | `supportedFeatures` / `supportedExtras`；摊平成 descriptor 同名字段，删 `SUBSCRIPTION_EVENT_FEATURES` 🔗 现状（3b-44，10-25）：清单订阅段与 wire 视图都已摊平并改读 `supportedFeatures`，`display`、`events` 与事件对照表已删 |
| `ExtensionDTO.reportProblems` 这一族 | `InstalledExtensionView.reportDiscrepancies` / `ReportDiscrepancyView` / `extension-report-discrepancies-changed`（上报出入：整条拒、丢了几格、这一轮没推都记在这；10-09 主人把原定的 `Rejection` 换成 `Discrepancy`，因为「被拒」只对其中一种；每个集成一张，与问题表分开） |
| `LiveStatusResult.state`、`"ended"`、`reason` | 结果形状：成功 `ok: true` + `kind`（`"live"` / `"offline"`），失败 `ok: false` + `code` + `message` |
| `trigger: "signal" / "status"`；`status()`；`onSubscriptionAdded(sub)`；`LiveSession.last` | `"start-signal" / "status-signal"`；`health()`（只交 `SourceHealth { summary }` 一行字）；删掉（与 `onSubscriptionsChanged` 重复）；`lastDetails` |
| ⚠️ 面板在播列表 `LiveListenerSnapshot.viewers`（装的是累计观看的排版字符串「1.2万」） | `totalViewers: number`，**不是** `currentViewers`（🔗 10-21（3b-23）已落：`LiveListeningEntry.totalViewers`） |
| ⚠️ `upstream_failed` 错误体里占着 `code` 的 B 站数字码 | `upstreamCode` |
| `LiveSessionRecord.peakViewers`；统计帧 `{ k, ts, peak }`；`UpStatsRow.archives` / `dynamics`；`FansSample.value` | `LiveSessionEntry.peakTotalViewers`；`{ kind, occurredAt, peakTotalViewers }`；`CreatorStatsView.videoPosts` / `posts`（**口径从「其余」变「全部」**：`posts` 是全部作品，`videoPosts` 是其中带视频的）；`followers` |
| 在播表：contract 的 `LiveListenerSnapshot` / `ExtensionLiveSnapshot`、服务端 `LiveListeningEntry` 两支；`attachBiliStatsSource` / `attachExtensionStatsSource` | 一个形状 `LiveListeningEntry { subscriptionId, identity, isLive, title?, category?, startedAt?, totalViewers? }`；`bindStatsRecorder`（🔗 10-21（3b-23）已落：在播表已合成一个形状；统计的直播那一支并成 `stats/live-source.ts`，整个适配器未合；🔗 现状（3b-26，10-24）：`attachBiliStatsSource` 已删，换成 `stats/registry-source.ts` 的 `attachRegistryStatsSource`（对所有在册来源记「这个小时在记」、忘登录丢了的在飞场次）；拓展一支 `attachExtensionStatsSource` 仍在，`bindStatsRecorder` 这个名字仍没落，随 3b-42 并入）🔗 现状（3b-42，10-24）：`bindStatsRecorder` 退役不造；拓展来源登进登记表后由 `attachRegistryStatsSource` 一并记，旧翻译层的 `stats/extension-source.ts` 随拓展上报一支删了 |
| 面板 `SubscriptionPlatform` / `subscriptionPlatformOf`、`BILI_PLATFORM`、`SubscriptionLookup`、`absent`；`BILI_ONLY_EXTRAS`、`guard-levels.ts` | `SourceDescriptor` / `descriptorOf(sourceKey)`、`sourceKey`、`SubscriptionTable`、`isAbsent`；删掉，改看 `supportedExtras`、`MembershipTier.color` |
| 历史行推送种类那格 `kind`（⑬f 已落）；`AuthState` 的 `loggedOut` / `awaitingScan` / `loggedIn` | `feature`；`logged-out` / `awaiting-scan` / `logged-in` |

**推送（09-27 字段名专项审查、09-28 推送侧中立化）。**

| 以前 | 现在 |
| --- | --- |
| 订阅顶层 `extras`（按目标的三态表） | `extraTargets` |
| `retryOf` / `HistoryRetryMessage`（人工重推） | `repushOf` / `HistoryRepushMessage` |
| 连接 `testStatus`（`ConnectionTestStatus`）；`ProbeResult.ok: boolean \| null`；目标 `testStatus.lastCheckedAt`（只在通断翻转时写） | `probeState`（对象，类型 `ConnectionProbeState`）；三态 `status`；`reachability.changedAt` |
| 连接的 `kind`（`direct` / `extension`）、`connector`、`extensionId`；连接的 `config` | 删掉，分发键并成 `adapterKey`；`settings`（OneBot 的 `transport` 留在里面，是它私有的设置） |
| `OnebotConnectionConfig` / `WebhookConnectionConfig` / `QQOfficialConnectionConfig`、桥的 `BridgeConnectionConfig` | `…ConnectionSettings`，随各自的适配器搬出 `internal` 🔗 现状（3b-44，10-25）：桥的旧名已改成 `BridgeConnectionSettings` |
| endpoint 目标的 `scope: "channel"`；目标的 `platform` | 删掉（通用 webhook 对外 JSON 照写常量）；删掉（经 `connectionId` 从连接取） |
| `PlatformDescriptor.tint`、`inbound`、`atAll`、`connectors` | `color`；挪成适配器的运行期能力；删掉 |
| `POST /api/connections/:id/test`；`/api/push/test`；`TestResponse` 与 `TestPushResponse` | `/probe`；`/api/targets/:id/test`；合成一个 |
| `TargetPlatformSchema`；`isConnectionOn`；拓展契约 `listBots` / `ExtensionBotView` / `boundTo` | `OpenPlatformSchema`；去留施工时定（连接不再分直连 / 拓展，分发按 `adapterKey`）；`listConnectionCandidates(signal)` / `ConnectionCandidate` / `boundConnectionId` |
| 重推原件 `DraftSchema` / `DRAFT_GONE`、`v`、`own`；`HistoryRecordInput.target`；`countsAsDelivery`（现在 failed 也回 true）；`PushMessageRole` 与 `HistoryMessageRole` | `RepushSnapshot`、`version`、`own` 与 `mime` 删掉（⑳d 已落：原件图格装图库引用，图按摘要进图库、按引用清扫，「复用历史那份 / 自己存的」不再有区别，格式随引用走）；`NewHistoryEntry.targetId`；改成名副其实的名字，按真实语义起（施工时定）；合成一个。`HistoryEntry` 不改名（它就是日志里的一条） |
| `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg`；出口 `sendPrivate` 与 `{ private: true }` | `notifyMaster(payload: string \| NotificationPayload)`，返回结果形状；删掉 |
| 链接回复现造的临时目标 | 删掉：回复经 `TargetDispatcher.sendToAddress(connectionId, address, payload)` 发回原会话 |
| `/api/history?uid=` | 删掉（没有调用方）；以后要按人查再加 `?identity=` |
| 载荷 kind `"forward-images"`；小程序卡 `picUrl` / `path`；判别键 kind 与 type 混用；`synthetic`；`InboundSinks`；入站 `groupId` / `userId`；`QQDiscoveredEntry.openid` | `"image-group"`；`imageUrl` / `pagePath`（桥帧照旧，在适配器里映射）；统一 `kind`；`isSynthetic`；`InboundHandlers`；私聊 `userId` → `address`、群消息 `groupId` → `address` 且发言者 `userId` → `senderId`（与 `selfId` 成对；不用 `author`，那是作品作者；桥协议帧不改名，由桥的适配器映射）；`address` |
| OneBot 入站的 `miniAppCardLinks`；B 站域名预筛 `CARD_HOST_HINT` | 适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" \| "nativeShare" }[]`（不用 `linkPreviews`：与 BN 回出去的 `LinkPreview` 同词两义），正文里的链接由核心从 `text` 挑、内部记成 `"text"`；删掉 |
| WS 频道 `push-events`；测试推送种类 `dyn` / `sc` / `guard`；失败原因 `reason` / `err` / `why`（重推预检的 `reason` 也在内，判别键 `can` 保留）；两级 `ConnectionCapabilitiesMap`；`muted` / `allowAtAll`；`mutedUntil` | `post` / `superchat` / `membership`（㉔e，与卡种键同一套词表）；特性键；`code` + `message`；收成一级；带 is 前缀（施工时定名）；`muteEndsAt` |

**配置（09-27 字段名专项审查）。**

| 以前 | 现在 |
| --- | --- |
| 全局 `roastSchedule` 及 `targets` / `days` / `approval` | `core.rankingReport`（类型 `RankingReportSettings`）及 `targetIds` / `windowDays` / `requiresApproval` |
| `app.logLevel` / `logLevels` / `logRetentionDays` / `memoryLog`；`app.historyRetentionDays`；`app.healthCheckMinutes` | `core.logging.{ level, levels, retentionDays, memoryLog.enabled }`（✅ 3a-38 已落，`app` 这个键已从核心设置里消失）；`core.history.retentionDays`（已落）；`core.timezone` 是 1.0 新增格（0.12 的 `app` 里没有这一格，零代迁移不写，缺了由 schema 默认补 `Asia/Shanghai`）；`bilibili.loginCheckIntervalMinutes` |
| `update.autoDownload`；`onboarding.skipped` | `update.isAutoDownloadEnabled`；`onboarding.isSkipped` |
| `schedule.quietHours`（`start` / `end`）；`schedule.liveEndGrace*`；`filters.minScPrice` / `minGuardLevel` | `defaults.quietHours`（`startHour` / `endHour`）；`defaults.liveEnd.grace{ enabled, waitSec }`；`defaults.superchat.minAmount` / `defaults.membership.minRank` |
| `cardStyle` / `cardStyleByKind` / `liveCoverImages`；退役的 `font` / `fontAsset` / `glass*` | `defaults.cards { enabled, liveCoverImageIds }`，`cardStyleByKind.live` 的封面图并上来、按卡种那一层取消（㉔e 已落）；逐订阅同形 `overrides.cards { liveCoverImageIds? }`（空数组算「有」：这位 UP 不用自定义封面）；从 schema 删掉 |
| `linkParsing.enabled` / `.defaults.parse` / `.defaults.form` / `.groups`（条目里 `parse` / `form`）、`cooldownSeconds` | `linkPreview` 五格：总开关（旧 `enabled`，默认关）、默认（旧 `defaults.parse`）、`replyForm`（旧 `defaults.form`）、`byTarget`（旧 `groups`，条目里 `parse` → 开关、`form` → 回复形式）、`cooldownSec`。名字落成 `enabled`、`isOnByDefault`、`replyForm`、`byTarget`（条目 `isOn` / `replyForm`）、`cooldownSec`；AI 写正文的默认同改 `isOnByDefault`。一一对应、行为不变、名单不丢 |
| 小程序卡：回复形式取值 `miniapp`、`LINK_REPLY_FORMS`、`MiniApp…` 类型、载荷种类 `"miniapp-card"`、能力格 `miniAppCard`、面板「小程序卡」 | 原生分享：取值 `nativeShare`（随 `linkPreview` 同一趟迁移），回复形式另有 `text`；载荷种类 `"native-share"`，类型 `NativeShare…`，能力格 `nativeShare`；面板上是「回图片 / 回原生分享 / 回文字」，原生分享附的小字由适配器的描述给，核心与面板里不写平台名；桥帧里的载荷种类（`miniapp-card`）与能力名（`miniAppCard`）alpha 期间不改，1.0.0 之前两步改完，改成什么名字见 [construction-plan.md](./construction-plan.md)；🔗 2026-10-19 能力格已改名：`ConnectionCapabilities.miniAppCard` → `nativeShare`（内部，不动盘），桥帧线上名照旧 |
| `defaults.ai` 的 `providers` / `activeProfile`、`search.engines`、`enableThinking` + `thinkingLevel`、`enableVision`；`activePreset` 与 `overrides.ai.preset`；顶层 `persona` / 提示词；`defaults.templateDefaultsSeen` | `core.ai.profiles` / `activeProfileId`、`search.scenes`、`thinking{ enabled, level }`、`hasVision`；`defaults.ai.presetId`；只在 `presets[]` 里一处；`core.templatesSeen`。已落（3a-38）的只有位置：`defaults.ai` 整段成了顶层 `ai`、`defaults.templateDefaultsSeen` 成了顶层 `templatesSeen`，键名一个没改；`defaults.ai.presetId` 这一格没造（`activePreset` 随整段留在顶层 `ai` 里），随 AI 子键改名那一片。🔗 现状（3b-12，10-24）：顶层 `persona` / `dynamicPrompt` / `liveSummaryPrompt` 已删；内置人格只按当前语言取，`ai.presets` 只存主人自建的，删过的内置 id 存在 `ai.removedBuiltinPresets`。`templatesSeen` 只给存着的文字记账。零代迁移修订号 52。 |
| `messageLayout.version`；面板标签键的裸叶子键、`app.*` 前缀、`ai.persona.*` 死条目 | 退役；写全路径、按新分段换前缀、删死条目、补上缺的条目 |

**类型名后缀（ADR-0023 决策 15，按 [naming.md](../agents/conventions/naming.md) 改）。** 上面几张表里已有的不重复列。

| 以前 | 现在 |
| --- | --- |
| contract：`DevStatusDTO` / `DevActiveDTO` / `DevCapturesDTO` | `DevScenariosResponse` / `DevActiveResponse` / `DevCapturesResponse` |
| contract：`MaidSkillDTO` / `MaidSkillProblemDTO`；`MarketplaceSourceDTO` / `MarketplaceEntryDTO`；`AiToolTraceDTO` / `AiChatMessageDTO` / `AiCardSkinTouchDTO` / `AiConversationDTO`；`ChromeSourceDTO` | `MaidSkillView` / `MaidSkillProblemView`；`MarketplaceSourceView` / `MarketplaceEntryView`；`AiToolTraceView` / `AiChatMessageView` / `AiCardSkinTouchView` / `AiConversationView`；`ChromeOriginView` |
| contract：`AiConversationMetaDTO` | `AiConversationMeta` |
| contract：`ExtensionDTO`（拓展页那张卡，没跑起来的也在） | `InstalledExtensionView` |
| contract：`UpdateStatusDTO` 与服务端别名 `UpdateStatus`（`GET /api/update` 的整份响应） | `UpdateResponse`，别名删掉；里面那格 `UpdateState` 不动 |
| contract：`SubscriptionDTO` / `BiliSubscriptionDTO` / `ExtensionSubscriptionDTO` / `SubscriptionRuntimeDTO` | 两支合成一个 `SubscriptionView` |
| `ExtensionStateDTO`（`ExtensionRunState` 的别名）；`ExtensionRunState`（装的是取值） | 别名删掉；`ExtensionRunStatus`，常量 `EXTENSION_RUN_STATES` 跟着改 |
| `MarketplaceEntryState`（六档取值） | `MarketplaceEntryStatus` |
| `HistoryRepushInfo` | `HistoryRepushView` |
| contract 的 `StatsRoastRunOutcome`、服务端 `RoastRunOutcome` 与 `ReportOutcome`（三份同形） | contract 里一份 `RoastRunResult`，服务端两处都用它 |
| 服务端 `DevRunOutcome` 与面板 `RunOutcome` | contract 里一份 `DevRunResult` |
| `ActionOutcome`、`MarketplaceInstallOutcome`、`QQSendVerdict`、`DeliverOutcome`（锐评投递）、`PushMessageOutcome`、`CellOutcome`、桥的 `BridgeSendOutcome` / `BridgePingOutcome` | `ActionResult`、`MarketplaceInstallResult`、`QQSendResult`、`RoastDeliveryResult`、`PushMessageResult`、`CellResult`、`BridgeSendResult` / `BridgePingResult` |
| `LookupOutcome`（解析门） | 随 `searchCreators` 改成 `…Result` |
| `StoredSettingsVerdict` / `judgeStoredSettings` | `StoredSettingsCheckResult` / `checkStoredSettings` |
| `ParsedExtraParams`（装的是 `{ ok, value, error }`） | `ExtraParamsParseResult` |
| `SweepReport`（这次清扫的结果）；`StatusReport`（status 指令现算的） | `SweepResult`；`StatusView` |
| `LiveSessionRecord`；`StatsSeenRow`；`ProvenanceRecord`；`ProcRow` | `LiveSessionEntry`；（seen 行没有了，并进「在记」的账 `RecordingEntry`，ADR-0027 决策 13）；`ProvenanceEntry`；`ProcessEntry` |
| `ModuleStatus`（装的是四个布尔的对象） | `ModuleState` |
| contract 的 `BrowserProcessState`（装的是取值）与 WS 字段 `ResourceSample.browserState`；服务端 `BrowserProcessInfo`（`{ state, pid }`） | `BrowserProcessStatus` 与 `browserStatus`；`BrowserProcessState`，里面的 `state` 改 `status` |
| `LoginSnapshot`（internal、B 站 api、面板各一份）；服务端 `LoginSnapshotView`；devtools 登录场景的 `OverridableStatus` | 中立一侧用 `AuthState`，`bilibili/` 里还要原形就叫 `BiliLoginState`；删掉（`login` 改核心通用指令、场景搬进 `bilibili/` 的 devtools，都读 `AuthState`）。✅ 3a-29 B 站半已落：三份 `LoginSnapshot`、`LoginSnapshotView`、`OverridableStatus` 都删了，`BiliLoginState` 住 `bilibili/auth/login-state.ts`；devtools 登录场景改盖 `Source.auth` 的 `state()` / `account()`，用 `OverridableApi<Required<SourceAuth>>`。`login` 仍是现有的那条私聊指令，只改成读 `AuthState`，改核心通用 `login [来源]` 仍随 3b |
| `AIProviderMeta` / `WebSearchBackendMeta` | `AiProviderDescriptor` / `WebSearchBackendDescriptor` |
| `GlobalConfig` / `AppConfig` / `MasterConfig` / `OnboardingConfig`；`ScheduleConfig` / `ScheduleConfigPartial` | `Settings` 的分段（`core.*`）；拆进 `defaults.quietHours` 与 `defaults.liveEnd`。`AppConfig` 已随 `app` 删掉（3a-38，换成 `LoggingSettings`）；`GlobalConfig` 等其余名字没动 |
| `PersonaConfig` / `CommentaryGeneratorConfig` / `ImageRendererConfig`（设置的值） | `PersonaSettings` / `CommentaryGeneratorSettings` / `ImageRendererSettings` |
| `WebSearchExecutorConfig`、`EnableCheckArgs`（参数包） | `WebSearchExecutorOptions`、`EnableCheckOptions` |
| devtools update 场景的本地 `Params`；HTML 清洗器的本地 `Ctx`；出图的 `AssembleCtx` | `UpdateScenarioValues`；`SanitizeState`；`AssembleState` |
| `QQTokenManager` / `QQTokenManagerOptions`；`KeyManager` | `QQTokenCache` / `QQTokenCacheOptions`；`KeyFileLoader` |
| `StorageManager` / `StorageManagerOptions` | 删掉（B 站 cookie 改走 `ctx.secrets`） |
| `SubscriptionStore`（`packages/subscription`，不存盘的内存镜像）；`WsTicketStore`（内存里的一次性票）、桥的 `BridgeBlobStore`（内存里取过即焚的图） | `SubscriptionCache`；`WsTicketIssuer`；`BridgeBlobCache` |
| `createClaimTable` / `ClaimTable<T>`（登记表） | `Registry<T>` / `createRegistry`，住 `integrations/registry.ts`（3a-08 已落；`entries()` 等第一个调用方出现再补，见 [architecture.md](./architecture.md)「接口族与登记表」） |
| 拓展契约 `ExtensionSubscriptionView`；v1 的 `ExtensionDescriptor` / `ExtensionConfigField` | 摊平进 `SourceDescriptor`；删掉 🔗 现状（3b-44，10-25）：`ExtensionSubscriptionView` 已摊平并改读 `supportedFeatures`，名字暂留；并进 `SourceDescriptor` 再删除这一步随第 4 期的 `/api/sources` 🔗 现状（4-12，10-27）：已并进 `SourceDescriptor` 并删掉（连同拓展的门上转出的那一份、`ExtensionDTO.subscription`）；清单订阅段与描述符的逐格相等改由 `manifest-shape-pin.ts` 对着 `SourceDescriptor` 钉 |
| 搬进 `bilibili/` 的 api：`BilibiliAPIConfig`（⑭c 已删：只剩自定义 UA 一格，随 UA 一起删了）、`RefreshOutcome`、`FollowOutcome` | `…Options`、`…Result`（`API` 写成 `Api`） |
| 搬进 `bilibili/` 的 blive：`LiveConnectionInfo` | 按装的东西起名，施工时定 |
| dynamic 的 `DynamicEngineConfig`、`DynamicFilterConfig`、`WorkDeliveryConfig`、`DeliverWorkArgs`、`WorkDeliveryOutcome`、`DynamicTimelineManager`、`SubManagerView` | 随包消失：`deliverPost` 的 `…Options`、`PostSettings`；过滤进核心的 `ContentFilters` |
| live 的 `LiveEngineConfig`、`ListenerManagerConfig`、`ListenerManager`、`LiveNotifyParams`、`LivePushTimerManager`、`UserInfoInLiveData`；种类取值 `LiveType`、`LivePushType`、`LiveNotifyPushType` | 场次引擎合一以后消失（推送种类就是特性键；`bilibili/` 里还要的种类照表叫 `…Kind`） |
| 面板：`RestartOutcome`；`SectionMeta`；`PushKindMeta`；`WebDevScenario`（带 `run`）；`CardStatus`（`{ tone, text }`） | `RestartResult`；`SectionDescriptor`；`FeatureDescriptor`（⑬f 已落，`apps/web/src/config/push-features.ts` 的 `FEATURE_DESCRIPTORS`）；`WebDevScenarioDef`；`CardStatusView` |
| 面板：`DetectState` / `ViewState` / `DraftUiState` / `TestState`（装的都是取值） | `DetectStatus` / `ViewStatus` / `DraftUiStatus` / 探测三态 `ProbeStatus` |
| 面板：手抄四份的 `HealthSnapshot` 与重启那份 `RestartProbe`；`GlobalConfigPatch` | contract 里一份 `HealthResponse`；`SettingsPatch` |
| 推送层的 `PushSendInfo`（一次广播对每个目标回调一次的载荷）；`SendContext`（跟着一次发送走的一包字段，不是宿主环境） | `PushSendResult`；`SendMeta` |
| 服务端 `MuteState`（带 `isMuted()` / `muteFor()` 的部件，不是状态对象） | `MuteGate` |
| 服务端 `ExtensionRuntime`（宿主这边握着的拓展把手） | `ExtensionHandle` |
| ai 的 `VisionToolContext`（`{ images, describe }`：一份数据加一个协作函数） | `VisionToolDeps` |
| 统计聚合的 `LiveSummary`（窗口里的直播场次与时长，撞了 AI 直播总结 `liveSummary`） | `LiveStatsView` |
| internal 设置段 `ExtensionState`（`{ enabled, settings? }`）；拓展契约的读取把手 `ExtensionSettings<T>` | `ExtensionSection`（和 `core` / `bilibili` 同一层的「段」）；`ExtensionSettings<T>` 删掉，与内置集成并成一个 `SettingsReader<T>`（`get()` 回 `Result<{ settings: T }>`） |
| `HistoryRecordInput`（要追加进历史的那一行）；备份的 `FullBackupInput`（要打包的各节数据）、`BuildBackupInput`（参数包） | `NewHistoryEntry`；`FullBackupPayload`、`BuildBackupOptions` |
| 三态取值：ui 的 `TriState`、桥的 `BridgeCapabilityState`、`MiniAppCardSupport` 的判别字段 `state` | `TriStatus`、`BridgeCapabilityStatus`、`status`（类型名随原生分享改成 `NativeShare…`）；拓展视图的 `tristate` 列名是契约 v3 的字面量，不动 |
| ui 的 `PlatformMeta`（怎么画一个平台：`tint`、`label`、`icon`、`svg`） | `PlatformBadgeSpec`；面板的注入口 `platform-meta` 跟着改 |
| 面板 `SessionStatus`（`GET /api/session` 的响应，面板手写的）；面板 store 里本地的 `AuthState` | contract 里一份 `SessionResponse`；`AuthStoreState`（`AuthState` 让给来源的登录态）。🔗 3a-29 B 站半：`AuthStoreState` 这一格不再有 —— 面板的登录态仓库（`store/auth.ts`）连同 `useAuthHydrate` 与面板自己的 `types/auth.ts` 都删了，登录态改住 react-query 的查询缓存（键 `["source-auth", 来源键]`，`hooks/use-source-auth.ts`），类型直接用契约的 `SourceAuthResponse`；`SessionStatus` 改 `SessionResponse` 那半不属于这一片，没动 |
| 当结果用的 `Check` / `Read` / `Parse`：`MarketplaceIndexCheck`、`SubscriptionReportCheck`、`SafeRegexCheck`、`ViewCheck`、`ExtensionDirRead`、storage 的 `JsonFileRead`、`ExtensionManifestRead`、桥的 `BridgeFrameParse` | `MarketplaceIndexCheckResult`、`SubscriptionReportCheckResult`（上报 schema 随契约 v3 重写，新名照这个起）、`SafeRegexCheckResult`、`ViewCheckResult`、`ExtensionDirReadResult`、`JsonFileReadResult`、`ExtensionManifestReadResult`、`BridgeFrameParseResult`。🔗 现状（3b-44，10-25）：`BridgeFrameParseResult` 已落。 |
| 更新镜像的 `Acceptance<T, R>`（`{ ok, value } \| { ok, reason }`） | `…Result`，主干施工时定 |
| 面板的 `PushToastSink`（一包两把回调） | `PushToastHandlers` |
| 太虚的 `Data`：storage 的 `CookieData`；出图的 `CardData`（皮肤字段取值表）、`RoastBoardData` / `RoastSoloData`（`…CardInput` 的别名；㉔f 起三个 `…CardProps` 改叫 `…CardInput`） | `CookieData` 随 `CookieStore` 退役消失（cookie 罐进 `packages/http`）；其余按装的东西起名，施工时定 |
| `Row`：拓展在播表的 `ExtensionLiveRow`、拓展宿主递给 ctx 的 `ExtensionSubscriptionRow` | 随 1.0 消失：在播表合成一个 `LiveListeningEntry`；来源拿到的名单是 `SourceSubscriptionView`（🔗 10-13（3b-20）：`ExtensionLiveRow` 这一片先改名为 `LiveTableEntry`，随在播表 `LiveTable` 搬进 `live/live-table.ts`；合成 `LiveListeningEntry` 留给后面） |
| 种类取值叫 `…Type`：指令参数 `ParamType`、版式块 `MessagePartType`、皮肤字段 `CardSkinFieldType`、QQ 官方机器人的 `QQOfficialBotType`（公域 / 私域）、blive 的 `UserActionType` | `ParamKind`、`MessagePartKind`、`CardSkinFieldKind`、`QQOfficialBotKind`（随适配器搬出 `internal`）、`UserActionKind`（随 blive 搬进 `bilibili/`） |
| 当读口子用的 `Source`：AI 只读工具的 `PlatformLabelSource` / `LiveNowReader`、资源采样的 `BrowserSource`、WS 的 `ResourceMonitorSource`、拓展推送的 `ExtensionNameSources` / `ExtensionCardAuthorSources`、桥的 `BridgeInboundSource`、面板的 `PersonaSource`；统计适配器的 `BiliStatsSourceOptions` / `ExtensionStatsSourceOptions` | 读口子改 `…Reader`（10-10 主人定：类型不用 `…Lookup` / `…Lookups`，`lookup` 只当函数名）；`LiveNowReader` 已由 `ai/read-only-tools.ts` 的所有订阅在播表读口落地；其余各自新名施工时定。市场源 `MarketplaceSource` / `MarketplaceOfficialSource` 是主人看得见的叫法，不改 |

参数包叫 `Input` 的 31 个改 `…Options`：`BareAuthPolicyInput`、`BootSelectedPayloadInput`、`ResolveWebDistDirInput`、`CreateDevtoolsInput`、`CreateDevRouteInput`、`ExtensionScenariosInput`、`InstallExtensionPackageInput`、`UninstallExtensionInput`、`RecordLoadAttemptInput`、`ViewCheckInput`、`RepushGateInput`、`CreateSystemRouteInput`、`CreateUpdateRouteInput`、`ResolveLinkParsingPoliciesInput`（主干随 `linkPreview` 改）、`RestartAbilityInput`、`ResolveTargetScopeInput`、`SkinAiCreateInput`、`SkinAiEditInput`、`DecideUpdateInput`、`FetchSignedManifestInput`、`FetchSignedJsonInput`、`FetchThroughMirrorsInput`、`InstallPayloadInput`、`PruneOldVersionsInput`、`SelectVersionForBootInput`、`ReadBootViewInput`、`PinVersionInput`、`MarkBootSucceededInput`、`CreateUpdateServiceInput`、`ResolveVersionsRootInput`、`BuildProviderParamsInput`。**不改**：`LiveCardInput`（出卡模板的输入）与 `RoastInput`（喂给模型的提示词输入），它们合 Input 行。

**服务端命名约定**：`create*` 造对象，`bind*` 挂到总线并返回可释放对象，`start*` 起定时或循环；入参一律叫 `XxxOptions`，注入的协作者包叫 `XxxDeps`（只放协作者，不混配置值）；存储一律是接口加 `create`，`Store` 只指存盘的。现存 4 个 `attach*`、5 个 `make*` 全改。面板的类型门面别名删掉，用本名。

**明确不改**：见 [architecture.md](./architecture.md)「明确不改的」。

🔗 现状（4-20，2026-10-30）：`core.accounts` 与其 `order` 实际均为可选、不带默认；缺键按登记顺序。显式排序 `PATCH /api/settings { core: { accounts: { order } } }` 才落盘；order / accounts 的 null 删除相应键。未知与重复键原样保存，聚合读口只认首次在册账号，遗漏者追加。`GET /api/accounts` 回 `{ accounts: [{ sourceKey, state, account?: { name, avatar? } }] }`，不装订阅资料或来源专有字段；完整与脱敏备份沿既有核心设置链路携带。

🔗现状（4-21，2026-10-30）：`InvalidSettingView` 共用 `path` / `issues`，以 `secret` 判别：非密钥支带 `raw` / `missing`，密钥支没有原文、掩码或原值摘要。缺键用 `missing: true` 表示，JSON 中的 undefined 原值不伪造成 null。核心路径在 HTTP 回应中以 `core` 起，登记集成以自己的键起，拓展读口路径相对该拓展设置。整个集成文件读不懂报告该段根；拓展 JSON 文件读不懂只报安全根原因。

🔗现状（4-22，2026-10-31）：订阅文件的单行 schema 错误与重复合法 UUID 整组隔离，不进运行中的订阅列表。私有布局账本只用于原样写回坏行的 JSON 值；合法的最小身份与 UUID 仍占位，新建与恢复不能绕过。文件级坏 JSON、形状与标签表错误仍挡开机。`core / subscriptions_invalid` 聚合问题只含数量与固定修复提示，不带原文、身份、密钥或校验原话，不私聊。配置仓 `getSubscriptionIds()` 给启动与删除后的资料清扫保留好行和坏行的可识别 UUID；没有合法 UUID 的坏行不猜缓存归属。坏行面板显示留 4-45，无新增 HTTP/contract。

🔗现状（4-24，2026-10-31）：核心设置的联网搜索开关现为 `ai.search.scenes.{post,live,roast}`（HTTP 挂在 `core` 下），后端与密钥仍为同层 `backend`、`keys`。零代完整迁移在 AI 上提后做原始值改名：新 `scenes` 整袋优先、新 `post` 优先，不用旧值补新；null 与错误值保留给既有坏格隔离，现代 schema 不双读旧键，缺键仍补三个 false、未知键仍按原 schema 剥除。修订号 53 沿既有开发代机制重开，原件不改；备份 23 仅同版恢复。Q7 的副标题、说明里的“引擎”和显示字段码仍保留，仅 `packIsland` 将新值投影到旧 UI 码 `ai.search.engines.dynamic/live/roast`，真实草稿与 PATCH 只用新键；4-36 一起撤显示投影。`AIScene` 类型名及 dynamic/liveSummary 取值、点评/总结参数层命名本片未改，按原批准记为后续待分配；它们不是搜索开关袋这一层，实例、writing 等其他 AI 键未顺改。
