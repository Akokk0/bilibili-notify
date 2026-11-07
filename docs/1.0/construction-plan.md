# 1.0 施工计划

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023，以及 ADR-0024 ～ 0031。

分几期、每期做什么、期间守什么规矩、中立性守卫哪一期开哪一期清零、第 1 期怎么切片、分支怎么走、alpha 怎么发，以及还没进表的零碎施工项、施工中顺手修的现存毛病和以后再说的事。要做成什么样见 [architecture.md](./architecture.md)、[data-model.md](./data-model.md)、[data-and-migration.md](./data-and-migration.md)、[subscription-sources.md](./subscription-sources.md)、[extension-contract.md](./extension-contract.md)、[push.md](./push.md)。

## 一句话

**在 `dev` 上一期一期做（10-06 前在 `dev-next`，见「分支与发 alpha」），每期全量门禁全绿才进下一期；先发 1.0 alpha，稳定后升到 1.0.0。**

## 纪律

- **不整体重写，以改造为主**（ADR-0021 决策 58）：某个模块的核心逻辑从头到尾是 B 站的形状、改造要动每一行时，才对着中立接口局部重写，旧测试当规格书；其余一律改造。分期表「方式」一列就是按这条判的；施工中逐模块按同一判据定，不另起整体重写。
- 每一片跑完整门禁再提交。
- 每期（3a、3b 分开算）全量门禁全绿才进下一期。
- 3a 完成即检查点：B 站的作品全经中立接口运行、行为不变，直播在 3a 只是外壳、3b 才真正并过来（10-07 主人定，见 [phase-3a-plan.md](./phase-3a-plan.md)）；守卫 21b「进程内中立性对拍」绿。
- 中立性守卫分三层（咽喉、静态扫描、对拍，ADR-0021 决策 59；判据与范围见 architecture「守卫」），每一道哪一期开、哪一期清零见下面「中立性守卫的归期」。棘轮守卫的规矩：开启那一刻记下命中数当上限，只许少不许多，多一处就红，上限随清理调低，到它清零的那一期结束必须是 0（不能「一开就红」：每期都得全绿才出期）。
- 哪一期改了盘上形状，就在同一期往迁移模块加条目、钉进守卫 13 的清单；不留到最后统一补。第 1 期只建迁移地基。
- 新写或重写的代码直接用新名，第 5 期只清扫没被动到的旧名。
- 新写或重写的接口方法与路由，失败直接按 ADR-0026 的结果形状与标准码写。

## 分期

规模以「④′ 轮」计（④′：约 5 小时、26 个提交、116 个文件）。原估 12–14 轮，第二轮拷问加了数据代、接口拆分与命名批，第三轮又加了推送侧中立化、集成与三层守卫，总量施工时重估，不含真机验收。

| 期 | 做什么 | 方式 | 出期条件 | 规模（④′ 轮） |
| --- | --- | --- | --- | --- |
| 0 ✅ | 测试拦外网（守卫 2，`scripts/network-guard.mjs`）；09-29 补上 DNS 查询（抓图拦内网要先解析，不补就漏；抓图 10-03 挪进 3a） | 改造 | 已落 | 0.2 |
| 1 ✅ | 地基：身份、持久化底层与关停、资产与皮肤存储合一；**迁移地基**（数据代、先 listen 再迁、只迁一次各代互不干涉、首访页、全新开始、订阅合一、设置分段）；迁移耗时测试。切片 ①–⑨ 见下 | 持久化局部重写，其余改造 | 迁移耗时测试绿 | 施工时重估 |
| 2 ✅ | 数据模型：作品卡与直播卡、**抽 `packages/http`**（请求客户端、cookie 罐、浏览器身份，从 B 站的实现里抽出，抽出去的直接按 naming.md 起名）、图库与图库引用（抓图服务原在本期、建在 `packages/http` 上，10-03 随调用方并进 3a）、皮肤字段、特性键；新类型直接用新名。并入：`LiveCardInput` 人数只收精确数；`formatCount` 带符号变体、`formatAgo`、`formatDuration`（连删 `{time}` 兜底与 `getTimeDifference` 钩子）；卡种中文名收一份；出图字节门按「批准的像素差清单」裁决（ADR-0028 决策 2）；⑥b 留在代里的三处过渡（`avatars/`、`history/img/`、`assets/chat/`）随图库并进 `images/`，目录表里那两个过渡键（`avatars`、`assets`；`history/img/` 是 `history` 键底下的子目录）随之删掉（`assets` 键 ⑳b、`avatars` 键 ⑳c 已删）；10-02 新定的推送历史拆两层、粉丝样本压缩、运行记录、统计总开关与存储占用、订阅标签也在本期。切片 ⑩–㉙ 见下 | 出卡前半段局部重写 | 守卫 10 清单外的差异为零；⑨ 迁移耗时测试在 ⑳ 与 ㉘ 之后仍绿 | 施工时重估（原估约 4，估于 `packages/http` 并入与 10-02 新增各项之前） |
| 3a ✅ | 接口先行：`Source` 与横切接口、登记表、`SourceContext`（建在 `IntegrationContext` 上：state / secrets / settings / http / report / fetchImage 挂上 ctx（🔗 现状 10-12：`http`、`fetchImage`、`storeImage` 没有挂上 ctx —— 请求客户端只有 B 站有、没进公共上下文，B 站来源经依赖拿抓图服务，ctx 上没有调用方；留到 3b 契约第 3 版，见「以后再说」；`settings` 只造在 `SourceContext` 上，`reportProblem` 同；`IntegrationContext` 今天是 `logger` / `signal` / `onDispose` / `state` / `secrets`）；`reportProblem` 进全在内存的问题表，ADR-0025 决策 11）；抓图服务（`fetchImage` / `storeImage` 的本体）、出图器零联网、舰长图标改本地资产（原第 2 期 ⑯ ㉕ 与 ㉓ 那半，10-03 并进，施工备注见第 2 期表下「⑯ 并进 3a」）；B 站四个包搬进 `bilibili/`（`blive` 不单开子目录，直接并进 `bilibili/live/`，10-05 主人定，ADR-0021 决策 1 的 🔗；先纯搬、只改 import 路径；紧接着单独一个提交按 naming.md 改名，含词表、外部接口回应的起名、原字段名只留在回应上；再做中立化） 并实现，中立部分同时拆进 `posts/` 与 `live/`；`bilibili/auth/`（3a-29 B 站半已落：登录系统搬进去，`SourceAuth` 挂到 `Source.auth`）与 `accounts/`（3a-29 没造，连同账号排序推到第 4 期，见「以后再说」）；B 站的报错按因果分层重写（未登录 → 风控 → 各项请求失败，只报最上面那条开着的、按状态报、开机就没登录也报，今天直播引擎、直播会话、动态引擎各自私聊的旁路删掉；带 `notify` 的问题清掉时由核心补一句「已恢复」，只对真私聊过的，ADR-0025 决策 11 下 10-03 的 🔗；✅ 3a-30 已落（10-11）：问题表、`GET /api/problems`、`problems-changed`、问题通知器与 B 站分层上报器都在，三个引擎的私聊旁路与 `masterTellers` 删了，两处偏离 ADR 字面（只有登录失效私聊；「已恢复」改成每条问题自带说法）见 ADR-0025 决策 11 下的 🔗，面板不动，记录见 [phase-3a-plan.md](./phase-3a-plan.md) 的「3a-30 已落」）；设置坏了只停那一处（集成段只停那个集成，`core` 段逐格退默认；✅ 3a-39 已落（10-11）：`core` 段逐格退默认并进问题表，`bilibili` 设置哪格坏停哪样而不是停整个集成，拓展设置文件不是合法 JSON 只停那一个拓展，来源读设置的 `settings(schema)` 先只造在 `SourceContext` 上，记录见 [phase-3a-plan.md](./phase-3a-plan.md) 的「3a-39 已落」）。推送侧：`PlatformAdapter` 接口与登记表（登记即 `start`）、OneBot / QQ 官方机器人 / webhook 作为内置适配器登记并带模板候选、`/api/adapters`、连接与目标的新形状（连接 `adapterKey` / `settings` / `platformSnapshot`，目标删 `platform`）与迁移条目、`DeliveryResult` 改成结果形状，历史行的投递结果同片跟上（新行存带码的结果、盘上旧失败转 `unknown`，原 ⑱，10-03 挪来：格跟着来源动，盘上始终只有一种形状）；活的 `NotificationPayload` 改名（`forward-images` → `image-group`、段的判别键统一成 `kind`），连同重推原件里对应的迁移与守卫 13 那条加固（原件每种载荷都有去向），原 ⑱，10-03 挪来：原件存的就是活载荷的原样，两边一起改才不用新旧对照表；只有 `TargetDispatcher` 能发送（链接回复与指令回复改走 `sendToAddress`，`notifyMaster` 返回结果形状；主人目标只许指向私聊目标（ADR-0021 决策 57：schema 校验、面板下拉只列私聊目标、迁移时清空指向群目标的并记进 ⑧ 的首访数据）；咽喉 e2e 在本期就要驱动这几条路）。schema 标 `secret: true`、服务端按 `MaskedSecret` 下发。本期开的守卫见「中立性守卫的归期」 | 改造 | 检查点：B 站的作品全经中立接口运行、行为不变（直播 3a 只是外壳，10-07 定）；守卫 21b 绿；出图器零联网绿。切片见 [phase-3a-plan.md](./phase-3a-plan.md)。🔗 现状（10-12）：43 / 43 片落成；守卫 21b 已落（对拍 20 行加「这版不开」18 行逐行写明等哪一期，口径是主人 10-12 定的：接口上今天只有 5 个成员，其余随 3b 与第 4 期，名单里标 3b 的行 3b 出期时转成对拍）；守卫 12 清零（棘轮表是空的）、出图器零联网（3a-37 起）；**全量门禁与真机由主会话收口，待跑**。落成记录见 [phase-3a-plan.md](./phase-3a-plan.md)「3a-42 已落」 | 施工时重估 |
| 3b ✅ | 各块中立化：先 e2e 钉直播四种行为，把醒目留言 / 会员 / 特别弹幕 / 特别进场的装配从 `room-session.ts` 抽进 `live/`，再合场次引擎；直播监听的唯一判定（B 站改存 `WATCHED_CHANGE` 的 `num` 10-02 挪进第 2 期 ㉒）；资料刷新；链接预览（ADR-0029）、指令（`CommandDef` 与通用的 `login [来源]`，ADR-0031）、AI 工具与女仆技能（ADR-0030）；DevtoolsProvider（场景 `DevScenarioDef`）与假桥搬家；拓展契约 v3（含推送侧加宽）、`pickPerId` 与索引规则；桥迁 v3 | 链接预览与指令重写，其余改造 | 守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫② 清零；守卫 21a、推送守卫③、模板变量可满足性、AI 工具与技能约束绿；守卫 21b「这版不开」名单里标 3b 的行转成对拍（主人 10-12 定：N02、N03、N04、N06、N07、N08、N10、N11、N12、N13、N16、N17、N18 共 13 行，清单在 `apps/server/src/__tests__/in-process-source-parity-e2e.test.ts` 的 `PARITY_ROWS`），另补定案清单里漏列的三项（按订阅的皮肤、点评输入与过滤用同一个取段函数、看图从图库引用，主会话 10-12 定归 3b） | 施工时重估 |
| 4 ✅ | 面板按描述画：来源按 descriptor 渲染（面板只从描述符拿来源信息，ADR-0027 决策 5–7）、连接 / 目标表单、候选 / 扫码 / 地址控件、B 站设置 tab（含「换一个身份」按钮）、功能页指向拓展设置的入口、两种「设置不合法」态（连接的、集成的）、健康卡（**先出设计稿，主人认了再照稿写**；含盘上遗留的同身份订阅，见 data-model）；AI 设置页「女仆写正文」一节（picker 切动态 / 直播，默认一行 + 按群例外表，例外表与链接预览共用一个件，ADR-0032）；账号排序与 `accounts/`（3a-29 推来的，见「以后再说」）、`/api/sources` 列表与多账号面板、预览、问题框（顶栏问候语后面那一行改读问题表、不再显示 B 站登录文字与「当前账号 XX 已登录」，账号挪到健康卡各集成那一格，10-03 主人定，ADR-0025 决策 11 下 🔗；右上「组件告警」到时只剩流程错误，它和问题框要不要合成一处，出稿时一起看）、日志筛选、密钥打码（统一密钥输入框）、素材库界面、旧版本数据清理界面、首访页与「正在搬家」界面与自愈退回提示（⑧ 的数据接口；「正在搬家」的进度今天只在开机那一段 503 的原话里（「BN 正在搬家(3/12)：…」），健康检查不说正在搬家，做界面时服务端补一个结构化的阶段与进度；搬家期间面板只显示进度、不去取各页的数据，搬完再进 —— 今天开着面板等它搬完，统计、历史这些不在重连刷新范围里的页会停在出错状态，要切页或刷新）、面板账号修改入口；首页改用直播监听的唯一判定；拓展页改成一个拓展一张卡（卡上标开了哪几口、页头按口筛选，ADR-0025 决策 13）；另有三条 10-11 主人定的，写在「以后再说」：两套交互文案（女仆 / 平实）做成一个开关、改面板时交互与提示用女仆风格而标题与数据名保持平实、多语言（核心与面板都做，几件大事在 3b 拓展契约定稿之前定）；问题框读 3a-30 已落的 `GET /api/problems` 与 `problems-changed`；另有两条 3b-40 留下的待办：内置适配器的模板候选已带 `settings` 默认值（服务端 `platforms/builtin-candidates.ts` 抄了面板 `makeEmptyConnection` 那份），面板改读候选后删掉 `apps/web/src/types/domain.ts` 里那份；`data-model.md`、`push.md` 写的「列候选时按平台名刷新连接的 `platformSnapshot`」3b-40 没做，随面板按快照画脸时一起做 | — | B 站替身清零 | 施工时重估 |
| 5 | 收尾：清扫剩余旧名、目录与文件名、测试归位、死代码、守卫补齐、托管文档与 docs/agents 同步；全仓包版本统一 `0.0.0-dev` | 机械活，一次做完 | 中文叫法棘轮清零 | 约 2 |
| 6 | alpha 配套：抖音拓展（`ctx.http` 的第一个拓展用户）；重议 Q76：`linkResolver` / `aiTools` 对拓展开不开，`commands` 只在抖音拓展真要自带指令时才议（`CommandProvider` 1.0 不造，见「以后再说」）；定桥的版本号；在 dev 上打 `v1.0.0-alpha.1` | — | — | 施工时重估 |

- 「方式」沿用最初分期表的施工指引：原第 3 期拆成 3a / 3b，链接预览与指令都在 3b；第 4、6 期没有对应的记录。
- 这些归期是 09-27 复核时补的，主人可调：第 2 期并入的格式函数与直播人数；3a 的中立部分同步拆分与密钥下发；3b 的装配抽出、监听判定与 `num`；第 4 期的首页判定与密钥输入框；第 5 期的包版本；以及下面「零碎施工项」整张表。
- 09-28 拍板的归期（ADR-0021 决策 60）已并进表：第 2 期的 `packages/http`；3a 的推送侧、`SourceContext` 的 `settings` 与 `http`、设置坏了只停那一处；3b 的契约 v3 推送侧加宽、桥迁 v3；第 4 期的按描述画与健康卡设计稿；第 6 期的 `ctx.http`。三层守卫的期次同日拍板，见下节。
- 10-12 拍板的多语言归期（ADR-0037 决策 16）没有写进表格的格子里，记在这里：**3b** 加字典机制、当前语言的 store、语言这项设置、钉键与占位符的检查，契约第 3 版带上「把当前语言交给拓展」与清单的译文文件，文字模板与内置人格改成「没改过的不存」（一件单独的重构，要迁移设置文件、占一个迁移修订号），3b 里新写的服务端文字直接进字典；**第 4 期** 面板的字随重画一起收、写中文的女仆层（口吻开关就是这套字典的一层），服务端与卡片剩下的字也收完；**第 5 期** 翻译（英文与日文的平实版、日文的女仆层、使用指引），以及 ADR-0037 决策 11 剩下的两件（提示词加一句「用当前语言回答」、标点整理认英日写法；10-25 定），发行说明（通知卡的 `notes`、发布页正文、升级之后「本次更新」弹窗里的概述与 ⚠️ 段，今天都从中文的 CHANGELOG 抽）翻不翻、怎么翻也在这一期定（3b-48 落地时记下）。3b 到第 4 期之间要有一条只降不涨的计数守卫看着还剩多少处写死的中文。各期的规模没有按这些重估。

