# 1.0 订阅来源与横切接口

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 ～ 0031（集成与 ctx 见 0025，失败规矩见 0026，监听、统计与面板读描述符见 0027，作品文字与模板变量见 0028，链接预览见 0029，AI 见 0030，指令与 devtools 见 0031，`sendToAddress` 见 0024）。

`Source` 全接口、来源的自我介绍与面板怎么读它、登录与账号、核心递给来源的 ctx、问题与健康、资料与直播怎么拉、横切接口（链接预览、指令、AI 工具、devtools 场景），以及 B 站怎么实现它们。数据类型（`Post`、`LiveSignal`、`Identity`……）见 [data-model.md](./data-model.md)；登记表与装配根见 [architecture.md](./architecture.md)；拓展能用其中哪些见 [extension-contract.md](./extension-contract.md)。

## 一句话

**`Source` 只管「订阅一个人」。** 链接预览、AI 工具、调试场景跟订阅无关，各是一个小接口；指令 1.0 没有来源自带的（见「指令」）。B 站直接实现它们，拓展由宿主经契约转一道。B 站、每个拓展、每个内置的平台适配器各是一个**集成**，各拿一份 `IntegrationContext`；登记表的键类型叫 `IntegrationKey`，来源的 `SourceKey`（`"bilibili"` 或拓展 id，不加前缀）是它的一部分；分派一律按 `identity.sourceKey` 查登记表。**来源只认人、不认订阅**：上报只带 externalId，BN 内部的订阅 id 来源永远看不到。

**结果形状**：来源、横切接口与 ctx 的方法，一次操作的结果一律是 `{ ok: true, … } | { ok: false, code, message, upstreamCode? }`（ADR-0026）。`code` 取 `internal` 里那张标准码表（`not_found`、`invalid`、`unauthorized`、`rate_limited`、`unavailable`、`timeout`、`unsupported`、`conflict`、`indeterminate`、`unknown`）；上游平台自己的错误码放 `upstreamCode`，不占 `code`。抛错只留给 bug，宿主在边界接住、按 `unavailable` 处理并记错误日志。下文的 `Result<T>` 是本文的简写：成功那一支带着 `T`；不带 `T` 的 `Result` 就是 `{ ok: true }`。通用类型的正式名字、成功那一支装 `T` 的格名，施工时定。

## Source

```ts
interface Source {
  descriptor: SourceDescriptor;
  // 必备
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
  searchCreators(query: string, signal: AbortSignal): Promise<Result<{ candidates: CreatorCandidate[] }>>;   // 解析门：链接 / id / 名字原样交进来
  fetchProfile(identity: Identity, signal: AbortSignal): Promise<Result<CreatorProfileReport>>;   // 也就是「按 id 取人」
  // 可选
  auth?: SourceAuth;
  fetchLiveStatus?(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult>;
  liveInteractions?: LiveInteractionReader;     // 出卡时才懒取观众头像与档位图标
  health?(): SourceHealth;                 // 健康卡与 status 指令的一行字
  fetchPreview?(identity: Identity, kind: "post" | "live", signal: AbortSignal)
    : Promise<Result<PostReport | LiveCardInput>>;
}

interface SourceHealth { summary: string }
```

| 成员 | 必备？ | 谁调、什么时候 | 要点 |
| --- | --- | --- | --- |
| `descriptor` | 是 | 面板、锐评、模板随时读 | 见下一节 |
| `start` / `stop` | 是 | 开机、关停、拓展启停 | `start` 拿到 ctx；`stop` 后不许再上报。收尾时宿主先调 `stop()`，再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾。`start` 期间读设置失败可以抛错中止启动（生命周期闸，唯一的例外），宿主接住记成 `settings-invalid`，见「设置」。🔗 3a-39：内置来源这一支没造（读设置回结果、不抛，哪样读不懂停哪样），拓展照旧 |
| `searchCreators` | 是 | 新建订阅弹窗打字时 | 「解析门」：输入框里是链接、id 还是名字都原样交进来，来源自己认；最多回 10 个 `CreatorCandidate`。失败回结果形状、不再靠抛：风控 `rate_limited`、没登录 `unauthorized`，文案由来源给、原话到面板；面板按 `code` + `message` 读一处（今天风控和没登录都报成 404） |
| `fetchProfile` | 是 | 核心按资料刷新 cron 定时调；按 id 取人也是它 | 头像先 `ctx.fetchImage` 再交引用。失败：`not_found` 记成关于这条订阅的 `creator_not_found` 问题；其余当暂时失败，下一轮再来；整轮要不要刹车（撞了风控，本轮剩下的不再打）由来源自己决定。`creator_not_found` 记在谁名下、什么时候清，施工时定。原先设计的 `lookupCreator` 与它重复，删掉。🔗 10-23（3b-24）：已落成必备成员，核心经 `fetchSourceProfile` 统一处理超时、抛错、来源消失与中止；B 站已实现 |
| `auth` | 否 | 系统 → 账号、`login` 指令 | 见「登录与账号」 |
| `fetchLiveStatus` | 否 | 核心按场次定时调 | 已落（3b-22）：返回结果形状，成功分 `live` / `offline`，失败时核心只跳过这一轮，见「直播」 |
| `liveInteractions` | 否 | 出卡时 | 已落（3b-22）：类型是 `LiveInteractionReader`；只有 `fetchViewerAvatar` / `fetchTierIcon` 两个懒取口，直播互动本身经 `reportLiveInteraction` 上报 |
| `health` | 否 | 健康卡、`status` 指令 | 只交一行字 `{ summary }`（原 `status()`）；订阅卡的「暂停 / 不可用」不看它，见「健康与运行状态」 |
| `fetchPreview` | 否 | 卡片页预览 | 没实现就用示例数据。返回结果形状是按失败规矩（ADR-0026 决策 4）推出来的；失败时回落示例数据还是报错，施工时定 |

`Source` 共 10 个成员：descriptor、必备 4 个、可选 5 个。🔗 现状（3b-22，10-21）：代码里 `Source` 今天有 8 个成员（`descriptor`、`start`、`stop`、`searchCreators`、`auth?`、`fetchLiveStatus?`、`liveInteractions?`、`health?`），`fetchProfile`（3b-24）与 `fetchPreview`（第 4 期）接口上还没有；进程内对拍（守卫 21b）的「这版不开」名单逐项写着去处，见 [architecture.md](./architecture.md)「第三层：对拍」。没有单独的「新建 / 启用订阅」钩子（原 `onSubscriptionAdded`，一度改名 `onSubscriptionActivated`）：它和 ctx 的 `onSubscriptionsChanged` 重复，删掉。来源要在订阅变化时做事，一律用 `onSubscriptionsChanged` 自己对比新旧名单。🔗 现状（3b-24，10-23）：代码里已有 9 个成员，新增了必备的 `fetchProfile`；只剩 `fetchPreview` 归第 4 期。

新建订阅弹窗只有一套流程：选平台 → 一个输入框搜索 → 预填资料；去重用 identity（同一身份只能有一条订阅，见 [data-model.md](./data-model.md)）。搜人接口是 `GET /api/sources/:sourceKey/creators?q=`，提示文字由 contract 的叫法函数按 `descriptor.searchAccepts` 拼（B 站三种都收，拼成「UID、主页链接或名字」；没声明就是「搜索{creatorNoun}」）。B 站的实现：纯数字按 UID 精确查、主页链接先抽出 UID、其余按名字搜。候选头像也是图库引用，没被订阅用上的由图库按引用清扫。

## SourceDescriptor

来源的自我介绍。面板与锐评只读它（经 `GET /api/sources` 下发，见下一节），所有 `isBili` 分叉删掉。拓展清单的 `contributes.subscription` 直接写这些同名字段（见 [extension-contract.md](./extension-contract.md)）。

```ts
interface SourceDescriptor {
  label: string; shortLabel?: string; color?: string;
  icon?: string;                   // 平台图标，对齐推送侧 PlatformDescriptor.icon
  postNoun?: string;               // 这个平台管作品叫什么；缺省「作品」，B 站「动态」
  creatorNoun?: string;            // 这个平台管创作者叫什么；缺省「创作者」，B 站「UP主」
  externalIdNoun?: string;         // 这个平台管外部 id 叫什么；B 站「UID」（🔗 10-23（3b-24）已落，宿主已认；拓展清单仍未收）
  externalIdRegex?: string;        // 外部 id 长什么样（正则源码，整串匹配）；核心核订阅身份与特别关注名单的 id；B 站纯数字；不声明只做中立校验
  searchAccepts?: ("id" | "link" | "name")[];   // 搜人输入框收哪几种输入；提示句由叫法函数拼，B 站三种都收；缺省「搜索{creatorNoun}」 🔗 现状（3b-44，10-25）：拓展清单已收这一格并随视图下发；面板拓展支暂用通用提示，叫法函数随第 4 期
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
- `icon` 的取值怎么解释（面板图标库里的名字还是一张图；拓展加不了图标库的名字），施工时定。🔗 现状（4-12，10-27）：拓展的 `icon` 照清单是图片 data URL，原样随来源表下发；B 站这一格先不填，读者（新建订阅的平台选择画图标）来了再定。
- 🔗 现状（4-12，10-27）：`SourceDescriptor` 已补 `shortLabel?`、`color?`（hex）、`icon?`、`searchAccepts?`、`supportedFeatures`（必填），拓展的描述符就是清单订阅那一口（去掉 `cardSkin`，`manifestSourceDescriptor`）。B 站填短名「B」、颜色 `#fb7299`、搜人收 `id` / `link` / `name`、特性全列。`supportedExtras` 与 `featureHints` 还没加：`featureHints` 清单与描述符都随规则页按描述符露节那一片一起收（主人 10-27 定，跟读者走）。B 站那颗平台钮的颜色因此从皮肤色改成描述符里的定值，不再跟着皮肤变，和拓展的钮一样（主人 10-27 定）。
- **外部 id**：身份标签写「{externalIdNoun} {externalId}」（B 站「UID 123」），没声明就写「{label} · {externalId}」，由一个函数生成（显示名链 `displayNameOf` 的最后一环）；「复制 UID」随之变成「复制 {externalIdNoun}」或「复制 ID」。🔗 10-23（3b-24）：`subscriptionIdentityLabel` 与 `displayNameOf` 已在 contract 落成，服务端叫法已按描述符拼；面板那一列与「复制 UID」仍归第 4 期。
- `postNoun` 进模板变量 `{postNoun}`（与提示词变量同名），默认文案「{name}发布了一条{postNoun}」，保留「一条」（ADR-0028 决策 3）。B 站用户的推送文字一字不差；盘上还是老默认的，面板亮「默认文案有更新」，主人点了才换，不静默改写。视频那条「{name}发布了新视频」不变。模板名、AI 提示词、屏蔽提示、面板标签都跟着 `postNoun` 走（缺省从「动态」改成「作品」）。🔗 现状（3a-42，10-12）：模板变量 `{postNoun}` 3a 还没做（`posts/deliver-post.ts` 里套作品文案只传 `{name}`）；核心里读来源上报的 `postNoun` 的是拼 AI 提示词那一处（同一个文件），它的缺省原先在代码里还是「动态」，3a-42 对拍查出后改成「作品」，与这里一致（没声明 `postNoun` 的拓展的提示词因此变了，B 站来源自己声明「动态」不变）。面板自己的特性标签另走拓展清单的 `display.postNoun`，这一片没动。🔗 现状（3b-21，2026-10-19）：3b-21 已做（默认作品文案用 `{postNoun}`，来源没声明叫法填「作品」）。🔗 现状（3b-12，10-24）：默认文案与会员体系默认句按当前语言取出厂，设置只存主人改过的文字；改回默认或编辑到与当前默认一字不差都会删键。换语言时没改过的立即跟新语言，不写盘；订阅覆盖仍是主人写的字。「默认文案有更新」只对改过的文字成立：面板输入框显示存的字或当前语言默认，恢复默认时同时清掉账本那一条。
- 特别关注这项设置只在 `supportedFeatures` 含 `viewerChat` 或 `viewerEnter`（原 `specialDanmaku` / `specialUserEnter`）时露出。
- `creatorNoun` 与 contract 里的叫法函数这一期（3b）造，提示词里的 `{creatorNoun}` / `{postNoun}` / `{sources}` 按 ADR-0030 决策 3 全做；面板上的叫法仍第 4 期。🔗 现状（3b-35，10-24）：`SourceDescriptor.creatorNoun` 与 `sourceNounsOf` 已落成；中性词按读者递，给人看的取字典 `nouns.*`，给模型的取 `PROMPT_NEUTRAL_NOUNS`，服务端按来源键取叫法走 `sourceNounsFor`。
- `liveStreaming` 开关只在 `has.liveStatus` 为真（来源提供了 `fetchLiveStatus`，宿主推算、随 `/api/sources` 下发），且 `supportedFeatures` 同时含 `liveStart` 与 `liveEnd` 时显示。🔗 现状（3b-44，10-25）：第 3 版清单要求声明 `liveStreaming` 时同时声明开播与下播；没声明它就不自动获得周期直播。

