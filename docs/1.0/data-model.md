# 1.0 数据模型与字段名

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

1.0 全部数据模型的正本。字段名一律是定案后的新名字，旧名在文末「改名对照」。文件放在哪、怎么迁，见 [data-and-migration.md](./data-and-migration.md)；接口（谁交这些数据、谁调谁）见 [subscription-sources.md](./subscription-sources.md)。

## 一句话

**核心只认中立形状**：订阅按身份 `{ sourceKey, externalId }` 认人，作品只有 `Post`，直播只有 `LiveSignal` / `LiveSession`，图只有图库引用 `ImageRef`。B 站的原始形状只活在服务端 `bilibili/`，进门就翻。

## 通用规矩

| 规矩 | 写法 |
| --- | --- |
| 时刻 | wire 与盘上一律 ISO 字符串，名字以 `…At` / `…Until` 结尾。老的 `ts` / `at` 与存毫秒的 `…At` 全改 |
| 时长 | 名字带单位：`Ms` / `Sec` 缩写，`Minutes` / `Hours` / `Days` 写全（`cooldownSec`、`chromeIdleSec`、`pollIntervalSec`、`streamingIntervalHours`、`loginCheckIntervalMinutes`、`retentionDays`）；不用 `Min`（会和 `min*` 阈值撞）；cron 字符串叫 `…Cron` |
| 枚举值 | 事件与状态类的值用 kebab（`grace-expired`、`logged-out`）；错误码与 problem code 用 snake（`invalid_profile`、`follow_failed`）；特性键保持 camel（`liveStart`）。「此刻没在播」统一叫 `offline`，`end` 只指「下播」这个事件 |
| 计数 | 全程是数字，只在出口（卡片、文案、面板）排一次版，见「数字、时间、不知道」 |
| 开关 | `enabled`，不用 `enable` |
| 布尔 | 带 `is` / `has` / `can` 前缀：`isLive`、`isAnimated`、`isPremium`、`isModerator`。例外：表示操作结果的 `ok` 保留；失败原因只用 `code` + `message` |
| 回退层 | `defaults` 只表示「按订阅覆盖时缺字段就回退到这里」；订阅覆盖不了的不放进去 |
| 过滤 | `allow*` 与 `block*` 成对 |
| 缩写 | `Ai…` / `Api…`，不用 `AI…` / `API…` |
| 「不知道」 | 缺键。不编成 0 或空串 |

⛔ 日志行格式（`msg`、`ts`）跨代共享、冻结，不在上面这些规矩之内。

## 键、身份与订阅

归属方只有两种键：内置的 `bilibili` 与拓展 id。所有登记表、设置段、数据目录都用它：

```ts
type SourceKey = "bilibili" | ExtensionId;   // 不加前缀；bilibili 是保留 id，拓展清单不许用

interface Identity {                          // 分派、判重都只看这两格
  sourceKey: SourceKey;
  externalId: string;                         // B 站就是 uid
}

function subscriptionIdentityOf(sub: Subscription): Identity;   // 全仓唯一判断「是谁」的函数

interface Subscription {
  id: string;                                         // uuid，运行期键
  identity: Identity;
  enabled: boolean;
  features: Partial<Record<FeatureKey, boolean>>;   // 开没开；来源「支持哪些」是 descriptor.supportedFeatures
  targets: string[];                                  // PushTarget id
  // 按目标的附加项三态表叫 extraTargets（原顶层 extras）
  specialUsers?: { id: string; note?: string }[];     // 公共形状；露不露看 descriptor.supportedFeatures
  // 按订阅覆盖：形状同全局 defaults，对所有订阅开放
}

interface SubscriptionState {          // runtime/subscription-state.json，按订阅 id；存储叫 SubscriptionStateStore
  cachedProfile?: CreatorProfile;
  problems?: Record<string, { message: string; since: string }>;   // 按 code 做键；重复报只更新文案、不重置 since
}

interface CreatorProfileReport {       // fetchProfile / reportProfile 交的；头像先用 ctx.fetchImage 抓好
  name: string; avatar?: ImageRef; bio?: string; followers?: number;
}

interface CreatorCandidate extends CreatorProfileReport {   // searchCreators 交的候选，最多 10 个
  externalId: string;
}

interface CreatorProfile {
  name: string; avatar?: ImageRef; bio?: string;
  followers?: number; refreshedAt: string;
}
```