🔗第4期已出期（2026-11-06）：61/61片完成，应清零棘轮与写死中文放行名单外均为0，54条进程内对拍及面板证据收口，全量门禁通过；迁移53/备份23不变。详见[第4期出期记录](./phase-4-plan.md#第4期出期记录4-542026-11-06)。中文叫法70处照原计划归第5期。

## 中立性守卫的归期

判据与范围见 [architecture.md](./architecture.md)「守卫」；这里只写哪一期开、哪一期清零或必须绿。棘轮按「纪律」里那条规矩走。

| 期 | 开启 | 清零 / 必须绿 |
| --- | --- | --- |
| 1 | 切片 ④：出网点名表（棘轮，④a）、错误体（④b）、结果不手写（棘轮，④b）、事件载荷（棘轮，④c；总线事件载荷里不许有 `uid` 键、`Bili*` 类型、平台原始值的裸 string）；切片 ⑥：守卫 12（棘轮，按 import 判；解构与下标归 B 站替身）、B 站替身（棘轮） | — |
| 2 | 守卫 10 的「批准的像素差清单」机制（快照早已覆盖全部卡种，10-02 查时 23 份），差异按清单裁决；出图器零联网 10-03 随抓图服务挪进 3a | 绿 |
| 3a | 咽喉四道：入口咽喉、出口咽喉、咽喉 e2e（逐条驱动全部发送路径，每条恰好一条截流记录、零外连）、出图器零联网（10-03 从第 2 期挪来）；守卫 1、17、22；守卫 11 修订版（边界匹配、词表自动生成、扫 contract；10-10 主人定晚开，10-12 随 3a-41 开张，词表自动生成落成只取 snake_case 的类型键）；uid 棘轮（3a-41 已开）；`.platform` 决定棘轮（推送侧，3a-41 已开）；推送守卫①；推送守卫②（棘轮，词表同期加宽并扫 contract；本来没有哪一片认领，由 3a-41 认领并已开，10-12）；~~守卫 18 的保留 id 加上三个内置适配器的键~~（10-07 勘察：早已落地） | 守卫 21b（进程内对拍）绿，即 3a 检查点；守卫 12 清零；出图器零联网绿。🔗 3a-42 已落（10-12）：对拍 20 行 + 「这版不开」18 行（`apps/server/src/__tests__/in-process-source-parity-e2e.test.ts`），全量门禁待主会话跑 |
| 3b | 守卫 21a（契约层对拍）、推送守卫③（假适配器对拍）、模板变量可满足性、AI 工具与技能约束 | 守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫②、出网点名表、事件载荷清零；守卫 21b「这版不开」名单里标 3b 的行转成对拍 |
| 4 | 中文叫法棘轮 | B 站替身清零 |
| 5 | 守卫补齐 | 中文叫法棘轮、结果不手写清零 |
| 随各项 | 守卫 4 点名表补项（监听判定、身份索引、`displayNameOf`、`formatViewers`、作品文字的取段函数、叫法函数；禁面板自带路由键表）；守卫 19 在 PATCH 与发送时复检；守卫 13 补上重推原件的 `kind` | 随所在那一项 |
| 施工时定 | 类型名后缀（ADR-0023 决策 15，扫我们写的全部类型名） | 施工时定 |

## 第 1 期：地基与迁移地基

| 片 | 做什么 | 状态 |
| --- | --- | --- |
| ① | storage / internal 的持久化原语（见 data-and-migration「持久化底层与关停」） | ✅ 已落 |
| ② | 守卫 3 先红；它点名的 25 个直接写盘的文件迁上原语；`createAssetStore` / `createSkinStore` 合一 | ✅ 已落 |
| ③ | ServiceContext `track()` + 分阶段 dispose + 8 秒关停 + 守卫 8 | ✅ 已落 |
| ④a | 扫源码守卫的共用工具（`scripts/` 平铺的 `.mjs` 配 `.d.mts`，认字符串 / 模板 / 正则字面量、保行号），收编守卫 3、拓展边界、面板 internal 入口三份私抄；出网点名表（棘轮开） | ✅ 已落 |
| ④b | 失败规矩落地（ADR-0026 决策 6）：`internal` 的标准码表、`Result` / `Failure` / `Issue`、`ok()` / `fail()`、`issuesFromZod`；服务端 `respondFailure` 与全局出错处理；非 2xx 与「做一件事回报结果」的回应、SSE 错误帧、WS 控制帧改形（现 `routes/subs.ts` 两处 B 站的码挪进 `upstreamCode`）；面板 `ApiError` 只解析一次、`errorMessage` 只认 `code` + `message`、删掉各处私有解析；守卫「错误体」（记账式）与「结果不手写」（棘轮）。盘上存的失败字段不动（决策 5） | ✅ 已落 |
| ④c | `BiliEvents` → `BusEvents`，载荷一律具名对象（今天 3 个事件是位置参数、几个是裸 id 或数组）；contract 的 WS 事件表从它推导，面板 hook 去掉手写的类型断言；`log` 频道里日志行的字段不动（冻结格式）；事件载荷守卫（棘轮） | ✅ 已落 |
| ④d | `/api/health` 进契约（`HealthResponse`、`ModuleState`），删 4 个恒为 `null` 的死字段（`/details` 里恒为 `null` 的与写死的 `history: { entries: 0 }` 一并删），面板 5 份私有的健康类型（4 份 `HealthSnapshot` 与重启的 `RestartProbe`）收成一份、4 处各写一遍的查询选项收成一份；面板把 contract 移进 `dependencies` | ✅ 已落 |
| ⑤ | 宿主根 / 数据根拆分 + 目录表（守卫 13 后半）：`runtime/roots.ts` 的两张表与带类型的 `hostPath` / `dataPath`，`AppRuntime` 上推一次 `hostRoot` / `dataRoot`，下游只认这两个名字；目录表登记的是第 0 代（0.x）的布局，也是 ⑥ 迁移的输入清单；`packages/storage` 不再自带缺省布局（三条路径由宿主给全） | ✅ 已落 |
| ⑥a | 开机分两段：先 listen（鉴权闸与完整的 app 同一套，健康检查照答，其余 `/api` 回 503 `unavailable`），再读数据、起引擎，就绪后切到完整的 app；启动入口仍等全部起来才返回（ADR-0022 决策 2 下的 🔗） | ✅ 已落 |
| ⑥b | 数据代：`generations/<序号>/` 与 `generation.json`、选代、`.partial` 原子改名、半截重来；第一版迁移器 = 0.x 升级链原样跑 + 按新目录树搬位置，格式一律不动；目录表换成代布局；守卫「第 0 代一个字节不变」（也是 ⑤ 欠的「两个根不同」那条）；开发期迁移修订号对不上就重迁 | ✅ 已落（b1 零件、b2 接线） |
| ⑥c | 第 0 步收编 0.x 升级链：先给零测试的 `migrateLegacyTargets` 补刻画测试，再把 schema 里的 preprocess 与读时翻译连同夹具搬进迁移模块，活 schema 删兼容分支。迁移器分两遍：先搬位置，再一族一族改写成 0.x 最新的形状，顺序是连接与目标 → 设置 → 订阅 → 历史、统计、锐评草稿 → 皮肤、对话、密钥 | ✅ 已落（各族收齐；留在活代码的长期规矩与排到后面的几项见 data-and-migration 第 0 步） |
| ⑥d | 订阅合一 + `Identity`：一个 `config/subscriptions.json`，行带 `identity`；`SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription` 删掉，wire 跟着变；B 站替身棘轮开 | ✅ 已落（身份读法、备份只收 1.0 格式、单一形状、棘轮四片） |
| ⑥e | 身份唯一闸 + 守卫 9：`writeSubscriptions` 与恢复备份的 `replaceSections` 两条写路径都拦 | ✅ 已落（恢复先按身份并入、备份自带重复整份拒收；健康页显示随第 4 期健康卡，见 data-model） |
| ⑥f | 设置分文件 + 守卫 12：`config/settings/core.json`、`bilibili.json`、`extensions/<id>.json`（ADR-0021 决策 42 下 10-01 的 🔗），只挪位置、不改键名（改名随第 2、3 期）；内存里核心读法不动，B 站与各拓展各有自己的读口；拓展开关留 `core.json`；`userAgent` 先落 `bilibili.json`，第 2 期随 `packages/http` 删 | ✅ 已落（核心挪进 `settings/core.json`；B 站三格拆进 `settings/bilibili.json`，通用的集成设置登记，`bilibili/` 进 B 站替身白名单，`System.tsx` 上限 25 → 27，主人 10-01 同意；各拓展的设置拆进 `settings/extensions/<id>.json`，开关留核心，备份多一节 `extensionSettings`，旧的「不搬」随数据代作废；守卫 12 按 import 判，`engines.ts`、`index.ts` 进棘轮、3a 清零） |
| ⑦ | 各代互不干涉（ADR-0022 决策 3 下 10-01 的 🔗，原定的回退指纹与自动重迁作废）：定案改写；开机用到一代就更新它的 `lastActiveAt`（只给系统页显示） | ✅ 已落（`lastActiveAt` 在原文上改这一格再写回，以后的版本加的格不剥掉） |
| ⑧ | 只做服务端与 contract，面板那半随第 4 期（10-02 定）。全新开始 + 「从旧代重新迁移」走同一条开新代的路：接口先判能不能重启（不能就拒、且不写标记）、重迁先判第 0 代还在，再在 `generations/` 里写一次性标记、复用 `/api/system/restart` 的重启；开机读到标记先删再开代：空代在 listen 之前开、主密钥 `master.key` / `kdf.salt` 从当前代拷过去（不登出），从第 0 代迁的在 listen 之后开；**开新代失败就留在当前代**、失败原因记进当前代、正常退出等拉起，不整个开机失败（否则应用内升上来的桌面用户会被退回 0.x）。「开机后要告诉主人的事」统一成一张提示清单（`/api/system` 底下读与标记已读）：迁好了（开代时把迁移报告的要点写进新代 `generation.json`，3a 加主人目标已清空）、开新代失败、自愈退回（读 `boot-state.json` 的判死名单，只报比当前运行版本新的）；已读记在当前代的 `generation.json`。字段名、文件名、路径施工前对过 naming.md 再给主人看（拒收 1.0 之前的备份已提前到 ⑥d 落地，见 ADR-0022 决策 6 的 🔗） | ✅ 已落（标记与选代、提示清单 `SystemNotice` 存在 `generation.json`、开机接线、`/api/system` 三个口；名字 10-02 主人认过，清单走通用的 `/api/system/notices`；面板随第 4 期） |
| ⑨ | 迁移耗时测试（365 天合成数据） | ✅ 已落（判据 C：比值 ≤ 5.5、满量 ≤ 5 分钟、照实打印；默认跳过，`vpr test:migration-timing` 与 CI 并行作业跑；主人 10-02 定）。实测（M 系列 Mac）满量约 29 秒、四分之一量约 7.2 秒、比值约 4.05，满量多出约十几秒的超线性开销就红；大头是推送历史搬位置 20 秒（四万多张图逐个建目录、逐个硬链接，按顺序等），统一图库那一步改写这段时一起看。Linux / Docker 上复制是真拷字节（Mac 是克隆），那边会更慢，CI 作业打出来的秒数更接近 Docker |

- 契约骨架归第 1 期切片 ④（主人 09-27 拍板）；错误体的防撞规矩见 [architecture.md](./architecture.md)。
- ④b 只改线上的形状（HTTP 回应、SSE 与 WS 控制帧、契约类型），**盘上存的失败字段一个不碰**（ADR-0026 决策 5，随改盘上形状的那一期带迁移条目改）：历史每条消息的投递结果 `HistoryMessageResult.err` 与喂它的 `DeliveryResult.err`、`targets.json` 里连接与目标的 `testStatus`、应用内更新的 kebab `reason`。历史接口回的是存档的视图（`HistoryEntryView`），也照旧。
- 契约做实的其余部分随契约骨架走：`/api/health` 补进契约、面板把 contract 移进 `dependencies` 已随 ④d 落；moduleVersions 删 api / dynamic / live 要等这几个包在 3a 删掉，那一小项留到 3a。`/api/health` 按 ADR-0025 决策 12 拆成短版（只留 `status`、`version`、`startedAt`、`uptime`）与 `/api/health/details` 随第 4 期健康卡做（拆了首页要先改读法，09-29 定）；moduleVersions 拆完以后去哪，到时候定。

### 切片 ② / ③ 的验收清单

第 1 期盘点出来的现状，不是主人逐条拍的；做完逐条确认修掉。另见 data-and-migration「持久化底层与关停」的「顺带修掉」。

② 写盘：

- 守卫 3 开张时点名 25 个非测试文件（按它的判据，mkdir / rm / unlink 不算写盘；盘点时的「29 个文件、151 处」连这几样一起数），全部迁上原语，待迁名单清空。
- 不是原子写的重要文件：cookie、AI 会话、card-bg 游标、字体清单（另有读改写不加锁）、资产字节、repush 草稿、stats since、两个皮肤库直写在用目录的资产。
- 固定名 `.tmp` 并发互踩：key-manager、两个皮肤库、maid-skills。
- `update/durable-json.ts` 并进原语（已做：留作策略层，导出改名 `readBestEffortJson` / `writeBestEffortJson`，底下是 storage 的同步原语）时注意：`boot.ts` 直接 import `select-version-for-boot`（它用 durable-json），所以这次改动会打进新载荷与新镜像里的选版代码；`boot-state.json` / `manifest-freshness.json` 在宿主根、格式冻结，改的只能是写法，不许动文件格式与位置。
- `bn.config.yaml` 两处写（`config/loader.ts` 的 `writeFileAtomic`，写首启动的种文件与迁移后的用户文件；`config/persist.ts`）也走原子写底层：两处都改用 storage 的 `atomicWriteFile`（原子写字节，不碰 YAML 注释），守卫 3 不留白名单。

③ 关停（已落，逐条对过）：

- HTTP 排空排在第 9 步（实测是 11 步里的第 10 步）：改成按段跑，`stop` → `drain` → 等后台活 → `flush` → `dispose`，见 data-and-migration「持久化底层与关停」。
- 一个 try 包住全程，任一步抛错后面全跳（含 stats 收尾）：钩子各自兜错，一个抛了只记一条。
- 没有总时限：8 秒；HTTP 排空最多占 30%，`flush` 之前的等待至少给它留 25%。dev 启动器、compose 样例、桌面壳的硬杀时限都比它长，有守卫。
- 第二次 Ctrl-C 直接杀：信号处理器挂到关停收完才摘，再来的信号与关停期的未捕获错误只记一笔。
- 关停期日志 hook 被还原成 `undefined`：不再摘；日志归档排在最后一段，最终落盘先等在途的那一次。
- `api.stop` 不加 `refreshGeneration`：已加，在途的 cookie 刷新随之作废。
- 关停返回以后还有写入落进数据目录：守卫 8 把关停开始时还在路上的写入垫慢，稳定红在 `state/targets.json`（送达回调写回可达性，发出去就不管）；写道在 `flush` 段落盘并关门、发出去不管的写入改走 `track()` 之后转绿。那条 `ENOTEMPTY` 直接跑 44 次没复现过，按守卫 8 的红判定是同一个原因。

施工中发现的（盘点时没列、这次一并修了或定了）：

- `createSerialQueue` 全仓零个 flush / close 调用点，另有 11 条手写队列同样没人 flush：迁上原语、各 store 加 `close()`；皮肤与资产原名清单那两条是模块级、同进程的所有 store 共用，只 flush 不关门。
- WS 关停只发关闭帧不断开，不回帧的对端能把 HTTP 排空拖满；拓展收摊每个最多等 30 秒；浏览器在 HTTP 排空之前就关了：都已按段与预算改掉。
- 20 类发出去不管的写入，其中几处连 `.catch` 都没有；长跑的补发、关注同步、更新下载不接中止：都已接上。
- `index.ts` 里两处 `config-changed` 监听的把手没人收（勘察报了五处，另三处其实交给拓展 ctx 收着）：写道在 `flush` 段关门以后不会再有 `config-changed`，没有能观察到的后果，不修。

## 第 2 期：数据模型

10-02 主人认了切片表。编号接着第 1 期往下排，免得和 3a / 3b 的期次写法混在一起。

| 片 | 做什么 | 状态 |
| --- | --- | --- |
| ⑩ | 出图字节门的「批准的像素差清单」（守卫 10 的本体）：清单文件、清单外的字节变化判红、更新快照必须同时补清单。快照早已覆盖全部卡种（10-02 查时 23 份：作品 10、直播 4、醒目留言 3、会员 3、榜单 2、词云 1），缺的是清单机制。后面几乎每片都改卡片字节，所以排第一 | ✅ 已落（清单 `packages/image/src/__tests__/approved-card-diffs.ts`：起点 23 个 hash + 只往末尾追加的批准；三类预批之外记 `master-approved` 带日期；`-u` 不补清单照样红） |
| ⑪ | 格式化函数收一份：`formatCount`（含带符号的变体）、`formatAgo`、`formatDuration`、`formatClock`（`video-card.ts` 里现在叫 `formatDuration(seconds)` 的那个改名过来）；删 `{time}` 兜底与 `getTimeDifference` 钩子；守卫 4 点名表补上 | ✅ 已落（口径主人 10-02 定：带正负号用普通「-」、零写「0」，「N 分钟前」带空格，时长最大到天；放在零依赖子路径 `@bilibili-notify/internal/format`；守卫 4 开张 `scripts/__tests__/unique-homes.test.mjs`，点名表头一批是这五个；顺手修了 B 站开播时刻按服务所在时区读的两处，见 data-model「数字、时间与「不知道」」） |
| ⑫ | 订阅标签（ADR-0034）；顺手删旧的 `SubscriptionStateSchema` 与 contract 的死字段 `SubscriptionDTO.state` | ✅ 已落（标签表与订阅同住 `config/subscriptions.json` 的 `{ tags, subscriptions }`，`GET` / `PUT /api/subs/tags`（㉚ 起是 `/api/subscriptions/tags`）整张换；迁移修订号 15，名字里的中文逗号不拆（主人定）；备份同进同出、合并先按 id 再按名字；面板一个 `TagEditDialog` 收掉逗号文本框与编辑分组弹框。施工时定的几点写进 ADR-0034 的 🔗） |
| ⑬ | 特性键改名、直播拆成 `liveStart` / `liveStreaming`（独立的开关、目标、间隔与补报开播）、`PushKind` 的两层意思拆开；以特性键做键的配置一起改键（迁移表「特性键」到「文案」那几行）；守卫 13 前半开（10-02 开片，切成 ⑬a–⑬f，见表下「⑬ 开片」） | ✅ 已落（10-03） |
| ⑭ | （10-03 开片，切成 ⑭a–⑭c，见表下「⑭ 开片」）抽 `packages/http`：请求客户端、cookie 罐、浏览器身份、`websocket()`；删自定义 UA；出网点名表换路径。身份与 cookie 罐本期经注入的存储留在原处，3a 再挪进 `ctx` | ✅ 已落（10-03） |
| ⑮ | （10-03 开片，切成 ⑮a–⑮b，前面先修桌面令牌闸，见表下「⑮ 开片」）图库 `images/`：`<sha256>.<ext>`、`ImageRef`、嗅探、8MB 上限、同源读口；目录表加键 | ✅ 已落（10-03） |
| ⑯ | 抓图核心服务：逐跳查重定向、超时、结果形状、`storeImage`。旧引擎本期由服务端直接调它拿 `ImageRef`，3a 改走 `ctx.fetchImage` | 并进 3a（10-03 主人定：本期没有调用方，见表下「⑯ 并进 3a」） |
| ⑰ | 引用方登记表 + 按引用清扫 + 新图宽限期；守卫：写图库的模块不在登记表里就判红 | 并进 ⑳（10-03 主人定：本期第一批写入方与引用方都在 ⑳，见表下「⑰ 并进 ⑳」） |
| ⑱ | 历史行改形：`identity`、`nameSnapshot`、`createdAt`、`repushOf`、`RepushSnapshot`（`kind` → `feature` 10-03 提前到 ⑬f；原件这一片只改 `DraftSchema` → `RepushSnapshot` 与 `v` → `version`）。原件的载荷改名与守卫 13 那条加固（重推原件每种载荷都有去向）10-03 挪去跟活的 `NotificationPayload` 改名走：`image-group` 与段的判别键 `kind` 归 3a，原生分享归 3b。跟图有关的格（头像换图库引用、配图格按词表 `Ref` 那行起名、原件的 `{ ref, mime }` 并成一格、删 `own`）10-03 挪到 ⑳；投递结果（盘上旧失败转 `unknown`、新行带码）10-03 挪到 3a，随 `DeliveryResult` 改形状 | ✅ 已落（10-03，切成 ⑱a–⑱c，见表下「⑱ 开片」；修订号 21） |
| ⑲ | 推送历史拆两层：文字不设上限，图按天数清（90 / 60 / 30 / 15 / 7 / 3 / 1，默认 30），超期的行「图已清理」、不能重推；迁移换算老配置、不搬超期图与孤儿图 | ✅ 已落（10-04，切成 ⑲a–⑲c，见表下「⑲ 开片」；修订号 23，备份版本 6） |
| ⑳ | 三处过渡目录并进图库：`history/img/`、`avatars/`、`assets/chat/`（女仆 AI 看图跟着读图库）；读口一起改；迁移把硬链接按摘要改名；目录表删两个过渡键；⑨ 复测。历史行与重推原件里跟图有关的格从 ⑱ 挪来：头像换图库引用、配图格按词表 `Ref` 那行起名（`imageRef` 这类改成按装的是什么起名，10-03 ⑮ 定）、原件的 `{ ref, mime }` 并成一格、删 `own`（10-03 主人定：格和字节同一片动，中间不留「名字说是引用、装的不是」的状态；⑱ 本期搬字节不行，图一进库就会被共用，⑲ 按行直接删会误删）。⑰ 的引用方登记表、按引用清扫、新图宽限期与守卫 10-03 并进来，今天按文件名直接删图的几条路同一片改走清扫 | ✅ 已落（10-05，切成 ⑳a–⑳e，见表下「⑳ 开片」；修订号 26） |
| ㉑ | （10-05 开片，切成 ㉑a–㉑e，见表下「㉑ 开片」）作品模型 `Post` / `PostImage` / `Creator` / `RichText` + 唯一取段函数；出卡改吃 `Post`；过滤键改名 | ✅ 已落（10-05，修订号 27，备份版本 7） |
| ㉒ | 直播卡输入：人数只收精确数（缺键不画）、封面走 `PostImage`、`startedAt` 改 ISO；B 站改存 `WATCHED_CHANGE` 的 `num`（10-02 从 3b 挪来） | ✅ 已落（10-05，切成 ㉒a–㉒d，㉒e 并进 ㉒c，见表下「㉒ 开片」；不动盘、修订号不抬） |
| ㉓ | 会员与醒目留言：`MembershipTier`、`SuperchatEvent.tier`、`templates.membership` 重做（顺手修图片空串不兜底）；`filters.minScPrice` → `defaults.superchat.minAmount`、`filters.minGuardLevel` → `defaults.membership.minRank`（10-05 主人定归这一片）。舰长图标改本地资产 10-02 从 3b 挪来、10-03 随 ⑯ ㉕ 回 3a。10-05 开片，切成 ㉓a–㉓e，见表下「㉓ 开片」 | ✅ 已落（10-06，修订号 28，备份版本 8） |
| ㉔ | 皮肤字段改名、卡种键改名（含 `cardStyleByKind` 的键与它挪进 `defaults.cards.byKind`，10-02 从 ⑬ 挪来）、皮肤 schema 抬版；卡种中文名收一份。醒目留言卡与会员卡两组字段 10-05 已随 ㉓ 改到最终名字，这一片只剩卡种键与其余卡；皮肤按档换色的挂点 10-05 从 ㉓ 挪来（见「㉓ 开片」）。10-06 开片，切成 ㉔a–㉔f，见表下「㉔ 开片」 | ✅ 已落（10-06，修订号 29，备份版本 9，皮肤包格式版本 2） |
| ㉕ | 出图器零联网守卫：渲染页只许 `data:` 与本机图库，其余拦下计数；出网棘轮里 `image-renderer` 清零 | 并进 3a（10-03，随 ⑯：出图器不再自己抓图，要等 B 站上报引用） |
| ㉖ | （10-06 开片，切成 ㉖a–㉖h，见表下「㉖ 开片」）统计改写：`PostEntry` / `LiveSessionEntry`、帧字段改名、`stats/posts`、统计行 `followers` / `videoPosts` / `posts` / `identity`；ADR-0027 服务端那半里今天做得了的（「在记」的按天小账、开播公告不记、拓展作品多收字段、「取最近几条」的读口）；锐评取数改成直接调函数 | ✅ 已落（10-06） |
| ㉗ | （10-06 开片，切成 ㉗a–㉗c，见表下「㉗ ㉘ 开片」）运行记录 + 迁移时从 0.x 粉丝样本回填运行时长（ADR-0033 决策 3，必须先于 ㉘） | ✅ 已落（10-06） |
| ㉘ | （10-06 开片，切成 ㉘a–㉘e，见表下「㉗ ㉘ 开片」）粉丝样本的行改名（`ts` / `value` → `sampledAt` / `followers`，10-06 从 ㉖ 挪来，和压缩同一遍重写）、降精度再合区间；「在记」的账满 8 天的也在这一趟合成区间（10-06 加，ADR-0027 决策 13）：最近 8 天原样、每天一趟压缩、迁移压 0.x 老样本；⑨ 复测 | ✅ 已落（10-06） |
| ㉙ | （10-06 开片，切成 ㉙a–㉙e，见表下「㉙ 开片」）统计总开关；系统页「存储占用」的服务端；旧代的列表、大小、删除服务口 | ✅ 已落（10-06） |
| ㉚ | 路由按资源整理（ADR-0036，10-03 主人定，**插在 ⑭ 之前做**）：照 ADR-0036 决策 4 的对照表只改路径、不改行为，server 改挂载、面板改调用方与缓存键、测试与文档跟上；素材库、来源、适配器、问题表那几组随各自那一片搬（决策 5） | ✅ 已落（10-03；路由文件跟着改名，源码目录不动；接线守卫 `apps/server/src/__tests__/routes-by-resource-mount.test.ts` 起整个 app：新路径每组不是 404、老路径都是 404、`/api/ws/ticket` 在 cookie 闸里；面板缓存键 `["globals"]` → `["settings"]` 等一并改；订阅头像地址存在资料缓存里，旧的 `/api/subs/<id>/avatar` 要等拓展下次报头像或 ⑳ 换成图库引用——⑳c 已换：读口退役，头像走 `/api/images/<ref>`） |

- 依赖：⑭ 与 ⑮ 互不依赖（⑯ ㉕ 10-03 并进 3a）（⑰ 10-03 并进 ⑳）；⑱ 要 ⑬（跟图有关的格 10-03 挪去 ⑳）；⑳ 要 ⑲（超期的图不搬）；㉑–㉓ 要 ⑪ ⑮；㉔ 要 ⑬ ㉑–㉓；㉖ 要 ⑪ ⑬；㉗ 先于 ㉘；㉙ 要 ⑳ ㉖。每动一处盘上形状都抬 `MIGRATION_REVISION` 并补夹具。
- 改 contract 形状的片（⑫ ⑬ ⑱ ⑲ ⑳ ㉒ ㉖ ㉙）面板同片跟上到「照旧能用」，面板的新界面仍在第 4 期。
- 设置键本期只改这几片碰到的：⑬ 以特性键做键的配置、⑲ 图片保留天数、㉙ 统计开关；`app` → `core.*` 的其余拆分随 3a「设置坏了只停那一处」（`app.logLevels` 的键、文案账本挪进 `core.templatesSeen` 也随这一步，10-02 ⑬ 开片时挪出）。✅ 3a-38 已落（10-10）：`app` 拆成 `logging` 与顶层 `profileRefreshCron`、`logLevels` 的 `dynamic` / `live` 并成 `bilibili`、账本成顶层 `templatesSeen`、`defaults.ai` 整段上提成顶层 `ai`；其余改名（排行榜推送、静音时间、免扰时段、词云停用词、登录检查间隔、AI 全部子键）各自成片、排在第一个 alpha 之前，还没有片号。
- 涨粉起点：压缩把最早那一小时换成小时末值，起点最多挪一小时，不算 data-model 里说的「截尾」，不另存起点；㉘ 落地时在 data-model 写明。
- **⑬ 开片（10-02）**：先勘察，再切成五小片，依次提交：
  - ⑬a 迁移器冻住 0.x 词表：`migration/` 里吃活词表的三处（附加项键与默认值、当前默认文案、推送种类）冻成 0.12 的原样，迁移测试造 0.x 输入改用冻住的字面量；产出一个字节不变，不抬修订号。✅ 已落（`migration/zero-vocabulary.ts` 与夹具 `migration/__tests__/zero-fixtures.ts`；0.12 的出厂全局设置用 `v0.12.0` 实跑的输出，`app` 里 B 站那两格也在）
  - ⑬b `packages/dynamic` 的 `PushKind` → `PostPushPart`（`post` / `post-images`），不落盘、不过 wire。✅ 已落（函数名照 naming.md 用 `Options`：`broadcastOptionsForPostPart`）
  - ⑬c 纯改名、行为不变：特性键 `dynamic` → `post`、`live` → `liveStart`、`liveGuardBuy` → `membership`，附加项 `atAllDynamic` → `atAllPost`、`atAllLive` → `atAllLiveStart`；文案 `templates.dynamic` / `dynamicVideo` → `post` / `postVideo`，账本跟着换键；`messageLayout.dynamic` → `post`（`live` 那组不改名，它管开播、正在直播、下播三种消息）；订阅顶层 `extras` → `extraTargets`；测试推送的 `kind` 改用特性键。迁移加一步「0.x 最新 → 1.0 改名」。✅ 已落（`migration/feature-renames.ts`，四张对照表都 `satisfies Record<0.x 的键, 1.0 的键>`，0.x 的键漏了去向编译不过；修订号 16；`FeatureFlagsObjectSchema` 改成从 `FEATURE_KEYS` 摊出来；备份版本抬到 4，拒收旧备份时只有 0.x 导出的才提「先装 0.12」）
  - ⑬d 直播拆键：新特性 `liveStreaming`（独立的开关与目标，间隔在 `defaults.liveStreaming.streamingIntervalHours`），`restartPush` → `defaults.liveStart.catchUpOnBoot`，`templates.liveOngoing` → `templates.liveStreaming`；补报走 `liveStart` 的路由、历史记成开播、不 @全体，文字与卡照旧用「正在直播」那一套；B 站的周期计时改成开着才计（今天关着也计、到推送闸才扔）；「监听开不开」手抄的三份清单都加上 `liveStreaming`，合成一个判定随 ㉖（ADR-0027 决策 1）。`schedule` 只搬走这两格，静音时段与断流接续随 3a 的设置分拆。新装默认照今天：`liveStreaming` 关、间隔 1 小时（范围 1–24，面板上限 23 顺手对齐成 24）、`catchUpOnBoot` 关。拓展订阅声明了开播与下播两种事件就露「正在直播」开关（`has.liveStatus` 那半随 3a）。✅ 已落：补报与周期靠新加的一档推送类型 `LivePushType.CatchUp`（11）分开，`engines.ts` 的翻译表各加一行，`liveTypeToPushKind` 收成 `featureToPushKind(liveTypeToFeature(t))`；迁移在 `migration/live-split.ts`，订阅那一步取第 0 代的全局值（设置那一步把 `pushTime` 折成间隔以后 0 与 1 分不开），修订号 17、备份版本 5；面板的继承基线改用真正的全局特性开关（原先拿出厂值，迁出来的全局「正在直播」开着时订阅上显示成关、还关不掉），规则页「直播推送阈值」段加全局开关「状态推送」；拓展那条路的周期在服务端也按「声明了开播与下播」认（`featuresForEvents`，面板与服务端同一份）。
  - ⑬e 守卫 13 前半。✅ 已落（清单 `migration/keyed-records.ts` + 判定函数 + 行为核对，做法见 data-and-migration「守卫 13」；订阅那一族的 1.0 步骤抽成纯函数 `toCurrentRow`，读写盘与守卫共用）
  - ⑬f 历史行的推送种类换成特性键（10-03 主人定从 ⑱ 提前）：盘上那一格 `kind` → `feature`，值 `dynamic` / `live` / `live-ongoing` / `live-end` / `guard` / `sc` / `special-danmaku` / `special-enter` → 对应的特性键；`/api/history?kind=` → `?feature=`、按天计数的键、重推闸、契约里的 `DailyHistoryCount`、面板 `PUSH_KIND_META` 改成按特性键做键；`PushKindSchema` 与 `featureToPushKind` / `pushKindToFeature` 删掉，全仓只剩特性键一套名字。迁移加在 `migration/history.ts` 的行级变换里，仍是一趟读写，⑱ 再往同一个函数里加别的字段，历史不会多迁一次；修订号抬一。✅ 已落（修订号 18；`?kind=` 与不是特性键的 `?feature=` 都回 400，和 `limit` / `since` 一个做法；面板的种类表叫 `FEATURE_DESCRIPTORS`（`config/push-features.ts`），分组 `PushFamily` 取值 `live` / `post` / `superchat` / `membership`；守卫 13 补了历史那一族，先红后绿；迁移耗时测试比值 4.05，仍在 5.5 以内）
  - 不归 ⑬ 的：`cardStyleByKind` 的键归 ㉔（它是卡种键，与卡片皮肤共用 `live` / `dynamic` / `sc` / `guard`，`live` 的新名 ㉔ 才定，分两趟改两边名字会对不上）；`app.logLevels` 归 3a（`dynamic` / `live` 并成 `bilibili` 要集成键；✅ 3a-38 已落）。历史行的推送种类原定 ⑬ 不改值、留到 ⑱（`featureToPushKind` 当桥）；10-03 主人定提前成 ⑬f：⑬d 之后两边已经一一对应，历史迁移是一趟读写、提前不会多迁一次，而 ⑱ 要等 ⑮ 的只有头像那一格（这一格 10-03 又挪去 ⑳）。备份版本在 ⑬c 抬一次（⑫ 改了备份里订阅那一节的形状，当时漏抬）。
- **⑭ 开片（10-03）**：先勘察，再一题一题问主人（定案在 ADR-0025 决策 6 下 10-03 的 🔗），切成三小片依次提交：
  - ⑭a 新包 `packages/http`、B 站搬过去：通用的 `client.fetch` 与 `HttpResponse`、结果形状；B 站那层的薄包保住今天的行为；罐子加 `load()` / `clear()` 与 IP、`Domain` 规则，客户端改成长期有效的同一个；身份的「生成」「只升不降」两个纯函数；出网点名表换路径、B 站替身棘轮删掉搬走的两行。行为不变。✅ 已落（施工时定的几条见 ADR-0025 决策 6 下「⑭a 施工时定」：罐子的换号计数、头序、`send-only`、中止回 `indeterminate`；刷新链补了两处 gen 比对；B 站薄包 `ApiClient` 的 `get` / `postForm` 改名随 3a）
  - ⑭b `websocket()`、B 站弹幕切过去（握手头不变），出网棘轮里 blive 那一条清零。✅ 已落（施工时定的见 ADR-0025 决策 6 下「⑭b 施工时定」；真机待验加一项：切过去以后弹幕照常收）
  - ⑭c 删自定义 UA：设置 schema、引擎接线、面板那一格、ticket 请求的特例；迁移把 `bilibili.json` 的 `userAgent` 丢掉，抬修订号。✅ 已落（修订号 19；`BilibiliAPI` 的 `config` 只剩 UA 一格，随之整个删掉；备份版本不抬：B 站设置那一节不是 strict，带 `userAgent` 的旧备份恢复时这一格被剥掉，有测试钉着；「换一个身份」按钮仍随第 4 期）
  - 真机待验（不在这一片）：弹幕握手要不要补 `sec-ch-ua` / `Origin`。
- **⑮ 开片（10-03）**：先勘察，再一题一题问主人（定案在 ADR-0022 决策 9 与 ADR-0036 决策 5 下 10-03 的 🔗，词表加了 `Ref` 一行），依次提交：
  - 先修桌面令牌闸：也认一个 `HttpOnly; SameSite=Strict` 的 cookie，桌面版里直连地址的图不再 401（现存 bug，单独一个提交）。
  - ⑮a 图库本体：`ImageRef`（文件名 `<sha256>.<ext>`）与校验、嗅探结果换成扩展名、`createAssetStore` 加按 sha256 取名、`createImageStore`（`put` / `read`）、目录表加 `images` 键、8MB 常量。只加键、不往盘上写，修订号不抬（⑳ 的迁移往里写时抬；运行时往图库写图碰不到迁移的闸，10-03 查明，原写「⑯ 或 ⑳」）。✅ 已落（`ImageRef` 放在 internal 的 `constants.ts`，与 `SourceKey` 一处；格式表与 8MB 常量住在 `apps/server/src/images/image-store.ts`；嗅探沿用 `sniffImageFormat`，`jpeg` → `jpg` 的对照在图库里）
  - ⑮b 同源读口 `GET /api/images/<ref>`，接线守卫加这一组。面板这一片还没有调用方，⑳ 换读口时接上。✅ 已落（图库挂在运行时上 `runtime.imageStore`，全进程一个；路由 `apps/server/src/routes/images.ts`）
  - 真机：10-03 桌面开发版换上带壁纸与自带字体的界面皮肤，壁纸与字体都出来了（CSS `url()`、`@font-face` 只能靠 cookie 过闸），桌面令牌闸认 cookie 算验过。历史配图、聊天附件走的是同一道闸，没逐个点开看。
- **⑱ 开片（10-03）**：先勘察，再一题一题问主人。三题都是把格挪去跟它的来源一起动：跟图有关的格去 ⑳（和字节搬家同一片），投递结果去 3a（随 `DeliveryResult` 改形状），原件的载荷改名与守卫 13 那条加固随活的 `NotificationPayload` 改名走（`image-group` 与 `kind` 3a、原生分享 3b）。剩下本期有来源的纯改名，切成三小片依次提交：
  - ⑱a 类型改名（只动内存，不碰盘）：`HistoryRecordInput` → `NewHistoryEntry`（`target` → `targetId`）、`HistoryMessageRole` 并进 `PushMessageRole`；能不能补的预检不能补时回 `code` + `message`（ADR-0026 决策 2）。
  - ⑱b 行的格改名 + 迁移：`uid` / `extensionId` + `externalId` → `identity`、`unameSnapshot` → `nameSnapshot`、`ts` → `createdAt`、消息的 `retryOf` → `repushOf`、补丁行的 `patch` → `rowId`（迁移头一回改写补丁行，按行首认补丁行的判断跟着换）；契约跟上、面板到照旧能用；删 `?uid=`；修订号抬一。`uavatarSnapshot` 不动，⑳ 换图库引用时一起改。✅ 已落（修订号 20；`identity` 落在旧身份格里最先出现的那个位置，B 站行是 `uid` 的、拓展行是 `extensionId` 的；推不出身份的行、推送种类认不得的行都是坏行，整行原样、改名也不碰；`?uid=` 删成静默忽略；服务端 `target-scope` 按身份两格一起查、两张表并成一张，面板判拓展行收进 `up-display.ts` 的 `isExtensionIdentity`；迁移耗时比值 4.13，仍在 5.5 以内）
  - ⑱c 重推原件：`DraftSchema` → `RepushSnapshot`、`v` → `version`；迁移新开一步改写 `history/repush/` 下的原件（旧代过来的是硬链接，先断开再写）；修订号抬一。✅ 已落（修订号 21；schema 不导出 —— 迁移只是给键改名、用不到它；原件的 `role` 改用 internal 的 `PushMessageRoleSchema`，内部的 draft 叫法统一成 snapshot；改写这一步挂在「推送历史」那一族里，原件自己存的图不碰；迁移耗时测试的合成原件原先不是 0.x 的真实形状（`{ v, messages }`），改正后这一步真被量到：满量 1825 份原件多约 16 秒，比值 4.04）
  - 推不出 `identity` 的行：已发布的 0.11、0.12 历史行 `uid` 必填，拓展行只在 dev-next 上有、没发过版，所以推不出的就是坏行，照旧原样不动、读的时候跳过。
- **⑲ 开片（10-04）**：先勘察（这一片有真实的删除路径与读者，不挪期），再一题一题问主人，定案在 ADR-0022 决策 9 下 10-04 的 🔗。切成三小片依次提交：
  - ⑲a 清扫改成两层：水位线 `history/retention.json`（`{ clearedThrough }`，只往前走）；到期只删图与重推原件，文字不删；历史视图加 `isPastRetention`，历史页在原来画图的位置写「图已清理」。这一片先沿用旧键 `app.historyRetentionDays`，只改语义。✅ 已落（清扫抽成 `sweepHistoryRetention`，时钟注入，⑲c 的迁移直接调它；`deleteDayFile` 换成只清图的 `deleteDayImages`；某一天清不动只记 warn、水位线照推，剩下的孤儿图留给 ⑳ 的按引用清扫；水位线文件读不懂当成没清过、下一轮写回；列表接口每次读一遍水位线，WS 推来的新行不带 `isPastRetention`）
  - ⑲b 换键与七档：`app.historyRetentionDays` → `history.retentionDays`（90 / 60 / 30 / 15 / 7 / 3 / 1，默认 30），迁移换算（不在七档里的往上取，超过 90 压成 90，缺键按 30）；备份版本 5 → 6；设置页那一格换成 `Picker`（标签「图片与重推原件保留」，带一句说明），历史页标题行「保留近 N 天」改成「图片留 N 天」；`packages/ui` 清单里 `Picker` 的选用判据改成「选项个数固定的用它，选项来自数据、个数不定才用下拉」（10-04 主人定）；修订号抬一。✅ 已落（修订号 22；七档常量 `HISTORY_RETENTION_DAY_OPTIONS` 放 internal 的零依赖 `constants.ts`，schema 与面板的段选读同一份；换键是设置迁移流水的最后一步 `moveHistoryRetention`，两把键都在时新键说了算；`days <= 0` 那条早就走不到的分支连同它的两条用例一起删了）
  - ⑲c 迁移里跑清扫：时钟注入，清超期的图、原件与孤儿图，定好水位线；迁移耗时测试跟着改（图只留 90 天以内以后，满量与四分之一量的图数差不多，原来的比值前提要重算）；修订号抬一。✅ 已落（修订号 23；`MigrateZeroGenerationOptions.now` 注入时钟，缺省读系统时钟；「推送历史」那一步的顺序是先迁日文件、清扫、再迁剩下的原件，要删的原件不白改写；清不动就让迁移失败、下次开机重来；搬过来又删掉的从报告的 `transfers` 里拿掉，`skipped` 里按数量各记一句，不逐个文件列；水位线文件是迁移新写的，不进 `rewritten`，摘要那条测试单独把它算进去；满量迁移 35 秒、比值约 3.7）
  - 不用问、照规矩办的：devtools 的整段删除（`deleteRange`）照旧连文字一起删，注明是刻意的例外；`deleteDayFile` 只剩清扫一个调用方，随 ⑲a 改掉；「1 天」那一档按 UTC 日界算，实际留 24 到 48 小时；七档以外的盘上值只可能来自手改 `core.json`，在 3a「核心设置逐格退默认」落地前和别的坏设置一样开机报错（备份只收当前版本，老天数只经迁移进来）；不能补时那句话（「只有保留期内的推送补得回来」）照旧。
- **⑯ 并进 3a（10-03）**：勘察发现 ⑯ 这一片没有调用方：旧引擎手里没有图，只把图链交给出图器、由出图器自己抓；卡片输入到 ㉑ ㉒ 才吃引用，而 `PostImage` 是 `{ ref?, url? }`，本期带 `url` 照旧能画。主人定 ⑯ 整片并进 3a：3a 那行本来就有「`fetchImage` 挂上 ctx」，B 站搬进 `bilibili/` 后上报交引用就是第一个调用方，客户端也就是集成自己的那个，只设计一次。㉕ 出图器零联网跟着去（出图器不再自己抓图要等 B 站上报引用），㉓ 里舰长图标那半也跟着回去（10-02 挪进来的理由就是 ㉕）。勘察到的事实，3a 开片时不用重查：
  - 现状：生产里抓图只有一处，出图器 `inlineRemoteImages` → `fetchImageAsDataUrl` → `fetchOnce`（`packages/image/src/image-renderer.ts`），卡里的图与皮肤 CSS 的 `url()` / `@import` / `image-set()` 都从这里进：全局 `fetch`、写死的 Chrome/120 UA 与 B 站 Referer、10 秒、8MB 边读边截、B 站域名白名单（`IMG_HOST_ALLOWLIST`，ADR-0019 那份，还在用）、缓存 300 条 / 30 分钟、失败一律换透明占位；B 站缩放后缀 `@1280w_80q_1s.webp` 失败回退原图。B 站订阅头像是远端地址存在资料缓存里，服务端从不抓；面板靠 `no-referrer` 直连 B 站。
  - `packages/http` 的 `client.fetch`：body 整包缓冲、没有大小上限；`beforeHop` 只看地址、看不到解析出来的 IP；调用方的头每一跳原样重发（跨域也带；**已定**：3b-39 起跨源那一跳剥掉 `authorization` / `proxy-authorization` / `cookie`，见 extension-contract「ctx.http」）；`cookies` 默认 `exchange`（CDN 的 `Set-Cookie` 会进集成的罐子）；B 站那层默认头是给 JSON 接口的（`Accept: application/json`、`sec-fetch-mode: cors`）；`BilibiliAPI` 的客户端是私有的；server 还没依赖 `@bilibili-notify/http`。出网点名表只放行 `http-client.ts`，所以抓图必须经客户端实例出网。
  - 全仓没有内网判定、没有 DNS 解析，要从零写。守卫 2 的 `lookup` 只放行回环名与 IP 字面量，报错文案就要求注入解析函数；正向用例只能用回环假服务，而回环本身算内网，所以判定或解析器必须可注入；反向用例可以直接用 IP 字面量。旧白名单「不解析、没有重绑定旁路」的好处，换成解析后判定就没了。
  - 到时要定：8MB 怎么读到一半截断（`FetchOptions` 加上限，还是 ADR-0025 决策 6 预留的交出响应流；现成的两份私有 `readCapped` 收成一份）；DNS 重绑定接不接受；内网段清单；解析器注入的形状；图片用哪套默认头、要不要 `send-only`、重定向跨域时剥不剥调用方的头（10-16 主人定：客户端在跨源那一跳（协议、主机、端口任一不同）剥掉调用方给的 `authorization`、`proxy-authorization`、`cookie`，归 3b-39）；状态码到结果码的完整对照（ADR-0025 决策 10 没覆盖 403 带图体、其他 4xx、429、2xx 但是 HTML、跟满的 3xx、调用方中止回 `indeterminate`）；超时值（出图器 10 秒、客户端 20 秒）；缩放后缀与回退归谁、图库存原图还是缩过的；结果带不带宽高与是否动图（今天拓展作品现算）；`storeImage` 与 `ImageStore.put` 几乎同形，文档说磁盘写失败回 `unavailable`、代码是抛；服务的类型名先对词表；舰长三档图标的字节从哪来（随包带还是抓）。
- **⑰ 并进 ⑳（10-03）**：勘察发现 ⑰ 本期也没有调用方：生产代码里没有一处调 `imageStore.put`，第一批写入方（历史配图、聊天上传、拓展头像、迁移的硬链接）和四家引用方（历史行、重推原件、资料缓存、AI 会话）都到 ⑳ 才开始。而图库按内容起名，同一张图可能被几家共用，到 ⑳ 今天那几条按文件名直接删的路就不安全了（历史保留删日文件连带删图、`deleteRange`、重推原件、会话删除删附件、头像开机清扫与订阅删除），必须同一片改走清扫：早了没东西可扫，晚了直接删会删掉别人还在用的图。主人定 ⑰ 整片并进 ⑳；⑲ 不再依赖 ⑰（那时图还在 `history/img/`，按行直接删照旧），㉙ 改成依赖 ⑳。勘察到的事实，⑳ 开片时不用重查：
  - 引用方怎么列：历史行在日文件 jsonl 里（重度用户 90 天约 1.1 万个引用，每次清扫要解析窗口内全部日文件；`history/store.ts` 现成的 `collectImageRefs` 可复用）；重推原件每个有目标的行都留一份、留到那一天过期（10-04 ⑳ 勘察更正：原写「只在失败时留，量小」，与代码不符，它和历史行同量级）；资料缓存一份 JSON；AI 会话最多 50 份、每份 200 条，消息里是 `images: string[]`。只经手、不落盘、靠宽限期活着的引用：搜索候选头像、在途的作品（登录二维码 10-11 起不进图库，直接带图片数据，见 subscription-sources.md）。
  - 今天的清扫：历史保留 `history/retention.ts` 每 6 小时加开机一次（`serviceCtx.setInterval` + `track`，失败只 warn）；`createAssetStore` 有 `list()`（只回 id 与大小，没有修改时间）与 `remove`；`ImageStore` 只露 `put` / `read`。现存的泄漏没人清：聊天上传了没发出去的孤儿、会话修剪删文件不删附件、`slice(-maxMessages)` 丢掉的老消息的图。
  - 宽限期：ADR-0022 决策 9 只写了「约一天」，没定数、没说是常量还是设置，与保留天数最小那档（1 天）的关系也没想过。
  - 竞态：清扫读到旧修改时间之后、删之前，`put` 同一份字节刷了修改时间并回 ok，图随后被删、调用方拿着悬空的引用（先例：`sub-avatar-store` 把写、删、清扫排进一条单键队）；标记期间引用在引用方之间搬家（头像换新、新历史行抄资料缓存里的头像），按先后扫可能两边都漏。迁移硬链接过来的文件修改时间是旧的，宽限期护不住，而 `utimes` 会改到旧代共享的那个 inode。
  - 守卫：按 import 判不出写入方（只有 `bootstrap.ts` 导入 `createImageStore`，写入方拿的是 `runtime.imageStore`），要么按属性链判，要么结构上不让 `AppRuntime` 露出 `put`；ADR 那句「写图库的模块必须在登记表里」把写入方和引用方并成了一个，要分开；迁移的硬链接不走 `put`。
  - ㉙ 要按引用方分开交引用集合（「只被历史行与重推原件引用的」算历史图，ADR-0027 决策 10），不能只回并集；库的列表要带大小，清理后能手动触发一次清扫。
  - 到时要定：「图已清理」按行龄推还是按文件在不在推（保留天数从 7 调到 30 时，按行龄推会让已清掉的行显示有图）；清扫挂在现有 6 小时的历史保留上还是自己一个定时器。（原有一句「保留天数同时管重推原件，⑲ 要拆开」，⑲ 实际定的是不拆，10-04 删。）
- **⑳ 开片（10-04）**：先勘察（两路：服务端存储与迁移；契约、面板与女仆 AI），再一题一题问主人，定案在 ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗。切成五小片依次提交：
  - ⑳a 清扫地基：引用方登记表、按引用清扫、新图宽限期（写死 24 小时）、守卫；图库加带修改时间的列表与删除。这时还没有写入方，清扫是空跑，靠测试钉住。盘上形状不变。✅ 已落（`ImageStore` 不再露 `put`：`register({ name, listRefs })` 回 `ImageWriter`（`put` / `keep`），`sweep({ now })` 回报删了哪些，`close()` 登记进关停的 flush 段；清扫接在 `startHistoryRetention` 那一轮的末尾，历史那半出错也照清；守卫 `images/__tests__/image-store-single-door.test.ts`。㉙ 要的「按引用方分开的集合」登记表里各家本来就分着，到时加一个口，不用改登记的形状）清扫必须排在第一个写入方之前：图按内容起名后会被几家共用，先有写入方再补清扫，中间那几个提交里按文件名直接删会删到别人还在用的图。
  - ⑳b 聊天附件进图库：上传走 `imageStore.put`，会话的 `images` 装 `ImageRef`，读口换 `/api/images/<ref>`；删会话不再直接删图，三处现存泄漏（传了没发、会话被修剪、老消息被截）由清扫收走；迁移把 `assets/chat/` 的图按摘要搬进 `images/` 并改写会话；视觉副模型失败时不再把整张图的 base64 写进日志。抬修订号。✅ 已落（修订号 24；施工时定的要点：①会话库是引用方，登记在装配里，名字叫「女仆对话」，写入口挂在运行时上叫 `chatImages`（`AppRuntime.chatImages`（10-04 主人认）），会话库加 `listImageRefs()`——文件只要认得出消息就收它的图（缺面孔三格的也算），读不成 JSON 的跳过，目录或文件读不了（不是「没有」）就抛；②图库导出三个纯函数 `isValidImageRef` / `imageRefOf` / `imageExtOf`，引用的形状、一份字节会得到的名字、扩展名各只此一处；③上传：字节嗅探定格式（不信 `file.type`）、5MB、不收 gif，回 `{ ok, id }`，同一张图传两次同一个引用；④发消息：引用逐个先过形状、去重、`keep` 续期、读得出来的才进消息，形状不对和图已不在静默跳过；⑤旧读口 `GET /api/ai/assets/:id`、`deleteChatImage`、`runtime/chat-assets.ts` 整个退役，`image-mime.ts` 的三张表仍有卡片背景图 / 皮肤包在用，一张没删；目录表 `assets` 键提前在这一片删了（⑳e 只剩 `avatars`）；⑥迁移：`assets/chat` 挪进 `inputs`，`migration/chat-attachments.ts` 逐个读被会话引用的旧 id、嗅探、**复制**到新代 `images/`（走 `imageRefOf`，不走 `ImageWriter`），旧 id 路径越界 / 软链 / 超 8MB / 嗅探不过 / 文件不在的从消息里拿掉，已经是图库引用的原样留着（对新代再迁不改字节），孤儿不搬；`transfers` 逐个记（旧路径 → `images/<引用>`，`copy`），`skipped` 里「输入」一句加「对不上」「孤儿」按数量各一句；⑦迁移耗时：满量约 34 秒、四分之一量约 9 秒，比值 3.65 与 3.76（两次），附件各不相同且各被一场会话引用；⑧视觉副模型的告警里 data URL 只说「一张内联图，约 N KB」。真机待看：桌面版里聊天缩略图走 `/api/images/<ref>` 过 cookie 闸）🔗 迁移那半（⑥）随 3b-53 撤掉：0.x 的聊天附件与女仆对话不再进新代，`chat-attachments.ts`、`conversations.ts` 已删（迁移修订号 46）；上传与读口那半不动
  - ⑳c 拓展订阅头像进图库：资料缓存里拓展头像是 `avatar: ImageRef`，B 站的远端地址挪到 `avatarUrl`（留到 3a）；`sub-avatar-store` 与它的读口、开机清扫、订阅删除时的删图都退役；迁移搬 `avatars/` 并改写资料缓存。抬修订号。✅ 已落（修订号 25；施工时定的要点：①资料缓存的头像拆两格 `avatar?: ImageRef`（拓展订阅）与 `avatarUrl?: string`（B 站），没有头像就两格都缺、不再写空串；②资料缓存仓是引用方，登记在装配里，名字叫「订阅资料」，写入口挂在运行时上叫 `profileImages`（`AppRuntime.profileImages`（照 `chatImages` 的样子）），资料缓存仓加 `listImageRefs()`——还没载入就被问会先载入再答，免得清扫赶在开机载入之前拿空名单去删图（`load` 改成记住同一次载入）；③两条写入路都走 `put`：新建订阅（面板把候选的头像 data URL 放进草稿的 `cachedProfile.avatarUrl`——它是个网址——随 `POST` 交进来，路由层核 128 KiB / png jpeg webp / 魔数、字节只解一次，订阅落盘之后存进图库）与拓展报资料（约 96 KiB 封顶）；没给头像或存不下来时沿用旧引用，沿用先 `keep`，图已经不在了就两格都缺；两道关搬进 `runtime/subscription-avatar.ts`，回 `Result`；④读：`readProfileAvatar` 一处（拓展出卡 / 锐评卡），`ExtensionSourceReader.readAvatar` 形状不变、类型 `contentType` 改叫 `mime`（与图库同词）；`push-history` 的 `uavatarSnapshot` 改读 `avatarUrl`，行为不变；⑤退役 `sub-avatar-store.ts`、`GET /api/subscriptions/:id/avatar`（接线守卫钉老路径 404）、`bindSubAvatarCleanup`、开机 `sweep`、目录表 `avatars` 键；订阅删除后头像不再有人引用、由清扫收走（接线测试钉住：删订阅 → 资料缓存没了这条 → 过了宽限期清扫收走；另一条订阅还引用同一张图时不收）；⑥面板 `profileAvatarUrl`（`utils/up-display.ts`）是取址的唯一一处：有 `avatar` 走 `/api/images/<ref>`，否则 `avatarUrl`；⑦迁移：新增 `migration/profile-avatars.ts`（图库复制与读旧图的共用几件抽进 `migration/image-library.ts`，聊天附件那边改用），在「订阅资料」一步改写新代里的 `runtime/sub-runtime.json`——**按 `avatar` 值的形状认拓展还是 B 站**（`/` 开头的同源相对地址 → 顺着记录的键即订阅 id 找 `avatars/<id>.<png|jpeg|webp>`，读字节、嗅探、复制进图库、换成引用；`http(s)://` 或 `//` → 挪到 `avatarUrl`；空串 → 两格都缺），不读订阅文件；并存的两个文件认地址里 `?v=` 内容摘要对得上的、对不上取最新写的；对不上的（文件不在 / 嗅探不过 / 超 8MB / 软链 / 订阅 id 不是干净的文件名）两格都缺，没有资料引用的头像文件是孤儿、不搬；`transfers` 逐个记（`avatars/<订阅 id>.<后缀>` → `images/<引用>`，`copy`），`skipped` 里 `avatars` 的「输入」一句加「对不上」「孤儿」按数量各一句；`ZeroMove` 加 `input` 一种（整个只作迁移输入，在就记进没带过来的）；改写只在有变化时写新文件；⑧备份不含资料缓存与头像，没抬备份版本；⑨迁移耗时：满量约 33 秒、四分之一量约 9 秒，比值 3.70，每个拓展订阅一张互不相同的头像、被资料缓存引用。真机待看：桌面版里订阅头像走 `/api/images/<ref>` 过 cookie 闸）
  - ⑳d 历史配图与重推原件进图库：消息的 `imageRef` → `image`，行的 `uavatarSnapshot` → `avatarSnapshot`（只装图库引用；拓展行开始有快照，B 站行空着到 3a，旧行的远端地址迁移时丢掉），重推原件的 `{ ref, mime, own }` 并成 `image: ImageRef`；保留期清扫、`deleteRange`、重推原件的删除都不再按文件名删图；迁移搬 `history/img/` 与原件自存的图。抬修订号。✅ 已落（修订号 26；施工时定的要点：①`ImageRef` 的形状正则 `IMAGE_REF_PATTERN`（与扩展名表 `IMAGE_REF_EXTENSIONS`）放 internal，图库的 `isValidImageRef`、历史行与重推原件的 schema 共用，图库的格式表用 `satisfies` 钉成同一组，测试钉着两边对同一组名字答案一致；②历史仓 `createHistoryStore` 要 `images: ImageWriter`，`reduce` 走 `put`，过不了图库（不是图、超 8MB）这一格缺着、行照写、记一句 warn，composite 只记第一张、第一张存不进后面的也不顶上；头像快照在 `record` 建行时才 `keep`（`NewHistoryEntry.avatarSnapshot` 是抄来的引用），续不上或续期出错都不写这一格、行照写；拓展行抄资料缓存的 `avatar`、B 站行不带；③两家引用方各登记各的：「推送历史」（`listHistoryImageRefs`，在 `retention.ts`：读水位线、只读水位线之后的日文件，本体行与补丁行都数、不过 schema 宁多勿少，读不动就抛）与「重推原件」（`listRepushImageRefs`，在 `repush-store.ts`：盘上每份原件里的图）；名单都是只吃 `dataRoot` 的模块级函数，所以图库先建、先登记，再把存图的口交给两个仓，没有先有鸡还是先有蛋；两家拿到的是同一个 writer，运行时只挂 `historyImages`；图库的 `close` 因此挪到历史仓之前登记（同段后登记的先跑），`flush-phase-order.test.ts` 加了一条证先后的用例；④重推原件每一张图（含第一张）自己 `put`，`RepushAppendItem.reduced` 删掉，图过不了图库 `append` 抛、由历史仓收成 warn；读回走 `imageStore.read`，mime 随引用；`drop` 只删 JSON，`dropDay` 抽成模块级 `dropRepushDay(dataRoot, day)`，`retention.ts` 不再建仓也不再有 `repush?` 注入口；`version` 不抬，新旧按图格的值认（对象 = 旧、字符串 = 引用）；⑤`sweepHistoryRetention` 只推水位线、删原件日目录，`deleteDayImages` / `mimeToExt` / `imageDir` / `GET /api/history/img/:name` 全退役，`deleteRange` 只删行与原件；⑥wire：消息 `imageRef` → `image`、`uavatarSnapshot` → `avatarSnapshot`，消息多一格 `kind`（面板靠它在迁移拿掉了图格的老行上仍写「图已清理」）；面板抽出 `utils/image-url.ts` 的 `imageUrl`（聊天附件、订阅头像、历史配图三处共用，`chatImageUrl` 删掉），`historyRowAvatarUrl` 收拢历史页与首页两处头像取址，过了保留期的行不用头像快照（那几天已不是引用方，图随时会被清走）；⑦迁移：`history/img/` 与原件日目录里不是 `.json` 的东西不整目录搬（`ZeroMove` 的 `move` 加了 `inputs` 谓词，同一句话的合并成一条记在目录上、写明共几个），新增 `migration/history-images.ts`；「推送历史」那一步改成先清扫（水位线只由此刻与保留天数定、不依赖行的形状）、再日文件（行的形状与图格同一趟读写：保留期内的读文件、嗅探、复制进图库、`imageRef` 原位换成 `image`；水位线及以前的拿掉 `imageRef`、不读图文件；`uavatarSnapshot` 一律丢掉）、再原件（`v` → `version` 与图格一趟写，`own` 的从原件日目录读、其余从 `history/img/` 读，任何一张读不到整份不搬），已经是现在形状的行与补丁行也迁图格，没有 `identity` 的坏行整行原样；图的复制共用 `image-library.ts` 的复制件，加了按路径缓存的 `copyFile`（同一个文件行和原件各引用一回只读一次），并改成不逐张同步目录（storage 包 `atomicWriteFile` 的异步版加了 `syncDirectory: false` 选项，文件各自照样原子写；历史图是几千到上万张，逐张目录 fsync 实测每张 7.8 毫秒对 4.4 毫秒），`images/` 的目录由 `migrateZeroGeneration` 在改名之前同步一次；报告里没搬的按数量各记一句（过了保留期的、孤儿、对不上的、整份作废的原件）；⑧备份不含历史与图，没抬备份版本；⑨迁移耗时：满量约 27–34 秒、四分之一量约 23–25 秒，比值 1.49 与 1.08（两次）—— 保留期内那 31 天 × 120 张图每张内容各不相同、两档都复制一样多，复制的活（每张约 4 毫秒，主要是 fsync）不随量涨，所以比值比 ⑳c 之前的 3.7 低得多，这条判据对历史改写那一步超线性拖慢的灵敏度也随之下降，要不要让四分之一量的保留天数也缩成 1/4 等主人定）
  - ⑳e 目录表删 `avatars`、`assets` 两个过渡键（`assets` 键 ⑳b、`avatars` 键 ⑳c 已提前删），文档收尾，⑨ 复测。 ✅ 已落（10-05：两个过渡键已随 ⑳b ⑳c 提前删；迁移耗时夹具让两档的 0.x 历史保留天数也按 1/4 缩（满量 60 天、四分之一量 15 天），否则 ⑳d 起最重的那一步「复制保留期内的历史图」两档一样多、比值掉到 1 点几；改后满量约 50 秒、四分之一量约 13 秒、比值 3.75。真实用户：保留期内每张历史图读 + 写约 4 毫秒，90 天 × 120 张约多 45 到 50 秒）
  - 真机待看（⑳ 全片，主人机器上）：桌面版里聊天缩略图、订阅头像、历史配图与头像快照都走 `/api/images/<ref>`、靠 cookie 过闸，这条路只验过壁纸与字体；拿主人真实的 0.x 数据迁一遍（附件、拓展头像、保留期内的历史图都只跑过夹具）；清扫在有真数据时删得对不对（删会话、删订阅、过保留期之后各等一轮）。
  - 清扫挂在现有 6 小时加开机的那个活上：先推历史的水位线，紧接着跑图库清扫；清扫本身是独立函数，㉙ 手动触发时直接调。引用从一家抄到另一家时（新历史行抄资料缓存里的头像），抄的一方刷新图的修改时间，清扫扫到一半也不会两边都漏。
  - 勘察到的事实（施工时不用重查）：
    - 重推每试一次，`appendToRow` 都把同一张图在 `history/img/` 再写一份（名字带行内下标）；进图库后按内容起名，自动消失。composite 历史只存第一张图，第二张起由原件自存在 `history/repush/<日>/`（标 `own`），所以历史图其实有两处。
    - 历史图的扩展名信 payload 声明的 mime、不嗅探；订阅头像后缀是 `jpeg`，图库一律 `jpg`；聊天上传信客户端声明的 `file.type`。进图库后一律按嗅探。
    - 测试与迁移夹具里的图大多是几个字节的占位内容（`Buffer.from("png")`、只写 4 个魔数字节的 `fakeBinary`），过不了嗅探，要换成真图字节；迁移耗时夹具里的图内容全是重复的（历史图只有 5 种内容）。
    - 迁移：非 jsonl 文件都是硬链接，`sub-runtime.json` 也是，改它必须写新文件再原子换名；`ZeroMove` 只有整目录同名搬，没有逐文件改名的种类；修订号钉的摘要只折进 `transfers`、`skipped`、`rewritten`，改名后的图要有地方记才钉得住；`sweepMigratedHistory` 的孤儿判据要日文件已是最新形状才读得出图格，图格改名时这个读取点要同步。
    - 读口现状不齐：历史配图不带 `Cache-Control`，聊天附件是 `public`，头像与图库口是 `private`；换成图库口后统一。`Avatar` 原子对同源地址也带 `no-referrer`，无碍。
    - 守卫 13 没有 `RepushSnapshot` 这个根（data-and-migration 写的「每种载荷都有去向」那条加固 10-03 已挪去 3a / 3b）。
    - 给每张图算摘要估计只让迁移多个位数百分比（估的，⑳d 后实测）；真实卡片图比夹具的 3KB 大得多。
    - 桌面版里这三种图经 cookie 过闸只验过壁纸与字体，换读口后真机逐个看一眼。
- **㉑ 开片（10-05）**：先勘察，再一题一题问主人，定案在 ADR-0021 决策 22 与 25 下 10-05「㉑ 开片」的 🔗。切成五小片依次提交：
  - ㉑a 过滤键改名（纯改名，行为不变）：`blockForward` / `blockArticle` / `blockDraw` / `blockAv` → `blockReposts` / `blockArticles` / `blockImages` / `blockVideos`，`whitelistKeywords` / `whitelistRegex` → `allowKeywords` / `allowRegex`；schema、引擎接线、面板与字段文案跟上；迁移加一步改写全局与订阅覆盖两处，冻住 0.x 的过滤键词表，抬修订号（26 → 27），备份版本要不要抬施工时对着 ⑬c 的先例定。
  - ㉑b 作品模型与取段函数：`Post` / `PostImage` / `Creator` / `RichText` / `Attachment` 进 `internal`；`RichText` 的校验（片段的字拼起来必须等于 `text`，对不上就丢）；唯一取段函数的两种拼法（过滤：无前缀换行；AI：「标题：」「视频标题：」「（转发自 X：…）」），进守卫 4 的点名表。只有新增代码，还没有调用方。
  - ㉑c 出卡器吃 `Post`（B 站这条）：B 站原始数据到 `Post` 的翻译放 `packages/dynamic`；出卡器的入口改吃 `Post`；链接预览、卡片预览路由、示例卡、开发工具场景跟上。先各用单独一步去头像、去小图标、换数字排版并记进批准清单，之后换入口那一步十份快照一字不差。
  - ㉑d 拓展这条：拓展上报到 `Post` 的翻译放服务端；图存进图库（写入方 `postImages`），出卡器按引用取图；`extension-post-work` 里自己造节点的那段退役。
  - ㉑e 取段收口与过滤吃 `Post`：过滤、AI 点评、AI 聊天工具、拓展作品四处拼法都换成那一个函数；类型开关只看最外层 `Post`、对所有来源生效，面板里拓展订阅露出四个开关，屏蔽提醒措辞改中立；文档收尾。
  - ✅ 五小片都已落（10-05）。施工中补定的：`Post` 加 `title?`、`video.durationSec` 改选填；㉑c 实际走了六步（去头像、去小图标与表情图、数字由核心排版、附加块按形状画、换入口、删旧入口），前四步的字节变化都在批准清单里，换入口那步 23 份快照零变化；出卡器新入口 `generatePostCard`，B 站翻译 `postFromDynamic`（`packages/dynamic`），拓展翻译 `postFromReport`（服务端），过滤 `filterPost` 直接吃折好的 `ContentFilters`；拓展作品的图在出卡前才写进图库（被屏蔽的作品不写盘）；B 站替身棘轮加了两个文件共 9 处（B 站显示值的解析，3a 掉出）。
  - 留给 3a 的：`packages/ai/src/tools.ts` 的 `get_user_dynamics` 还有一份自己的作品文字拼法（ai 包够不着 `postFromDynamic`，dynamic 依赖 ai），随来源自带 AI 工具处理；卡片预览路由的出卡器还没接图库解析口（B 站交引用后接上）；B 站作品卡的头像、正文小图标、表情图等 B 站交引用后回来；直播卡的拓展头像仍是字节转 data URL（㉒）。
  - 真机待看（㉑ 全片，主人机器上）：没头像时默认皮肤头部左边空出的那一列；面板规则页里这几个过滤开关（拓展订阅现在也露出四个类型开关）；拓展作品卡经图库出图（只跑过假源的端到端）；拿真实 0.x 数据迁一遍过滤键。
  - 勘察到的事实（施工时不用重查）：
    - 代码里没有任何作品模型的领域类型，只有 `ImageRef` 与 `PostPushPart`；撞名的有三处局部别名 `type Post = SubscriptionReportValue<"post">` 与面板的 `RichText` 组件。
    - 包依赖：`image` 只依赖 `blive` 与 `internal`、不依赖 `dynamic`，`dynamic` 依赖 `image`；所以类型与取段函数只有放 `internal` 才够得着所有消费者，十份字节快照（输入是 B 站原始数据）要跟着翻译挪到够得着它的地方。
    - 作品文字现在各拼各的：过滤（`dynamic-filter.ts` 的 `getDynamicText`，图文标题不要求有摘要）、AI 点评（`dynamic-engine.ts` 的 `extractDynamicText`，标题只在有摘要时带、转发括号里用空格连、丢原作品的图文标题）、AI 聊天工具（`packages/ai/src/tools.ts`，空格连、没有转发）、拓展过滤与拓展 AI（`extension-post-work.ts`）。
    - 涉及作品的卡只有 `dynamic` 一种；皮肤字段表声明只增不删不改名，`card-data.test.ts` 钉着产出路径与表恰好相等；`dynamic.time` 对外层卡含「· 投稿了视频」后缀；`data-bn` 挂点被 `card-hooks.test.ts` 双向钉着。批准清单 `approved-card-diffs.ts` 现在是空的。
    - 过滤 schema 是 strip：全局那份老键会让整份拒收，覆盖里的老键被静默剥掉，所以迁移步骤要有自己的测试；覆盖版 schema 必须保持无默认纯可选。守卫 13 不覆盖这类普通字段改名。
    - 类型开关现在对拓展作品一律不看（`dynamic-filter.ts` 注释写了当时的理由），面板 `PerUpEditor` 用 `typeToggles={isBili}` 门控；「屏蔽后提醒」在生产里是死的（`engines.ts` 把 `notify` 固定成 `false`）。
    - 拓展 v2 上报是 `topics[]`、时间是毫秒、图是字节；契约 v3 在 3b，所以服务端收件口要有 v2 形状到 `Post` 的翻译。
    - 链接预览经 `videoToDynamic` 伪造一条视频动态，伪造里的 `badge.text` 还决定「投稿了视频」标签，是隐含耦合。
  - 施工中发现的问题（㉑ 不修）：出卡器的 UnoCSS 生成器整个进程只建一个，属性层会跨卡累积，所以一张卡的字节取决于它前面渲染过什么（㉑c 去掉「游戏」标签后，排在后面的 12 份无关快照各少了一个没人用的 `--un-border-opacity`）。要让属性层每卡独立会让所有快照再变一次，另开一件事看。
- **㉒ 开片（10-05）**：先勘察，再一题一题问主人（定案在 ADR-0021 决策 24 下 10-05 的 🔗）。不动盘上形状、不抬修订号（人数、封面、开播时间都只在内存里）。这一片改 contract 形状（在播行的观看人数由字符串改数字），面板同片跟到照旧能用。切成五小片依次提交：
  - ㉒a 先补测试钉住现状：B 站收到观看人数那段（存值、两秒节流、发出去的实参、在播快照）今天零覆盖；「输入 → 排版」那一步四份直播快照绕过了（夹具直接写排好版的 `LiveCardView`），守卫 10 拦不住它的回归。
  - ㉒b B 站直播卡去头像（`Creator` 只收图库引用，B 站头像 3a 才有；照 ㉑c 第 1 步的先例单独一步，登记批准清单）。
  - ㉒c 输入换成最终形状：`author` → `creator: Creator`、`area` → `category`、`online` → `currentViewers`、`fans` → `followers`、`fansChanged` → `followersDelta`；人数只收数字、缺了就缺键、卡上那一格不画（B 站人气的 `?? 0` 与点赞初值「0」都去掉）；`startedAt` 改 ISO（只改卡的输入，拓展内部的在播表、场次仍是毫秒，交给卡之前转一次）；`cover` 改 `PostImage`（B 站照旧带 `url`；引用解析不到当成没有封面，画「暂无封面」）。出卡器入口收成一个 `generateLiveCard`（原来吃 B 站原始数据的那个删掉，`generateNeutralLiveCard` 改这个名）；B 站翻译 `biliLiveCardInput` 搬到 `packages/live`、改叫 `liveCardInputFromRoomInfo`，两份 `live_time` 解析合成一份；拓展那边的拼装收成 `liveCardInputFromReport`。`LiveCardView` 与皮肤字段名不动（㉔）。✅ 已落（10-05，施工时定的要点）：**㉒e 并进了这一步**——拓展直播的头像与封面在输入里只能是图库引用（`Creator.avatar` 是 `ImageRef`），不并的话拓展直播卡会暂时没头像，所以拓展那半直接做到底：单列一家引用方 `liveImages`（`runtime/bootstrap.ts` 登记，名单是在播表里此刻那些行的封面与事件头像，字节算得出引用），`extensionCardAuthor` 字节转 data URL 那条路退役，`ExtensionSourceReader.readAvatar` 随之删掉。与 ㉒e 原文唯一的差别：在播表（拓展 v2 上报的形状）里存的仍是字节，所以**图在出卡那一刻才存进图库**（`deferImageWrites` 推迟、包在渲染器外的 `committing`；版式藏起卡片 / 关了出图不写盘，写盘失败降级纯文字），周期卡每次出卡再存一遍；契约 v3（3b）上报直接交引用后这一步自然消失。**累计观看的过渡**：B 站的 `totalViewers` 今天是 `text_small` 字符串、输入只收数字，所以翻译「是数字才给」，B 站下播卡的「累计观看人数」一格暂时不画，㉒d 把引擎改存精确数后自动接上、翻译不用再动。缺了就缺键的其余几格都已落（人气不补 0、点赞初值去掉）；`parseBiliLiveTime` 与 `biliLiveTimeToIso` 合成一份留在 `packages/live`（`live-card-input.ts`）；出图器的 `LiveData` 随翻译搬走后删掉，`htmlToPlain` 从 `packages/image` 导出给翻译用；拓展没头像时从前给一张透明占位，现在头像块整块收起。
  - ㉒d 观看人数改数字：B 站存 `WATCHED_CHANGE` 的 `num`；「暂未获取到」不再写回直播数据，文字模板的 `{watched}` 缺数时由文字渲染器在出口印；总线 `live-viewers-changed.viewers`、契约在播行的 `viewers`、面板「正在直播」那一列都改数字、统一用 `formatCount` 排；统计不再解析「1.2万」（`parseBiliViewers` 只留给迁移）。只改类型不改名，事件的最终形状（按订阅认、拆两格）仍归 3b。✅ 已落（10-05，施工时定的要点）：解析器 `parseWatched` 只认 `num`，`WATCHED_CHANGE` 事件里的 `textSmall` 删了（没人用，`text_small` 也不再是解析成败的条件）；`LiveData.watchedNum` 收成 `number`，`emitViewers` / 总线 `live-viewers-changed.viewers` / WS 同名帧 / `LiveListenerSnapshot.viewers` 都是 `number`；两处写回删了（`tickPushAtTime`、`bootstrapRoomStateInner`），在播快照的哨兵过滤随之没了（0 是真数，回 0）；「暂未获取到」只在 `renderLiveText` 的 `{watched}` 出口印（`renderLiveStreaming` 与 `LiveTextValues.watched` 收成 `number | undefined`，拓展那条路传进来的本来就是数字，缺了同样印这一句）；下播卡的「累计观看人数」回来（㉒c 留的「是数字才给」自动接上，一帧没收到这一格不画）；面板 B 站行与拓展行合成一套 `formatViewers`（`formatCount`，没有数「—」，0 写「0」）；统计的 B 站适配直接把数字喂给记录器，`parseBiliViewers` 搬进 `migration/stats.ts`（只给读 0.x 字符串峰值用）；`PostImageSink` 改名 `ImageSink`（作品与拓展直播共用）。**顺手收的一个现存问题**：`liveData` 是会话级的，上一场的观看人数与点赞会留到下一场；现在开播事件被接受那一刻（`onLiveStart`，刷房间信息与发开播卡之前）清掉这两格，下播时不清、断流接续被「已经是开播状态」的去重挡住不算新的一场、重启补报本来就是新会话。`formatCount` 与 B 站原来排的字的对照在 `packages/internal` 的 `format.test.ts`（只有真实录制帧为证的 87334 ↔ 「8.7万」进断言，其余是推测、标明不确定）。
  - ㉒e（**已并进 ㉒c**，见上）拓展直播的封面与头像进图库：单列一家引用方 `liveImages`，名单是在播表里的封面与事件头像（直播可以超过 24 小时，周期卡几小时后还要用封面，不能像作品那样只靠宽限期）；`extensionCardAuthor` 字节转 data URL 那条路退役。
  - 勘察到的事实（施工时不用重查）：
    - 四种 status：`start` / `streaming` / `end` / `offline`；补报不是单独一种卡（画 `streaming`，推送类型是 `CatchUp`）。`offline` 没有生产调用方，只有测试在走。
    - `WATCHED_CHANGE` 的载荷是 `{ num, text_small, text_large }`，解析器要求 `num` 与 `text_small` 同时在，今天存的是 `text_small`；`text_large` 与 `rank-count` 没人用，别顺手接。B 站的「人气」来自房间接口的 `online`（类型没声明，靠 any 读），不是 WS。
    - 观看人数字符串今天的三个去处：下播卡的累计观看、文案 `{watched}`（缺了写回「暂未获取到」，下播卡因此可能印出这句）、总线事件（统计解析回数字 / WS → 面板）。统计的峰值盘上早就是数字。
    - 主人设的自定义直播封面是另一条路（`colorOptions.liveCoverImage` → `resolveAsset`），优先级 自定义 > 输入 > 「暂无封面」占位，这一片不动。
    - 卡上「开播时间」固定 UTC+8，作品卡的时间按机器本地时区；全局时区设置单开一小片，这一片不做。🔗 现状（3b-11 已落）：两处时间都按核心设置 `timezone` 排（默认 `Asia/Shanghai`），不再看机器时区。
    - 棘轮：`bus-event-payloads` 的 `RAW_STRINGS["live-viewers-changed.viewers"]` 在那一格改成非字符串时必须同步删；B 站替身棘轮里 `bili-live-input.ts`、`image-renderer.ts`、`routes/cards.ts`、`stats/bili-format.ts`、`stats/bili-source.ts` 的上限会随搬动变（只降不升，要升先问主人）。
    - 往卡片基线里加新夹具要放末尾：出图器的 UnoCSS 生成器全进程一个，前面渲染过什么会影响后面的字节。
  - 留着的：`formatCount` 整万写「1.0万」，B 站原来多半写「1万」（没有录制帧可证，只有 87334 → 「8.7万」对得上）；重连核对那条分支把断线前后当同一场、计数不重置（它本来的口径）；mock 预览与示例里的 `LiveCardView` 仍是排好的字符串（㉔）。
  - 真机待看（㉒ 全片）：B 站直播卡没头像时默认皮肤头部的样子（与 ㉑ 同一类）；面板「正在直播」那一列 B 站行的人数换成我们自己排的字之后和原来差多少。
- **㉓ 开片（10-05）**：先勘察，再一题一题问主人（定案在 ADR-0021 决策 26 下 10-05 的 🔗）。会员与醒目留言今天没有任何中立类型，B 站消息进来后直接在直播会话里拼文字、出卡、推送；这一片从零建模型，并把「醒目留言按价格算档」从出图器搬到 B 站那一侧。㉓d 动盘（修订号 27 → 28，备份版本 7 → 8），其余小片不动盘。切成五小片依次提交：
  - ㉓a 只加测试钉住现状：醒目留言六档的边界（按元 50 / 100 / 500 / 1000 / 2000 五条线）与各档的色、时长；`minScPrice` 等于门槛时放行、`minGuardLevel` 三个值 × 三档的放行表；醒目留言与上舰的兜底文字原文、上舰卡三句宣告语原文（舰长那句带「号」）；上舰文案的渲染（含 `-uname` 老写法）。顺带修「自定义文案开着、图片是空串时不兜底官方图」（`room-session.ts` 里 `tier?.imageUrl ?? guardImg`，空串不算缺；先写红的复现测试再修）。
  - ㉓b 纯新增、还没有调用方：`MembershipProgram` / `MembershipTier` / `MembershipEvent` / `SuperchatEvent`（住 `packages/internal`，3a 随中立部分搬）；B 站档位表 `packages/internal/src/bilibili-guard.ts` 的 `BILIBILI_GUARD_PROGRAM`（key、名字、rank、徽章地址、档色、宣告语），`guard_level` 与 rank 的换算只在这个文件里；翻译 `membershipEventFromLiveEvent` / `superchatEventFromLiveEvent`（住 `packages/live`，醒目留言的档在这里按价格算）；`formatAmount(amount, currency)`（住 `packages/internal/src/format.ts`）。
  - ㉓c 两种卡换新输入与新入口：`generateSCCard` / `generateGuardCard` → `generateSuperchatCard` / `generateMembershipCard`，输入 `SuperchatCardInput` / `MembershipCardInput`。分步做、每步单独登记批准清单：去观众与主播头像；删会员卡的房管那一格与为它调的接口；时长走 `formatDuration`、金额走 `formatAmount`；宣告语取档位表；档色取档位表；皮肤字段改名；最后换入口（这一步快照应零变化）。出图器对 `blive` 的依赖随 `GuardLevel` 的 7 处引用一起去掉。
  - ㉓d 设置搬家与迁移：`filters.minScPrice` → `defaults.superchat.minAmount`、`filters.minGuardLevel` → `defaults.membership.minRank.guard`（逐订阅覆盖同样各加一段）；`templates.guardBuy` → `templates.membership.guard = { enabled, default, tiers }`；占位符改名与 `-key` 改写；默认文案账本的路径跟着改写。规则页同片跟到照旧能用。
  - ㉓e 面板收口（删 `guard-levels.ts`、色块读档位表、上舰文案一节按「体系默认 + 每档」铺）、守卫登记、文档。
  - 主人定的：
    - **档位表 3a 之前住 `packages/internal` 的新文件**，名字老实带 `bilibili`，面板、引擎、出图器都读这一处，面板的 `guard-levels.ts` 删掉；3a 搬进 `bilibili/` 的来源描述符。B 站替身棘轮为它新登记一行。被否的备选：这一片先做下发接口（给没定形的接口提前定形）；面板继续留自己的一份（两份真源）。
    - **醒目留言卡与会员卡两组皮肤字段这一片就改到最终名字**（开发期没有 1.0 的皮肤，版本只在 alpha 前抬一次，不必等 ㉔）：`sender.name` / `sender.face` → `viewer.name` / `viewer.avatar`；`sc.price` / `sc.priceValue` / `sc.duration` / `sc.text` → `superchat.amount` / `superchat.amountValue` / `superchat.duration` / `superchat.text`；`sc.level`（0–5）→ `superchat.rank`（1–6，1 最低）；`user.name` / `user.face` → `viewer.name` / `viewer.avatar`；`guard.level`（1 = 总督）→ `membership.rank`（1 = 舰长）；`guard.levelName` → `membership.tierName`；`guard.badge` → `membership.icon`；`guard.text` → `membership.announcement`。卡种键 `sc` / `guard`、主播那两格 `master.name` / `master.face`、抬皮肤格式版本仍归 ㉔。
    - **会员卡上不再有房管这一格**：`user.isAdmin` 连同「买舰的人是房管就把主播名换成『房管』」那段替换一起删，为它多调的那次接口也去掉。各平台的房管标记都挂在聊天消息上，会员事件上没有；那段替换没有任何说明，看着是写错了位置。ADR-0023 里「`isAdmin` 改成 `isModerator`」那句作废。
    - **上舰文案的占位符这一片改**：`{uname}` → `{viewer}`、`{mname}` → `{name}`、`{guard}` → `{tier}`，盘上的 `-key` 老写法迁移时改写成花括号写法，上舰文案改由 `interpolate` 填。其余 6 条直播文案（特别弹幕、特别进场、弹幕总结等）仍等 3b；改写规则写成共用函数，3b 直接调。
    - **`custom` 体系只建地基**：类型里有 `"custom"`，文案按档的 key 取、取不到用体系默认，配单元测试；面板（按档名增删、没有 rank 的体系的开关）留 3b，1.0 里它没有真实来源。
    - **档色留卡片那一套**（舰长 `#4ebcec`、提督 `#d8a0e6`、总督 `#f2a053`），面板的三个色块跟着变。面板上总督色块会与「上舰」的代表色同为 `#f2a053`，主人知情。**止色（10-06 更正）**：档位加可选的 `colorEnd`，B 站三档填回 0.x 的止色（`#b494e5` / `#b494e5` / `#ef5f5f`），会员卡的背景照旧是渐变；没声明止色的档是单色，面板色块只读 `color`。原先定的是「止色取同一个值、不加格」，那是开片时漏查了：默认皮肤的外框背景是从起色到止色的渐变，同值会让三张会员卡变成单色，施工 ㉓c 时才发现，主人改定加这一格。
    - **醒目留言的时长走 `formatDuration`**：「60秒 / 2分钟 / 5分钟 / 30分钟」变成「1分 / 2分 / 5分 / 30分」，后两档不变。被否的备选：把 `formatDuration` 的「分」改成「分钟」（所有直播卡跟着变）；醒目留言卡单写一个排版（多一个时长函数）。
    - **名字**：见 ㉓b ㉓c 两行；「会员体系」用 `Program`，起名表加一行；`formatAmount` 进「一个名字一个家」点名表。会员文案的一条沿用 `{ template, imageUrl }`。
    - **`blive` 并进 `live`，3a 搬家时做**（ADR-0021 决策 1 的 🔗）。这一片做完出图器就不再依赖 `blive`，合包的循环依赖障碍随之消失。
    - **上舰文案的默认值与迁移**：体系默认的出厂值是「{viewer} 成为了 {name} 的{tier}！」（推出去的字与今天三档默认一字不差）；迁移时逐档看，文案还是旧默认且图片没填的不搬、跟随体系默认，改过的才进每档覆盖。原迁移表写的「三档原样搬、默认留空」作废。面板上某一档没填就显示跟随默认，图片没填用该档的官方徽章图。
    - **皮肤按档换色的挂点归 ㉔**：今天皮肤读得到档色变量（`--bn-card-tier-color`），但清洗器只放行 `[data-bn="…"]` 一种选择器，写不出「档位是几时」的条件；加挂点是在设计皮肤契约，和 ㉔ 的其它皮肤改动一起做。
  - 照先例或施工时直接定的：
    - B 站这两种卡 3a 前不画头像（照 ㉑ ㉒）。连带：醒目留言出卡前不再调接口查发送者（名字用消息里带的），原来查不到会退成一行文字，现在总是出卡。
    - 醒目留言配色用自己的六色，不接 B 站消息里带的颜色；档超出六色用最后一色，没有档用第一色。
    - 醒目留言的档由 B 站那一侧按价格算，边界照今天；留言时长取消息里自带的秒数（解析器已读出，原来没往下传）。
    - 金额固定中文环境、关掉千分位：「¥30」「¥2000」与今天一字不差，「¥30.5」「US$30」「JP¥30」。
    - 没配门槛就是全推：迁移时旧值是默认的不写（`minGuardLevel` 3、`minScPrice` 0），调过的才写（提督以上 → `guard: 2`，仅总督 → `guard: 3`）。逐订阅覆盖里的 `minRank` 按体系合并，不整表替换。
    - 认不出的档位丢掉并记一条警告（原来会带着一张空图推出去）。
    - B 站上舰事件只填月数（`num`）与金额（金瓜子除以 1000，`CNY`）；开通还是续费、谁送的，上舰消息里没有，不填。续费照旧推一张卡。
    - 舰长徽章继续用 B 站的图链（`tier.icon` 带 `url`），两份相同的图链表合成一份；改本地资产归 3a。
  - 勘察到的事实（施工时不用重查）：
    - 上舰与醒目留言没有总线事件、契约类型、统计；历史行只有通用的 `feature`。`LivePushType` 只在进程内流转，改它不用迁移。
    - `guard_level` 的倒序换算今天不存在，只有一处直接拿数字比（`body.guard_level > this.sub.minGuardLevel`）；面板靠 `.reverse()` 排序。
    - 续费时 B 站同秒发三帧（`GUARD_BUY` 与两种 `USER_TOAST_MSG`），业务只消费 `GUARD_BUY`，另两帧不许并流。
    - 上舰消息的 `price` 是金瓜子（198000 = 198 元），没有头像、没有房管标记；醒目留言消息的 `price` 是元，带 `time`（秒）、`user_info.face`、`user_info.manager` 与 B 站自己的一组配色。
    - 醒目留言正文在判门槛之前就记进弹幕收集，被门槛挡掉的也算进词云。
    - 自定义图与官方图是以链接段推出去的，不是内联图。
    - 默认文案账本按点路径记，`guardBuy.<档>.template` / `.imageUrl` 六条（空串也是一片叶子）；`renameTemplateLedger` 只换路径首段，新路径多一层，要专门改写。
    - `feature-renames.ts` 的 `FILTER_KEY_RENAMES` 用 `satisfies Record<ZeroFilterKey, keyof ContentFilters>` 钉着，两个门槛键离开 `ContentFilters` 时编译即红，要从「改名」改成「搬家」。
    - 卡片基线：醒目留言 3 份、上舰 3 份；它们排在锐评与词云前面，字节一变后面三份可能被 UnoCSS 属性层牵连。
    - 新文件里出现 `bili` / `bilibili` 的标识符段或字面量，B 站替身棘轮就红；只有 `bilibili-guard.ts` 登记。
  - 留给 3a：舰长图标改本地资产；两种卡的头像（醒目留言用消息里自带的头像地址，会员卡要重新接一次查询）；档位表搬进来源描述符并由 `/api/sources` 下发；`blive` 并进 `bilibili/live/`。留给 3b：其余 6 条直播文案的占位符改名与 `-key` 改写、`applyTemplate` 删除；会员与醒目留言的总线事件；拓展上报会员与醒目留言、`custom` 体系的面板。留给 ㉔：卡种键 `sc` / `guard`、`master.*` 两格、皮肤按档换色的挂点、抬皮肤格式版本。
  - ✅ 已落（10-06，施工时定的要点）：
    - 订阅视图加了 `subscriptionId`（翻译函数要订阅 id，引擎原来只认 uid）；上舰与醒目留言出卡前不再调接口查用户，`getUserInfoInLive` 没有调用方了、方法留着（3a 会员卡头像要用）。
    - 皮肤字段：没有 rank 的档 `membership.rank` 是 0；`superchat.rank` 永远落在 1–6（与取色同一个值），没有档是 1。会员档没有声明徽章或宣告语、醒目留言没有时长时，对应的块整块收起。
    - 取文案 `membershipTemplateOf(bundle, tierKey)`：文案与图片逐字段回落（档 → 体系默认）；某一档的文案是空串也跟随默认（原来推空文字）。`{tier}` 填档名，不再是 B 站消息里的礼物名（真数据里两者同字）。
    - 迁移在 `migration/membership-moves.ts` 与 `placeholders.ts`（`rewritePlaceholders` 是给 3b 复用的那个共用函数）。「没动过的档」认两代旧默认（0.12 的与更早的 `{user}` / `{mastername}` 那一代）；账本去掉旧六条、新路径两条记成已见，0.x 没有账本时新建一份只含这两条的。
    - 全局设置热更新原来靠「过滤变了」顺带覆盖门槛，门槛搬走后补了一道 `interactionChanged`（漏了的话改门槛要重启才生效）。
    - 规则页草稿合并把补丁里的 `null` 当「拿掉这个键」，与服务端一致，整页生效。
    - 面板只有 `apps/web/src/config/membership-programs.ts` 一个文件认得 B 站档位表（棘轮登记 2），组件都按「体系的档列表」铺；档位表经 `@bilibili-notify/internal/bilibili-guard` 子路径给面板。预览请求体 `guard.level` → `guard.tierKey`、`sc.price` → `sc.amount`（外层卡种键 ㉔）。预览页的档位钮改成由低到高，与规则页同序（主人 10-06 定）。
    - 棘轮：`bilibili-guard.ts` 1、`membership-programs.ts` 2，别的文件数字没变。
  - 留着的：迁移后，0.x 里手写过字面 `{name}` 的上舰文案会被当成主播名（0.x 不认它、原样印出）；`subscription-sources.md` 等处讲 3a 设计时仍写「面板的 `guard-levels.ts` 删掉」，那个文件 ㉓e 已删。
  - 真机待看（㉓ 全片）：会员卡与醒目留言卡没有头像时默认皮肤的样子；醒目留言时长写成「1分」「30分」的样子；会员卡背景仍是渐变；规则页直播门槛一节与上舰文案一节（体系默认 + 每档、占位显示跟随默认、清空一格能清掉）；面板三档色块换成卡片那套色；卡片预览页选档出图；改门槛不重启就生效；真实 0.x 数据迁一遍后门槛、改过的上舰文案、`-uname` 老写法对不对，且不亮「默认文案有更新」。
- **㉔ 开片（10-06）**：先勘察，再一题一题问主人（定案在 ADR-0023 决策 3 下 10-06 的 🔗）。这一片里是三类风险不同的活：纯改名（卡种键、字段、视图类型、文件，快照里没有这些字符串，零字节）、会改字节的（块名与挂点名进 HTML 的 `data-block` / `bn-blk-<id>` / `data-cell` / `data-bn`，画面不变）、动盘的（卡片样式设置搬家、皮肤包抬版、迁移）。㉔e 动盘（修订号 28 → 29，备份版本 8 → 9）。切成六小片依次提交：
  - ㉔a 只加测试钉住现状：七个卡种键与字段、块、挂点的全集；直播卡 `stats.popularity` / `stats.fans` 在三种状态下各取什么；作品卡外层把动作标签拼进时间那一行；`cardStyleByKind` 非空与皮肤指针指向自建皮肤时走迁移的现状（0.x 夹具里这两样今天全是空的）。
  - ㉔b 字段改名、视图类型改名、文件改名（目标零字节）：字段照 data-model「皮肤字段」对照表；`dynamic.action` → `post.label` 且时间字段只装时间（默认皮肤的时间块照旧把两样拼成同一行字，目标字节不变，变了就单独登记）；直播卡 `stats.popularity` 拆成 `stats.currentViewers` / `stats.likes`、`stats.fans` 拆成 `stats.followers` / `stats.totalViewers`；`LiveCardView` 等视图的字段名跟上；文件 `sc-card.tsx` → `superchat-card.tsx`、`guard-card.tsx` → `membership-card.tsx`、`dynamic-*` → `post-*`，`blocks/` 同理。
  - ㉔c 块名与挂点名按下表改，默认皮肤同步（显式块 id `video-desc` → `video-description`、`forward-count` → `share-count`）；字节变化逐类登记批准清单。
  - ㉔d 出图器给醒目留言卡与会员卡的外框和每个块加 `data-rank="<档位>"`（没有 rank 的会员档不带）；给皮肤作者与 AI 做皮肤的说明同步。六张基线的字节变（多了属性）。
  - ㉔e 卡种键改名、三套词表收成一套、卡片样式设置搬家、老皮肤指针回默认、皮肤包抬版与删退役字段、迁移；面板同片跟到照旧能用。
  - ㉔f 卡种中文名收成一份、守卫、文档。
  - 主人定的：
    - **卡种键**：`dynamic` → `post`、`sc` → `superchat`、`guard` → `membership`；`live`、`roastBoard`、`roastSolo`、`wordcloud` 不改（已经是中立词，`live` 与直播那一族特性键同根）。预览与测试推送请求里的 `dyn` 并进 `post`；`CardKind`（4 种）与 `CardSkinKind`（7 种）收成一套七个键。起名表补 `roast`。
    - **块名、挂点名、字段用同一套词，全部改一遍**（这是抬皮肤格式版本的那一次，1.0 之后改不动）。被否的备选：只改定案点名的四个；块名与挂点名都不动。改名表（没列的不改）：
      - 直播：`avatar` / `name` → `creatorAvatar` / `creatorName`；`desc` → `description`；`area` → `category`；`popularity` 拆成 `currentViewers` 与 `likes`；`fans` 拆成 `followers` 与 `totalViewers`。
      - 作品：`avatar` / `name` → `creatorAvatar` / `creatorName`；`additional` → `attachment`；`pics`（挂点 `pics` / `pic`）→ `images`（挂点 `images` / `image`）；`forward` → `repost`；`forwardCount` → `shareCount`；`videoDesc` → `videoDescription`。
      - 醒目留言：`avatar` / `name` → `viewerAvatar` / `viewerName`；`price` → `amount`；`to` 的挂点 `master` / `masterAvatar` / `masterName` → `creator` / `creatorAvatar` / `creatorName`。
      - 会员：`avatar` → `viewerAvatar`；`user` → `viewerName`；`master`（挂点 `masterAvatar` / `masterName`）→ `creator`（挂点 `creatorAvatar` / `creatorName`）；`badge` → `icon`；`text` → `announcement`。
      - 三处是这次的设计：头像与名字的块带上是谁的（「同名在所有卡上同义」也用到块名上）；直播卡两个随状态换含义的块拆成四个只显示一样东西的块，各自只在该出现的状态下显示，默认皮肤摆在原位、画面不变；会员卡的 `user` 改 `viewerName`（原定 `viewer`），与醒目留言卡一致。
    - **去掉「按卡种分开存的卡片样式」这一层**：`defaults.cardStyle` / `cardStyleByKind` → `defaults.cards { enabled, liveCoverImageIds }`，逐订阅覆盖 `overrides.cards { liveCoverImageIds? }`。迁移时把 `cardStyleByKind.live` 下的封面图并上来（两处都有时卡种那份赢，照今天的优先级），退役的 `font` / `fontAsset` / `glassOpacity` / `glassClear` 与没人读的逐订阅 / 按卡种 `enabled` 丢掉。理由：按卡种这一层原是给每种卡各配字体与玻璃效果的，那些挪进皮肤后只剩直播封面一个用途。被否的备选：照原定留 `byKind`（一层只有 `live` 有意义的壳）；七种卡都能配。
    - **皮肤按档换色用属性 `data-rank`**：清洗器今天就放行非 `data-bn` 的属性选择器，零改动。限制：默认皮肤用的档色变量是出图器写在元素上的，皮肤 CSS 盖不掉，换色要对每个部位各写一条规则。「皮肤包里声明一张色表、全卡生效」那条路以后有需要再加，两者不冲突。
    - **老皮肤包被拒收的提示**：「这是旧版本的卡片皮肤，1.0 起卡片皮肤的格式变了，需要重新制作。」
    - **开发期做的 1.0 皮肤抬版后失效**（开机被跳过、文件不删、用到它的地方回落默认皮肤），不写转换。
    - **皮肤数据版本号 `CARD_DATA_VERSION`** 跟皮肤格式版本一起从 1 抬到 2。
  - 照定案、照先例或施工时直接定的：
    - 老皮肤指针回默认（ADR-0022 决策 12 早就定了，迁移漏做）：指向用户自建老皮肤的全局与逐订阅指针改回 `default`，没有对应皮肤的旋钮删掉，补夹具与测试。
    - 皮肤包的退役字段 `variables` / `variablesByKind` 整套删（它们只为让老包装得进来，老包抬版后一律拒收）。
    - 卡片基线的样例名不改（批准清单按样例名认账、只追加）。目标表没提到的字段保持原名（`report.days`、`live.title` 等）。锐评榜单卡恒为空串的 `master.name` 删。
    - AI 对话里存的卡种键只有开发期会话里有，读时认不出的丢掉，不写迁移。
    - 去头像后空出来的列不在这一片收拾：头像 3a 就回来，拓展的卡现在就带头像，一张卡的列宽也没法按有没有头像切换。
  - 勘察到的事实（施工时不用重查）：
    - 卡种中文名 5 处各写一份：`constants.ts` 的 `CARD_SKIN_KIND_NAMES`、面板 `CardSkinEditor.tsx`、`cards/CardSkinSection.tsx`、`Cards.tsx`（两张表）、服务端 `routes/cards.ts`。
    - 落盘或过 wire 的卡种键：全局与逐订阅的 `cardStyleByKind`、皮肤包 `card-skin.json` 的 `cards.<kind>` 与 `variablesByKind`、AI 对话消息的 `cardSkins[].kinds`、contract 里预览与 AI 写 CSS 请求的 `kind`、皮肤摘要的 `kinds`、AI 工具的枚举。只在进程内的：`CardPropsByKind`、`FRAMES`、块库、`resolvedCardStyle`。
    - `cardStyle` 今天真有人读的只有 `enabled`（出图总开关）与 `liveCoverImages`；`cardStyleByKind` 只有 `live.liveCoverImages` 有意义；`cardStyleToColorOptions` 写死 `enable: true`。
    - 默认卡片皮肤是代码里的 `DEFAULT_CARD_SKIN`，不落盘；「`default.json` / `skin.json` 双文件」说的是界面皮肤，与这一片无关。默认皮肤里没有字段占位符也没有 `showIf`，所以字段改名零字节。
    - 老包拒收走 `parseCardSkin`，文案是 zod 的「schemaVersion 必须是 N」。测试与夹具里钉着字面 `schemaVersion: 1` 的有卡片皮肤与界面皮肤两批，界面皮肤那批不要动。
    - 皮肤 CSS 清洗器 free 档只查 `data-bn`（精确等号、值在挂点表里、起头挂点后不许紧跟 `+` / `~`），别的属性名不查；at 规则只放行 `@media`。块 CSS 必须以 `self` 起头，所以 `data-rank` 也要挂在块自己的 wrapper 上。
    - 守卫 13 的四条待迁（`cardStyleByKind` 全局与逐订阅、皮肤包 `variablesByKind` 与 `cards`）都归这一片；搬家后清单要同步。
    - 迁移是搬家不是改名，照 ㉓d 新开一个文件接在会员搬家之后、直播拆键之前；`live-split.ts` 里两张键序数组列着 `cardStyle` / `cardStyleByKind`，要跟着换成 `cards`。
  - ✅ 已落（10-06，施工时定的要点）：
    - 词表只留 `CardKind` 一套（`CardSkinKind` 并进去）。视图与类型：`PostCardView` / `PostNode` / `PostNodeVideo`、`RoastCardCreator`，词云与锐评两张卡的输入叫 `…CardInput`。被转发的那层视图带 `isReposted`：默认皮肤外层把动作标签拼在时间后、内层接在名字后，画面与字节都没变。
    - 块的默认 id 是块名的连字符写法（`creator-avatar`、`current-viewers`）：块 id 只许小写字母、数字、连字符，驼峰块名直接当 id 过不了皮肤包自己的校验。直播卡四个新块带 `scenes`（在看人数与粉丝数属直播中、点赞与累计观看属已下播），只给编辑器画布用。
    - 字节：㉔b 零变化；㉔c 二十份变（把旧快照的旧名按改名表机械替换后与新快照逐字节相同，直播卡拆块没有结构差异，不显示的块不输出）；㉔d 六份只多了 `data-rank`；㉔e ㉔f 零变化。锐评两张与词云全程没变。
    - `data-rank`：常量 `CARD_SKIN_RANK_ATTR`，加在档位卡的外框与每个块的 wrapper 上，会员档没有 rank 时不加；说明进了 AI 做皮肤的规则提示词与编辑器检查器。
    - 迁移在 `migration/card-moves.ts`：直播卡种那份封面有就用它（空数组也算有，照迁移前的合并行为），否则取基准；不是内置的皮肤指针回 `default`，旋钮只留内置那一套；逐订阅并完没有东西就不留键。钉摘要的夹具原来不含卡片设置，已补上（剪掉这一步摘要测试会红）。
    - 拒收提示两句：老版本「这是旧版本的卡片皮肤，1.0 起卡片皮肤的格式变了，需要重新制作。」；比当前新的版本另有一句请先更新。盘上版本不对的皮肤目录开机被跳过、不进索引、不删。
    - 卡种中文名在 `constants.ts` 一处三张表：全名、短名、按事件推的四种卡在卡片页导航上的名字；有一条走语法树的测试防别处再抄一份。测试推送的图说跟着改用全名（「开播卡片」→「直播卡」）。
  - 留着的：去头像后空着的列（3a 头像回来）；编辑器里单场景卡的场景名没并进中文名表（它们是场景名不是卡种名）；基线样例名与夹具分组名仍是旧叫法（`sc-low`、`dynamic-*`）。
  - 真机待看（㉔ 全片）：卡片页（出图总开关、全局与逐订阅的直播封面、清空逐订阅封面能清掉、预览七种卡）；皮肤编辑器（块目录的新名字、直播卡切场景时四个新块、档位卡检查器里的按档换色说明）；写一条 `[data-bn="self"][data-rank="3"]` 的块 CSS 看是否生效；装一个老版本皮肤包看拒收提示；AI 做皮肤能不能照新的字段与块名产出；真实 0.x 数据迁一遍后封面图、皮肤指针、旋钮对不对；开发期做的 1.0 皮肤不再出现在皮肤库里。
- **㉖ 开片（10-06）**：先勘察，再一题一题问主人（定案在 ADR-0027 决策 11–14 的 🔗）。动盘两次：㉖c（修订号 29 → 30）、㉖f（30 → 31）；统计不进备份，备份版本不抬。八小片改的是同一批文件，依次提交：
  - ㉖a 只加测试钉住现状：统计总览接口的完整返回、锐评提示词里的「投稿 / 动态」数字。
  - ㉖b 纯改名（不动盘）：`UpDynamicEvent` → `PostEntry`、`appendDynamic` / `listDynamics` → `appendPost` / `listPosts`、`LiveSessionRecord` → `LiveSessionEntry`、`StatsSeenRow` → `StatsSeenEntry`、`LiveSummary` → `LiveStatsView`、`DynamicCounts` / `countDynamics` → `PostCounts` / `countPosts`。
  - ㉖c 作品行与直播帧改形、目录 `stats/dyn` → `stats/posts`：作品行 `{ id, kind, ts }` → `{ id, hasVideo, publishedAt }`，帧 `{ k, ts, peak }` → `{ kind, occurredAt, peakTotalViewers }`；开播公告不再记，旧的公告行迁移时丢掉。
  - ㉖d 接口与面板同片跟上：`fans` → `followers`、`archives` / `dynamics` → `videoPosts` / `posts`（口径从「其余」变「全部」，面板与锐评提示词改成相减，显示的数字不变）、身份格改 `identity`。
  - ㉖e 锐评不再在进程里给自己发 HTTP 请求取统计，取数抽成函数两处直接调，子路由自挂的出错处理随之删。
  - ㉖f 「在记」的小账（按小时记，ADR-0027 决策 13；老的合成区间随 ㉘）：新目录、关着不记、`seen/` 并入、接口回三份「在记」、面板跟到照旧能用、迁移推出老日子、总览缓存的键带上开关状态。目录登记进目录表（㉙ 的存储占用算进「统计」那一类）。
  - ㉖g 拓展作品多记链接、摘要、话题、视频时长；统计仓加「取最近几条」的读口（没有调用方，3b 的 `get_creator_posts` 用）。
  - ㉖h 文档、守卫数字、计划勾销。
  - 开工前各问一次的名字：㉖f 的目录名与账里三项的取值；㉖g 的摘要等字段名。
  - ✅ 已落要点（修订号 31，备份版本没动）：
    - 作品行 `{ id, hasVideo, publishedAt }` 外加可选的 `url` / `title` / `summary` / `topic` / `videoDurationSec`（今天只有拓展作品在填，取五格的函数在 `stats/post-entry-extras.ts`，3a 的 B 站适配直接复用）；直播帧 `{ kind, occurredAt, peakTotalViewers }`；目录 `stats/posts`。
    - 「在记」的账 `stats/recording/<订阅 id>.jsonl`，行 `RecordingEntry = { kind: "posts" | "live" | "followers", startedAt, endedAt }`，现场写的每行正好一个 UTC 整点小时，迁移写合好的区间，读的一方吃任意长度。B 站认登录有效（每 5 分钟现读一次）、拓展认收到上报、粉丝认拉到资料。`seen/` 与水位线 `since` 删了。
    - 统计行：`followers`、`videoPosts`、`posts`（全部作品）、`identity`、`recording`（三份逐天的在记，面板第 4 期才读）。面板的「动态」只在 `services/stats.ts` 的 `plainPostCount` 相减。
    - 「直播类开关开着」的判定抽成 `packages/live` 的纯函数 `needsLiveMonitor`，房间上下文与统计共用（3b-14 起住 internal，不在 `packages/live`）；`engines.ts` 的 `getModuleState` 那份手抄（读 `routing`）3b-14 已换成同一个判定。
    - 统计总览的取数是一个函数 `createStatsOverview`，面板、手动锐评、定时锐评共用同一份 30 秒缓存。
    - B 站替身棘轮：`routes/stats.ts` 11 → 5；`stats/roast-subject.ts` 4 → 6、`stats/bili-source.ts` 8 → 15、`stats/recorder.ts` 2 → 5、`index.ts` 3 → 5（主人批的，3b 搬进 `bilibili/` 后不计）。
      - 🔗 现状（3b-26，10-24）：`stats/bili-source.ts`、`stats/extension-source.ts`、`stats/recorder.ts` 三行已删（统计里再没有认 B 站的地方）。
  - 行为变化：开播公告不记；作品开关关着的订阅不记作品、那些天显示「没记录」；直播类开关关着的订阅直播那几格（含最高与平均观看）显示「没记录」；拓展订阅没在记的日子即使盘上有作品也显示「没记录」；一条从没有粉丝样本的 B 站订阅，在窗口里没有任何记录时从整行「没记录」变成显示 0（老规则随窗口长短变，账表达不了）。
  - 留着的：`index.ts` 里把 B 站登录读口交给统计的那一行没有测试覆盖（端到端测试里启用的 B 站订阅会去连真接口、被防联网的守卫拦下），3b 搬 B 站适配时补；记录器里挡重复用了三个集合，㉘ 给账加压缩时一起收；「在记」的缓存键没有加开关状态（查账得来，不需要）。
  - 真机待看：统计页（开关关着的订阅各格显示「没记录」、热力图、投稿与动态两个数、CSV 两列）；真实 0.x 数据迁移后的老日子。
  - 粉丝样本的行改名挪去 ㉘；B 站作品的多收字段挪去 3a、直播场次的挪去 3b；CSV 合列挪去第 4 期；`UpStatsRow` 的类型改名随第 4 期、`fans-refreshed` 的事件改名随 3b。
- **㉗ ㉘ 开片（10-06）**：先勘察（报告在 `.bn-design/s27-28-survey.md`），再一题一题问主人，定案在 ADR-0033 决策 3 的 🔗 与 ADR-0027 决策 15。两片各抬一次修订号（㉗b → 32、㉘c → 33），备份版本不抬。㉗a、㉘a、㉘b 文件面不相交，各开一个工作区并行；其余排队：
  - ㉗a 运行记录的现场记录：新仓、每个整点记一行 `{ hourStartedAt, minutes }`、关停补记；数据根目录表加 `uptime`。只写新目录，不抬修订号。
  - ㉘a 只加测试钉住粉丝相关的现状（逐日曲线、24 小时与 7 天涨跌、涨粉起点、累计、总览里粉丝那几格），「显示不变」靠它们裁决。
  - ㉘b 纯函数：样本压缩、账的区间合并、段展开回每小时的点并裁到窗口、段上的「最新 / 最早 / 之前最近一条」。
  - ㉗b 迁移回填运行记录（修订号 32），排在「统计」那一步之后。
  - ㉘c 接入（修订号 33）：粉丝行改名改形、仓与目录改名、按订阅排队写、定时压缩、迁移压老样本；⑨ 满量耗时复测。
  - ㉘d 「在记」的账接进同一趟压缩，迁移合老账。
  - ㉗c / ㉘e 文档、词表、计划勾销。
  - ✅ 已落要点（修订号 34，备份版本没动）：
    - 运行记录：`uptime/hours.jsonl`，行 `UptimeEntry { hourStartedAt, minutes }`；每个整点记刚过去那一小时，关停补记当前小时，同一小时几行相加（封顶 60），0 分钟不写；定时器睡过好几个整点时只记最初那一小时。迁移回填在 `migration/uptime.ts`，与「统计的在记」共用 `migration/follower-times.ts` 读样本时刻。
    - 粉丝时序：仓在 `followers/store.ts`（`FollowersStore`），行 `{ sampledAt, followers }`、段多一格 `lastSampledAt`；仓只认新形状，读口把段展开回点；写入按订阅排队，关停时关门。纯函数在 `followers/`（压缩、展开、查找）。
    - 压缩那趟叫 `startStatsCompaction`（`stats/compaction.ts`）：开机一次、每 6 小时一次，先压粉丝样本再压「在记」的账，一边出错不挡另一边。账的压缩排在记录器按键的那条队里，与追加不交错。
    - 迁移顺序：统计 → 统计的在记 → 运行记录 → 粉丝样本压缩（后两步读的是压缩前的样本）；迁移写出的账与样本就是压缩后的规范形态，开机那趟不会再改它们。满量迁移耗时测试通过（合成盘的粉丝行从约 231 万压到约 34 万）。
    - 裁判：`__tests__/followers-display-pinned.test.ts` 等四个文件（㉘a）钉着压缩前的显示，㉘c 只改了它们造样本的帮手；另有「压缩前后读统计总览逐字节相同」的测试（样本与账各一条）。
  - 留着的：非整点时区下的日末值没有测试（定案只保证整点时区）；`fans-poller.ts` 里还有一份自己的「一小时」常量，随 3b 并进资料刷新时收；运行记录还没有读口（年度总结在 alpha 之后）。🔗 10-23（3b-24）：`fans-poller` 已并入 `profile-refresh`，这份重复常量随旧引擎删除。
  - ㉘a 查出的两处现状，不是这两片引入的，没修：统计总览只读窗口内的样本，窗口第一个有样本的日子没有前一天可比、净增是「没记录」，「近 7 日涨跌」会跟着丢；BN 停了一段时间再开，重开那天的净增是整段空档的涨幅。前一处是 bug（注释写的是基线要回溯到窗口之前），10-06 主人定现在修：总览取数时多读一条窗口之前最近的样本当基线，只用来算窗口里第一个有样本那天的净增。后一处主人定先不动，记成已知的限制，第 4 期重做统计页时再看；注意前一处修好以后它在短窗口里也会显出来（基线是几个月前的样本时，窗口首日的净增就是这几个月的涨幅）。
  - 真机待看：跑满一个整点后 `uptime/hours.jsonl` 有行、正常退出补记当前小时；开机后老的粉丝文件被压小而统计页的曲线、涨跌、涨粉起点不变。
- **㉙ 开片（10-06）**：先勘察（报告在 `.bn-design/s29-survey.md`），再一题一题问主人，定案在 ADR-0027 决策 16、17 与 ADR-0022 决策 7 下 10-06 的 🔗。全程不改盘上已有数据的形状、不抬修订号、不抬备份版本。㉙a、㉙b、㉙c 文件面基本不相交，各开一个工作区并行；㉙d 排在它们之后：
  - ㉙a 统计总开关：设置键 `stats.enabled`、记录器入口与 B 站粉丝轮询两处拦、在播的场次照常收尾、涨跌给空、关着不生成锐评。
  - ㉙b 图库按引用方分开交用量：每张图的大小与引用它的是哪几家；清扫的结果带腾出的字节数。
  - ㉙c 旧代的列表、两个大小、删除（按来源保护的规则由服务端判断）；删到一半崩了的残骸开机收走。
  - ㉙d 存储占用的读与清：四类各补一个整类清空的入口（统计经记录器的队、连 B 站的涨粉起点）、历史图清到昨天、清完接图库清扫、手动清扫的口。
  - ㉙e 文档、词表、计划勾销。
  - ✅ 已落要点（修订号仍是 34，备份版本仍是 9）：
    - 统计总开关 `stats.enabled`（顶层一节，默认开，靠 schema 默认值补）；读它的是一个缓存的布尔 `stats/enabled.ts`，记录器入口与 B 站粉丝轮询两处拦；关着时在播的场次照常收尾、涨跌给空、手动与定时锐评回「数据统计已关闭,开启后才能锐评」；压缩与运行记录不受它管。
    - 图库 `usage()`（每张图的大小与引用方）、清扫结果带 `removedBytes`、引用方名字表 `images/image-referrers.ts`。
    - 旧代：`runtime/generation-usage.ts`（规则、两个大小、删除、开机收残骸）与 `/api/system/generations` 两个口。
    - 存储占用：`runtime/storage-usage.ts` 与 `/api/system/storage` 三个口；各仓新增整类清空 `clear()`（统计记录器、粉丝仓、历史仓、会话库），记录器原来的 `clear()` 改名 `reset()`。
  - 留着的：面板界面全在第 4 期（统计页关着时留一段话、系统页的存储占用与旧版本数据）；`index.ts` 里把统计开关交给 B 站粉丝轮询的那一行只有类型检查保护、没有专门的测试；量大小没有缓存，重度用户下一次查询的耗时没实测；删第 0 代后宿主根里 0.x 留下的空壳目录 `bilibili-notify/` 不在白名单里、会留着；清统计后拓展订阅在首页粉丝面板上暂时消失到下一次采样（没有粉丝样本就不上面板的老规矩）。
  - 真机待看：关掉统计后各处不再记、订阅卡上的当前粉丝数照常、锐评给那句话；重新打开后恢复；存储占用各行的数字与盘上对得上；逐类清理后别的类不受影响；旧版本数据的列表与「未满 30 天不许删」。**清理与删旧代不可恢复，真机验之前先备份数据目录。**
  - 留给 3a 开片时问的：图片渲染与女仆 AI 两节在 `defaults` 里的处理不一致（定案对 AI 是能覆盖的那一格留 `defaults`、其余拆去顶层，对图片渲染是整节连开关留在 `defaults`），拉不拉齐 3a 设置分拆时定。
- 开片时要问主人的名字（词表没有的先问再用）：⑭ 请求客户端与 cookie 罐的类名；⑮ `ImageRef` 带不带扩展名（10-03 定：带）；⑲ 图片保留天数的键名（10-04 定：`history.retentionDays`，不带 `image` 前缀）；㉔ 直播、榜单、词云、直播总结的卡种键；㉙ 统计总开关的键名。

## 第 3a 期：接口先行

10-07 开片。这一期太大，单独一份计划表：[phase-3a-plan.md](./phase-3a-plan.md)（42 片分七组，各片进度与每组开工时定的事都记在那边）。上面分期表里 3a 那一行只管范围。

## 第 3b 期：各块中立化

10-13 排片。和 3a 一样单独一份计划表：[phase-3b-plan.md](./phase-3b-plan.md)（50 片分七组、四条线同时走，各片进度与每组开工时定的事都记在那边）。上面分期表里 3b 那一行只管范围与出期条件。10-13 主人定的几件归期：核心包 `packages/internal` 的出口整理排在 3b 最后（3b-49）；剩下的一批设置改名（3a-38 留着的「其余改名」）挪到第 4 期，和核心设置加 `core.` 前缀并成一次。

## 第 4 期：面板按描述画

10-27 排片。和 3a、3b 一样单独一份计划表：[phase-4-plan.md](./phase-4-plan.md)（61 片，主会话单线做；各片进度、片表那 11 题的定案与开工时定的事都记在那边）。上面分期表里第 4 行只管范围与出期条件。

## 第5期：收尾与多语言

2026-11-06主人要求先清理。2026-11-07当前机械清理队列37/37已核销，资源管理组另计6/6：手写结果与中文叫法棘轮均0，旧名/职责说明、字典归属、无读者代码及严格登记已收口；格式、持久字段与兼容入口的保留边界见[phase-5-plan.md](./phase-5-plan.md)。主程序界面翻译尚未开工；5-38桥接四语及其日志、5-39宿主生命周期与拓展装卸日志、5-40配置/密钥/存储日志、5-41推送路由与宿主链路日志、5-42作品装配与来源上报日志、5-43直播场次/互动/回顾日志、5-44历史/问题表/通知器日志、5-46内置适配器日志、5-48B站登录流程与账号日志、5-49B站API/续期/WBI日志、5-50作品轮询日志、5-51关注同步与来源辅助日志、5-52直播连接与会话日志、5-53AI用量日志、5-54AI请求/工具/配置日志、5-55视觉管线日志、5-56图片渲染诊断、5-57统计与运行记录存储日志、5-58集成上下文与拓展边界诊断、5-59资料刷新与投递边界诊断、5-60命令与锐评链接任务诊断、5-61HTTP与WebSocket诊断、5-62浏览器与资源监测诊断、5-63启动与异步事件收尾日志已接线验收，日志按主人11-07要求纳入第5期。大改UI限制保留，第5期整体出期条件未变。

## 分支与发 alpha

**2026-10-06 起 1.0 直接在 `dev` 上做**（第 2 期收官后主人拍板）：`dev-next` 已快进合进 `dev`，本地与远端的 `dev-next` 分支都删了。

1. `dev` 是 1.0 的开发线；第一版 alpha 之前不推（本地原子提交照旧）。
2. 发 alpha 时在 `dev` 上打 `v1.0.0-alpha.1`（发版流水线要求 tag 在 dev 上）。
3. `main` 仍是发布快照，只能快进。

代价：`dev` 上已经是 1.0 的代码，0.12.x 要再出急修得从 `v0.12.0` 的 tag 另开分支。10-02 已定 0.12.1 不发、小修全放 1.0，所以这条路平时用不到。

原先的安排（1.0 在 `dev-next` 上做、`dev` 只收小修并随时合进 `dev-next`、发 alpha 时才快进）到此作废。

## alpha 之后、1.0.0 之前

| 项 | 怎么做 |
| --- | --- |
| 年度总结（ADR-0033）：「你和 BN」「你关注的创作者」两块，随时能看、12 月中旬提示一次；导出成「年度总结卡」更晚 | 面板几屏 + 年度统计接口 + `SystemNotice` 新 kind；数据地基已在第 2 期 |
| 桥帧改名（09-27 拍板；alpha 不动）：`forward` → `mergeForward`、`desc` → `description`、`picUrl` → `imageUrl`、能力名 `forward` 同改、载荷种类 `miniapp-card` 与能力名 `miniAppCard` → 原生分享（内部叫 `native-share` / `nativeShare`），一趟改完（原文把能力名写成 `miniapp-card`，那是载荷种类，代码里的能力名是 `miniAppCard`）。内部载荷已改名 `native-share` 并带 `appId`，桥适配器对任何 `appId` 都映射成线上的 `miniapp-card` 五格（帧里没有 `appId`）；进 alpha 后两步改名时一起给帧加 `appId`。09-28 加一格：群入站消息的 `miniAppCardLinks` 改成 `sharedLinks`（`{ url, kind: "card" | "nativeShare" }[]`，ADR-0029 决策 2） | 按方向走两步，合起来三拍：① BN 先同时认入站 `miniAppCardLinks` 的新旧两种写法（入站字段两步反过来走：BN 先认、插件再改发，ADR-0029 决策 2）；② Koishi、AstrBot 薄插件发新版：认 BN 发的新旧两种名字，入站改发新写法，回执改发结果形状（过渡期 `err` 照带，ADR-0026 决策 7）；③ 等用户都升上去，BN 再改发新名字、不再认回执的 `err`，桥的适配器里的新旧映射整个删掉。都要在 1.0.0 之前做完；插件只发一次版。`listAddressCandidates`、`connectionAuth` 对拓展开不开放同时看（见「以后再说」） |
| devtools 换 devframe（09-27 从「1.0 之后」提前） | 先做小试验：查清许可证与维护者，重新验证 devtools 不进生产产物（守卫 14 与构建后自检照旧）；试验过了再换 |
| 新手引导换 driver.js（09-27 从「1.0 之后」提前） | 先做小试验：验证引导锁（聚光灯外不能操作，⛔ 不许放开）、跨页面的步骤与晚挂上的锚点、能不能跟随界面皮肤；试验过了再换 |

## 零碎施工项

| 项 | 归期 |
| --- | --- |
| AI 写正文按目标选（ADR-0032）：`core.ai.writing` 两份，默认 `enabled: true`、`byTarget` 为空，升级后行为不变；模板正文总备好，默认开或任一例外开才生成 AI 正文；推送层逐目标挑正文，和 @全体 的分组叠成两维 | 3b，两份都做（3b-36 作品那份、3b-37 直播总结那份）。原写「3a（推送层与作品那份）/ 3b（直播总结那份）」，作品那份 3a 没有排进片表、没做，主人 10-13 定进 3b |
| 订阅标签（ADR-0034，issue 53）：标签登记表 `SubscriptionTag` + 订阅上的 `tagIds`、读写口、0.x 迁移一条；面板同期跟上（筛选与卡片角标按登记表读名字，订阅详情的「分组」文本框换成和「编辑分组」弹框同一个勾选组件，文案「分组」→「标签」） | 第 2 期（数据模型、迁移与面板跟上）；标签管理界面（改名、删除、排序，接口 `PUT /api/subscriptions/tags`（⑫ 已有，㉚ 改了路径））第 4 期。10-02 主人真机看过 ⑫：建了删不掉（就是缺管理界面）、卡片左下角只写第一个标签、只是一行字不好看 —— 第 4 期卡片上把挂的标签全部显示成胶囊 |
| 目标标出所在连接 + 下拉换成自己的组件（ADR-0035，issue 55）：目标一律标平台图标 + 连接名，由一个函数从目标与连接表算出来；`TSelect` 改用 `PopoverShell` + `MenuItem` 拼（键盘、读屏器、焦点由测试钉住），`HourSelect` 与 `Logs` / `SkinEditor` / `RoastPushBox` 三处原生 `<select>` 一并换掉，驱动原生 select 的测试改成点开再选，加守卫拦裸 `<select>`，`packages/ui` 清单同步 | 第 4 期（随连接 / 目标表单） |
| 拓展的定时器收口（与守卫 22 同期）：宿主的 `ctx.setTimeout` 一次性定时器触发后自动从登记里放掉（今天要等拓展卸载才放）；桥的 `pendingTable` 与握手超时改用 `ctx.setTimeout`，结算或断开时 dispose | 3a |
| 拓展契约 v3：min 抬到 3，删 v1、v2 的退路（`legacy-v1.ts` 连同过时注释）；ctx 改成 `IntegrationContext` 加各自特有的一层，新增 `http`、`settings`，上报改 `void`、被拒记进 `reportDiscrepancies`；推送侧加宽到 `PlatformAdapterDef`（ADR-0024 决策 3，这一版不开的见决策 11）；`pickPerId` 改成「在当前 BN 装得了的版本里取最高」；索引规则放宽成「每个契约版本各留最新一条」；官方索引这一期只换地址（10-14 主人定）：新版 BN 改读新的滚动 release `extensions` 上的 `marketplace.json`，旧 release `extension-marketplace` 上那份留给 0.12、从此不动（说明里写「0.12 专用，已冻结」），格式不顺手改（`issuedAt` 仍是秒、`apiVersion` / `apiRevision` 不改名）；桥迁 v3，1.0 alpha 期间 v3 的桥只进预发布档 | 3b。🔗 3b-03（10-13）已删第 1 版的退路，最低版本眼下是 2；其余各样的片号见 [phase-3b-plan.md](./phase-3b-plan.md) 己组 |
| 读设置的写法简化（10-01 主人提，10-14 定）：格式只声明一处，面板要的字段由打包脚本从规则导出进清单，作者不写第二份；不学「改了设置就整个重启」（B 站改个间隔就要断开全部直播间）。**不改第 3 版契约的形状**：「规则只写一份、清单字段由打包脚本从规则导出」那一半排到第 4 期，与面板「按描述画」一起做；「规则写在定义里、一行读到」（`ctx.settings.get().x`，读处不再传 schema）不做 | 第 4 期，与面板按描述画一起。🔗 3a-39 造的 `SourceContext.settings(schema)` 仍是读处传 schema、`get()` 回结果；它「不学整个重启」做到了（改了哪格只换那一样）。**「规则只写一份」已落（4-11，10-28）**：导出函数 `settingsFieldsFromSchema`（`packages/internal`，给人看的那几格读规则的 `.meta()`），官方拓展在**构建**时导出进 `dist/extension.json`（开发版装的是 `dist/`，只在打 zip 时导出面板就画不出表单），源码清单不再写设置项；桥、假源已改。内置集成的读者随 4-13 / 4-44 |
| 核心读设置加 `core.` 前缀（⑥f 内存里核心读法暂不动）、面板 PATCH 的核心路径改 `core.*`；`/api/globals` 改名 `/api/settings`（10-03 主人定，ADR-0036，随 ㉚） | 随第 2、3 期改名；面板那半随第 4 期。3a-38 没做这一片：`GET / PATCH /api/settings` 仍是核心顶层键平铺加 `bilibili`，仍随第 4 期。**线上那半已落（4-08）**：核心那份挂在 `core` 下，PATCH 顶层只认 `core` 与集成键，系统页字段码带 `core.`；服务端内存里的核心读法没加前缀 |
| 面板改账号密码（10-02 主人定，不强制改）：服务端加一个改面板账号的接口，照 `config/persist.ts` 的写法写回 `bn.config.yaml`（保留注释、原子写、0600），改完会话随之失效、重新登录。Docker 主路径（设了 `BN_CONFIG`）环境变量只在首次开机生成这份文件时用一次、之后以文件为准，面板改了就生效；只有没设 `BN_CONFIG` 的旧式部署（每次开机「文件 < 环境变量 < 命令行」合并）在环境变量里设了 `BN_DASHBOARD_USER/PASS`、或根本没有配置文件时拒绝并说明，桌面版（token）与不要求登录的部署不显示入口；开机生成种子凭据时那句日志改成「登录后可在系统页修改」。面板入口随第 4 期。**服务端已落（4-07）**：`PUT /api/session/credentials`（登录着、再报一遍当前密码；新账号去掉首尾空白、非空，新密码 8–256 位），写到哪由 `resolveCredentialsTarget` 每次现问，`persistDashboardCredentials` 写回；会话签名器 `rotate` 换凭据，此前的会话全部失效、回话清 cookie。**面板已落（4-49，11-03）**：系统账号区独立弹窗，成功回登录页，失败保留重试；桌面/免登录隐藏，有设置草稿先保存或放弃。种子凭据日志已同步指向系统页 | 服务端 4-07、面板 4-49 已落；既有 WS 不主动断开残余保留 |
| 日志级别的 `core` 键会和叫 `core` 的拓展撞名（`logging.levels` 是核心模块 + 集成键混放）：`core` 进保留 id 表，或把集成键分开放 | ✅ 3a-38 已落：`core` 进「拓展不许用的 id」（`RESERVED_EXTENSION_IDS`），不进内置集成的键表（那张表被当「内置集成有哪些」读） |
| 桥迁 v3 时必须抬 `extensions/bridge/extension.json` 的 `version`（现在 `0.0.1`，同号发出去市场永远不提示更新）；具体号发 alpha 时定 | 3b 抬号，6 定号 |
| 渲染器运行时从 `s1.hdslb.com` 拉舰长图标（`packages/image/src/image-renderer.ts` 的 `GUARD_LEVEL_IMG`），改成本地资产：B 站在 `bilibili/` 声明 `guard` 体系时用 `ctx.storeImage` 把三档图标存成 `tier.icon`，出图器只内联引用。守卫 11 的 `hdslb` 会在这里变红 | 3a（10-02 从 3b 挪进第 2 期 ㉓，理由是不挪的话出图器零联网过不了、会员卡只能画占位；10-03 出图器零联网随抓图服务挪进 3a，它跟着回去，和 `ctx.storeImage` 一起落；三档图标的字节从哪来到时定） |
| 补关注「-101 整批跳过、不降级」（已定未做，见 subscription-sources「B 站怎么实现」），随关注同步搬进 `bilibili/` | 3b ✅ 3b-25 已落（10-23）：批量查回 `unauthorized` 整批跳过、不降级，关注同步住 `bilibili/follow-sync.ts` |
| 直播监听的唯一判定（internal）：「开着」只看开关、不看有没有目标（ADR-0027 决策 1）；首页的「不会被监听」与直播就绪判断都改用它。已知 bug 就落在这条上（见「施工中顺手修」），别拖到最后。🔗 3a-31 已把首页那句的**判定**改成只看（折好的）开关、不再数推送目标（文案改成「没开直播推送」）。✅ 3b-14 已落（10-13）：判定住 `packages/internal/src/live-monitor.ts`（零依赖子路径 `@bilibili-notify/internal/live-monitor`，主入口也转出），入参是五把开关加 `specialDanmaku` / `specialUserEnter` 两个布尔；服务端三处（直播引擎、统计、`getModuleState` 的 `liveReady`）与面板首页「没开直播推送」那句都读它，手抄的键表全删；首页「直播」那一格改成只看开关与特别关注、不再数推送目标，面板那句也算上了特别弹幕 / 特别进场。🔗 3b-16 改判（10-13 主人定）：五把直播类开关任一开着，或（`viewerChat` 开着且名单上有人带 `viewerChat`），或（`viewerEnter` 开着且名单上有人带 `viewerEnter`）；两把键 `specialDanmaku` / `specialUserEnter` 改名 `viewerChat` / `viewerEnter`，见 [data-model.md](./data-model.md)。`getModuleState().live` 还要该订阅的来源实现了直播：在册来源有 `fetchLiveStatus`，或拓展声明了直播周期 | 3b；首页在 4 |
| 密钥打码：schema 标 `secret: true`、服务端按 `MaskedSecret` 下发；面板那一半（统一密钥输入框） | 3a；面板在 4 |
| 重启能力的预检 `RestartAbility` 不能重启时还是 `{ can: false, reason }`（`source-run` / `unsupervised`）：按 ADR-0026 决策 2 改成 `code` + `message`，系统页与拓展页读它的地方同期跟上（10-03 ⑱a 施工中发现，主人定归期）。**已落（4-04）**：`{ can: false, code: "source_run" | "unsupervised", message }`，话由服务端按当前语言现取（路由每次现问），面板原样显示、删了自己抄的那两句 | 第 4 期（4-04 已落） |
| 原生分享：解析器交中立描述，由 OneBot 适配器去签。施工先查签名接口收不收通用参数，不收就在适配器内部放一张 appId → 预设的对照表（ADR-0029 决策 2）；重推原件里小程序卡那一种的迁移随之（10-03 从 ⑱ 挪来） | 3b |
| 测试助手重复：scripts 6 处各算 repoRoot、internal 三份 BASE AI 夹具、面板 UpDialog 三份 renderDialog 与造目标、`extSub` 与 `makeExtSub` 重复、backup 两份 pickFile | 各区重写那期合并，没重写到的归 5 |
| 还在用正则扫 TS 源码的守卫迁上 AST 共用工具（09-29 定的规矩，见 architecture「守卫」开头）：devtools 隔离（服务端、面板各一份）、`constants-imports.test.ts`、`index-background-work-tracked.test.ts`（今天只钉形状）、面板 `walk.ts` / `blankComments` 的 13 个消费方与颜色 token 等处的内联剥注释、`font-reader-singleton`、`tour-anchors-exist`、`asset-dir`；碰到哪道先迁哪道。🔗 现状（3b-49，10-25）：`constants-imports.test.ts` 已由 `scripts/__tests__/internal-package.test.mjs` 取代，用 `source-scan.mjs` 的语法树判 | 5（守卫补齐） |
| 统计的 `/overview` 被定时锐评与手动锐评**在进程内当 HTTP 请求打**（`statsRoute.request("/overview")`），为此统计子路由自挂了一份出错处理（④b 第 4 组）：把取数抽成函数、两处直接调，子路由的那份出错处理随之删掉 | ✅ 已落（㉖e，10-06） |
| knip 报的 3 个老的未使用文件（`devtools/stub.ts`、两个 shape-pin；knip 不在 CI） | 5 |
| `constants-imports.test.ts` 按行判，多行 `export {…} from "zod"` 会漏（🔗 3b-49，10-25：已由 `scripts/__tests__/internal-package.test.mjs` 取代，多行写法认得出）；`UpDialog.test.tsx` 没有 JSX，应是 `.ts`；network-guard 夹具路径写了两处 | 5（守卫补齐） |
| 设置页的 AI 连通测试从 `routes/globals.ts` 挪进 `packages/ai`（出网点名表不给路由开白名单） | ✅ 3b-02 已落（10-13）：搬之前它在 `routes/settings.ts`，现在是 `packages/ai` 的 `probeAiProvider` |
| 面板自己另有一份 `LoginSnapshot`（`status` 收窄成 `BiliLoginStatusValue`），和核心那份（`status: number`）对不上，留下 ④c 唯一一处对 WS `data` 的类型断言（`useAuthChannel`）。登录状态中立化（`subscription-auth-changed`、`AuthState`）时面板改吃核心那份，断言与面板那份类型一起删掉 | ✅ 3a-29 B 站半已落（面板的 `types/auth.ts` 删了，`useAuthChannel` 用 `isWsEvent` 按事件表定型，没有类型断言了） |
| 桥协议的失败统一成结果形状（ADR-0026 决策 7）BN 那半：`result` 帧认 `code` + `message` + `upstreamCode?`，只带 `err` 的旧回执进门翻成 `unknown`；`error` 帧补 `code`；协议升 minor 并记进 PROTOCOL.md 的版本表；投递结果接住 `code`；假桥改发新形状（`fail()` 展开），「结果不手写」棘轮里假桥那两格随之删掉。🔗 现状（3b-44，10-25）：BN 那半已落，假桥回执也是结果形状了。 | 3b（随桥迁 v3 与假桥搬家） |
| ~~拓展包没有 `ok()` / `fail()`，桥拓展 28 处只能手写结果~~（10-08 随 3a-15 落地：契约包导出 `ok()` / `fail()`，桥的投递与探活结果已换；下面说的取图口与守卫两件仍在）；其中取图口的 404 回的是 `{ ok: false, err }`，不合错误体规矩，而错误体守卫只认 `apps/server/src` 造的回应，拓展造的看不见。契约 v3 要不要导出 `ok()` / `fail()`、错误体守卫要不要认拓展的调用栈，随契约 v3 定 | 3b |
| 出网点名表加不加一条判据：集成目录（`bilibili/`、`platforms/`、`extensions/*/src`）值 import `@bilibili-notify/http` 自己造客户端、绕过 `ctx.http` 就红 | 归 3b-50（10-16 主人定；判据 `new HttpClient(` / `new CookieJar(`，三个集成目录都扫，宿主共用的开集成函数 `openIntegration` 放行，上限零） |
| 全仓包版本统一 `0.0.0-dev`：剩 push、subscription、internal、image、ai、storage、extension 7 个包（api / blive / dynamic / live 在 3a 随包删掉；第 2 期新建的 `packages/http` 建时就用 `0.0.0-dev`）。⛔ 不做：extension 包版本对齐契约档位 + 守卫（兼容看清单 apiVersion 与 EXTENSION_API_RANGE，不看包版本） | 5 |
| 进程托管文档：孤儿自检、stdin 关停、数据目录与端口、载荷选版；桌面版和以后的插件照同一份 | 5 |
| `docs/agents/self-update.md`：数据代、开机顺序、回退后再升级，以及 0.x → 1.0 这一次旧文件保持原样 | 5 |
| 「面板」的英文统一叫 `dashboard`（`docs/agents/conventions/naming.md` 词表），剩下的旧名：首页组件 `pages/Dashboard.tsx` 让出这个词，照别的页面改叫 `pages/Overview.tsx`（界面上这一页叫「概览」）；出错页的「回首页」改「回概览」；桌面壳的 `panel_url`、`open_panel`、`open_panel_in_browser`（壳内部与托盘菜单的 id，面板不调，不算冻住的契约）。`skins/panel/` → `skins/dashboard/` 已改（ADR-0022 决策 10 下的 🔗） | 5 |
| 去掉 Standalone（只剩一种形态）之一：服务端代码。启动入口两个名字一起导出，`startServer` 为主，`startStandaloneServer` 作冻住的别名（ADR-0005 决策 4 下的 🔗），新 boot.mjs 先调新名、调不到再调旧名；`StandaloneServerHandle`、启动选项类型、`StandalonePuppeteer`、`standaloneContentBuilder`、`standalone-lifecycle.test.ts` 去掉前缀 | 1（⑥a 之前，⑥a 要重写的正是这个函数） |
| 去掉 Standalone 之二：「镜像 / 安装包自带的那一版」改叫预装版本 `preinstalled`（`imageVersion` / `imagePath` / `isImageVersion` 等）；环境变量改成 `BN_PREINSTALLED_VERSION` / `BN_PREINSTALLED_PATH`：0.x 的 boot.mjs 只写旧名 `BN_IMAGE_*`，所以新 boot.mjs 新旧两套都写，载荷先读新名、读不到再读旧名，旧名随换 Node 大版本那一版删；ADR-0022 决策 14 的冻结名单补上旧名与这个期限 | 5 |
| 去掉 Standalone 之三：中文「独立端」（CHANGELOG、ADR、发布公告这类历史记录不动）、面板连不上后端时那句「standalone 服务」、CLAUDE.md | 5 |
| 去掉 Standalone 之四：流水线脚本 `*standalone-version*.sh`、`create-standalone-github-release.sh` 与 `BN_STANDALONE_VERSION` 改名；流水线只能靠 dry-run 验，和打 alpha 前那一轮 dry-run 一起 | 6 |
| 文档同步：CLAUDE.md 与 `docs/agents/` 的 push、architecture、commands、events、devtools、self-update、extension-marketplace；补上 `subscriptions.md`（整篇讲 B 站 / 拓展两支、两个文件、两种键，1.0 后全错）、`build-release.md`（没有 dev-next 与 alpha 的打法）与 CLAUDE.md 的「分支」一节；CLAUDE.md「项目」一节里「`CONNECTION_PLATFORMS` 不加档、拓展连接走 `kind: "extension"`」那条（闭集与 `kind` 都已删掉，ADR-0024）；示例 yaml 写清每个键对应的环境变量（ADR-0022 决策 14） | 5 |
| 面板文案：订阅面板上的「特别用户进房」改成「特别用户」（10-07 真机时主人提）。这句是特性 `specialUserEnter`（10-13 改名 `viewerEnter`）的中文名，只有一处定义（`apps/web/src/types/domain.ts` 的特性名表），规则页、历史等别处用的是同一个名字，动手时先问主人是全部跟着改还是只改订阅面板 | 4 |

### 还没归期的（施工时定）

ADR-0024 ～ 0031 里定了做什么、没定哪一期做的项。

| 项 | 备注 |
| --- | --- |
| `PostEvent` 信封与 `post-detected` 事件（取代 `dynamic-detected`）；`deliverWork` → `deliverPost`、`NeutralWork` 退场；「正文链接」版式块；番剧、合集、课程翻成附件视频卡 | 10-05 主人定：都在 **3a**（前三件要等投递入口吃 `Post`，最后一件随 B 站翻译搬进 `bilibili/`）。**已落**：`PostEvent` / `post-detected`（`dynamic-detected` 已删）与 `deliverPost`、`NeutralWork` 退场，都在 3a-27；番剧、合集、课程的附件视频卡 4-01 落（10-27，见 ADR-0028 决策 1 的 🔗） |
| 全局时区设置（ADR-0021 决策 43 要默认 `Asia/Shanghai`） | ✅ 3b-11 已落（10-20）：核心设置顶层 `timezone`（只收 IANA 名、带默认），作品卡与直播卡的时间、榜单周报 / 单人锐评与 AI 创作者统计的按天切都读它；出卡器在出卡那一刻现取。 |
| 其余服务端墙上时间跟不跟全局时区（10-20 主人定 R1 甲：这次不跟） | **第 4 期面板露出时区那一格时一起定**。要看的几处：`apps/server/src/runtime/mute-command.ts` 的 `describeUntil`；`packages/ai/src/tools.ts` 的 `stamp` / 开播于 / 最后活动三处日期；`packages/internal/src/util/quiet-hours.ts` 的 `inQuietHours`（连同 `packages/push/src/push-router.ts` 的调用与 `apps/server/src/devtools/clock.ts` 的开发版免扰时钟）；`apps/server/src/runtime/roast-scheduler.ts`、`apps/server/src/runtime/fans-poller.ts`、`apps/server/src/bilibili/dynamic/dynamic-poller.ts` 三条 `CronJob` 与 `apps/server/src/stats/extension-source.ts` 的 `CronTime`；`apps/server/src/devtools/scenarios/timers.ts` 的下次触发显示。🔗 10-23（3b-24）：`runtime/fans-poller.ts` 已换成 `runtime/profile-refresh.ts`，这一项查的是后者的 `CronJob`。🔗 2026-10-28 定了（第 4 期片表 Q10，主人定）：面板露出时区那一格，上面这几处**也跟**，新开 4-55（见 [phase-4-plan.md](./phase-4-plan.md)）。 |
| 连接设置的校验：保存时适配器在场就按 `settingsSchema` 校验、不过回 400；读盘逐条校验，不过的只隔离那一条，只有外壳坏了才挡开机（ADR-0024 决策 10） | ✅ 已落（3a-22-2）：保存时按在场适配器的规则校验、不过就拒，开机读到坏的只隔离那一条；面板的「设置不合法」态仍在第 4 期 |
| 投递失败归核心：按目标逐个投递、只重试失败的那个（`rate_limited` / `unavailable` / `timeout` 退避，`indeterminate` 与其他码不重试）；出卡或 AI 失败降级、不整条重来；每个目标一行历史，失败带 code（ADR-0024 决策 15） | 10-13 主人定：先不进 3b 的片表，3b 开工后量清楚还差什么再定（推送层按目标的退避重试与来源交完就前移已有，核心按失败种类重试没做） |
| 删掉自定义 UA 设置，身份一律由 `packages/http` 生成；老配置里这一格由迁移丢掉、新 schema 不留（ADR-0025 决策 7） | **第 2 期 ⑭**；「换一个身份」按钮随第 4 期的 B 站设置 tab |
| 健康的服务端那半：`SourceHealth = { summary }`、`/api/health/details`、短版 `/api/health` 只留四格，应用内更新靠 `version` 与 `startedAt` 认新进程（ADR-0025 决策 12） | 健康卡界面在第 4 期，先出设计稿 |
| 历史里存的旧失败转成 `{ code: "unknown", message: 原话 }`；应用内更新的 `reason` 从 kebab 改 snake（ADR-0026 决策 3、5） | 迁移条目随改盘上形状的那一期：历史那份 **3a**（随 `DeliveryResult` 改形状，10-03 从 ⑱ 挪去）；更新的 `reason` 随动更新状态那一期 |
| ADR-0027 的服务端那半（唯一判定除外，它在 3b）：「在记」按特性分；开播公告不再记；统计多收现成字段、统计仓回最近几条作品；历史接口删 `?uid=`；统计 CSV 的「UID」与「外部 ID」合成一列 | **第 2 期 ㉖**（10-06 按 ADR-0027 决策 12、14 分期：拓展作品的字段与读口在 ㉖，B 站作品的字段随 3a 的 `post-detected`，直播场次的字段随 3b 的场次变化事件，CSV 合列随第 4 期；`?uid=` 已在 ⑱ 落）；面板那半在第 4 期 |
| 作品文字只有一种拼法：`posts/` 里唯一的取段函数（ADR-0028 决策 1） | **第 2 期 ㉑**（`posts/` 3a 才建，本期的落点施工时定）；进守卫 4 的点名表 |
| 模板变量 `{guard}` → `{tier}`、`{mdn}` → `{fanclub}`，资料加 `fanClubName?`，迁移改写主人的文案（ADR-0028 决策 3） | 最迟 3b：模板变量可满足性守卫那期要绿 |
| 醒目留言加可选 `tier`、金额按币种排版；会员档加可选 `announcement`，皮肤字段 `guard.text` → `membership.announcement`（ADR-0028 决策 4） | **第 2 期 ㉓** |
| 类型名后缀守卫的开启期（ADR-0023 决策 15） | 见「中立性守卫的归期」 |
| 启动器要不要更新（10-02 主人定）：拿预装版本判断，不给启动器另编号 —— 启动器与预装载荷同一个镜像或安装包发，预装版本（boot.mjs 传的 `BN_IMAGE_VERSION`，按命名表改叫 preinstalled、旧名兜底）就是启动器出自哪一版；载荷里记「启动器最后一次改动在 X 版」，预装版本比它旧就进 `SystemNotice`，提示拉新镜像 / 重新下载应用 | 随第一次改启动器的那一期 |
| 推送历史拆两层（10-02 主人定，ADR-0022 决策 9 下的 🔗）：文字不设上限、无设置项；图片保留天数改成选项 90 / 60 / 30 / 15 / 7 / 3 / 1、默认 30，超期的行显示「图已清理」、不能重推；清扫只数保留期内的引用，新图宽限期，引用方登记表 + 守卫；迁移换算老配置（超 90 压成 90，不在选项里往上取）、不搬超期的图与孤儿图。设置的键 10-04 定成 `history.retentionDays`，⑲ 就建顶层 `history` 一节（核心设置加前缀后是 `core.history.retentionDays`） | **第 2 期 ⑲ ⑳**（⑰ 10-03 并进 ⑳）；随第 2 期统一图库；面板的选项随第 4 期 |
| 年度总结的数据地基（10-02 主人定，ADR-0033 决策 3）：1.0 起记运行记录（每天跑了多少分钟）；迁移时先从 0.x 的粉丝样本算出运行时长写进去，再压缩粉丝样本 | **第 2 期 ㉗**，排在粉丝样本压缩 ㉘ 之前（不能晚：压缩以后 0.x 的心跳就没了） |
| 更新后弹「本次更新」（10-02 主人定，ADR-0005 决策 16 下的 🔗）：`SystemNotice` 新 kind，每个版本一次、主人手动关；标题「恭喜主人成功更新到 X 版本～」，内容是跨过的每一版的概述 + ⚠️ 段 + 完整说明链接，打包时从 CHANGELOG 抽进载荷；被自愈退回的只有标题；0.x → 1.0 那次与首访页合成一个；开发版不弹 | 服务端与打包脚本 **3b 末尾**（10-02 排）；面板随第 4 期 |
| 粉丝样本按时间降精度再合区间（10-02 主人定，ADR-0027 决策 8）：最近 8 天原样，满 8 天的每小时留末值、相邻同值合区间；每天一趟压缩；迁移照同规则压 0.x 的老样本，压之前先把运行时长算出来带给年度总结 | **第 2 期 ㉘**；迁移条目同期 |
| 数据统计总开关 + 存储占用（10-02 主人定，ADR-0027 决策 9、10）：开着才记、新装与升级默认开、关了不记但资料刷新照跑；关掉后数据留着、页面只留一段话，女仆 AI 与图片渲染同样处理；系统页「存储占用」按类显示与清理（统计、历史文字、历史图、女仆 AI、旧版本数据） | 服务端 **第 2 期 ㉙**（连同旧代的列表、大小、删除几个服务口）；面板随第 4 期（「旧版本数据清理界面」并进来） |
| 拓展设置报错里的字段名用清单原字（`apps/server/src/extensions/settings-io.ts`）：3b-43 之后面板表单显示的是译后的名字，报错里却是原字，两边对不上；这些句子在设置变的那一刻生成、存下，就算改成译文也冻在当时的语言 | 未定 |

## 施工中顺手修

已查出的现存毛病，各归一期，随那一期的改动修掉。

| 毛病 | 期 | 怎么修掉 |
| --- | --- | --- |
| 面板的错误提示只认 `err` / `message` / `errors`，`{ error, scope, issues }`、`{ error, id }` 这些形状的原因全被吞掉（读代码得出，未真机验） | 1（切片 ④） | 错误体统一以后，`errorMessage` 只认 `code` + `message` 一种 |
| 搜人时风控与未登录都报成 404：`/api/subscriptions/lookup`（原 `/api/subs/lookup`）把任何非 0 码都回成 `not_found`，还把 B 站的码塞在 `code` 里 | 1（切片 ④）挪码；3a 修分类 | ✅ 切片 ④ 已把 B 站的码挪进 `upstreamCode`，面板不再按状态码换成固定文案、直接显示服务端的话；3a `searchCreators` 返回结果形状、路由合成 `GET /api/sources/:sourceKey/creators?q=`，风控回 `rate_limited`、未登录回 `unauthorized`（HTTP 403：401 只留给看板自己的登录失效，面板见 401 就踢回登录框）。🔗 现状（4-15，10-28）：旧的两口删了，新口落成，来源的失败码原样回 |
| 拿登录二维码失败却回 `ok: true`：网络异常只打 warn 就返回、状态不变；其余抛错回 500 与一句固定英文，原因被吞 | 3a | ✅ 3a-29 B 站半已落（`fix(bilibili): report QR and logout failures as results`）：登录搬进 `bilibili/auth/`、走 `SourceAuth`，`beginLogin` 与 `logout` 回结果形状 —— 取码请求抛错回 `unavailable`（状态不动，免得一次网络抖动把好会话盖成出错）、B 站回非 0 码回 `unavailable`（`-352` / `-403` 回 `rate_limited`，都带 `upstreamCode`，状态进「出错」）、渲染二维码失败回 `unavailable`；退出登录存盘失败仍进未登录，但回 `unavailable` 并写明「重启后可能还是登录着」 |
| 晚登记的适配器收不到对账：拓展的推送适配器在开机对账之后才登记，对账（今天的 `reconcile`）就调不到它 | 3a | 登记即 `start`（ADR-0024 决策 3） |
| AI 工具失败在面板上显示成功：工具失败时返回一段字符串，只有抛错才记失败 | 3b | AI 工具随 ADR-0030 改写时按结果形状返回 |
| 指令出错不回话：处理函数抛错只打 warn | 3b | `CommandDef.run` 返回结果形状；失败回「『{指令名}』没办成：{message}」，抛错回「出错了，详情在日志里」并记错误日志（ADR-0031 决策 1） |
| 开机关注同步改了 `followed` 却不发事件，面板不跟着变 | 3b | 关注同步搬进 `bilibili/`、`followed` 进 B 站的 `ctx.state`；补关注失败按 `follow_failed` 报进问题表，问题表变了发 `problems-changed`。✅ 3b-25 已落（10-23）：`followed` 不再存（问题表顶替），订阅回应带 `problems`，面板订阅列表听 `problems-changed` 重取 |
| 首页「不会被监听」只看有没有配直播推送目标，和服务端的判定对不上 | 3b 判定；首页在 4 | 见「零碎施工项」的直播监听唯一判定。🔗 3a-31 已先把首页这句改成只看折好的开关（不再数目标）。✅ 3b-14 已落（10-13）：判定并成 internal 的 `needsLiveMonitor`，面板这句与它同一份，「特别弹幕 / 特别进场」两项也算上了（首页这一片已改用它，Dashboard 的画法留到第 4 期） |
| 没实现列 bot 方法的推送拓展建不了连接：列 bot 的接口回 404，面板说拓展没跑起来 | 4 | `listConnectionCandidates` 在 3a 改成必备；面板新建连接只走「挑一个候选 → 填字段」一条路 |
| 会员文案自定义开着、图片是空串时 `??` 不兜底官方图，推出 href 为空的图 | 2 | `templates.membership` 重做时修（`default` 的回退正好在这条路上） |

## 以后再说

1.0 不做、已知要回头的事。ADR-0021「以后再说」里的其余几条照那边。

| 项 | 什么时候再看 |
| --- | --- |
| B 站链接前的三个小图标（正文里视频链接、抽奖链接前的，预约卡抽奖行前的）：原来是写死在出图器里的 SVG，不是 B 站给的数据；3a-36 只恢复了表情图，这三个没回来（10-07 主人定）。中立形状里 `link.icon`、`lines[].icon` 两个格子留着、模板照认，B 站只是不填。想做时两条路：开机把自带的 SVG 转成位图存进图库再填格子；或给链接加一格类型，由皮肤自己画 | 主人想要的时候 |
| 存盘的待发队列：补上「推送进行到一半进程崩了，这一条可能漏掉（最多一次）」（ADR-0024 决策 15 认下的代价） | 没定 |
| 时间处理换 Temporal、运行时升 Node 26（10-02 主人提、又放下）：我们跑的 Node 24 默认没有 `Temporal`（只在实验开关 `--harmony-temporal` 后面），Node 26.0.0 起默认带、2026-10-28 才转 LTS；浏览器里 Safari 只有预览版有、iOS 没有，桌面版在 macOS 上用的 WKWebView 也就没有 —— 服务端换了、面板换不了，仓里时间处理就分成两套。改动面今天不大：luxon 只在 `dynamic` / `image` / `live` 三个 B 站引擎包的 6 个文件里；升 Node 大版本有现成的闸（更新清单 `requires.nodeMajor` → 提示拉新镜像，v0.9.0-alpha.1 起有），ADR-0005 决策 4 的 `BN_IMAGE_*` 旧名兜底也约定随换 Node 大版本那一版删 | Node 26 转 LTS 之后，且 Safari 正式支持 Temporal 时再提 |
| `listAddressCandidates`、`connectionAuth` 对拓展开放（ADR-0024 决策 11；10-11：运行时也不开放，宿主登记时摘掉） | alpha 之后桥帧改名时一起看：连同拓展契约、桥协议、仓外两个桥插件一起设计 |
| 来源的 `searchCreators`、`GET /api/sources/:sourceKey/creators`、`/api/sources`（描述符下发）：3a-28 没做，面板这一片完全不动（已定），旧的 `/api/subscriptions/search` 与 `/lookup` 还在用。10-14 主人定提前：**来源方法 `searchCreators` 3b 造（B 站实现、只给 AI 的搜人工具用），路由 `GET /api/sources/:sourceKey/creators` 与面板仍第 4 期**；来源描述的 `creatorNoun` 与 contract 里的叫法函数 3b 造，提示词按 ADR-0030 决策 3 全做（面板上的叫法仍第 4 期） | 方法与叫法函数 3b；路由与面板第 4 期面板改造时，连同关旧口、修「搜人时风控与未登录都报成 404」一起做。🔗 现状（4-12，10-27）：`/api/sources`（描述符下发）与面板的 `useSources()` 已落；搜人路由与关旧口仍在后面。🔗 现状（4-15，10-28）：搜人路由落了，`/api/subscriptions/search`、`/lookup` 与 `/api/ext/:id/lookup` 都删了 |
| 登录状态的定时检查（10-14 主人定现在不做）：仍由 B 站自己按 `healthCheckMinutes` 起定时器；宿主看 `auth.onChange` 报登录问题，但不替来源定时检查 | 第二个有登录的来源出现时一起设计（宿主定时调、统一判） |
| 市场索引里给人看的字不分语言（10-14 主人定）：这一期索引只放清单里的默认文字，装上之后才按语言显示 | 第一个带译文的拓展上架时，给条目加一格可选的按语言文字（索引规则不严格，加一格是加宽）；见 [extension-marketplace.md](../agents/extension-marketplace.md) |
| 桥接拓展自己的清单与视图文字出三种语言（ADR-0037 后果一节）：3b-43 只让假源带 `locales/`、当 `ctx.i18n` 的真实使用者，桥这一片不动（10-17 照规矩定） | 代码与验收已落5-38（2026-11-07）：四语`locales/`、`ctx.i18n`及桥接日志齐备；版本选择与发桥仍待发行安排 |
| issue 56 其余部分：填 `作者/仓库名` 加源、`.bn/`、脚手架、发布模板、契约包怎么给第三方（10-14 主人定时机） | 排在 1.0 重构之后、抖音拓展之前 |
| 来源的 `fetchProfile`：定案点名的使用者是核心按资料刷新 cron 定时调，今天资料刷新仍由粉丝轮询那条路做 | 3b，资料刷新中立化时。🔗 10-23（3b-24）：已落成必备成员，核心资料刷新经它取资料，粉丝轮询已并入。 |
| `ctx.fetchImage` / `storeImage`：请求客户端这一期只有 B 站有、没进公共上下文，B 站来源仍经依赖拿抓图服务，绑上去没有调用方。10-14 定：造的时候一个集成一个写口，抓到的图挂在名单恒空的「在途」引用方下（见 [extension-contract.md](./extension-contract.md)「图」） | ✅ 3b-39 已落（10-19）：每个集成经 `openIntegration` 拿到 `ctx.http` / `fetchImage` / `storeImage`，B 站来源与直播引擎改读上下文的 `fetchImage`；写口是「集成在途」（`IMAGE_REFERRERS.inTransit`，运行时 `AppRuntime.transitImages`） |
| 登录装配进集成的 `start`（主人 10-12 定留到 3b；原归 3a-40，两次量过都是同一个结论：要进就得把 `api` 等句柄交回入口，入口的 B 站替身数不降反升、`compose.ts` 的导出类型里多一个 B 站客户端）：`createAuthSystem` 的调用与它交回的 `api` / `auth` / `integration` 等今天仍在入口，入口那 1 条越界 import 由守卫 1 的棘轮钉着，入口手里 B 站的东西由入口咽喉守卫的判据 ③、④ 钉着，都只许降。🔗 现状（3b-47，10-25）：已落。`createAuthSystem` 改同步收现成的 `BiliContext`，在 `createBiliSource` 里造一次，来源 `start` 第一步起、`stop` 最后停；入口不再造登录系统 | 3b，直播、关注同步、粉丝轮询、链接解析并进来源、`Api` 的读者清掉时，一次进集成的 `start` |
| 系统页与拓展页的日志等级入口（主人 10-11 定：服务端一次做全、面板入口第 4 期；主人 10-12 定：第 4 期之前，适配器与拓展没写自己那一格的直接跟总等级、不加回落）：今天系统页只有 `core`、`bilibili`、`image`、`ai` 四行（概览页同样看不出它们的等级），三个内置适配器与每个拓展要单独调，只能调总等级，或手发 `PATCH /api/settings`（`core.logging.levels.<适配器键或拓展 id>`，清掉发 `null`） | 第 4 期，系统页与拓展页按集成的描述画时 |
| 概览页「各模块」里 `api` 那一格显示的日志等级读的仍是 `core` 的覆盖（`apps/web/src/pages/Dashboard.tsx` 的 `OVERRIDE_KEY`）：B 站接口的日志现在实际跟 `bilibili`，这一格只是显示不准、不影响实际等级；同文件与 `System.tsx` 里「B 站那一格管动态与直播两个引擎」的注释也过时（主人 10-12 定：留到第 4 期随健康卡重做一起改；概览页看不出适配器、拓展的等级同理。被否：现在改一行，`Dashboard.tsx` 的 B 站替身数 5 → 6、要涨上限） | 第 4 期，健康卡整个重做时 |
| 集成级登记的终点（主会话照方案记）：集成级的登记表，内置集成在 `start(ctx)` 里用同一组登记方法把各接口登进表。今天没有地基 —— `linkResolvers`、`aiToolProviders` 两张表 3b 才有，3a-40 没造；`compose.ts` 仍直接往来源登记表、适配器登记表登记。🔗 2026-10-23（3b-34；34-3 落成后）：两张表已造，来源在自己的 `start(ctx)` 里已经能分别经 `ctx.registerLinkResolver` / `ctx.registerAiToolProvider` 登记，撤销随来源上下文走；B 站的链接解析器与两把 AI 工具都走这一条 | 3b |
| 来源 `health()` 的返回当外来数据收（主会话 10-12 照第一次独立审查的记一笔留 3b）：今天唯一的实现者是仓里带类型的 B 站来源，`status` 那头只有 `try` 兜着抛错；返回 `{}`、一个 Promise、带换行的 `summary`、空的 `label` 都拦不住 | 3b，给拓展来源开 `health` 的口时，在契约那头收成字符串、单行、限长。🔗 现状（3b-42，10-24）：已落 |
| 中立的「会员档位图标」口：B 站在来源启动且名单里有人要监听直播间时，经 `ctx.fetchImage` 抓三档徽章，引用写进自己描述符的 `tier.icon.ref`；宿主「来源声明的图」名单现读登记表中全部描述符，缺引用时经 `liveInteractions.fetchTierIcon` 补抓 | ✅ 3b-22 已落（10-21） |
| `status` 分不出「没有订阅开着动态」（主会话 10-11 定不为它单说）：这时那一行与刚启动一样是「B 站：还没抓过」；要说准得给动态引擎开新的读口，而「cron 没在跑」同时也是风控退避的样子，分不清 | 没定 |
| 统计「这个小时在记」对在册的非 B 站内置来源不成立（3a-42 对拍查出，文档此前没有单独点名；对拍名单 N16）：「在记」只有两个来路 —— B 站登录着的每小时一跳（`stats/bili-source.ts`）与拓展的上报事件（`stats/extension-source.ts`），内置的非 B 站来源作品行记了、「在记」没人替它记，那几天统计页是「没在记」、锐评与榜单跳过它；定案是「在记」由核心自己算（ADR-0027 决策 2），今天只有 B 站这一个内置来源所以没暴露 |

> 🔗 现状（3b-26，10-24）：已落（N16 → P45）。`stats/registry-source.ts` 的 `attachRegistryStatsSource` 对所有在册来源按订阅的 `recordsPosts` / `recordsLive` 记当前小时（没有登录口，或登录口现读是 `logged-in`；挂上时、每 1 分钟、`subscription-auth-changed` 时各看一眼）；`stats/bili-source.ts` 删了。3b-42 把拓展来源登进登记表后，没有登录口的拓展会被当成「在册即在跑」，3b-42 要定它的在跑怎么算。
 3b，第二个内置来源出现之前，或统计「在记」改成核心自己算时 |
| 会员档位读口按（体系 id, 档 key）找：体系 id 在全部在册来源之间唯一，登记时撞了拒收；档 key 只在所属体系内唯一。卡片预览请求带可选的 `program`（体系 id），`MembershipTierReader.byKey` / `lowest` 按这一对查 | ✅ 3b-22 已落（10-21） |
| 锐评里订阅的名字：B 站没有资料名时写「UID <id>」，别的来源走拓展那条名字链（`stats/roast-subject.ts`，3a-42 对拍查出）：「UID」这个叫法只有 B 站有 | 3b，资料刷新中立化时随名字链一起统一。🔗 10-23（3b-24）：已落成，锐评与直播卡、女仆订阅视图同走 `displayNameOf` 与描述符驱动的身份标签。 |
| 新建订阅的路由（`routes/subscriptions.ts`）把键不是 `bilibili` 的一律当拓展，只认「装着的 v2 订阅源」、不问来源登记表（3a-42 对拍查出的结构性后门，对拍名单 N01）：在册的内置来源经接口建不出订阅，对拍只能开机前写订阅文件 | 第 4 期，来源的 `searchCreators` 与 `/api/sources` 落地时一起改这道门。🔗 现状（4-15，10-28）：门改问来源登记表（在册就认；不在册的才看装没装成订阅源拓展，停着也行），所有来源同一条路；带来的候选资料一律种进资料缓存，没带就只建订阅、不当场刷（主人定只种不刷）。对拍 N01 转成进程内对拍 P52 |
| `status` 指令的「登录」一行直读 B 站登录系统（N17）✅ 3b-06 已落：`status` 的登录行与 `login [来源]` 都现读来源登记表，N17 转进对拍的 P21。女仆的订阅视图里 B 站给 `uid` 而别的来源的平台名问拓展装载器不问来源登记表（N18，3a-42 对拍查出）：假来源的订阅在女仆眼里平台名退成键名 | N18 一半：3b，AI 工具中立化时 |
| AI 实例按每一家隔离之后留着的几件（3a-39 的后续，主人 10-12 知情）：面板在指针没着落时（比如 `activeProfile` 指着的那家读不懂、在内存里不在），会把「平时用哪一份」拨到新加的那一家；保存补丁里带 `__proto__` 键仍静默丢；实例 id 含冒号时密钥袋键可能撞车（第三次独立审查量过：`a` 与 `a:vision` 撞名时键只在这两家之间串、不丢；`search:` 开头的 id 会丢袋键，已修）；撞 id 的拒收排在 AI 探活之后（AI 开着时新 key 会被真打一次探活）；经保存撞原型名回的是英文的 `Invalid key in record` | 第一件第 4 期改面板时看（4-36）；🔗 2026-10-28（第 4 期片表 Q11，主人定）：后几件不进第 4 期 |
| 面板里有三处与核心新缺省「作品」（作品叫法没声明时，3a-42 改）不一致（第三次独立审查记一笔；面板特性标签等仍以「动态」兜底） | 第 4 期改面板时一起改 |
| 核心账号模块 `accounts/`（汇总各来源的登录态）与账号排序 `core.accounts.order`（进备份）、`/api/sources` 列表与 `has.auth`、多账号面板、头部多账号下拉、新手引导的登录步按来源生成：3a-29 B 站半没做（主人 10-11 定范围甲档），今天只有 B 站一个有登录的来源，读者都在第 4 期；面板读登录态是 `["source-auth", 来源键]` 的查询缓存，读的地方各自点名要哪个来源 | 第 4 期开账号页时造 |
| `IntegrationContext` 上的 `reportProblem` / `resolveProblem`（不带对象的第一层）与 `PlatformAdapterContext` 上带 `connectionId` 的那一支：3a-30 只把两个成员造在 `SourceContext` 上（落成的签名多可选的 `recoveryMessage` 与 `resolveProblem` 的 `notify`，见 ADR-0025 决策 11 下的 🔗），`IntegrationContext` 与适配器的上下文上没有（没有实现者的接口不造） | 3a-39 报了设置读不懂的问题但**没造这一格**（核心那条由 `runtime/bootstrap.ts` 直接写问题表，B 站那两条走 `SourceContext`），仍留着，等第一个在 `start(ctx)` 之外要报的集成；拓展那一支随 3b 契约第 3 版 |
| `Problem.about` 的 `{ connectionId }` 那一支与「连接删了，关于它的问题跟着清」：3a-30 的 `Problem.about` 只有订阅一支，订阅删了清已做（`subscription-changed` 的 `remove`）。10-14 主人定随 3b-38 造（宿主替连接报的几条、适配器的 `reportProblem({ connectionId })` 都用它） | 3b-38 |
| 风控码全仓几处不一致：接口层分类器的 `-352` / `-403`、动态引擎只认 `-352`、粉丝轮询四个码、上舰观众头像那次查询撞风控只记 warn 不进退避；3a-30 没有重新定义「哪些码算风控」（只把今天叫风控的两处——动态的 `-352`、直播预检被拦——报到风控层）。10-14 主人定：B 站在 `bilibili/` 里有一张共用的「数字码 → 标准码」翻译表，请求层查一次：`-352`、`-412`、`-799`、`-509` → `rate_limited`；`-101` → `unauthorized`；`-403` 不进共用表，由用到它的接口自己判；没对照的码 → `unknown`（原码进 `upstreamCode`，每个进程第一次撞上记一条 warn）。详见 [subscription-sources.md](./subscription-sources.md)「B 站怎么实现」 | 3b（上舰观众头像那处从 3a-30 改记到这里）。3b-18 已落：翻译表、拉动态、直播预检、上舰观众头像（撞限流后 5 分钟冷却，不进问题表）、cookie 续期（只有 `-101` 才登出）都读标准码；粉丝轮询那几处与登录取码手写的 `-352` / `-403` 留给 3b-24。🔗 10-23（3b-24）：两边都已改完，表外码统一 `unknown` 且每 `Api` 实例每码只 warn 一次。 |
| `CardFailureTracker` 的接口可以收小：删掉出图失败的直发私聊之后，`settle(false)` 只剩「告警发射同步抛了」一种来路，`claimNotice` 加 `settle` 两步可以收成一步 | 3a-30 之后任何一次动 `posts/deliver-post.ts` 时顺手 |
| 两套交互文案（女仆 / 平实）做成用户可选的开关（10-11 主人定）：一个开关管全部交互文案，不是每处各一个；3a-30 只出了女仆版，给主人看的话集中在 `bilibili/problem-texts.ts`。10-14 修订：集成写的问题句（B 站、内置适配器、拓展）一律平实、只说事，口吻由宿主按开关加工（推翻 3a-30「B 站问题文案女仆口吻」的定稿），见 [extension-contract.md](./extension-contract.md)「问题上报」 | 第 4 期，和面板重做一起做 |
| 第 4 期改面板时，交互与提示文案用女仆风格，标题、导航、栏目名、数据名保持平实（10-11 主人定的界线） | 第 4 期开工时带上，写第 4 期计划时列进去 |
| 多语言：**10-12 已定，见 [ADR-0037](../adr/0037-i18n.md)**（整台一种语言、简中 / 英 / 日、口吻是叠在平实版上的一层、译文放 JSON、自己写一层不装包、拓展清单的译文另放文件）。还悬着的在那份的「仍未决」：设置校验的报错怎么翻、新装时猜出的语言什么时候写进设置、日文译文谁把关、口吻默认哪一种（第 4 期定；定之前取女仆，默认值只写在规则里、不落盘）、桌面托盘菜单。清单译文文件的细节与拓展问题的引子 3b 已定（见 [extension-contract.md](./extension-contract.md)「译文与 `ctx.i18n`」与「问题上报」），核心那一层 3b-09 定了公开接口（`mergeDict` / `translate` / `createI18n`，`packages/internal` 新开的零依赖子路径；服务端 `i18n` 与 `t`，面板 `i18n` 与 `useT()`；译文 JSON 住服务端与面板各自那边） | 归期见分期表下 10-12 那一条 |
| `SourceAuth.methods` 与 `beginLogin` 的 `method` 参数、`"cookie"` 这种登录办法：3a-29 B 站半没造（今天只有扫码一种，没有实现者也没有预知的使用者，规范：没有实现者的接口不造） | 第一个有两种登录办法的来源出现时，连同配套问题一起设计 |
| 来源自带指令与指令重名的规矩；`CommandProvider` 登记表到那时连同设计（1.0 不造，ADR-0031 决策 1） | 第一个真要自带指令的拓展 |
| 订阅坏行隔离（主人 10-11 定，排到 3a 之后）：订阅文件有一行过不了、形状不对或标签表不合规矩，今天整个拒、挡开机（跳过坏行的话下次写回那几行就永久丢了，所以 3a-39 只在规范里写明、代码没动）；要做成「坏的那一行隔离、别的照常」，得连着定被隔离的行放在哪、写回时怎么保它不丢、面板怎么显示。推送目标文件同样今天整个拒，这一条没点它 | 第 4 期（10-13 主人定），和问题框、「设置不合法」那两种状态一起设计。🔗 2026-10-28（第 4 期片表 Q4b，主人定）：坏行原文留在原文件原位、配置仓记着、写回时原样带回，盘上形状不变（4-22）；推送目标文件本期不捎 |
| 备份导出结果里提示哪几格是按默认值导出的，连同一个只给路径的坏格读口（主人 10-11 定放第 4 期）：3a-39 的导出带内存值、不记 warn，因为要提示就得把带原文的坏格表接给备份服务，或为一行日志另开一个只给路径的读口；坏格在开机时已经记过 warn、问题表里也有 | 第 4 期，要动导出回包与面板时 |
| 第 4 期面板显示坏格的原值与原因（主会话 10-11 照规矩定，主人没反对）：今天读坏的格面板拿到的是默认值，是哪一格、为什么只写在问题条目的文字里，不为面板造「原值与原因」的字段（形状没定，读者是第 4 期）；旧面板也清不掉「就想用默认值」的那一格（没有改动发不出保存），要先改成别的再改回来 | 第 4 期，问题框与系统页一起做。🔗 2026-10-28（第 4 期片表 Q4a，主人定）：非密钥格回原值 + 原因，密钥格只回原因（4-21，见 ADR-0025 决策 4 下的 🔗） |
| 内置来源的运行状态读口与 `failed`（主会话 10-11 照「没有实现者的接口不造」定，ADR-0025 决策 5 下的 🔗 主人点了头）：3a-39 没造，今天没有读者（`/api/sources` 不下发运行状态、健康卡没接）；`settings-invalid` 今天只有拓展装载器产生。🔗 3a-40 造了 `Source.health()`，`status` 指令改读登记表里各来源的那一句话（原写「读动态引擎」已不成立），但 `health()` 只交一句 `summary`、不是 `running` / `failed` 的运行状态读口，所以这一条仍留着 | 待定（原写「3a-40 的来源 `health()`」，那一片没有造运行状态；等第一个要读运行状态的人，如第 4 期的健康卡或 `/api/sources` 的 `status`）。🔗 2026-10-28（第 4 期片表 Q3，主人定）：由宿主投影、`Source` 不加成员（4-18，见 ADR-0025 决策 5 下的 🔗） |
| `settings(schema)` 升到 `IntegrationContext`（主会话 10-11 照「没有实现者的接口不造」定，ADR-0025 决策 2 下的 🔗 主人点了头）：今天只造在 `SourceContext` 上，使用者只有 B 站来源 | 第一个不是来源的内置使用者出现时（登录装配进集成，3a-40 没做、留到 3b；或 3b 契约第 3 版）。🔗 现状（3b-47，10-25）：该触发器已发生；`createAuthSystem` 已由 B 站来源装配，来源之外现在有登录装配这个真实使用者 |
| 拓展的 `SettingsReader` 与内置的并不并（主人 10-11 定「3b 改名时再定」）：拓展契约里是 `ExtensionSettings<T>.get(): T \| undefined`，内置来源的是 `get(): Result<{ settings: T }>`，两个不同形。10-14 主人定：**并成内置那一种**，`ExtensionSettings<T>` 删掉；读不懂的拓展仍不起 | 3b，拓展契约第 3 版（3b-38） |
| 拓展的「设置读不了」进不进问题表（主会话 10-11 记下，没单独问主人）：今天只在拓展那一行的状态与说明里，不进问题表，规范 `settings-validation.md` 规矩 3 写的是「进问题框」。10-14 主会话照规矩定：进，code `settings_invalid`、记在拓展 id 名下、不私聊，改好起来 / 停用 / 卸载时清；这条是装载器替没起来的拓展报的，「拓展停下就清它名下的问题」不能在启动失败那条路上触发 | 3b，拓展拿到 `reportProblem` 那一片（3b-38） |
| 系统页「登录心跳间隔」数字框的范围与服务端 schema 不一致（主会话 10-11 顺手读到、没改，这一片面板不动）：框是 1 到 1440，schema 是 5 到 180，填 3 会被服务端 400 拒掉 | 第 4 期改系统页时，或 `healthCheckMinutes` 改名 `loginCheckIntervalMinutes` 那一片 |
| alpha 之间还改盘上格式的话怎么迁：格式版本加 1、从上一代迁，还是继续用迁移修订号从第 0 代重迁（测试者在 alpha 期间的数据会丢）；修订号在 alpha.1 冻住。选前者的话要写「上一代 → 这一代」的迁移器（`migration/zero-generation.ts` 只认 0.x；选代遇到「格式版本比我旧」那处报错就是给它留的位置，开代与搬文件的规矩照用），外加「什么改动要抬格式版本」的判据（schema 大多严格，加一个可选字段也会让旧版整份拒收） | 发 alpha 前定 |
| 删掉冻住的别名 `startStandaloneServer` 与旧环境变量名 `BN_IMAGE_VERSION` / `BN_IMAGE_PATH`（那时跑着的 boot.mjs 都写新名）：那一版在清单里抬 `requires.nodeMajor`，旧镜像报「需要新镜像」、不会装上；0.9.0 起每个更新器都认这一格（ADR-0005 决策 4 下的 🔗） | 下次换 Node 大版本 |
| 清零期的字面与实际清得掉的时间不一致的几格（主人 10-12 定：照记进棘轮、清零期的字面先不改，3b 收尾时再问）：uid 与守卫 11 在 `routes/cards.ts`、`routes/subscriptions.ts`、`apps/contract/src/rest.ts` 上的 uid 50 处、守卫 11 17 处，`.platform` 与推送守卫② 在 `packages/internal` 的平台表（`constants.ts`）与连接设置规则（`schema/targets.ts`）上的 3 处与 61 处，以及面板那张 `.platform` 表，按守卫 1 与入口咽喉 ④ 表里的「第 4 期」与 ADR-0024 决策 1 都要等第 4 期；而这几道守卫、守卫 1 的表头与本文件的归期写的是 3b 末清零（主会话推荐的是现在就注明「随第 4 期」，主人选了先不改） | 3b 收尾时问主人 |
| 几张表要不要合成一处记账（3a-41 开了四张，同一个文件常常被四到六张表记着，如 `runtime/engines.ts`、`routes/cards.ts`；主人 10-12 同意这一片不合，每道守卫自带一张表） | 3b 排片时，若发现调表成了负担再看（那时哪些片并行已经清楚） |
| `adapterKey` 比字面量没有守卫（`adapterKey === "webhook"`，核心今天 1 处，在 `packages/internal/src/constants.ts` 的 `isWebhookPlatform` 里；`config/store.ts` 托管 webhook 目标那套逻辑同属这一类，今天没有任何一张表记着）：定案没点它，3a-41 没加，记在 `.platform` 守卫文件头的「抓不到」里 | 3b 的推送守卫③（假适配器对拍）排片时看 |
| 宿主自己的抓图口：核心抓会员自定义图今天借 B 站集成的请求客户端（`BuiltinIntegrations.bilibili.fetchImage`），不合『BN 自己的请求不走集成的客户端』（`docs/agents/conventions/integration-side-effects.md`「边界与例外」）；3b-47 为了把登录装配进来源照旧接上，没改行为（主人 10-25 定）。触发：第 4 期之前，或 3b-50 收尾时。**已落（4-03）**：宿主自己的抓图口 `AppRuntime.imageFetcher`（BN 自己的请求客户端，空罐子、不带 cookie，图存进「集成在途」那一家），入口递给 `createPipelineRuntime`；`BuiltinIntegrations.bilibili.fetchImage` 删了。 | 第 4 期（4-03 已落） |

🔗现状（4-55，2026-10-31）：其余服务端墙上时间已跟核心timezone：免扰、静音截止显示、AI日期和三个cron家族；统计登记表的60秒检查、资料首轮3秒及退避仍按经过时长。旧stats/extension-source.ts已由stats/registry-source.ts替代；followers-sample-gap.ts的CronTime只估间隔，本片不改。新1.0拓展契约从apiVersion1/revision0起号，仅接受当前strict清单，不恢复历史v1/v2。4-48时区选择UI仍未做，迁移53/备份23不变。

🔗现状（4-55，2026-10-31）：桌面宿主不在东八区、或Docker改过TZ的用户，免扰将从宿主当地时刻切为核心timezone（默认Asia/Shanghai）的当地时刻，可能按原时差挪动一次；后续发版素材应说明这项行为变化，本片不直接改CHANGELOG。