## 面板怎么读描述符

面板里不再有来源分叉：事实放描述符，句子由核心拼，来源只填几个词；加一个来源不用改面板。

- `GET /api/sources` 回每个来源一条 `{ key, descriptor, has, status }`：
  - `descriptor` 由服务端备好：B 站的写在 `bilibili/` 的代码里，由 `compose.ts` 静态登记完整的 `SourceDescriptor`，B 站设置坏了照样下发（3a-39 落成后来源本来就照常在册，只停读不懂的那一样）；拓展的取清单 `contributes.subscription`；装上就有，停用、启动失败、设置不合法时照样有。
  - `has { auth, liveStatus, preview }`：来源实现了 `auth` / `fetchLiveStatus` / `fetchPreview` 中的哪些，由宿主推算，不让来源自报。
  - `status`：该集成运行状态的取值（内置集成只取 `running` / `failed` / `settings-invalid`，见「健康与运行状态」）。
- 面板进来拉一次进缓存，订阅按 `identity.sourceKey` 取；`extension-status-changed` 时缓存失效。加载中「不知道」不等于「没有」，按中性默认画。
- 🔗 现状（4-12，10-27）：列表与面板的 `useSources()` 已落（名字主人 10-27 定）：回 `SourcesResponse { sources: SourceEntry[] }`，`SourceEntry { key, descriptor, has? }`。不是拓展的来源（B 站）取登记时交的描述符、按登记先后在前；拓展一律取装载器那份清单（按当前语言盖好译文，在跑的也不取登记那一刻冻住的那份），停用、没起来的照样列、不带 `has`（= 不知道）。`has` 先只有 `{ auth, liveStatus }`，`preview` 随 `fetchPreview` 一起加；`status` 随运行状态读口；描述符先不带 `membershipPrograms`（档位图标是图库引用，随面板读会员档那一片）。面板缓存键 `["sources"]`，跟拓展表一起失效（装卸、开关、换上新版、重连、globals 变了），不看 `extension-status-changed`（那一帧只说拓展的视图变了）；拓展「在不在跑」仍看拓展表。拓展表 `ExtensionDTO` 上原来的 `subscription` 那一格已删。

**从描述符直接拿**：

| 面板上哪儿（例子） | 描述符哪格 | 没填时 |
| --- | --- | --- |
| 平台名与徽章：新建弹窗的「B 站」按钮、订阅卡与在播徽章、统计 / CSV / 锐评的平台列 | `label` `shortLabel` `color` `icon` | 只显示 `label` |
| 创作者叫法：导航「订阅 UP 主」、「添加 UP 主」、「全部 UP 主」、空态、历史搜索框、模板变量说明「UP 主名字」 | `creatorNoun` | 「创作者」 |
| 作品叫法：特性分组「动态」、规则节「动态过滤 / 图集 / 消息」、推送种类、统计列、雷达「动态量」、皮肤分类 | `postNoun` | 「作品」 |
| 外部 id：卡上「UID 123」、「复制 UID」、「该 UID 已在订阅中」、单人页身份、特别关注「纯数字 UID」 | `externalIdNoun`；格式校验 `externalIdRegex`（10-15，3b-58） | 「{label} · 123」、「复制 ID」 |
| 搜人输入框提示 | `searchAccepts`（只声明收哪几种输入，句子由叫法函数拼） | 「搜索{creatorNoun}」 |
| 露出哪些特性开关、规则节、特别关注节 | `supportedFeatures` | — |
| 露出哪些附加项（词云、总结）；「词云与总结只有 B 站有」这类小贴士也改看它（`BILI_ONLY_EXTRAS` 删掉） | `supportedExtras` | 不露 |
| 特性开关下的小字 | `featureHints`（B 站写回「投稿 / 转发 / 专栏」「Super Chat 提醒」） | 能推导的推导：会员行 = 档名连起来，下播行 = 「下播卡片」加上挂在下面、且 `supportedExtras` 里有的附加项名；其余用核心的中性默认（「开播提醒」「醒目留言提醒」…） |
| 会员：档名、档序、档色，每档文案与图片设置，`{tier}` 的说明，卡片页示例 | `membershipPrograms[].tiers[]` 的 `name` `rank` `icon` `announcement` `color`；体系名做规则节标题 | 没有会员体系，整节不露 |

🔗 10-23（3b-24）：上表「外部 id」一行服务端已按 `externalIdNoun` 拼身份标签；面板列与「复制 UID」仍归第 4 期随 `/api/sources` 收。

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
| 头像兜底色（今天的 `colorFromSeed`） | 核心的中立函数按身份算 |
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
// 落成的五个成员（3a-29 B 站半，住 packages/internal/src/source.ts）；原定的 methods 与 beginLogin 的 method 参数没造，见下
interface SourceAuth {
  beginLogin(): Promise<Result>;    // 只有扫码一种办法；已有一次在进行时重新开始、换一张新码
  logout(): Promise<Result>;        // 不碰主密钥；没登录时也能调
  state(): AuthState;               // 同步、不出网
  account?(): SourceAccount | null; // 没登录或还没取到是 null
  onChange(fn: () => void): Disposable;  // 状态或账号可能变了就叫一声；要做事自己再读 state() / account()
}

interface SourceAccount {           // 来源登录着的账号
  name: string;
  avatar?: ImageRef;                // 图库引用，抓进图库之后才有；不是平台的图片地址
}

type AuthState =                   // 状态值用 kebab
  | { status: "logged-out" }
  | { status: "awaiting-scan"; qr: { dataUrl: string; expiresAt: string } }   // 10-11 改：原定 image: ImageRef，见下
  | { status: "confirming"; message?: string }   // 10-11 改：原定 scanned，BN 还在等 / 还在核，此刻不算登录，见下
  | { status: "logged-in"; loggedInAt: string }
  | { status: "expired" | "error"; message: string };