- **身份没有前缀**：`SourceKey` 就是 `"bilibili"` 或拓展 id。不带点的 id 本就只给官方源，`ExtensionIdSchema` 再把 `bilibili` 列为保留 id，手动放进目录的拓展也撞不上。分派读 `identity.sourceKey`，不再有 `sourceKeyOf`；`SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription` 删掉。
- 「identity」在仓里另有 ChatIdentity、inboundIdentity、ExtensionIdentity 等意思，订阅身份的函数一律带 `subscription` 限定词。
- **订阅只有一个文件** `config/subscriptions.json`，B 站与拓展同一数组、行行带 `identity`。「缺 kind 就当 B 站」的默认值删掉。
- **同一身份只能有一条订阅**。在真正写盘的 `writeSubscriptions` 把关，判据是「这次写入有没有**新增**重复」，不是整份数组有没有重复。开机读到遗留重复只记警告、健康页显示，事件照旧分发给每一条。恢复备份先按 id 对、再按身份并入。
- **核心的订阅运行态里没有 B 站字段**：只留资料缓存与问题表。B 站的 `roomId`、`followed`、`followError` 在 B 站自己的 `ctx.state` 里。`fansBaseline` 退役，涨粉起点取粉丝时序的第一条样本。这份文件丢了只退化，不会重推漏推。
- **显示名只有一条链** `displayNameOf()`：事件上的 `creator.name` → 资料名 → 身份标签（「UID 123」或「抖音 · abc」）。别名退役。
- **身份挂在所有行上**：推送历史、统计、在播三种行都带 `identity`，盘上直接是新形状，不留读时映射。
- **特别关注名单只存 `{ id, note? }`**，平台由所挂的订阅决定。来源在 `descriptor.supportedFeatures` 里声明了 `specialDanmaku` 或 `specialUserEnter` 才露出这项设置。

## 作品

渲染器只认中立的 `Post`。B 站动态与拓展作品各自翻过来，B 站动态类型不进核心。`Post` 是纯数据（能 JSON 序列化、不含 JSX），存原始值，排版归核心。**没有形态字段**：有什么画什么，块没数据就收起。

```ts
type ImageRef = string;   // 图库 images/ 里的 sha256；作品图、直播封面、头像、历史快照共用

// 出卡只认 ref；url 只给「查看原图」，出图器不去抓
interface PostImage { ref?: ImageRef; url?: string; width?: number; height?: number; isAnimated?: boolean }

interface Creator { name: string; avatar?: ImageRef; isPremium?: boolean }

interface Post {
  creator: Creator;
  publishedAt: string;
  label?: string;                      // 「投稿了视频」，来源给
  topic?: string;
  article?: { title: string; images?: PostImage[] };   // 有这格就按文章排版；images 是文章配图
  text?: RichText;                     // 片段：text / break / emoji / mention / topic / link（可带图标 video | lottery）
  notice?: string;                     // BN 自己说的一句，画在正文后面
  locked?: { icon?: PostImage; title: string; hint: string };   // 专属内容锁，替掉正文
  images?: PostImage[];                // 只表示图集
  video?: { cover: PostImage; title: string; description: string; durationSec: number; views?: number; danmaku?: number };
  attachment?: Attachment;
  repost?: Post;                       // 被转发的原作品
  stats?: { shares?: number; comments?: number; likes?: number };
}

type Attachment =                      // 封闭联合，出图器按种类直接渲染，不开登记口
  | { kind: "card"; eyebrow?: string; cover?: PostImage; title: string; lines?: string[]; button?: { text: string; enabled: boolean } }
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

- `images` 只是图集；文章配图在 `article.images`。`blockImages` 就是屏蔽图集。
- `video` 表示「作品本身就是这个视频」，不设视频级的互动数。
- `repost` 是被转发的原作品；OneBot 的「合并转发」叫 `mergeForward`，两者无关。
- 所有图格（封面、附加块、锁图标）都是 `PostImage`。图由来源先用 `ctx.fetchImage`（有链接）或 `ctx.storeImage`（手里已是字节）存进图库、填 `ref`，上报里只交 `ImageRef`；抓失败由来源决定跳过这张，或只给 `url`（卡上画占位）。
- 链接卡出的也是 `Post`，就是作品卡。
- 老的 NeutralWork 上的 link / name / isVideo / postNoun / gallery / commentText，要么在信封上，要么由 `Post` 推出来，不许每条路各拼一个包装。
- 统计仓里一条作品记录叫 `PostRecord`（与同文件的 `LiveSessionRecord` 对称），和装配信封 `PostEvent` 是两样东西。

**验收硬门**：同一份 B 站动态，改造前后出的图逐字节不变。

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
  | { type: "start";  startedAt?: string; details: LiveDetails }
  | { type: "status"; isLive: boolean;    details: LiveDetails }
  | { type: "end";    endedAt: string;    details?: LiveDetails };

// 核心按身份展开后喂给场次引擎的：每条订阅一份
type LiveSignal = LiveSignalReport & { subscriptionId: string; identity: Identity };

// ② 拉取式：核心定时问 fetchLiveStatus
type LiveStatusResult =
  | { type: "live"; startedAt?: string; details: LiveDetails }
  | { type: "offline" }                                        // 此刻没在播，核心当成漏收的下播
  | { type: "unavailable"; code: string; message: string };

// ③ 核心自己记的一场
interface LiveSession {
  subscriptionId: string;
  sourceKey: SourceKey;
  startedAt: string;          // 场次身份：来源给的开播时刻 ⛔ 语义不动
  detectedAt: string;         // BN 认出这一场的时刻；没开播时刻时拿它当身份
  followersAtStart?: number;  // 下播卡算涨粉的基线
  peakTotalViewers?: number;  // 本场报过的最大累计观看
  lastDetails?: LiveDetails;  // 下播卡缺的格从这里补
  pendingEnd?: { endedAt: string; details?: LiveDetails };   // 断流等待中
  nextTickAt?: string;        // 下一次「正在直播」，按场次各自从开播时刻起算
}

// ④ 场次的变化 → 推送、统计、总线 live-session-changed
type LiveSessionChange =
  | { type: "start";  session: LiveSession; trigger: "start-signal" | "status-signal" | "poll" }
  | { type: "resume"; session: LiveSession }
  | { type: "status"; session?: LiveSession; isLive: boolean }
  | { type: "tick";   session: LiveSession; details: LiveDetails }
  | { type: "ending"; session: LiveSession }
  | { type: "end";    session: LiveSession; reason: "signal" | "poll" | "grace-expired" | "stopped" }
  | { type: "unmatched-end"; subscriptionId: string; endedAt: string };

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
- 场次引擎的行为（断流、定时、重启重建）见 [subscription-sources.md](./subscription-sources.md)「直播」一节。

## 会员、醒目留言与特别关注

会员按「体系 + 档」表达：各平台档数不一、有的由主播自定，一个升序数字装不下。体系由来源在 `descriptor.membershipPrograms` 里声明。

```ts
interface MembershipProgram {
  id: string;                           // B 站叫 "guard"
  name: string;
  tiers: MembershipTier[] | "custom";   // "custom" = 档位由主播自定
}
interface MembershipTier { key: string; name: string; rank: number; icon?: PostImage }   // rank 从 1 起、1 最低

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
}
```

| 事项 | 规矩 |
| --- | --- |
| B 站体系 | `guard`，档 key 是 `captain` / `commander` / `governor`，rank 1 / 2 / 3。B 站接口的 `guard_level` 1 = 总督，这个反向换算只在 `bilibili/` |
| 徽章 | 图库引用，来源声明档位时给（`tier.icon`） |
| 文案配置 | `templates.membership[体系 id] = { enabled, default, tiers[key] }`。每档与 default 都是文案加图片，没单独配的档用 default；`custom` 体系按档名存；`enabled` = 用不用自定义文案，推不推由特性开关管 |
| 门槛 | 每套体系一个 `minRank`，在 `defaults.membership.minRank[体系 id]`；没有 rank 的体系只能开或关 |
| SC 门槛 | `defaults.superchat.minAmount`，按人民币；别的币种先放行 |
| 出图输入 | 只有一种会员卡。`viewer.name` / `viewer.avatar`、`isModerator: boolean`；不再有 `captainImgUrl`，改用 `tier.icon`；「大航海舰队」文案在 `bilibili/` |

## 特性键与推送种类

全部特性与附加项都在核心、用中立名。醒目留言、会员、特别弹幕、特别进场、词云、直播总结在别的平台也有对应，只是现在只有 B 站填数据。来源支持哪些由 `descriptor.supportedFeatures` 声明。历史行存推送种类的那一格叫 `feature`，值就是特性键；`/api/history?feature=`、按天计数的键、测试推送的种类都直接用特性键。

```ts
const FEATURE_KEYS = ["post", "liveStart", "liveStreaming", "liveEnd", "membership",
  "superchat", "specialDanmaku", "specialUserEnter", "wordcloud", "liveSummary"] as const;
