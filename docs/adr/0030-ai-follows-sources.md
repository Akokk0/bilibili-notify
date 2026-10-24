# ADR-0030：AI 跟着来源走 —— 工具参数、技能、看图与提示词

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）。**未施工**。
- **记录方式**：拷问当场落的定案。工具表与迁移条目的正本在 [docs/1.0/](../1.0/)；本份只写定了什么、为什么、否了什么。
- **影响面**：`packages/ai`（工具、点评、看图）、内置技能、聊天路由与会话存储、锐评与人格预设、`apps/web` 的聊天与工具显示。
- **依赖**：[ADR-0021](0021-neutral-core.md)、[ADR-0027](0027-monitoring-stats-and-descriptor-driven-panel.md)（叫法规矩、统计仓）、[ADR-0022](0022-data-generations-and-migration.md)（图库与素材库）。

## 背景

核心 AI 工具的参数是 `uid`，六个内置技能写死「UP 主」「B 站」；看图时 `packages/ai` 自己读磁盘；聊天附件存在 `ai/` 下自己的目录；人格预设、锐评、卡片工坊的提示词里平台叫法写死了 44 处。

## 决策

1. **AI 工具与技能**：
    - 中立工具的参数统一叫 `creator`，值是「来源键:外部 id」（按第一个冒号切）；核心工具参数里不许出现 `uid`。`list_subscriptions` 与 `search_creators` 的返回带着它。
    - 中立工具加第六把 `get_creator_stats(creator, days?)`，读统计仓；`search_creators(source, query)`；`get_creator_posts` 读统计仓最近几条。
    - 六个内置技能全部跨来源、只用中立工具；`find-up` → `find-creator`、`up-pk` → `creator-pk`，旧名留别名。
    - B 站独有的数据（总播放、获赞、视频列表）由 B 站的 `AiToolProvider` 登记只读工具，B 站版的周报由 B 站自己以技能提供。
    - 🔗 2026-10-23（3b-34，主人定；B 站这一段 34-3 落成后）：**工具提供方的登记与命名空间**。来源在 `start(ctx)` 里经 `SourceContext.registerAiToolProvider(provider)` 登记，键取来源键，来源停下时自动撤；登记表是 `apps/server/src/ai/tool-provider-registry.ts` 的 `createAiToolProviderRegistry`，挂在 `AppRuntime.aiToolProviders`。提供方只起本名，宿主统一加命名空间，模型与技能看到的全名是 `<命名空间>__<本名>`，命名空间 = 来源键里 `[A-Za-z0-9_-]` 以外的字符换成 `_`（`acme.douyin` 的 `get_videos` → `acme_douyin__get_videos`）；本名非法、同组重名、全名超 64 或命名空间相撞时登记即抛。B 站两把搬进 `apps/server/src/bilibili/ai-tools.ts`，由 `createBiliAiToolProvider` 交来源登记：`get_up_totals`（原 `get_user_stats`）与 `get_up_videos`（原 `get_user_videos`），全名分别为 `bilibili__get_up_totals` / `bilibili__get_up_videos`，参数都收 `creator`；来源键不是 B 站或外部 id 不合格式回 `invalid`，失败码走 B 站的翻译表。
    - `AiTool` 加 `label` 与参数标签，面板读下发的，不再写死一张表。
    - 🔗 2026-10-14（3b-33，主人定）：**来源的 `searchCreators` 这一期造、B 站实现、只给 AI 的搜人工具用**；`GET /api/sources/:sourceKey/creators` 与面板仍第 4 期。
    - 🔗 2026-10-14（3b-53，主人定；落细处主会话照规矩定）：**技能改名不再有迁移改写**。0.x 升 1.0 时 `maid-skills/` 与女仆对话都不带进新代（见 ADR-0022 的 🔗），所以 `find-up` → `find-creator`、`up-pk` → `creator-pk` 没有旧数据要改写；内置技能改名后旧的斜杠名照上面「旧名留别名」。技能里写了查不到的工具名记一条 warn；主人自建技能撞上内置新名，照今天的规矩（读不进来、说明原因，不删不改）。
    - 🔗 2026-10-15（3b-33，主人定）：**`get_creator_profile` 对没订阅的人也查得到**。资料缓存里没有这个人时，回落调一次来源的 `fetchProfile`（3b-24 造，在那之前先答查不到），交名字、粉丝数、简介；等级、视频数这类 B 站独有的不带（中立的资料与搜人候选里本来就没有这两格，不为它们改契约）。今天的 `get_user_info` 对任意 UID 都能查，内置技能「找 UP」「UP 主 PK」靠它查没订阅的人；照「读缓存类工具对没订阅的人答查不到」那一句改的话，这两个技能会废掉一半。其余读缓存类工具照旧只答订阅过的人。
    - 🔗 10-23（3b-24）：女仆资料回落已接上来源的 `fetchProfile`；订阅着的读资料缓存，没订阅的现查来源一次且不写缓存。
    - 🔗 2026-10-24（3b-35，主人定）：**提供方技能与技能读口落成**。`AiToolProvider.skills` 已造，提供方交本名，宿主加前缀 `<技能命名空间>-<本名>`；命名空间 = 来源键小写、非 `[a-z0-9]` 连续段换一个 `-`（首尾也去掉）。B 站版周报为 `/bilibili-weekly-report`，定义在 `apps/server/src/bilibili/weekly-report-skill.ts`。技能读口在 `apps/server/src/maid-skills/reader.ts`，列表路由、`load_skill` 目录与斜杠点名三处都经它：内置与提供方技能缺工具不列、点名拿不到，主人技能照列、照交集收窄、只记一条 warn（主人定）。`find-creator` / `creator-pk` 落成，旧名 `find-up` / `up-pk` 是别名（写在内置条目上、经 DTO 下发，不占名、不设期限，主人自建同名优先）。六条内置技能只用核心中立工具，没订阅的人只看得到资料。