```

- 🔗 **10-11 二维码直接带图片数据，不走图库引用**（主人定，偏离原定的 `image: ImageRef`）：二维码几十秒到几分钟就作废，写进图库再清是为形状统一多出来的活；B 站登录与 QQ 绑定今天两处都是 `data:` 串，面板直接画。`qr.dataUrl` 是 `data:image/…;base64,…` 的整串，格名取契约里已有两处同义的格（卡片预览回应、皮肤截图回应）都叫的 `dataUrl`。`expiresAt` 是 ISO 字符串、必填，含义是**最晚作废时刻**：平台给得出真过期时刻就填它；给不出的平台（今天的 QQ 官方：腾讯只在轮询里回「过期」状态）取「任务创建时刻 + 清扫时限」，所以它是上界，不是平台二维码真正的过期时刻，消费方不要拿它提前判过期（浏览器与服务端的时钟可能不一致）。两半（订阅侧 `SourceAuth`、推送侧 `connectionAuth`）共用这个形状；类型住 `packages/internal/src/auth-state.ts`，3a-29 QQ 半已落地。
- 🔗 **10-11 `scanned` 换成 `confirming`**（主人提，改定案；3a-29 B 站半已落）：原来的 `scanned` 只覆盖「手机上已扫、等确认」，而 B 站还有一种「手里有登录信息、开机还没向 B 站确认过有效」（原来的「正在加载登录信息」，探活遇到网络异常时会长期停在这里），`AuthState` 里没有地方放。这个状态 B 站与 QQ 都没有对应的原生状态，是 BN 自己推断出来的「在等、在查，还不算登录」，两种情况都用它：已扫码、等主人在手机上点确认；开机还没向平台确认过。`message` 可选，由服务端给人话，因为两种情况要主人做的事不一样（一个要去手机上点确认，一个什么都不用做、等自动重试），读的人分不出来，与 `error` / `expired` 的 `message` 同一个规矩，面板不靠比对文字做判断；没带 `message` 时读的人写「正在确认」。`confirming` **不算已登录**（`isLoggedIn` 只认 `logged-in`）。**扫码确认之后、账号信息还没取到的那一小段，对外仍是 `logged-in`**（状态机那一刻已经是已登录、引擎已恢复；主人接受）。于是取值仍是六种，不新增第七种；被否：新增第七种；把开机没确认映成 `error` 或 `logged-out`。状态值的名字 `confirming`（kebab、一个词）是施工时按规矩定的，可否决。QQ 没有「已扫、等确认」，不发它。
- 🔗 **10-11 `expired` 只指「已经登着的登录失效了、要重新登录」**（主人选 A）：只有订阅侧会发。二维码超时、失效两边都报 `error` 并带一句话（B 站「二维码已超时（3分钟），请重新登录」，QQ「二维码已过期，请重新生成」）。`connectionAuth` 没有「已经登着的登录」，不发 `expired`，所以 QQ 半回头改了码过期那一支。被否：两边各说各的；两件事都报 `expired` 靠 `message` 分。
- `beginLogin` / `logout` 返回结果形状是按失败规矩（ADR-0026 决策 4）推出来的：原来拿二维码失败只打 warn、路由却回 `ok: true`。**3a-29 B 站半已落**，B 站各回：取码请求抛错回 `unavailable`、状态不动（免得一次网络抖动把一个好会话在面板上盖成出错）；B 站回非 0 码回 `unavailable`、状态进「出错」，`-352` / `-403` 回 `rate_limited`，都带 `upstreamCode`；渲染二维码失败回 `unavailable`、状态进「出错」；被新发起的一次（或已成立的登录）取代的一次回 `conflict`。`logout` 总会进未登录，存着的登录状态清不掉时回 `unavailable`，话里写着原因与「重启后可能还是登录着」。
- 🔗 **10-11 `SourceAuth` 落成五个成员**（3a-29 B 站半，主人选范围甲档）：
  - **`methods` 与 `beginLogin` 的 `method` 参数、`"cookie"` 不造**（偏离定案原文这一格）：今天只有扫码一种登录办法，第二种办法没有实现者，也没有哪个计划点名谁、哪一期要它（规范：没有实现者的接口不造）。等第一个有两种登录办法的来源出现，连同配套问题一起设计；已记进 construction-plan 的「以后再说」。
  - **通知口是 `onChange(fn): Disposable`**（施工时照规矩定，可否决）：集成不拿总线（`docs/agents/conventions/integration-side-effects.md` 规矩 8），所以由宿主订阅、宿主发 `subscription-auth-changed`；形状与设置读口的 `onChange` 同一种；不放在 `SourceContext` 上，因为登录这套建得比来源早。宿主不替来源去重，由来源自己保证「状态与账号都没变就不叫」；宿主登记来源成功后才订阅、登记时不补发（面板进来走 `GET`），撤登记时先摘。
  - **`loggedInAt`** 是这个进程里这一段登录第一次被确认的时刻，不落盘；重启后是开机探活成功的时刻。同一段登录里账号补到、探活暂时失败后又恢复，都不换它。
  - **账号头像走图库**（主人选 A，已定）：`account().avatar` 是图库引用；图库多一家引用方「账号头像」，名单从来源登记表现读（每个在册来源 `auth.account()` 的头像），不点名哪个来源；B 站登录后、头像网址变了时，由登录系统用 B 站自己的请求客户端把头像抓进图库（登录状态确定之后另起的后台活，不拖慢登录；抓不到只是没有头像，账号照常，登录状态一个字不动）；引用只在内存，重启后重抓。面板从图库取（`/api/images/<ref>`），不再直连 B 站的图片服务器。被否：这一片头像退成首字母；先交网址（偏离定案的形状）。
  - **没有 `refresh`**：续期是 B 站自己的事（开机一次、之后每小时），主人选 A 把「刷新 Cookie」按钮、`POST /api/auth/cookies/refresh`、「最近 Cookie 刷新」那行字、`cookies-refreshed` 事件与 `AuthSystem.refreshCookies` 整套删了。被否：给 `SourceAuth` 加可选成员留按钮；原样留 B 站专用的口。
- ⚠️ `logout()` 不许碰主密钥：主密钥同时加密 AI key 等全部密钥，轮换它会让别的密文解不开。
- **系统 → 账号**为每个声明了 `auth` 的来源列一行。
- **排序**：主人拖动，存 `core.accounts.order`（进备份）。默认按登记顺序，B 站在前；新来源追加在末尾。
- **头部**显示排第一的账号；有多个账号时加小三角下拉。AI 对话里主人的头像同头部。
- **新手引导**的登录步由声明了 `auth` 的来源生成。
- 🔗 **10-11 以上四条（列一行、排序、多账号下拉、按来源生成引导步）3a-29 没做，推到第 4 期**（主人选范围甲档）：今天只有 B 站一个有登录的来源，读者都在第 4 期，现在造 `accounts/` 与排序键是没有读者的东西。3a-29 B 站半做的是「不退化」：头部、AI 对话、引导、概览、系统页账号卡都改读 B 站那一个来源的登录口。已记进 construction-plan 的「以后再说」。
- 私聊指令 `login [来源]` 也读 `AuthState`，把二维码发回会话，见「指令」。推送侧连接的 `connectionAuth` 用同一个 `AuthState`（ADR-0024）。（3a-29 B 站半：`login` 读 `AuthState`——从 `awaiting-scan` 的 `qr.dataUrl` 解出图发回；发起失败回结果里的话；`status` 指令的登录行也由核心按 `AuthState` 拼。3b-06 已改成通用的 `login [来源]`：带登录的来源现读来源登记表，只有一个直接扫、有好几个列出来让主人挑；`status` 的登录行每个带登录的来源各一行，不再直读 B 站登录系统。）
- 面板登录态按 `SourceKey` 分开存。登录状态变化上总线 `subscription-auth-changed`。（落成：面板的数据面是 react-query 的查询缓存，键 `["source-auth", 来源键]`（`hooks/use-source-auth.ts`），读的地方各自点名要哪个来源；WS `auth` 频道的帧按帧里的 `sourceKey` 写那一条缓存并让它失效重取，重连后 `hydrate` 让整个前缀失效。原来的 zustand 登录仓库删了。）
- 核心账号模块住 `accounts/`（第 4 期，见上）；B 站原来的 AuthSystem 进 `bilibili/auth/`（3a-29 B 站半已落，仍由入口造，登录装配进 `compose.ts` 原写随 3a-40；3a-40 也没做，留到 3b，主人 10-12 定）。🔗 现状（3b-47，10-25）：登录装配已进 B 站来源；`createAuthSystem` 由 `createBiliSource` 同步造一次，随来源 `start` / `stop`，入口不再造。
- 拓展积木 `qrLogin` 退役（从没实现过）。
- 凭据的备份与恢复全归宿主：备份信封按集成分格 `integrationSecrets`（内容就是各集成的 `ctx.secrets`），恢复回 `restoredIntegrations`，没带回来的回 `unrestoredIntegrations`。来源不再自己导入导出（原先设计的 `SourceAuth.secrets` 删掉）。
- 日志落盘前按值脱敏：各集成 `secrets` 里的每一段字符串、cookie 罐里每条 cookie 一到就登记，设置里标了机密的格（核心 `markSecret`、清单 `secret` / `generate`）宿主自动登记，还没存进 `ctx.secrets` 的临时凭据（比如扫码刚拿到的 token）由来源用 `ctx.redact(value)` 先登记；**少于 8 个字符的值不遮**。核心里写死 B 站 cookie 名的五条正则删掉，`sk-`、`Bearer` 两条（AI 服务商密钥）留着。代价：cookie 里不机密的值（比如登录账号的 uid）也会被遮掉，不豁免。
- **登录问题由宿主看登录状态报，来源不报**：宿主订每个有登录口的来源的 `auth.onChange`，按 `AuthState` 自己报与清 —— `expired` 进表并私聊、`logged-out` 只进表、`logged-in` 清（私聊过的补「已恢复」）、`awaiting-scan` / `confirming` / `error` 保持上一次的结论；记在来源名下；宿主写整句并带指路（面板账号页、`login <来源>` 指令）。契约不为此加成员。B 站不再报 `auth_lost`；「登录掉了时把风控、请求失败压下去」的分层仍在 B 站，照旧看自己的登录状态。🔗 现状（3b-51，10-20）：已落，报与清住 `subscriptions/login-problems.ts` 的 `watchLoginProblems`，由 `builtin-sources.ts` 在登记来源时接上、撤登记时先摘；整句由宿主写、不盖「谁写的」，私聊时不加引子。B 站已删掉登录那一层与 `reportLogin`，`problem-layers.ts` 只剩风控与请求失败两层，照旧按登录状态压。

## SourceContext

核心在 `start(ctx)` 时递给来源。ctx 分两层：每个集成都拿一份 `IntegrationContext`（日志、状态、凭据、设置、请求客户端、抓图、问题上报、生命周期）；`SourceContext` 在它上面加来源特有的名单与上报，推送侧的 `PlatformAdapterContext` 同理（见 [push.md](./push.md)）。拓展的 `activate(ctx)` 拿到的就是它的 `IntegrationContext` 加各登记方法；来源特有的那一层和内置的一样，经所登记实现的 `start(ctx)` 递进来，登记交回的把手只管注销（ADR-0025 决策 1）。**B 站与拓展用同一个 `SourceContext`**：类型统一，实例按集成各一个。上报只带 `externalId`，`sourceKey` 由核心按 ctx 补，所以拓展冒充不了 B 站。

```ts
interface IntegrationContext {
  logger: Logger;
  state: KeyValueStore;             // 游标、分页令牌、小索引；明文
  secrets: KeyValueStore;           // cookie、token；主密钥加密
  redact(value: string): void;      // 还没进 secrets 的临时凭据先登记，日志按值遮掉
  settings<T>(schema: ZodType<T>): SettingsReader<T>;   // get(): Result<{ settings: T }>，不抛；内置集成与拓展同一个
  http: HttpClient;                 // packages/http 的客户端（原 BiliHttpClient 去掉前缀），一个集成一个
  fetchImage(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal })
    : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
  storeImage(bytes: Uint8Array, opts?: { signal?: AbortSignal })   // 手里已是字节的
    : Promise<{ ok: true; ref: ImageRef } | { ok: false; code: string; message: string }>;
  reportProblem(p: { code: string; message: string; notify?: boolean; recoveryMessage?: string }): void;
  resolveProblem(p: { code: string; notify?: boolean }): void;
  signal: AbortSignal;              // 集成停下时中止
  onDispose(fn: () => void): void;  // 集成停下时收尾
}