type FeatureKey = typeof FEATURE_KEYS[number];

// 历史的推送种类直接用特性键的名字，是特性键表的子集
type PushKind = "post" | "liveStart" | "liveStreaming" | "liveEnd"
  | "membership" | "superchat" | "specialDanmaku" | "specialUserEnter";

// 作品推送的部件（原 DynamicPushPart），与 PushKind 不是一回事
type PostPushPart = "post" | "post-images";
```

| 键 | 说明 |
| --- | --- |
| `post` / `atAllPost` | 作品推送与它的 @全体 |
| `liveStart` | 开播。子项 `catchUpOnBoot`：启动时发现正在播就补报一次。只有开播能 @全体（`atAllLiveStart`） |
| `liveStreaming` | 周期「正在直播」，间隔 `streamingIntervalHours`（最小 1）。来源提供了 `fetchLiveStatus` 并且同时上报开播与下播，面板才显示这个开关 |
| `liveEnd` | 下播 |
| `membership` / `superchat` / `specialDanmaku` / `specialUserEnter` / `wordcloud` / `liveSummary` | 核心中立特性 |

卡种：作品卡 `post`、直播卡、榜单（锐评）、醒目留言 `superchat`、会员 `membership`、词云、直播总结，全由核心登记。附加块 card / video / goods 核心直接渲染。历史行状态多一种 `silenced`，见 [push.md](./push.md)。

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
| `dynamic.time` / `dynamic.action` | `post.time` / `post.label`（内外层卡都填） |
| `dynamic.topic` / `dynamic.hasTopic` | `post.topic` / `post.hasTopic` |
| `dynamic.isForward` / `dynamic.hasAdditional` | `post.hasRepost` / `post.hasAttachment` |
| `dynamic.hasVideo` / `dynamic.hasPics` | `post.hasVideo` / `post.hasImages` |
| `pics.count` / `pics.first` | `images.count` / `images.first` |
| 作品卡 `stats.forward` / `stats.comment` / `stats.like` | `stats.shares` / `stats.comments` / `stats.likes` |
| 下播卡 `stats.fans` / `stats.popularity`（装的是累计观看 / 点赞） | `stats.totalViewers` / `stats.likes` |
| 直播卡 `live.area`、`stats.area` | `live.category`；`stats.area` 删 |
| 直播中 `stats.popularity`、`stats.fans`、`stats.fansChanged`、`stats.hasFansChanged` | `stats.currentViewers`、`stats.followers`、`stats.followersDelta`、`stats.hasFollowersDelta` |
| `video.desc` | `video.description`；`video.duration` 装排好版的文字；`danmaku` 保留 |
| `dynamic.type` | 删；用 `hasVideo` / `hasImages` / `hasRepost` |
| `sc.*` / `guard.*` | `superchat.*` / `membership.{ program, tier, rank?, icon?, text, months?, gift? }` |
| 锐评榜单卡的 `master.name`（恒为空串） | 删 |
| `live.title` / `live.time` / `live.description` / `live.cover` / `live.hasCover` / `live.isStreaming` / `live.isEnded`，`video.title` / `video.cover` / `video.views` | 不变 |

老卡片皮肤不适配：皮肤包 schemaVersion 抬版、旧包拒收，卡片只用按 1.0 契约新生成的皮肤。迁移怎么处理老指针见 [data-and-migration.md](./data-and-migration.md)。界面皮肤不受影响。

## 配置

主人填的设置只有一个文件 `config/settings.json`，分段存。每段的 schema 由归属方定义，核心组合成最终 schema。`defaults` 只表示「按订阅覆盖时的回退层」：订阅上能覆盖的才放进去，覆盖不了的一律挤出去。

```ts
interface Settings {
  core: {
    master: { targetId?: string };    // 主人目标必须是私聊目标（schema 校验；面板下拉只列私聊）
    defaults: GlobalDefaults;         // 按订阅覆盖的回退层，订阅上的覆盖与它同形
    templatesSeen: TemplatesSeen;     // 出厂文案账本（原 defaults.templateDefaultsSeen）
    ai: AiSettings;                   // profiles、activeProfileId、search.scenes、聊天、thinking{ enabled, level }、hasVision；人格与提示词只在 presets[] 里一处
    rankingReport: RankingReport;     // 原全局 roastSchedule（榜单周报）：targetIds、windowDays、requiresApproval
    muteEndsAt?: string;              // 原 mutedUntil；没在静音就缺键
    commands: CommandConfig;
    linkCards: LinkCardsConfig;       // base{ enabled, replyForm }、byTarget（键是目标 id）
    accounts: { order: SourceKey[] }; // 头部显示顺序
    onboarding: { isSkipped?: boolean };
    update: UpdateSettings;           // isAutoDownloadEnabled 等
    marketplace: MarketplaceSettings;
    logging: { level; levels; retentionDays; memoryLog: { enabled } };   // levels 是开放键：核心模块 + bilibili + 拓展 id
    history: { retentionDays };
    profileRefreshCron: string;       // 资料刷新，由 fansCron 原值迁来
    timezone: string;                 // 卡片时间读它，默认 Asia/Shanghai
  };
  bilibili: { dynamicCron; userAgent?; loginCheckIntervalMinutes };   // 由 bilibili/ 定义
  extensions: Record<ExtensionId, { enabled: boolean; settings?: unknown }>;   // settings 由拓展自己的 zod 校验
}