2. **看图读图库**：点评与聊天传 `ImageRef`，宿主注入读图函数读字节、过大先缩、拼 data URL 放进请求；`packages/ai` 不碰磁盘；视觉副模型同路，工具返回的图也改 `ImageRef`。聊天附件存进图库（不是素材库），会话里存 `ImageRef`，图库清扫把会话算作引用方；上传仍是单张 5MB、每条 4 张、拒 SVG。
    🔗 **2026-10-04**（⑳b 已落）：上传层再加一条不收 gif（图库本身收），格式一律按字节嗅探、不信客户端声明的类型；上传回的 `id` 就是 `ImageRef`，读走图库的 `/api/images/<ref>`，旧的 `/api/ai/assets/:id` 读口退役；删会话不再直接删图，没人引用的图由清扫收走。
    🔗 **2026-10-14**（3b-53，主人定）：聊天附件存进图库、会话里存 `ImageRef` 这一半只对 1.0 起新开的会话成立；0.x 的女仆对话不迁（见 ADR-0022 决策 4 下的 🔗），所以没有旧会话附件要进图库。
3. **提示词跟着来源叫**：内置人格、卡片工坊、锐评、内置技能与工具说明里的平台叫法改用 `{creatorNoun}`、`{postNoun}`、`{sources}`，调用时由核心按这次涉及的订阅填（叫法规矩同 ADR-0027 决策 6）；主人自己写的不改写，内置预设改版照旧亮「默认文案有更新」；风格性的写法（「B 站弹幕解说员」「B 站梗」）改成中性。
    - 🔗 2026-10-14（3b-35，主人定）：**来源描述的 `creatorNoun` 与 contract 里的叫法函数这一期（3b）造，提示词按本条全做**；面板上的叫法仍第 4 期。
    - 🔗 2026-10-24（3b-35，主人定）：**叫法落成**。`SourceDescriptor.creatorNoun`（B 站「UP主」）；contract `sourceNounsOf(platforms, neutral)` 只管挑，中性词由调用方按读者递 —— 给人看的从服务端字典 `nouns.*` 取，给模型的用 `packages/ai` 的 `PROMPT_NEUTRAL_NOUNS`（叫法规矩第 4 条同改）。服务端按来源键取叫法的是 `subscriptions/platform-label.ts` 的 `sourceNounsFor`（不给键 = 全部启用订阅的来源，一个都没有取在册来源），路由侧共用 `ai/prompt-nouns.ts` 的 `promptNounsOf`；人格、核心工具说明、锐评、两个工坊、内置技能、设置里的内置人格（`BUILTIN_AI_PRESETS`）都按这次涉及的来源填。推送点评与下播总结按那条订阅、榜单锐评按上榜那批、聊天 / 试一句 / 工坊 / 内置技能按全局；风格性写法改中性。内置人格默认文案变了，零代迁移修订号 49 → 50（主人批）。「勤奋 UP」这个称号跟着面板与推送正文，等第 4 期面板叫法。
    - 🔗 2026-10-24（3b-12，主人定）：**上一条里「内置预设改版照旧亮『默认文案有更新』」作废**。内置人格按语言各一份，内容每次按当前语言从 `@bilibili-notify/internal/builtin-texts` 的 `builtinPresetsFor(locale)` 取，不存进设置；改版与换语言都直接跟上，设置只记 `ai.removedBuiltinPresets`（缺 = 一份没删）与主人自建的 `ai.presets`。主人自己写的提示词与从内置另存的副本不改写、不跟语言。

## 取代与修订的旧条款

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0022 决策 11「对话附件留在 `ai/`」 | 修订：进图库（仍不进素材库） | 2 |

## 明确不做

- **提示词全部改成中性词**：只订 B 站的主人会听到女仆说「创作者」，味道变了。
- **聊天附件先进素材库**：素材库只收主人主动上传、要反复挑来用的东西。

## 后果

- 主人自己改过的提示词里若写着「UP 主」，不会被自动改写。