interface KeyValueStore {           // state 与 secrets 同一个接口，差别只在保管
  get<T extends Json>(key: string): T | undefined;   // 同步：宿主在 start 前读进内存
  set(key: string, value: Json): Promise<{ ok: true } | { ok: false; code: string; message: string }>;   // 宿主原子落盘
  delete(key: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  batch(ops: readonly KeyValueOp[]): Promise<{ ok: true } | { ok: false; code: string; message: string }>;   // ops 的每步是 { kind: "set", key, value } 或 { kind: "delete", key }；一起成或一起不成
}

interface SourceContext extends IntegrationContext {
  subscriptions(): readonly SourceSubscriptionView[];   // 名单：只列启用中的，不带订阅 id
  onSubscriptionsChanged(fn: () => void): Disposable;   // 订阅变化的唯一通知；要做事就自己对比新旧名单
  reportPost(externalId: string, report: PostReport): void;
  reportLive(externalId: string, report: LiveSignalReport): void;
  reportLiveInteraction(externalId: string, report: LiveInteractionReport): void;
  reportProfile(externalId: string, profile: CreatorProfileReport): void;   // 推送式平台主动报
  reportProblem(p: { externalId?: string; code: string; message: string; notify?: boolean; recoveryMessage?: string }): void;
  resolveProblem(p: { externalId?: string; code: string; notify?: boolean }): void;
  // 🔗 现状（3a-30）：这两个只造在 SourceContext 上（packages/internal/src/source.ts），
  // 上面 IntegrationContext 里的两行还没造（见「问题上报」的现状）
}

interface SourceSubscriptionView {  // 原拓展契约的 ExtensionOwnSubscription{ id, externalId, enabled }
  externalId: string;
  features: ReadonlySet<FeatureKey>; // 这个人开着的特性（只看开关，不看有没有目标）
  monitorsLive: boolean;             // 宿主按 needsLiveMonitor 算好；同一人的重复订阅取或
}
```

| 成员 | 规矩 |
| --- | --- |
| `subscriptions` / `onSubscriptionsChanged` | 名单只列启用中的订阅，条目 `{ externalId, features, monitorsLive }`、不带订阅 id；同一人遗留的重复订阅合成一条、`features` 取并集、`monitorsLive` 取或。**开了开关才干活**：单个订阅开了作品或直播类开关，来源才去监听（没开直播就不连弹幕、没开作品就不拉也不抓图），统计也只记开着的；「开着」只看开关、不看有没有目标（ADR-0027 决策 1）。来源只上报名单里的人。B 站也用这份名单，不再拿完整的订阅对象 |
| `reportPost` | 核心按身份展开成每条订阅一份 `PostEvent`（正常一条，老数据里的重复各一份），再发 `post-detected`（旁路通知，给统计）并交进作品装配；查不到或已停用就丢弃、记 debug 日志。判新、去重、限流归来源。来源交完就前移自己的锚点，投递失败由核心按目标重试（见 [push.md](./push.md)） |
| `reportLive` | 已落（3b-22）：开播 / 状态 / 下播三种中立信号，按身份展开后交 `LiveSessionEngine.apply`；`status` 与 `end` 可带 `startedAt` |
| `reportLiveInteraction` | 已落（3b-22）：`viewerChat` / `viewerEnter` / `superchat` / `membership` 四种，形状是对应事件去掉 `subscriptionId`；后两种可带 `fallbackText` |
| `reportProfile` | 推送式平台主动报资料；按资料刷新的间隔限密。🔗 现状（3b-42，10-24）：已落成；停用的订阅不收，写完当场重算面板那几行，粉丝样本按刷新间隔稀释 |
| `reportProblem` / `resolveProblem` | 见下「问题上报」 |
| 上报被拒 | 上报类（`report*`、`reportProblem`、`resolveProblem`）一律 `void`：被拒（种类没声明、id 不合法、形状坏）或被丢格，记进该集成的 `reportDiscrepancies` 表并打 warn 日志，来源不知道；报的人不在名单里照旧静默忽略。被拒都是来源自己的 bug，运行时改不了，回结果只会诱导它重报；拓展契约从 v2 的 reject 改成这样。内置集成（B 站与内置适配器）的上报被拒就是 BN 的 bug，只打错误日志、靠对拍守卫兜，不进 `reportDiscrepancies` 的展示面 |
| `fetchImage` | 走集成自己的客户端（同一套 cookie 与身份），来源带着自己要的请求头去抓；拦内网地址防 SSRF（每一跳重定向都查）、单张 8MB、按内容嗅探格式、超时，这一层只在 `fetchImage` 上；按 sha256 存进图库，交回 `ref`。失败共七个码：404 回 `not_found`；401 / 403 回 `unauthorized`；429 回 `rate_limited`；超 8MB、不是图、内网地址回 `invalid`；超时回 `timeout`；网络或上游 5xx 回 `unavailable`；调用方中止回 `indeterminate`。抓到的图算「在途」：一个集成一个写口，挂在一家名单恒空的「在途」引用方下，图活不活看引用落在哪（上报进历史 / 重推、资料缓存、在播表、登录状态、来源描述）；只攥在集成自己手里、没交给宿主的引用，过了 24 小时宽限期不保；「来源声明的图」的名单改成宿主从在册来源的描述里现算。被否的备选：来源在上报里直接交字节；来源声明 `imageFetch { hosts, headers, rewrite }` 由核心代抓。🔗 现状（3b-39 落成，2026-10-19）：已落成；写口是图库「集成在途」那一家（`IMAGE_REFERRERS.inTransit` / `AppRuntime.transitImages`），名单恒空、靠 24 小时宽限期；B 站来源与直播引擎已改读上下文的 `fetchImage`，账号头像、订阅资料头像、卡片真实预览、旧搜人四处仍走旧路 |
| `storeImage` | 手里已是字节的图走它（B 站也用；要来源自带客户端才抓得到的签名 / TLS 指纹 / POST 图；接口内嵌 base64）。同一套格式嗅探与单张 8MB，存进同一图库；超 8MB、不是图回 `invalid`。上报一律只收 `ImageRef` |
| `state` | 宿主托管的小键值存储，明文、不脱敏。单键 64KB、每个集成 1MB。落 `runtime/bilibili/state.json` 或 `runtime/extensions/<id>/state.json`；跟代走、不进备份、卸载与全新开始时清。`http.` 开头的键归宿主（`ctx.http` 的浏览器身份） |
| `secrets` | 用主密钥加密，一个集成一个文件：`secrets/bilibili/secrets.enc` 或 `secrets/extensions/<id>/secrets.enc`（B 站 0.x 的 `cookies.json` 由迁移转成 `secrets/bilibili/secrets.enc`）；每个集成 256KB；仅完整备份（普通备份抹掉）；卸载与全新开始时清掉；值里的每一段字符串按原文脱敏（很短的不遮）。`http.` 开头的键归宿主（`ctx.http` 的 cookie 罐） |
| `state` / `secrets` 的写、删与 `batch` | 返回结果形状、不抛：超上限或写了 `http.` 前缀回 `invalid`，磁盘写失败回 `unavailable` |
| `redact` | 临时凭据按值登记脱敏；存进 `secrets` 的值、cookie 罐里的每条 cookie 一到自动登记，不用再登记；少于 8 个字符的不遮 |
| `settings(schema)` | 和拓展同一个用法（`get` 与 `onChange`）：B 站拿 `bilibili` 段，拓展拿 `extensions.<id>` 段；校验就发生在这一步，见「设置」。交回的读取把手叫 `SettingsReader<T>`（原拓展契约的 `ExtensionSettings<T>`）。🔗 现状（3a-39，10-11）：今天**只造在 `SourceContext` 上**（`packages/internal/src/source.ts`），`SettingsReader<T>` 是 `{ get(): Result<{ settings: T }>; onChange(fn): Disposable }`：`get()` 每次现读现判、**永不抛**，读得懂回过了那份 zod 的值，读不懂回 `invalid` 并带逐条原因（整个设置文件读不懂时只有一条、不带 `path`）；`onChange` 在值变了、或读得懂与读不懂之间翻了时叫，别的集成的设置动了不叫。**可以交多份 zod**，各读各的格（zod 的对象默认剥掉不认识的键），B 站来源交了三份：动态那格（`dynamicCron`，比读盘 schema 多一道「能解析」）、登录检查那格（`healthCheckMinutes`），外加一份只为分辨「面板此刻显示的是默认值还是盘上原文」的动态那格（没有「能解析」那一道）。把手随来源上下文收掉自动摘，来源不必在 `stop()` 里记得收。拓展契约里的 `ExtensionSettings<T>.get(): T | undefined` 今天没动；3b 并成这一个：拓展的 `ctx.settings(规则)` 也交回 `SettingsReader<T>`，`ExtensionSettings<T>` 删掉。从没设过的，拿空对象过规则：过得了是成功拿默认值，过不了回 `not_configured`、拓展照跑；每个拿到上下文的集成都在配置仓登记一段（内置适配器也登记），没设过的照这条读；配置仓对根本没登记的键照旧抛（组装漏了是 bug）。🔗 现状（3b-41 C4，10-17）：已上提到 `IntegrationContext`（`SettingsReader<T>` 搬进 `packages/internal/src/platform.ts`，`SourceContext.settings` 的声明删掉、改为继承）；一个集成只有一份 `settings` 实现，由造上下文的人经 `createIntegrationContext` 的 `settings` 选项交进去——内置三处（B 站、三个内置适配器）用 `integrations/settings-reader.ts` 的 `createIntegrationSettings` 由读源造，读源由入口造一次的 `settingsReaderOptionsOf(configStore)` 按集成键给（B 站的键在 `bilibili/context.ts` 里挑，入口不写）；拓展把自己的实现（对表清单、记「设置读不了」）交进去，推送源 `start(ctx).settings` 与 `activate(ctx).settings` 是同一份。来源上下文与适配器上下文只转发 `integration.settings`，来源的 `onChange` 订阅记在来源上下文名下、来源停下就摘；`engines.ts` 不再接这条线。🔗 现状（3b-57，10-25）：文件已改名为 `runtime/pipeline.ts`，这条设置边界不变 |
| `http` | 见下「请求客户端」 |
| `signal` / `onDispose` | 集成停下时 `signal` 中止在途调用、`onDispose` 的回调收尾；先后是宿主先调实现自己的 `stop()`，再中止 `signal`、跑 `onDispose` 登记的收尾（ADR-0025 决策 5）；内置集成与拓展走同一套生命周期 |
| `logger` | 来源名写进日志行已有的 `name` 字段（`bilibili` 或拓展 id），不拼进正文；面板日志页可按来源筛 |

核心收到上报后**兜底再查一次名单**：名单变化和上报之间可能有时间差（主人刚停用某条订阅），来源自己也可能有 bug。

没有 `reportSubscriptionsChanged`：B 站的「关注同步」是 BN → B 站单向（订阅了谁就补关注谁，因为动态从关注流里拉），全在 B 站内部，挂在 `onSubscriptionsChanged` 回调、开机、重新登录之后；仓里从来没有「平台那头关注列表变了反过来改 BN 订阅」的功能。

**来源不读写文件**：状态与凭据全由宿主托管，请求走 `ctx.http`，来源拿不到任何文件路径。B 站由守卫强制（`bilibili/` 里 import `fs` 就红）；拓展这边见 [extension-contract.md](./extension-contract.md)。

### 请求客户端

- 新中立包 `packages/http`：从 B 站的实现里抽出请求客户端、cookie 罐与浏览器身份。宿主给每个集成建一个客户端，经 `ctx.http` 拿（`bilibili/` 整块共用一个，一个拓展一个）。BN 自己的请求不用它：客户端带着集成的身份与 cookie，BN 自己的请求不该冒用。
- cookie 由宿主自动存进该集成的 `secrets`（`http.` 前缀）。
- `websocket(url, opts?)` 只负责用集成的身份建连、集成停下时自动关；能发文本帧、能读连接状态；帧、心跳、重连归集成。给错地址（地址不合法、协议不收）回结果形状 `invalid`，不再同步抛。
- 请求体收 `FormData`（遇到要重发的重定向时怎么办，施工时核）；单次请求可选「不带浏览器身份、不碰 cookie 罐」那一档，内置三个适配器全用这一档，拓展的适配器调官方接口也用它。
- 请求客户端对外的接口类型住核心包，实现留在 `packages/http`（避免包之间成环）。cookie 罐按公共后缀表（引 `tldts`）拒 `Domain=com`、`com.cn`、`co.uk` 这类；`packages/http` 加运行时依赖，加完走装配自检。cookie 罐那组口第 3 版不对拓展开，B 站照旧由宿主单独递它那份把手。
- 不加别的协议：SSE 需要时给请求加「原样交出响应流」的选项；出站代理以后挂在这里。
- 重试、退避、限流归集成，BN 侧不替它限流。
- 整体不拦内网（局域网里的 RSSHub 要连得上）；拦内网只在 `fetchImage` 那条路上。
- 浏览器身份生成一次、存进该集成的 `state`（`http.` 前缀），重启照用；只在发版把版本区间前挪、存的低于下限时升级，只升不降。UA 与 `sec-ch-ua` 永远配套，没有自定义 UA。
- 1.0 对拓展整套开放（请求、websocket、cookie 自动存、身份自管；不开「默认请求头」的口，拓展每次请求自己带头）；第 6 期的抖音拓展是第一个拓展用户。
- 🔗 现状（3b-39 落成，2026-10-19）：上面这些已落成。每个集成（B 站、三个内置适配器、每个拓展、对拍假来源）经 `openIntegration` 拿自己的客户端，身份存它自己的 `state`、罐子存它自己的 `secrets`；`ctx.http` 只转发 `fetch` 与 `websocket`，`websocket` 把调用方的 `signal` 与 `ctx.signal` 合成。`websocket()` 回 `Result<{ socket }>`、能发文本帧、能读 `readyState`，错地址回 `invalid`；`bare: true`、`FormData`、跨源剥凭据头、公共后缀（含私有段）都已落成；`HttpResponse` 没有 `statusText`，内置适配器按 `node:http` 的 `STATUS_CODES` 补。B 站的客户端仍在关停 `drain` 段收，内置适配器与拓展的池子随各自收摊收。

### 设置

- 设置只有一个词 `settings`；`config` 只指存储（`config/` 目录、`ConfigStore`、`bn.config.yaml`）。
- **按集成放**：声明了 `settingsFields` 的内置集成在系统页各开一个 tab（今天只有 B 站；tab 名取它的 `label`，面板代码里不出现 `bilibili`），用通用的设置表单与对表门；拓展的设置只在拓展页，功能页面放指过去的入口；「运行」tab 只留核心参数。设置字段挂在集成的登记上，不挂在 `SourceDescriptor` 上（一个集成可能同时提供来源与适配器，ADR-0025 决策 3、ADR-0027 决策 6）：B 站的 `settingsFields` 在 `compose.ts` 登记集成时交（脸取来源的描述符），拓展的写在清单里。面板从哪个路由拿集成的设置字段，施工时定。
- **坏了只停那一处**：`bilibili` 段、拓展段校验不过，只停那一个集成，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起；BN 照常开机。校验发生在 `start` 里调 `settings(schema)` 时：只有 `start` / `activate` 期间读设置失败可以抛错中止启动，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。
- 🔗 **现状（3a-39，10-11）**：
  - **核心**：只有核心那份设置文件整份解析不了才挡开机；一格坏了只那一格退默认、进问题表（`settings_invalid`，几格合成一条、不私聊）。订阅文件、推送目标文件、连接外壳读坏也挡开机（数据不是设置）。
  - **`bilibili` 设置**：不是「停整个集成、运行状态记 `settings-invalid`」，而是**哪格坏停哪样**（主人定）：动态那格读不懂停动态，登录检查那格读不懂停定时的登录检查（登录本身照常，失效仍由请求撞 `-101` 报上来），整个文件不是合法 JSON 两样都停。**来源照常 `start`、照常在册**，`start` 不因设置抛，宿主那个「接住转成 `settings-invalid`」没造；读到的是 `SettingsReader.get()` 的结果，读不懂就报 `dynamic_settings_invalid` / `login_check_settings_invalid`（只进表、不私聊），握着把手等 `onChange`，改好保存当场起（先起成功、后清问题）。盘上一条字符串但解析不了的 cron 读盘算好的、面板显示那条原文，动态读者比读盘严一道「能解析」，读不过也算动态那格坏了。
  - **拓展**：设置文件不是合法 JSON 只停那一个拓展（`settings-invalid`）；读不懂的拓展照旧不会跑着。
- 理由：BN 起不来时，桌面壳连续失败几次就把这一版判死、自愈退回 0.12，而且进不去面板改设置；Docker 则反复重启。

### 问题上报

- 问题一律进面板问题框；`notify: true` 再私聊主人。严重度由来源定；问题句只说事、平实（不称呼主人、不写宿主的界面与操作），平台的数字错误码写进 `message`、不占 `code`；私聊时宿主按口吻加工，见 [extension-contract.md](./extension-contract.md)「问题上报」。
- 问题进表有三条路：集成自己报、宿主看登录状态报（有登录口的来源，见「登录与账号」）、宿主探连接报（见 [push.md](./push.md)「连接通不通」），外加宿主自己的事。
- 核心只守一条底线：同一报的人（`reporter`）、同一 code 的私聊 60 秒内只发一次。
- 核心收到每条问题自动记一行日志。问题上报不设「只记日志」档，只想记日志就用 `ctx.logger`，两者不合并。
- **问题表只有一种形状，全在内存**：`Problem { reporter: IntegrationKey | "core", about?: { subscriptionId } | { connectionId }, code, message, since }`。来源不填 `externalId` 就是来源本身的问题（如请求被风控）；填了由宿主换成订阅 id。`since` 记第一次出现，重复报只更新文案。平台适配器带 `connectionId`，宿主核它是不是这个适配器的，不是就拒收；核心自己直接写，code 表明是哪个模块（如 `renderer_unavailable`）。
- **一条生死规矩**：报的人 `resolveProblem` 按 code 清；报的人停下，它报的全清；对象删了，关于它的全清。订阅运行态不再存问题。
- **谁看**：订阅卡、连接卡看关于自己的，问题框看全部；来源本身的问题只在问题框与健康卡，不在每张订阅卡重复。`GET /api/problems` 一次给全；变了发总线事件 `problems-changed`（只带键），经 `state` 频道、250ms 合并。
- 代价：重启后的头几秒，订阅卡上的问题红字会先消失，等来源重报（开机时关注同步与第一轮资料刷新几秒内就会重报）。
- code 用 snake：`follow_failed`、`creator_not_found`、`risk_controlled`。
- B 站也走它。B 站内部按因果分层，只报最上面那一条开着的根问题：风控 → 各项请求失败，下面的只记日志；根问题按状态报，清掉后下一层照常报、停掉的监听拉起来；不同报告方互不遮挡（ADR-0025 决策 11 下 10-03 的 🔗）。**登录问题不由 B 站报**，改由宿主看登录状态报；B 站的分层只剩风控与请求失败两层，登录掉了时这两层被压下，登录恢复再冒出来。
- **关注搬进 B 站之后**（3b-25）：补关注在 `onSubscriptionsChanged` 的回调里异步做，失败报 `follow_failed`（带 `externalId`、挂在那个人的订阅上、只进表），补关注成功就 `resolveProblem` 清掉；新建订阅的回应不再带关注结果；订阅列表的回应由宿主把挂在这条订阅上的问题一并带上，面板订阅卡通用地显示它们（去掉「是不是 B 站」的判断），问题变了面板刷新 —— 这是提前到 3b 的一小块面板活。订阅卡上的红色警告文字沿用现在的「未关注该 UP —— 收不到动态（原因）」（原因就是原来的 `followError`）。它和别的问题一样只在内存、不再存盘，重启后由下一轮关注同步重报。🔗 **现状（3b-25，10-23）：已落**。关注同步住 `bilibili/follow-sync.ts` 的 `syncFollows` / `watchFollows`，B 站来源在开机（已登录）、`auth.onChange` 从非登录恢复成 `logged-in`、订阅名单变化三处触发；名单变化只处理新进入关注范围的外部 id。批量查询回 `unauthorized`（B 站 `-101`）时整批跳过，单个补关注回 `unauthorized` 时也停下这一轮；批量查询的其他失败降级为逐个幂等补关注。成功或查到已关注会清掉该人的 `follow_failed`，离开关注范围按「不再适用」清。`followed` / `followError` 哪里都不存；`SubscriptionDTO.problems` 由订阅回应携带，面板对每条问题通用显示，`problems-changed` 到了就重取订阅列表。
- 来源级问题不再走 `engine-error`。
- 🔗 **现状（3a-30，10-11）**：
  - **只造在 `SourceContext` 上**：`reportProblem({ externalId?, code, message, notify?, recoveryMessage? })` 与 `resolveProblem({ externalId?, code, notify? })`；`IntegrationContext` 与 `PlatformAdapterContext` 上的两个还没造（3a-39 是下一个要报的）。两个都是 `void`。🔗 3a-39 报了设置读不懂的三条问题（见 data-model.md「问题表」），**仍没造这两个成员**：核心设置那条由 `runtime/bootstrap.ts` 直接写问题表，B 站那两条走 `SourceContext`；等第一个在 `start(ctx)` 之外要报的集成再造。
  - **`recoveryMessage`**：这条问题清掉、且当初真私聊过时核心发的那一句，发的是私聊出去那一刻存下的；不给就用核心的通用说法：宿主自己写的那条用 `problem.recoveredGeneric`（「之前的问题已恢复：<原句>」）；集成写的那条用 `problem.relay.recoveredGeneric`，带名字与集成的原句（「<名字>之前报告的「<原句>」已恢复」，2026-10-20 主人定 R2 乙，只接原句、不套两层引子）。**`resolveProblem` 的 `notify`**：`false` = 这次不是修好了、只是不再适用，不补「已恢复」。宿主清（来源停下、订阅删了）一律不补。
  - **宿主这一步**（`subscriptions/source-context.ts`）：来源已停下、`code` 不是 snake、`message` 或 `recoveryMessage` 是空白、`externalId` 是空串的一律丢弃并记一行 error（内置来源被拒就是 BN 的 bug）；带 `externalId` 的按身份展开成每一条订阅、停用着的也照记，一条订阅都没有就记 debug 不收。被拒的没有记进 `reportDiscrepancies`（这一片的上报方只有内置的 B 站，那张表是拓展那一支的展示面）。
  - **私聊与「已恢复」**由 `problems/problem-notifier.ts` 统一发，细节见 architecture.md「问题表与健康」下的 🔗。问题私聊按 60 秒的节流表，键是 报的人 + code（不含对象），所以同一分钟内同一个 code 的几个订阅只私聊第一个；「已恢复」只对真私聊过的发、不受窗口与沉淀管（10-12 主人定），引子在交给发送口那一刻加。
  - **code 例子**：B 站落成的名字有 `auth_lost`（3b-51 起由宿主看登录状态报，B 站不再报）、`risk_controlled`、`dynamic_fetch_failed`、`live_monitor_stopped`、`live_room_restricted`；关注同步的 `follow_failed` 还没接（3b-25）。🔗 **现状（3b-25，10-23）：已接**。补关注失败由 `bilibili/problem-layers.ts` 的第三层经 `ProblemLayers.reportFailure` 上报，带 `externalId`、`lasting: true`、只进表、不私聊；成功或查到已关注时清掉。资料刷新搬进 B 站来源后撞风控也进同一个风控层（路名 `profile`），只进表、不私聊。🔗 现状（3b-26，10-24）：新落一个 `live_room_not_found`：B 站房号解析得到「没开通直播间」而这位 UP 开着直播推送时报，挂在这位 UP 名下、只进问题表、显示在订阅卡上、不私聊；离开直播监听名单（关推送、停用、删订阅）静默清，之后解析成功也清（`bilibili/live/session/listener-manager.ts`）。
  - **B 站的分层**落在 `bilibili/problem-layers.ts`：只剩风控与请求失败两层；只看 `AuthState.status` 决定压不压（`expired` / `logged-out` 压、`logged-in` 放，`awaiting-scan` / `confirming` / `error` 保持上一次的结论），登录本身不在这里报。风控层按「路」记（`dynamic`、`live:<uid>`），所有撞着的路都清了才清；请求失败层每次失败都报（幂等），`lasting` 决定高层开着时存不存。高层一开，表里已有的低层静默清掉。先造、来源 `start(ctx)` 最后一步才 `attach` 到核心，接上那一刻把此刻该在表里的整份报上去。问题句在 `bilibili/problem-texts.ts` 取，字在字典 `bilibili.problem.*`（平实句）。🔗 现状（3b-47，10-25）：`ProblemLayers` 改在来源 `start` 里造、`stop` 里收；“先造后接”的过渡线已拆，`attach` 仍是启动末步。

### 健康与运行状态

- 内置集成的运行状态只取 `running` / `failed` / `settings-invalid`；内置集成与拓展走同一套生命周期（`start(ctx)`、`AbortSignal` 中止、`onDispose` 收尾；收尾时先调 `stop()`，再中止 `signal`、跑 `onDispose`）。系统页、健康卡、`status` 指令与 `/api/sources` 的 `status` 都读它。🔗 3a-39：内置来源的运行状态读口还没造（没有读者），`failed` 没造，`settings-invalid` 今天只有拓展装载器产生；B 站设置读不懂时来源仍是在册的，停着的那一样在问题表里。再看的时机是 3a-40 的 `health()`。🔗 3a-40：`health()` 造出来了（同步、可选、只交一句话，今天只有 B 站来源实现、只有 `status` 指令读它），但它不是运行状态读口，运行状态读口仍没造，再看的时机待定（见 construction-plan 的「以后再说」）。
- `health?()` 交 `SourceHealth = { summary: string }`，只给健康卡与 `status` 指令一行字。🔗 现状（3b-42，10-24）：拓展来源的返回已按 [extension-contract.md](./extension-contract.md)「订阅源」一节所述当外来数据收，核心只认规整后的 `{ summary }`。
- **订阅卡的「暂停 / 不可用」不看 `health()`**：看运行状态（「{label} 没在跑」）与问题表里关于这条订阅的条目。
- 健康卡分两排：核心（持久化、订阅、推送、卡片、AI）与集成（每个集成一格；推送适配器有连接才占格；同时供来源与适配器的拓展也只占一格）。集成格的灯按运行状态与问题分四色（绿正常、黄有问题、红失败或设置不合法、灰停用）；小字取 `health().summary`，没实现就写运行状态，登录态由宿主从 `AuthState` 补。
- 数据放 `/api/health/details`；短版 `/api/health` 只留存活探测要的 `status`、`version`、`startedAt`、`uptime`（应用内更新靠 `version` 与 `startedAt` 认新进程），B 站的格子删掉。卡片的界面第 4 期先出设计稿再重做。

## 资料刷新与「在记」

**资料**：

- 核心按 `core.profileRefreshCron`（由 `fansCron` 原值迁来）定时调 `fetchProfile`，只调启用中的订阅（09-27 拍板；和名单只列启用中一致，也少打平台接口）。停用的订阅资料缓存停在停用那一刻，面板照常显示最后一次的名字与头像，重新启用后下一轮刷新。
- 对同一来源**串行**调用；防风控的间隔由来源自己管（B 站那个 200ms 留在 `bilibili/`）。失败怎么算见「Source」表里的 `fetchProfile`：`not_found` 记问题，其余下一轮再来，整轮刹车归来源。
- 来源主动 `reportProfile` 的，按同一个间隔限密。
- 粉丝数就在资料里，粉丝轮询并进这项必备能力，不另占能力位。涨粉的增量、时序、首页粉丝面板由核心算，上总线 `followers-refreshed`。
- 资料另有中立的可选字段 `fanClubName`（粉丝团名，平台没有就空），模板变量 `{fanclub}`（原 `{mdn}`）取它。
- 头像：来源先 `ctx.fetchImage` 抓进图库，再交 `ImageRef`。B 站在 `bilibili/` 里带 Referer 下载，图链没变不重抓。面板一律走同源地址、出卡一律从本地内联，删掉 `no-referrer` 绕行。
- 动态轮询不在此列：B 站拉的是整条关注流，没法按订阅逐个拉。

🔗 10-23（3b-24）：资料刷新引擎已落成（`runtime/profile-refresh.ts`），按 `profileRefreshCron` 经来源 `fetchProfile` 刷新启用中的订阅；同来源串行、不同来源并行。粉丝轮询已并入资料刷新，核心写资料缓存、记粉丝样本并发 `followers-refreshed`。

**统计只记开着的**：单个订阅开了作品开关才记作品，开了直播类开关才记场次；关了就不查也不记（ADR-0027 决策 1）。

**「在记」按特性分**（ADR-0027 决策 2），核心自己算：

- 作品：那天作品开关开着，且来源在跑；
- 直播：那天直播类任一开关开着，且来源在跑；
- 粉丝：那天拉资料成功。

🔗 **现状（3b-26，10-24）**：「来源在跑」这里只看登录：来源在登记表里，且没有登录口或登录口现读是 `logged-in`（`confirming` 不算），核心就按每条订阅的作品 / 直播开关记当前小时（`stats/registry-source.ts`）。作品入口的闸与女仆查直播仍是「在册即在跑」；两种说法合成一个读口归第 4 期。

每张图（热力图也是）读自己的「在记」，关着的日子显示「没在记」、不画成 0；锐评与榜单跳过没在记的日子。seen（「那天有没有联系上来源」）不再单独当判据。在播状态与当前粉丝数取在播表与资料缓存。「在记」记成每个订阅一份按小时的小账 `stats/recording/`，原来的 `seen/` 并进去（ADR-0027 决策 13）。

统计记录开着作品的订阅的全部作品，另外记其中带视频的那些。面板与 CSV 仍叫「投稿」「动态」：投稿 = `videoPosts`，动态 = `posts − videoPosts`（面板相减）；锐评提示词同样这么算。

## 直播

两套场次引擎合成一套：原先拓展那套（本就中立）去掉 `Extension` 前缀升格为核心 `live/`，B 站那套旧场次实现删掉。

🔗 10-13（3b-20）已落的是拓展那一半：场次引擎 `ExtensionLiveSessions` → `LiveSessionEngine`（`live/live-sessions.ts`）、在播表 `ExtensionLiveTable` → `LiveTable`（`live/live-table.ts`）、推送 `bindExtensionLivePush` → `bindLivePush`（`live/live-push.ts`），当时的出卡输入翻译搬进 `live/`；总线事件 `extension-live-changed` / `extension-live-session` 与契约里的 `ExtensionLiveSnapshot` 没改名。B 站那一半已在 3b-22 并进来，见下。

删 B 站的 `room-session*` 之前，先把醒目留言、会员、特别弹幕、特别进场的装配从 `room-session.ts` 抽进 `live/`（它们是核心中立特性的装配，不跟着 B 站引擎走）。🔗 10-13 四块都已抽完：特别弹幕与特别进场 3b-15（`live/special-users.ts`，随名单改叫 `specialViewers` 改名 `live/special-viewers.ts`）、醒目留言 3b-17（`live/superchat.ts`）、会员 3b-18（`live/membership.ts`，B 站会话的 `onGuardBuy` 只剩翻事件、查档位表、挑文案包、拼兜底句、绑取徽章 / 取头像与发送）。

🔗 10-21（3b-22）：B 站直播间连接已搬进 `bilibili/live/session/` 的 `BiliLiveRooms`，场次与计时由核心 `LiveSessionEngine` 统一；出卡输入现由 `live/live-card-input.ts` 的 `liveCardInputFromDetails` 翻，旧的 B 站场次引擎与共享会话基类已删。

来源有三种输入：

| 输入 | 形状 | 谁用 |
| --- | --- | --- |
| 推送式信号 | `ctx.reportLive(externalId, LiveSignalReport)`：`start` / `status` / `end` | 拓展照现在的上报走；B 站在 `bilibili/` 把弹幕通道的开播、下播、状态翻成这三种 |
| 拉取式 | 核心按场次定时调 `fetchLiveStatus` | 提供了它的来源 |
| 观众互动 | `ctx.reportLiveInteraction(externalId, LiveInteractionReport)`：`viewerChat` / `viewerEnter` / `superchat` / `membership` | 来源在直播间收到这些事件时上报；核心按订阅现折设置后出卡 |

`fetchLiveStatus` 返回结果形状（ADR-0026 决策 4）：`{ ok: true, kind: "live" | "offline", … } | { ok: false, code, message }`，成功那一支的判别键是 `kind`：

| 结果 | 核心怎么做 |
| --- | --- |
| `ok: true, kind: "live"` | 推「正在直播」卡 |
| `ok: true, kind: "offline"` | 此刻没在播：当成漏收的下播，走 `end` 同一条路（含断流宽限与私聊主人）；时长算到「发现已下播的那一刻」 |
| `ok: false`（带 `code` + `message`） | 核心跳过这一轮、记日志；**不再停止监听**（ADR-0021 决策 27 原文），问题由来源自己报 |

- **漏收下播的兜底与周期推送拆开**：凡在一场直播里的订阅都按间隔核一次还在不在播；周期推送（`liveStreaming`）开着照推「正在直播」卡，关着只核不推、间隔用默认 1 小时。重连后核对发现已下播也走同一条下播的路；合进核心那套之后，开播看 `liveStart` 开关。

- 计时按每一场的开播时刻各自起算（`LiveSession.nextTickAt`），不全局同时拉。间隔是 `liveStreaming.streamingIntervalHours`。
- 同一来源串行调用；超时与中止走 `subscriptions/call-source.ts` 的 `callSource` 外壳；来源停用时取消在途调用。
- **重启**后核心对每条开着直播推送的订阅调一次 `fetchLiveStatus` 重建场次；要不要补推一张正在直播卡由 `liveStart.catchUpOnBoot` 统一决定。补报不 @全体、历史记成开播，见 data-model「特性键」。
- 断流：收到 `end` 先进 `pendingEnd` 等宽限，宽限里又开播就 `resume` 接着同一场；等满了才 `end`。
- 场次的每次变化是一条 `LiveSessionChange`，推送与统计吃同一份；B 站与拓展来源统一由场次引擎发 `live-session-changed`，信号或核对带的人数另发 `live-viewers-changed { subscriptionId, currentViewers?, totalViewers? }`，只带实际带来的格（🔗 10-21（3b-23）已落）。
- ⛔ 场次身份按开播时刻认、排在闩之前；统计 `current` 与 `isLive` 的语义不动。
- 「这条订阅会不会被监听」全仓只有一处判定（在 internal），首页与服务端共用：五把直播类开关任一开着，或（`viewerChat` 开着且名单上有人带 `viewerChat`），或（`viewerEnter` 开着且名单上有人带 `viewerEnter`）就监听，只看开关与名单、不看有没有目标。看得见的变化：五把直播开关全关、名单上有人、特别关注开关也关着的订阅，升级后不再连直播间、首页说它「不会被监听」、统计不再记它的直播（0.x 是「名单有人就监听」，迁移记账本留一份冻住的旧读法）。宿主把结果算进 `SourceSubscriptionView.monitorsLive`，同一人的重复订阅取或；B 站来源的 `ListenerManager` 只连 `monitorsLive` 为真的人。面板的「不会被监听」与直播就绪判断都用它（原来面板只看有没有目标，还自抄一份路由键，是一句假话；3a-31 已把面板的判定改成只看折好的开关、不再数目标）。`getModuleState().live` 还要求这个来源实现了直播：在册来源有 `fetchLiveStatus`，或拓展声明了直播周期。
- **醒目留言**：`SuperchatEvent` 带可选的 `tier { rank, durationSec? }`，由来源按平台规矩算；卡按档取色（默认配色照今天六档，皮肤可按档换色），有留言时长就显示。
- **验收**：开播、下播、断流接续、漏收下播兜底四种行为已由端到端测试钉住，并已换到核心 `LiveSessionEngine` 跑同一组。
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

🔗 2026-10-23（3b-34）：`AiTool` / `AiToolResult` / `AiToolLabelFields` 已住 `packages/internal/src/ai-tool.ts`，`@bilibili-notify/ai` 照旧再导出；`AiToolProvider` 也住这个文件，今天只造了 `readOnly`，`chat?` / `skills?` 没造（`skills` 随 3b-35 的 B 站版周报）；`readOnly` 当前不挂推送路径。拓展清单的 `contributes.aiTools` 仍不开。

| 接口 | 核心负责 | 来源负责 |
| --- | --- | --- |
| `LinkResolver` | 闸门与出口，见「链接预览」 | 认链接（`matches`）、解析成 `LinkPreview`（出的是 `Post`）；可选给原生分享的中立描述 |
| `AiToolProvider` | 生成器、人格、六把中立只读工具与六个内置技能，见「AI 工具」 | 来源独有数据的只读工具与技能 |
| `DevtoolsProvider` | 只认接口与登记表，不认识任何一家来源 | 自己的造状态 / 造事件场景，见「devtools 场景」 |

- 这三个接口的登记表在核心照做、B 站照用；1.0 只对拓展开 `devtools`，其余两个见 [extension-contract.md](./extension-contract.md)。
- 指令没有来源的接口，见「指令」。

### 链接预览

群里贴链接，回一张预览。

- 统一叫「链接预览」（原「链接解析」「链接卡片」「小程序卡」）：目录 `link-preview/`；设置 `linkPreview`，由 `linkParsing` 迁移（原定的 `linkCards` 作废）；解析器仍叫 `LinkResolver`（链接解析器），门叫 `LinkPreviewer`（`createLinkPreviewer`、`LinkPreviewerOptions`，文件 `link-preview/link-previewer.ts`）。
- **设置五格** `{ enabled, isOnByDefault, replyForm, byTarget, cooldownSec }`：总开关 `enabled`（默认关）、默认回不回 `isOnByDefault`、回复形式、按目标的例外 `byTarget`（条目 `isOn` / `replyForm`）、`cooldownSec`。链接预览回卡不走推送链、全局静音与免扰管不到，所以留一个一键全停的总开关（当初摊平时顺手带掉的）。迁移一一对应、行为不变、名单不丢：总开关 ← 旧 `enabled`，默认 ← `defaults.parse`，回复形式 ← `defaults.form`（`miniapp` → `nativeShare`），例外 ← `groups`（条目里 `parse` → `isOn`、`form` → `replyForm`），`cooldownSeconds` → `cooldownSec`。「默认」不叫 `enabled`，避开 AI 写正文那边曾用 `enabled` 表示默认的撞义（AI 写正文的默认也改叫 `isOnByDefault`）。3b-29 已落。
- **闸门在核心**：开关、按目标的表、冷却、硬上限、失败不出声、一条最多三个、从分享卡取链接。冷却键是「群 + 解析器 + `canonicalId`」。
- **挑链接**：核心先用通用网址正则挑出候选，再问各解析器的 `matches`。出口不按平台域名预筛：OneBot 入站的 B 站域名预筛删掉，64KB / 8 层的上限保留。
- **入站链接的来源标记**：适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" | "nativeShare" }[]`，取代 `miniAppCardLinks`；正文里的链接仍由核心从 `text` 里挑、内部记成 `"text"`；规矩是「原生分享卡里的链接不回预览」。桥帧里那一格进 alpha 之后两步改名的清单；它是插件发给 BN 的入站字段，两步反过来走：BN 先同时认新旧两种写法，插件再改发新的。
- **回复形式** `replyForm` 取 `image` / `nativeShare` / `text`，面板上是「回图片 / 回原生分享 / 回文字」。原生分享由 OneBot 适配器拿中立描述去签，签不了就回图片（签不了原生分享的出口会一直回图片）。`appId` 填 B 站 QQ 小程序真实的 appid（施工时从真分享卡里读出来核）；OneBot 签名接口不收通用参数，就在适配器里放 appid → 预设的对照表。载荷种类 `"miniapp-card"` 改 `"native-share"`、能力格 `miniAppCard` 改 `nativeShare`。
- **「回文字」发什么**：作者名 + 作品文字（经作品取段的那一个函数，限长），不带链接（群友的消息里已有链接）。🔗 10-20 已落（3b-31 提交 4）：`replyForm` 的第三档 `text` 随之进了取值表；门里 `text` 直接可发，不要渲染器也不问能力，作品文字按码点限 200，发送失败不回落图片。
- **回复**经 `TargetDispatcher.sendToAddress` 发回原会话：不进路由、不过闸、不落历史，但要查 `isAvailable`、结果带 code、由截流统一记，不重试。原先现造的临时目标删掉。

🔗 10-13（3b-27 链接半、3b-28）已落：核心的 `LinkResolver` / `LinkPreview` 类型（`packages/internal/src/link-preview.ts`）；登记表 `link-preview/registry.ts`，来源在自己的 `start(ctx)` 里经 `ctx.registerLinkResolver(…)` 登记（键取来源的键，停下时自动撤）；门（`link-preview/link-previewer.ts`）用 `link-preview/extract-urls.ts` 的通用网址正则挑候选、按登记先后问解析器认不认、取前三个被认领的，冷却分两把键（联网前按链接原文、解析成功后按 `canonicalId`），同一条消息里指着同一个东西的几种写法只出一张；B 站的解析器是 `bilibili/link-resolver.ts`（视频链接的认法 `bilibili/video-links.ts`、视频翻成作品 `bilibili/video-card.ts`，都是从别处搬来的），封面在解析器里抓，原生分享由解析器交中立描述、门翻成今天的小程序卡载荷；对拍 N07 因此转成了 P22。「入站链接来源标记 `sharedLinks`」「回复形式 `replyForm`」「设置改叫 `linkPreview` 并加回总开关与冷却」两条还没动；门已改名 `LinkPreviewer`（3b-28 收尾，行为不变）。

### 指令

- **框架在核心**：入站链路、鉴权门、确认流、参数、错误反馈、近似建议；通用指令 `help`、`mute`、`report`、`status`、`login`。`status` 里每个集成那一行取运行状态与 `health()`。🔗 现状（3a-40）：`status` 今天只读在册来源的 `health()`、每个来源一行，没有运行状态那半（运行状态读口没造）。
- 交给登记表的一整包叫 `CommandDef`（代码里的 `CommandSpec` 改名），字段不变。
- `run(values, ctx: { reply(payload), signal })` 返回结果形状（成功 `{ ok: true }`）；`reply` 经 `TargetDispatcher.sendToAddress` 回到发指令的那个会话（原先回到主人目标那条连接），送没送到照返。
- 返回失败时框架回「『{指令名}』没办成：{message}」；抛错回「出错了，详情在日志里」，并记错误日志（今天出错只打日志、不回话）。
- **`login [来源]` 是核心的通用指令**：只装了一个带登录的来源就直接扫它，装了多个就列出来让主人挑；二维码取自 `AuthState`，经 `reply` 发图。B 站不再自带指令。
- 于是 1.0 没有来源自带的指令，`CommandProvider` 登记表先不造：没有实现者的接口先不造。来源自带指令与指令重名的规矩，等第一个真要自带指令的拓展再定。

### AI 工具

- **六把中立只读工具**：`list_subscriptions`、`get_creator_profile`（读资料缓存）、`get_creator_posts`（读统计仓最近几条）、`get_live_status`（读在播表）、`search_creators(source, query)`（转给该来源的 `searchCreators`）、`get_creator_stats(creator, days?)`（读统计仓：作品数、视频作品数、直播场次与时长、涨粉、最后活动）。
- 中立工具的参数统一叫 `creator`，值是「来源键:外部 id」（按第一个冒号切）；核心工具参数里不许出现 `uid`（进 AI 约束守卫）。`list_subscriptions` 与 `search_creators` 的返回带着它。没订阅的人，读缓存类工具答查不到 —— 只有 `get_creator_profile` 例外（10-15 主人定）：资料缓存里没有这个人时，回落调一次来源的 `fetchProfile`（3b-24 造，在那之前先答查不到），交名字、粉丝数、简介；等级、视频数这类 B 站独有的不带。内置技能「找创作者」「创作者 PK」本来就冲着没订阅的人去，靠这一条不废一半。
- **六个内置技能**全部跨来源、只用中立工具；`find-up` → `find-creator`、`up-pk` → `creator-pk`，旧名留别名。技能改名没有迁移改写（0.x 的女仆技能不迁，见 ADR-0030 决策 1 下 10-14 的 🔗）。🔗 现状（3b-35，10-24）：正名已落成，旧名作为 `aliases` 写在内置条目上并经 DTO 下发；别名不占名、不设期限，主人自建同名优先。
- 统计总开关关着时，`get_creator_posts` / `get_creator_stats` 回 `not_configured`（照锐评的先例）；注入的工具失败也按结果形状返回；B 站工具的失败码走上面「B 站返回码的翻译表」。`searchCreators` 这一期造、B 站实现，`search_creators` 工具读它。
- **来源独有的数据**经来源的 `AiToolProvider` 登记只读工具：B 站的总播放、获赞、视频列表；B 站版的周报由 B 站自己以技能提供。🔗 2026-10-23（3b-34）：登记表是 `apps/server/src/ai/tool-provider-registry.ts` 的 `createAiToolProviderRegistry`，挂在 `AppRuntime.aiToolProviders`；来源经 `SourceContext.registerAiToolProvider` 登记，键取来源键，来源停下自动撤。`CommentaryGenerator.setProvidedTools(get)` 每次请求现取提供方的只读工具，挂在聊天与「试推送 / 试一句」上（凡挂核心工具的地方）；推送路径（点评 / 锐评）不挂。分发与标签的顺序是注入的 > 提供方的 > 核心。提供方起本名，宿主统一加命名空间，全名是 `<命名空间>__<本名>`，命名空间 = 来源键里 `[A-Za-z0-9_-]` 以外的字符换成 `_`（`acme.douyin` 的 `get_videos` → `acme_douyin__get_videos`）；本名非法、同组重名、全名超 64 或命名空间相撞时登记即抛。技能编辑器的工具名单每次现取核心工具 + `web_search` + 登记表。
- 🔗 现状（3b-35，10-24）：`AiToolProvider.skills` 已落成；提供方交本名，登记表按来源键生成 `<技能命名空间>-<本名>` 并经 `skills()` 交出，B 站版周报为 `bilibili-weekly-report`。技能读口 `apps/server/src/maid-skills/reader.ts` 把内置、提供方与主人技能合成一张表；缺工具的内置 / 提供方技能不列、点名拿不到，主人技能照列、照交集收窄、只记一条 warn。

- `AiTool` 加 `label` 与参数标签，面板读下发的，不再写死一张表。缺工具的女仆技能面板自动隐藏；面板里找不到工具的 3 条死标签（`subscribe_user`、`unsubscribe_user`、`update_subscription`）删掉。
- 工具返回的图也是 `ImageRef`；看图时由宿主注入的读图函数读图库，`packages/ai` 不碰磁盘。
- **提示词跟着来源叫**：内置人格、卡片工坊、锐评、内置技能与工具说明里的平台叫法改用 `{creatorNoun}`、`{postNoun}`、`{sources}`，调用时由核心按这次涉及的订阅填（规矩同「叫法」）；主人自己写的不改写，内置预设改版照旧亮「默认文案有更新」；风格性的写法（「B 站弹幕解说员」「B 站梗」）改成中性。🔗 现状（3b-12，10-24）：内置人格按语言各一份，内容每次按当前语言从 `builtinPresetsFor(locale)` 取、不存进设置；改版与换语言都直接跟上，不再亮「默认文案有更新」。设置只记 `ai.removedBuiltinPresets`（缺 = 一份没删）与主人自建的 `ai.presets`；主人写的提示词和从内置另存的副本不改写、不跟语言。

### devtools 场景

- `DevtoolsProvider { scenarios: DevScenarioDef[] }`，只在开发版登记；过线给面板的纯声明叫 `DevScenarioDescriptor`。
- 场景 id 由宿主加前缀（`bilibili.xxx`、`<拓展 id>.xxx`），不会撞名，也冒充不了别家。
- 参数按提供方收窄：来源用新种类 `creator`（值是自己名单里的 `externalId`）；推送适配器只能挑自己的连接；`sub` / `target` 只给核心。
- `run` 返回 `{ ok: true, summary? }` 或失败：参数不合法回 `invalid`，场景找不到回 `not_found`；原来那两个异常类（`DevParamError`、`DevScenarioNotFound`）删掉。`active` / `reset` 不变。
- 场景只用自己集成的东西做事（B 站「造一条新动态」经 B 站自己的轮询上报），核心的句柄不交出去。

🔗 现状（3b-45，10-25）：纯声明叫 `DevScenarioDescriptor`，这一族与 `DevtoolsProvider` 的本体住 `packages/internal/src/devtools.ts`；`@bilibili-notify/extension` 转出给拓展，contract 只借给面板。拓展只在开发版 `devtools.mjs` 的开发入口登记 provider，登记与撤销随拓展起停，场景 id 由宿主加 `<拓展 id>.`，撞核心场景即拒。

🔗 现状（4-06，10-28）：核心场景也加前缀（`core.`，建表时就以 `core` 认领），描述符多一格宿主填的 `provider`；`creator` 种类已造，值经宿主按来源名单（`ctx.subscriptions()` 那一份）核过，`sub` / `target` / `connection` 只给核心、别家认领时就拒；推送适配器挑自己连接的种类没造（没有使用者）。B 站场景只拿 B 站来源一个把手，注入点仍在 B 站自己的边界上；那句例子原文是「就调 `ctx.reportPost`」，主人 10-28 改，理由与随之变的几处见 ADR-0031 决策 2 的 🔗。

## B 站怎么实现

`apps/server/src/bilibili/` 放 B 站的全部：

| 子目录 / 件 | 内容 |
| --- | --- |
| 原 `api` / `blive` / `dynamic` / `live` 四包 | 各成子目录（`blive` 并进 `live` 那个子目录，ADR-0021 决策 1 的 🔗）；B 站接口响应类型（Dynamic、RichTextNode、LiveData）只住这里。请求客户端、cookie 罐与浏览器身份抽进 `packages/http`，不留在这里 |
| `Source` 实现 | 拉动态翻成 `PostReport`（见下「作品映射」）、直播间弹幕通道翻成 `LiveSignalReport` 与 `LiveInteractionReport`、`searchCreators`、`fetchLiveStatus`、`liveInteractions` |
| `auth/` | 扫码登录（原 AuthSystem），对外只交中立的 `AuthState`；内部若还要一个原形，叫 `BiliLoginState`。cookie 由 `ctx.http` 的 cookie 罐存进 `ctx.secrets`。（3a-29 B 站半已落：`createAuthSystem`、`LoginFlow`、`BiliLoginState` 与 `authStateFromLoginState`（内部原形 → `AuthState` 的纯映射）都在这个目录，`auth` 挂在 `Source.auth` 上；入口仍直接造它，不经 `compose.ts`） |
| `LinkResolver` | B 站视频链接识别与解析；给原生分享的中立描述 |
| `AiToolProvider` | B 站独有数据的只读工具（总播放、获赞、视频列表）与 B 站版周报技能 |
| `devtools/` | `DevtoolsProvider`，只在开发版登记；场景只经 B 站自己的 ctx 做事 |
| 翻译表 | 大航海等级表与等级名（`guard_level` 反向换算）、档色（原面板的 `guard-levels.ts`，进 B 站的描述符）、醒目留言的档位规矩、返回码翻译表（数字码 → 标准码，见下）、响应解包、CDN 缩放后缀与 Referer、「大航海舰队」文案 |

🔗 2026-10-23（3b-34；34-3 落成后）：B 站两把在 `apps/server/src/bilibili/ai-tools.ts`，由 `createBiliAiToolProvider` 交来源在 `start(ctx)` 里登记；本名 `get_up_totals`（原 `get_user_stats`）/ `get_up_videos`（原 `get_user_videos`），全名 `bilibili__get_up_totals` / `bilibili__get_up_videos`，参数都收 `creator`。来源键不是 B 站或外部 id 不合格式回 `invalid`；失败码走 B 站的翻译表，不再一律 `unavailable`。回给模型的话在 `apps/server/src/bilibili/ai-tool-texts.ts`，写死中文守卫的白名单由三份变四份；标签进字典（`bilibili.aiTools.*`）。`packages/ai` 的 `BiliReader` 与两把过渡工具删净，`packages/ai` 不再有任何 B 站认知；B 站版周报技能不在这一段的 `readOnly` 里，随 3b-35。

- **只经中立接口进核心**，在 `compose.ts` 登记（见 [architecture.md](./architecture.md)）。
- **只报 uid**：B 站按 uid（即 `externalId`）上报，由核心展开成订阅 id；B 站不知道订阅 id，只用 `ctx.subscriptions()` 的名单决定拉谁。
- **直播并进来源**：`bilibili/live/session/` 的 `BiliLiveRooms` 在 B 站来源的 `start(ctx)` 里启动，按名单里 `monitorsLive` 的人维护直播间连接。`RoomSession` 管弹幕 WS、房间信息、心跳、重连与退避，把帧翻成中立的开播 / 状态 / 下播信号和四种互动上报；封面、头像等图先经 `ctx.fetchImage` 存进图库。🔗 现状（3b-47，10-25）：`BiliLiveRooms` 改听 `watchLoginEdges`；`BiliSourceDeps.bus` 已删，动态引擎也走同一条登录边。
- **拉取式直播状态**：`BiliLiveRooms.fetchLiveStatus` 查房间信息；`live_status` 为 1 时交在播数据和 `live_time` 转成的 ISO 开播时刻，0 / 2 交 `offline`。取不到房间号、回应或状态不认时经分层上报器记 `live_status_unavailable`，核心只跳过这一轮。
- **互动懒取**：`liveInteractions.fetchViewerAvatar` 负责观众头像，`fetchTierIcon` 负责会员档位徽章。B 站描述符里的三档徽章在来源启动且名单有人要监听直播间时预抓，引用写进 `tier.icon.ref`；缺引用时按需补抓，两次尝试至少隔 5 分钟。
- **请求走 `ctx.http`**：B 站的请求与弹幕 websocket 都经 `ctx.http` 拿，用 B 站这个集成的身份与 cookie；帧、心跳、重连、重试、退避、限流归 `bilibili/`。
- **开了开关才监听**：关注流只能整条拉，名单里没开作品的人，那条不抓图、不上报；没开直播类开关的人不连弹幕。原先为了统计让时间线覆盖每条订阅的做法，随 ADR-0027 决策 1 推翻。
- **进门换 ISO**：`live_time` 是不带时区的北京时间，在这里转。
- **作品映射**：`text` 只放正文（动态正文、图文摘要）；图文标题进 `article.title`，视频标题进 `video.title`，转发的原作品进 `repost`。UP 自己的视频进 `post.video`；番剧、合集、课程进附件的视频卡。附加块翻成 card / video / goods。过滤、AI、出图都经核心 `posts/` 里同一个取段函数读这份字。
- **开播公告直接丢**：开播时生成的那条伪动态不上报，统计也不再记（旧数据照原定不搬）。
- **资料**：`fanClubName` 填粉丝牌名，照文档由 `fetchProfile` 交；B 站不为它多发请求 —— 直播时取主播信息本来就带粉丝牌名，B 站先记进自己的 `ctx.state` 的 `profile:<uid>`，下一轮资料刷新经 `fetchProfile` 写进核心资料缓存。`{postNoun}` 进默认作品文案归 3b-21（ADR-0028 决策 3 的目标）；对拍 N08 随 3b-22 收尾。
- **醒目留言**：`tier` 由 B 站按平台规矩算，卡按档取色。
- **禁 fs**：B 站的状态（`roomId`、`followed`、`followError` 等）只走 `ctx.state`，cookie 只走 `ctx.secrets`；动态游标仍只在内存。🔗 **现状（3b-25，10-23）**：实际只有房号缓存进 `ctx.state` 的 `room:<uid>`，由 `bilibili/live/room-ids.ts` 的 `createRoomIds` 读写；只缓存名单内的人，名单变化时删除离开者的键，同一人的在途解析合并、出网至少相隔 300ms。`followed` / `followError` 哪里都不存，关注失败改由问题表顶替。房号解析撞持续风控时，连续重试按 `[60s, 5m, 15m, 30m]`，之后每 30 分钟一次、不放弃；风控走来源级 `risk_controlled` 的路 `live:<uid>`，只进表、不私聊，解析成功才真解除，停止监听或离开名单时按「不再适用」清。
- **设置**：B 站段 `settings.bilibili`（`dynamicCron`、`loginCheckIntervalMinutes`）由 `bilibili/` 定义，核心不许读。系统页为 B 站单开一个 tab，名取它的 `label`（见「设置」）。`bilibili` 段校验不过只停 B 站这一个集成：来源、链接解析器、AI 工具都不登记，订阅卡显示「{label} 没在跑」，B 站 tab 显示原值、「设置不合法」与原因并进问题框，改对了当场起；BN 照常开机。
- **删掉自定义 UA**：身份一律由 `packages/http` 生成，UA 与 `sec-ch-ua` 永远配套；B 站设置页加「换一个身份」按钮，重新生成一套。老配置里的 `userAgent` 这一格由迁移丢掉，新 schema 不留。理由：填了自定义 UA，`sec-ch-ua` 仍是生成的 Chrome 身份，拼出一个自相矛盾的指纹；风控 -352 的第一嫌疑本来就是 TLS 指纹，不是 UA。
- **补关注**（BN → B 站单向）：在 `onSubscriptionsChanged` 回调、开机、重新登录后各跑一次。整份名单先批量查关系、只补缺的（稳态写请求为零）；失败按「问题上报」报 `follow_failed`。登录态失效时跳过；批量查询回 -101 按「没登录」整批跳过，订阅卡上的关注状态不动，等登录恢复再跑；其他失败码仍走降级。停用的订阅不在名单里，自然不补；从停用改回启用时名单变化，那一轮就补上。
  - 🔗 **10-11 3a-31（主人定）**：关注只为从关注流里拉到动态，所以**只对启用中、且作品开关开着的订阅做**，只开直播的订阅不查也不补；开关从关到开（订阅被启用、订阅自己的作品开关打开、全局作品开关打开）时补一次；BN 只补关注、从不取关，从开到关、停用什么都不做；订阅卡上只开直播的订阅不再显示「未关注」。**这是今天的现状，不是上面那句设计的落成**：关注同步还没搬进 `bilibili/`，今天住 `runtime/follow-sync.ts` 与引擎装配（`runtime/engines.ts`：开机、登录恢复、开关翻开三处触发，不挂在 `onSubscriptionsChanged` 上），整个搬进 B 站来源、用来源上下文的名单自己算差集，没有单独的片认领（construction-plan 里「补关注 -101 整批跳过」「开机关注同步不发事件」两行顺带记着 3b），细节见 `docs/agents/subscriptions.md`「关注同步」一条。搬进 B 站之后（3b-25）：补关注在「订阅名单变了」的回调里异步做，失败报 `follow_failed`（见「问题上报」）。
  - 🔗 **现状（3b-25，10-23）：已落**。关注同步在 `bilibili/follow-sync.ts`，不再有 `runtime/follow-sync.ts`。B 站来源从 `ctx.subscriptions()` 的 `features.has("post")` 选人；开机只在已登录时跑全量，`auth.onChange` 从非登录变成 `logged-in` 时跑全量，`onSubscriptionsChanged` 只对相比上一次新进入关注范围的外部 id 跑一轮。新建订阅不在路由请求里当场关注，由这次名单变化补；停用、关作品或退订使一个人离开范围时，按「不再适用」清掉他的 `follow_failed`。整批关系查询回 `-101` 时整批跳过，不降级；其他查询失败仍降级为逐个 `follow()`。
  - 🔗 **现状（3b-63，10-24，主人定）**：关系查询撞风控（`rate_limited`，含 HTTP 412）也整批跳过、不降级（记一条带原话的 warn，这一批不报 `follow_failed`：不知道谁没关注）；逐个 `follow()` 撞风控时，撞上的那位照报 `follow_failed`，随后停下这一批，剩下的等下一次关注同步。
  - 🔗 **现状（2026-10-27，3b 期末审查 R14）**：欠着的随下一次名单变化一起补 —— `syncFollows` 的结果多交一格 `pending`（这一轮没处理完的外部 id：批量查撞风控的整批、逐个写撞上的与没轮到的、撞 `unauthorized` 停下时没轮到的）；`watchFollows` 记着这份欠账，名单回调对 `added ∪ (pending ∩ next)` 跑，全量那一轮（开机、登录恢复）之前清空，离开关注范围的人摘掉。撞风控照旧整批跳过、不降级、这一批不报 `follow_failed`，每次先发的仍是一个读。🔗 主人 10-27 定：欠着的非空时按 `RISK_BACKOFF_STEPS_MS`（60 秒 / 5 分 / 15 分 / 30 分，到顶一直 30 分）自己再跑一轮，每轮只跑「欠着且还在名单里的」那几位、先只发一个读，还在风控就照旧整批跳过、不写；补全就停、档位归零，没补全进下一档；同一时刻最多挂一个重试计时器（`watchFollows` 经来源的可回收 `setTimeout` 口挂，关停一起收），名单变化 / 登录恢复的全量跑完后欠账变了，按同一规矩重判；没登录不跑，`dispose` / `signal` 中止时收掉。
- **开机不碰 B 站**：`start()` 不预取 ticket（WBI 签名时现取）；未登录开机不补关注。开机那一刻连不上 B 站、或 ticket 接口回风控码，都不许拦住 BN 起来（第 0 期测试拦外网时查出：预取失败曾让整台 BN 起不来；分期见 [construction-plan.md](./construction-plan.md)）。ticket 请求和别的请求用同一个身份：原先固定用默认 UA 的特例删掉（建仓时从老插件原样搬来，没有留下理由）。
- **B 站返回码的翻译表**：B 站在 `bilibili/` 里有一张共用的「数字码 → 标准码」表，请求层在接口回来时查一次，翻成 `fail(标准码, 原话, { upstreamCode })`：`-352`、`-412`、`-799`、`-509` → `rate_limited`；`-101` → `unauthorized`；`-403` 不进共用表，由用到它的接口自己判（也可能是真没权限，如受限直播间）；没对照的码 → `unknown`，原码进 `upstreamCode`，每个进程第一次撞上记一条 warn。各轮询把 `unknown` 当一时失败、下一轮照拉、只进表不私聊。cookie 续期只在 `unauthorized` 时登出，`unknown` 下一轮再试（死会话由普通请求撞 `-101` 时登出）。资料刷新搬进 B 站来源后撞风控也进同一个风控层（路名 `profile`），只进表不私聊。🔗 3b-18 落成（拉动态、直播预检、上舰观众头像、cookie 续期）：纯函数 `failureFromBili`（`bilibili/error-codes.ts`）造「标准码 + 原话 + `upstreamCode`」，请求层 `Api.resultOf` 查一次，回应不是对象或没有数字 `code` 回 `unavailable`（不是 `unknown`，失败规矩第 6 条）；表外码的 warn 是每个 `Api` 实例（集成重启会新建）每个码一次。拉动态的 `-412` / `-799` / `-509` 从此是风控（进表并私聊）。cookie 续期的探测、刷新、确认三步只有 `unauthorized` 登出，别的失败跳过本轮、闸留着。直播预检：`rate_limited`（含持续 `-352`）走长尾重试、不判受限房；`-403` 与表外码仍当受限房（B 站对加密 / 付费 / 测试房回什么码没核，靠请求层的 warn 取证）；`unauthorized` 与 `unavailable` 当「弹幕连接没建起来」。上舰观众头像撞限流后 5 分钟冷却（`RoomContext.viewerAvatars`，不进问题表）。粉丝轮询那几处与登录取码手写的 `-352` / `-403` 还没改，归 3b-24。🔗 10-23（3b-24）：卡片、搜人与登录取码已按要求经码表或各自的 `-403` / `-404` 判别；表外码统一为 `unknown`，每个 `Api` 实例每个码只 warn 一次，`searchByType` 已回 `Result`。🔗 10-24（3b-63，主人定）：HTTP 412 风控页也算风控 —— 请求层抛 `RiskControlError`、外层不重试，回 `Result` 的方法一律翻成 `rate_limited`（不带 `upstreamCode`，412 是 HTTP 状态、不是 B 站的码，原话进 `message`），资料刷新与直播预检经各自现有的风控分支退避；wbi 签名请求那一族加熔断（`bilibili/api/wbi-breaker.ts`），持续撞风控就当场回 `rate_limited`、不出网，窗口 60 秒 → 5 分钟 → 15 分钟 → 30 分钟（与直播长尾共用 `riskBackoffStepMs`），到期只放一个调用去试探、其余等它，主人重新登录时清掉；风控层的上报不变。
- **失败码**：B 站接口的数字错误码放在 `upstreamCode`，不占错误体的 `code`；`code` 取标准码表（风控 `rate_limited`、没登录 `unauthorized`……）。
- 验收检查点：「接口先行」那一期（3a，见 [construction-plan.md](./construction-plan.md)）完成时，B 站全经中立接口运行、行为不变。