interface GlobalDefaults {
  features: FeatureFlags;
  filters: ContentFilters;            // 只放作品过滤（block* / allow*）
  templates: { post; postVideo; membership: Record<string, MembershipTemplate>; … };
  wordcloud: { stopWords: string[] };
  quietHours: { startHour: number; endHour: number }[];
  liveEnd: { grace: { enabled: boolean; waitSec: number } };
  superchat: { minAmount?: number };
  membership: { minRank?: Record<string, number> };
  ai: { presetId?: string };          // 订阅能覆盖的只有人格预设
  cards: { enabled: boolean; byKind; liveCoverImageIds: string[] };
  cardSkin; cardSkinKnobs;
  imageGroup: { enabled; mergeForward; … };
}
```

| 段 | 校验不过 | 谁能读 |
| --- | --- | --- |
| `core` | BN 起不来 | 核心 |
| `bilibili` | BN 起不来 | 只有 `bilibili/`（守卫拦核心读它） |
| `extensions.<id>` | 只停那一个拓展，面板卡片显示「设置不合法」 | 宿主与那个拓展；卸载删掉这一段 |

- **并发**：所有写入排在同一条队列里；拓展设置用内容哈希做版本号，对不上回 409；面板普通保存在队里深合并。
- **过滤**：`blockReposts` / `blockArticles` / `blockImages` / `blockVideos` 看 `Post` 上「有没有」，在装配第一步、对所有来源生效。白名单 `allowKeywords` / `allowRegex` 对 `blockKeywords` / `blockRegex`。特别关注去掉 uid 正则，template 死字段退役。SC 与会员的门槛不在 filters 里。
- **主人通知**：推送层只有一个 `notifyMaster(text)`（合掉 `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg`）；出口上的 `sendPrivate` 与「强制私聊」标志删掉，因为主人要是选了群目标，强制私聊会把群号当 QQ 号错投。私聊的要求挪到选主人目标时：`master.targetId` 必须指向私聊目标；迁移时指向群目标的清空，首访页提示重选。
- **图集推送行为** `imageGroup`（全局与逐订阅）只作用于 `Post.images`，子键 `imageGroup.mergeForward`。
- **模板变量**：`{noun}` 取自 `descriptor.postNoun`，默认文案「{name}发布了一条{noun}」；人名变量统一 `{name}` / `{viewer}`；直播文案的 `-key` 写法统一成 `{key}`，全仓只有一个模板引擎 `interpolate`。

### 连接与目标

`connections.json` 回答「用谁发」，一条连接就是一个 bot（OneBot http / ws / 反向 ws、Webhook、QQ 官方机器人、拓展借来的 bot）。`targets.json` 回答「发到哪」。订阅按目标 id 引用。

```ts
type PushTarget =
  | { kind: "session"; id: string; connectionId: string; platform: string; scope: "group" | "private"; address: string }
  | { kind: "endpoint"; id: string; connectionId: string; platform: string; managedBy?: "connection" };   // Webhook 这种连接本身就是终点
```

`platform` 在核心里只指推送 / 聊天平台；订阅来源的平台名叫 `sourceLabel`。

### 凭据字段标 `secret: true`

- 凭据字段在 schema 上标 `secret: true`，与拓展设置字段同一写法。面板打码与备份脱敏都读这个标记，不再按键名猜。
- 下发给面板只有一种打码：契约里的 `MaskedSecret`，固定 8 个点，≥24 字符才露头尾各 4 位。带着打码对象写回一律 400；面板保存时没动过的密钥格不进 PATCH。AI apiKey 的哨兵字符串退役。
- Webhook 的 `url` 算凭据（token 常在路径里）。OneBot 的 `baseUrl` / ws 地址面板照常显示，备份里照旧抹掉。
- 密钥放哪：AI key 在 `secrets/config-secrets.enc`；B 站 cookie 在 `secrets/bilibili/`；拓展凭据走 `ctx.secrets`，在 `secrets/extensions/<id>/`。

## 数字、时间与「不知道」

- **计数排版只有一份** `formatCount`（internal），带正负号的变体也在里面。口径照搬卡片现有的：万和亿都一位小数、保留「.0」、万以下不加千分位；统计表「百万以上取整」是同一函数的紧凑档。统计图轴刻度另有 `formatAxisTick`。
- **直播人数传精确数**。B 站存 WATCHED_CHANGE 帧里的 num；「1.2万」的解析只在迁移模块。文字模板的 `{watched}` 缺数时，文字渲染器在出口印「暂未获取到」。
- **时长只有一种写法** `formatDuration(start, end)`，写成「2小时13分5秒」。按秒数排时钟格式的另叫 `formatClock`。
- **进门换 ISO**：拓展契约的毫秒时刻、签名清单的秒、B 站不带时区的 `live_time`（北京时间），都在进门处换成 ISO。
- **不知道就缺键**：外部数据不知道就不写这个键（`mutedUntil: 0`、内置皮肤的 `updatedAt: 0` 也改成缺键）。只有位置固定的格子（数组、表格）用 `null`。出口不受约束：给皮肤的排好版文字缺了就是空串。头像、bio 都是可选，渲染器缺了显示首字。这条不加守卫，靠审查。

## 改名对照

量大但都是机械替换，每批改完 grep 旧名必须为零。盘上有的键归迁移模块（见 [data-and-migration.md](./data-and-migration.md)「迁移步骤」）。特性键、推送种类、皮肤字段见上文。

**人：up / author / master 统一叫 creator。** 之后 `author` 只指皮肤或拓展的作者，`master` 只指「主人」。

| 以前 | 现在 |
| --- | --- |
| `UpCard`、`UpDialog`、`pages/up/`、`UpStatsRow`、`UpMeta`、`upColor` / `UP_COLORS`、`upName` | `CreatorCard`、`CreatorDialog`、`pages/creator/`、`CreatorStatsRow`、`CreatorMeta`、`creatorColor` / `CREATOR_COLORS`、`creatorName` |
| `UpColorIdentity`、`colorFromUid` | 并进身份判别联合、`colorFromSeed` |
| `SubscriptionAuthor` / `AuthorSchema`；拓展契约里的 `author` | `SubscriptionCreator` / `CreatorSchema`；`creator` |
| `UpDynamicEvent` / `appendDynamic` / `listDynamics` | `PostRecord` / `appendPost` / `listPosts` |
| `AUTHOR_FIELDS`、挂点 `masterAvatar` / `masterName` | `CREATOR_FIELDS`、`creatorAvatar` / `creatorName` |
| 直播内部 `MasterInfo` / `masterInfo` / `masterName` / `masterAvatarUrl` / `LiveMasterFeature` / `getMasterInfo` | `CreatorInfo` / `creatorInfo` / `creatorName` / `creatorAvatar` / `LiveCreatorFeature` / `getCreatorInfo` |
| AI 视图的 `uname`；历史行 `unameSnapshot` / `uavatarSnapshot` | `name`；`nameSnapshot` / `avatarSnapshot` |
| 订阅来源的平台名 `platform`（AI 视图、锐评对象） | `sourceLabel` |

**数据字段与平台词。**

| 以前 | 现在 |
| --- | --- |
| `desc` / `descChars`、`area` / `areaName`、`sign`、`isVip`、`price` / `priceValue` | `description` / `descriptionChars`、`category`、`bio`、`isPremium`、`amount` + `currency` |
| 此刻在线义的 `online` / `viewers` | `currentViewers` |
| 累计义的 `watchedNum` / `viewers` / `peakViewers` / `avgPeakViewers` | `totalViewers` / `maxViewers` / `avgViewers`（同名两义，按含义分开改） |
| fans 整族：`fans`、`fansChanged`、`FansStore` / `FansSample` / `FansRefreshEntry` / `FansResponse`、`/api/fans`、`fans-refreshed` | `followers`、`followersDelta`、`Followers…`、`/api/followers`、`followers-refreshed` |
| dynamic 整族：`DynamicCounts` / `countDynamics`、`dynamicEnabled`、面板 `DynamicMsg…`、`broadcastOptsForDynamicKind`、AI 视图 `dynamic?` | `PostCounts` / `countPosts`、`postEnabled`、`PostMsg…`、`broadcastOptionsForPostKind`、`post?` |
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
| AI 配置 `dynamicPrompt`、`presets[].dynamicPrompt`、`search.engines.dynamic`、AiScene 的 `dynamic` | `postPrompt`、`presets[].postPrompt`、`search.scenes.post`、`post` |
| `linkParsing`、`LinkParser` | `linkCards`、`LinkResolver` |
| `templates.wordcloudStopWords` | `defaults.wordcloud.stopWords` |
| `fansCron` | `core.profileRefreshCron`（原值迁来） |
| 日志级别键 `dynamic` / `live` | 并成 `bilibili`，键改成开放的 |
| `restartPush`、`pushTime` | `liveStart.catchUpOnBoot`、`liveStreaming.streamingIntervalHours` |
| bootstrap 的 `cookieEncryptionKey` / `BN_COOKIE_KEY` / `--cookie-key`（实际是所有密钥的主密钥） | 中立名（如 `secretsPassphrase`，名字施工时定），yaml、环境变量、命令行三处同步改；旧名永远继续认，新旧同设且值不同就拒绝启动；两份 BootstrapConfigSchema 合一、按可选处理 |
| `chromeIdleSeconds` / `BN_CHROME_IDLE_SECONDS` / `--chrome-idle-seconds` | `chromeIdleSec` / `BN_CHROME_IDLE_SEC` / `--chrome-idle-sec`，旧名永远继续认 |
| bootstrap 的 `preset.pushTargets`（零读取） | 删掉。其余 bootstrap 名字不动；冻住的桌面壳放行的 5 个环境变量、镜像写死的 5 个永不改名 |

**接口、模块与其他。**

| 以前 | 现在 |
| --- | --- |
| `Source`、暂定名 `fetchLiveStreaming` | `SubscriptionSource`、`fetchLiveStatus` |
| `registerPushSource` / `PushSourceHandle` / `PushExtensionDef`（字段 `adapter`）；`PlatformAdapter`、`AdapterRegistry`、`platforms/` | `registerPushOutlet` / `PushOutletHandle` / `PushOutletDef`（字段 `outlet`）；`PushOutlet`、`PushOutletRegistry`、`outlets/`；`PlatformDialect` / `Connector` 的新名施工时定 |
| `NotificationSink` | `TargetDispatcher` |
| `BilibiliPush` / `bilibili-push.ts` / `BilibiliPushOptions` | `PushRouter` / `push-router.ts` / `PushRouterOptions` |
| `BiliEvents`；事件 `source-auth-changed` / `live-session` / `live-viewers` | `BusEvents`；`subscription-auth-changed` / `live-session-changed` / `live-viewers-changed` |
| `ExtensionLiveSession`、`fansAtStart`、场次上的 `totalViewers` | `LiveSession`、`followersAtStart`、`peakTotalViewers` |
| `SubRuntimeStore`、`SubAvatarStore`、`subId` 系、`/api/subs` | `SubscriptionStateStore`（与 `SubscriptionState`、`subscription-state.json` 同一个词）、头像库删掉并进图库、`subscriptionId` 系、`/api/subscriptions` |
| `identityOf`（草案名） | `subscriptionIdentityOf` |
| 会员 `tiers: "dynamic"`（草案名）；`DynamicPushPart` | `tiers: "custom"`；`PostPushPart`（`post` / `post-images`） |
| 错误体 `{ error, message }`、`{ ok: false, err }` | `{ code, message }`、`{ ok: false, code, message }` |
| `AIOverride` / `AISettings` / `AIScene` / `APIFlavorId`；`WordCloud` / `wordCloud` / `Wordcloud` | `Ai…` / `Api…`；`WordCloud` / `wordCloud`（特性键仍是 `wordcloud`） |
| `formatWan` / `formatSignedWan` / `formatAxisWan`；`pigeon` / `diligent` | 并进 `formatCount`、`formatAxisTick`；`leastActive` / `mostActive`（连同提示词与草稿） |
| `DailyHistoryCount.d`、`Opts`、`Img`、`normaliseAvatarUrl` | `day`、`Options`、`Image`、`normalizeAvatarUrl` |
| `HistoryPatch.patch`、`PickCardBackground`、table 积木的 `count` | `rowId`、`PickLiveCover`、`showCount` |
| 两个 `createSerialGate` | `createSerialQueue`（串行队列）、`createRenderGate`（渲染闸） |
| `PushLike`、`SubItemView`（动态、直播、AI 各一份） | 各合成一份；推送出口收成 `broadcast(subscriptionId, messages, kind)` |
| 拓展积木 `qrLogin` | 删掉 |

**订阅与来源（09-27 字段名专项审查）。**

| 以前 | 现在 |
| --- | --- |
| `Identity` 判别联合 `{ kind, uid }` / `{ kind, extensionId, externalId }`；`SourceKey` 的 `ext:<id>`；`sourceKeyOf` | `{ sourceKey, externalId }`；`bilibili` 或拓展 id，不加前缀；读 `identity.sourceKey` |
| `SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription`；`EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX` | 删掉，按 `sourceKey` 判；`EXTERNAL_ID_MAX` |
| 拓展契约 `lookup` / `lookupPlaceholder`；草案的 `lookupCreator`；`/api/subs/search` 与 `/api/subs/lookup`；候选 `ExtensionSubscriptionCandidate{ id, avatar, fans }`、面板 `UpProfileLookup` / `SearchResponse` | `searchCreators` / `searchPlaceholder`；删掉（用 `fetchProfile`）；`GET /api/sources/:sourceKey/creators?q=`；`CreatorCandidate`，面板本地类型删掉 |
| `ExtensionOwnSubscription{ id, externalId, enabled }` | `SourceSubscription{ externalId, features }`（只列启用中） |
| `reportSubscriptionsChanged` | 删掉（关注同步是 BN → B 站单向） |
| `PostEvent.id`；`reportPost(externalId, SubscriptionPost)`、`reportLiveStart` / `End` / `Status`；上报种类五种 | `postId`；`reportPost(externalId, PostReport)`、`reportLive(externalId, LiveSignalReport)`；收成 `post` / `live` / `profile` |
| `ctx.report("problem" / "problem-resolved")` 与 `level`；`SubscriptionState.problem` | `reportProblem` / `resolveProblem` 与 `notify?: boolean`；`problems` 按 code 做键 |
| `SourceAuth.secrets{ export, import, redactPatterns }` | 删掉；临时凭据用 `ctx.redact(value)` |
| `descriptor.features` / `extras`；清单 `display{ … }` + `events` | `supportedFeatures` / `supportedExtras`；摊平成 descriptor 同名字段，删 `SUBSCRIPTION_EVENT_FEATURES` |
| `ExtensionDTO.reportProblems` 这一族 | `reportRejections` / `ReportRejectionView` / `extension-report-rejections-changed`（上报被拒，与来源自报的问题分开） |
| `LiveStatusResult.state`、`"ended"`、`reason` | `type`、`"offline"`、`code` + `message` |
| `trigger: "signal" / "status"`；`status()`；`onSubscriptionAdded(sub)`；`LiveSession.last` | `"start-signal" / "status-signal"`；`health()`；删掉（与 `onSubscriptionsChanged` 重复）；`lastDetails` |
| ⚠️ 面板在播列表 `LiveListenerSnapshot.viewers`（装的是累计观看的排版字符串「1.2万」） | `totalViewers: number`，**不是** `currentViewers` |
| ⚠️ `upstream_failed` 错误体里占着 `code` 的 B 站数字码 | `upstreamCode` |
| `LiveSessionRecord.peakViewers`；统计帧 `{ k, ts, peak }`；`UpStatsRow.archives` / `dynamics`；`FansSample.value` | `peakTotalViewers`；`{ type, occurredAt, peakTotalViewers }`；`videoPosts` / `posts`；`followers` |
| 在播表 `LiveListeningEntry` 两支；`attachBiliStatsSource` / `attachExtensionStatsSource` | 一个形状 `{ subscriptionId, identity, isLive, title?, category?, startedAt?, totalViewers? }`；`bindStatsRecorder` |
| 面板 `SubscriptionPlatform` / `subscriptionPlatformOf`、`BILI_PLATFORM`、`SubscriptionLookup`、`absent` | `SourceDescriptor` / `descriptorOf(sourceKey)`、`sourceKey`、`SubscriptionIndex`、`isAbsent` |
| 历史行推送种类那格 `kind`；`AuthState` 的 `loggedOut` / `awaitingScan` / `loggedIn` | `feature`；`logged-out` / `awaiting-scan` / `logged-in` |

**推送（09-27 字段名专项审查）。**

| 以前 | 现在 |
| --- | --- |
| 订阅顶层 `extras`（按目标的三态表） | `extraTargets` |
| `retryOf` / `HistoryRetryMessage`（人工重推） | `repushOf` / `HistoryRepushMessage` |
| 连接 `testStatus`；`ProbeResult.ok: boolean \| null`；目标 `testStatus.lastCheckedAt` | `probeStatus`；三态 `status`；`reachability.changedAt` |
| endpoint 目标的 `scope: "channel"`；OneBot 的 `config.transport` | 删掉（通用 webhook 对外 JSON 照写常量）；删掉（和 connector 重复） |
| `POST /api/connections/:id/test`；`/api/push/test`；`TestResponse` 与 `TestPushResponse` | `/probe`；`/api/targets/:id/test`；合成一个 |
| `TargetPlatformSchema`；`isConnectionOn`；拓展契约 `listBots` / `ExtensionBotView` / `boundTo` | `OpenPlatformSchema`；`isDirectConnectionOn`；连接候选 / `boundConnectionId` |
| 重推原件 `DraftSchema` / `DRAFT_GONE`、`v`、`own`；`HistoryEntry`；`HistoryRecordInput.target`；`countsAsDelivery`；`PushMessageRole` 与 `HistoryMessageRole` | `RepushOriginal`、`version`、`isOwnCopy`；`HistoryRow`；`targetId`；改成名副其实的名字（施工时定）；合成一个 |
| `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg`；出口 `sendPrivate` 与 `{ private: true }` | `notifyMaster(text)`；删掉 |
| 载荷 kind `"forward-images"`；小程序卡 `picUrl` / `path`；判别键 kind 与 type 混用；`synthetic`；`InboundSinks`；入站 `groupId` / `userId`；`QQDiscoveredEntry.openid` | `"image-group"`；`imageUrl` / `pagePath`（桥帧照旧，outlet 映射）；统一 `kind`；`isSynthetic`；`InboundHandlers`；address；`address` |
| WS 频道 `push-events`；测试推送种类 `dyn` / `sc` / `guard`；失败原因 `reason` / `err` / `why`、重推结果判别键 `can`；两级 `ConnectionCapabilitiesMap`；`muted` / `allowAtAll`；`mutedUntil` | 名副其实的名字（施工时定）；特性键；`code` + `message`、`ok`；收成一级；带 is 前缀（施工时定名）；`muteEndsAt` |

**配置（09-27 字段名专项审查）。**

| 以前 | 现在 |
| --- | --- |
| 全局 `roastSchedule` 及 `targets` / `days` / `approval` | `core.rankingReport` 及 `targetIds` / `windowDays` / `requiresApproval` |
| `app.logLevel` / `logLevels` / `logRetentionDays` / `memoryLog`；`app.historyRetentionDays`；`app.timezone`；`app.healthCheckMinutes` | `core.logging.{ level, levels, retentionDays, memoryLog.enabled }`；`core.history.retentionDays`；`core.timezone`；`bilibili.loginCheckIntervalMinutes` |
| `update.autoDownload`；`onboarding.skipped` | `update.isAutoDownloadEnabled`；`onboarding.isSkipped` |
| `schedule.quietHours`（`start` / `end`）；`schedule.liveEndGrace*`；`filters.minScPrice` / `minGuardLevel` | `defaults.quietHours`（`startHour` / `endHour`）；`defaults.liveEnd.grace{ enabled, waitSec }`；`defaults.superchat.minAmount` / `defaults.membership.minRank` |
| `cardStyle` / `cardStyleByKind` / `liveCoverImages`；退役的 `font` / `fontAsset` / `glass*` | `defaults.cards` / `cards.byKind` / `liveCoverImageIds`；从 schema 删掉 |
| `linkParsing.defaults` / `.parse` / `.form` / `.groups` | `linkCards.base` / `base.enabled` / `base.replyForm` / `byTarget` |
| `defaults.ai` 的 `providers` / `activeProfile`、`search.engines`、`enableThinking` + `thinkingLevel`、`enableVision`；`activePreset` 与 `overrides.ai.preset`；顶层 `persona` / 提示词；`defaults.templateDefaultsSeen` | `core.ai.profiles` / `activeProfileId`、`search.scenes`、`thinking{ enabled, level }`、`hasVision`；`defaults.ai.presetId`；只在 `presets[]` 里一处；`core.templatesSeen` |
| `messageLayout.version`；面板标签键的裸叶子键、`app.*` 前缀、`ai.persona.*` 死条目 | 退役；写全路径、按新分段换前缀、删死条目 |

**服务端命名约定**：`create*` 造对象，`bind*` 挂到总线并返回可释放对象，`start*` 起定时或循环；入参一律叫 `XxxOptions`；存储一律是接口加 `create`。现存 24 个 `*Deps`、4 个 `attach*`、5 个 `make*` 全改。面板的类型门面别名删掉，用本名。

**明确不改**：见 [architecture.md](./architecture.md)「明确不改的」。
