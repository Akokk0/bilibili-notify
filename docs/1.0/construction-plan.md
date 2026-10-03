# 1.0 施工计划

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023，以及 ADR-0024 ～ 0031。

分几期、每期做什么、期间守什么规矩、中立性守卫哪一期开哪一期清零、第 1 期怎么切片、分支怎么走、alpha 怎么发，以及还没进表的零碎施工项、施工中顺手修的现存毛病和以后再说的事。要做成什么样见 [architecture.md](./architecture.md)、[data-model.md](./data-model.md)、[data-and-migration.md](./data-and-migration.md)、[subscription-sources.md](./subscription-sources.md)、[extension-contract.md](./extension-contract.md)、[push.md](./push.md)。

## 一句话

**在 `dev-next` 上一期一期做，每期全量门禁全绿才进下一期；先发 1.0 alpha，稳定后升到 1.0.0。**

## 纪律

- **不整体重写，以改造为主**（ADR-0021 决策 58）：某个模块的核心逻辑从头到尾是 B 站的形状、改造要动每一行时，才对着中立接口局部重写，旧测试当规格书；其余一律改造。分期表「方式」一列就是按这条判的；施工中逐模块按同一判据定，不另起整体重写。
- 每一片跑完整门禁再提交。
- 每期（3a、3b 分开算）全量门禁全绿才进下一期。
- 3a 完成即检查点：B 站全经中立接口运行、行为不变；守卫 21b「进程内中立性对拍」绿。
- 中立性守卫分三层（咽喉、静态扫描、对拍，ADR-0021 决策 59；判据与范围见 architecture「守卫」），每一道哪一期开、哪一期清零见下面「中立性守卫的归期」。棘轮守卫的规矩：开启那一刻记下命中数当上限，只许少不许多，多一处就红，上限随清理调低，到它清零的那一期结束必须是 0（不能「一开就红」：每期都得全绿才出期）。
- 哪一期改了盘上形状，就在同一期往迁移模块加条目、钉进守卫 13 的清单；不留到最后统一补。第 1 期只建迁移地基。
- 新写或重写的代码直接用新名，第 5 期只清扫没被动到的旧名。
- 新写或重写的接口方法与路由，失败直接按 ADR-0026 的结果形状与标准码写。

## 分期

规模以「④′ 轮」计（④′：约 5 小时、26 个提交、116 个文件）。原估 12–14 轮，第二轮拷问加了数据代、接口拆分与命名批，第三轮又加了推送侧中立化、集成与三层守卫，总量施工时重估，不含真机验收。

| 期 | 做什么 | 方式 | 出期条件 | 规模（④′ 轮） |
| --- | --- | --- | --- | --- |
| 0 ✅ | 测试拦外网（守卫 2，`scripts/network-guard.mjs`）；09-29 补上 DNS 查询（第 2 期抓图拦内网要先解析，不补就漏） | 改造 | 已落 | 0.2 |
| 1 | 地基：身份、持久化底层与关停、资产与皮肤存储合一；**迁移地基**（数据代、先 listen 再迁、只迁一次各代互不干涉、首访页、全新开始、订阅合一、设置分段）；迁移耗时测试。切片 ①–⑨ 见下 | 持久化局部重写，其余改造 | 迁移耗时测试绿 | 施工时重估 |
| 2 | 数据模型：作品卡与直播卡、**抽 `packages/http`**（请求客户端、cookie 罐、浏览器身份，从 B 站的实现里抽出，抽出去的直接按 naming.md 起名），抓图核心服务建在它上面（安全防护逐跳查重定向 + 图库）与图库引用、皮肤字段、特性键；新类型直接用新名。并入：`LiveCardInput` 人数只收精确数；`formatCount` 带符号变体、`formatAgo`、`formatDuration`（连删 `{time}` 兜底与 `getTimeDifference` 钩子）；卡种中文名收一份；出图字节门按「批准的像素差清单」裁决（ADR-0028 决策 2）；⑥b 留在代里的三处过渡（`avatars/`、`history/img/`、`assets/chat/`）随图库并进 `images/`，目录表里那三个过渡键随之删掉；10-02 新定的推送历史拆两层、粉丝样本压缩、运行记录、统计总开关与存储占用、订阅标签也在本期。切片 ⑩–㉙ 见下 | 出卡前半段局部重写 | 守卫 10 清单外的差异为零；出图器零联网绿；⑨ 迁移耗时测试在 ⑳ 与 ㉘ 之后仍绿 | 施工时重估（原估约 4，估于 `packages/http` 并入与 10-02 新增各项之前） |
| 3a | 接口先行：`SubscriptionSource` 与横切接口、登记表、`SourceContext`（建在 `IntegrationContext` 上：state / secrets / settings / http / report / fetchImage 挂上 ctx；`reportProblem` 进全在内存的问题表，ADR-0025 决策 11）；B 站四个包搬进 `bilibili/`（先纯搬、只改 import 路径；紧接着单独一个提交按 naming.md 改名，含词表、外部接口回应的起名、原字段名只留在回应上；再做中立化） 并实现，中立部分同时拆进 `posts/` 与 `live/`；`accounts/` 与 `bilibili/auth/`；设置坏了只停那一处（集成段只停那个集成，`core` 段逐格退默认）。推送侧：`PlatformAdapter` 接口与登记表（登记即 `start`）、OneBot / QQ 官方机器人 / webhook 作为内置适配器登记并带模板候选、`/api/adapters`、连接与目标的新形状（连接 `adapterKey` / `settings` / `platformSnapshot`，目标删 `platform`）与迁移条目、只有 `TargetDispatcher` 能发送（链接回复与指令回复改走 `sendToAddress`，`notifyMaster` 返回结果形状；主人目标只许指向私聊目标（ADR-0021 决策 57：schema 校验、面板下拉只列私聊目标、迁移时清空指向群目标的并记进 ⑧ 的首访数据）；咽喉 e2e 在本期就要驱动这几条路）。schema 标 `secret: true`、服务端按 `MaskedSecret` 下发。本期开的守卫见「中立性守卫的归期」 | 改造 | 检查点：B 站全经中立接口运行、行为不变；守卫 21b 绿 | 施工时重估 |
| 3b | 各块中立化：先 e2e 钉直播四种行为，把醒目留言 / 会员 / 特别弹幕 / 特别进场的装配从 `room-session.ts` 抽进 `live/`，再合场次引擎；直播监听的唯一判定（B 站改存 `WATCHED_CHANGE` 的 `num` 10-02 挪进第 2 期 ㉒）；资料刷新；链接预览（ADR-0029）、指令（`CommandDef` 与通用的 `login [来源]`，ADR-0031）、AI 工具与女仆技能（ADR-0030）；DevtoolsProvider（场景 `DevScenarioDef`）与假桥搬家；拓展契约 v3（含推送侧加宽）、`pickPerId` 与索引规则；桥迁 v3 | 链接预览与指令重写，其余改造 | 守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫② 清零；守卫 21a、推送守卫③、模板变量可满足性、AI 工具与技能约束绿 | 施工时重估 |
| 4 | 面板按描述画：来源按 descriptor 渲染（面板只从描述符拿来源信息，ADR-0027 决策 5–7）、连接 / 目标表单、候选 / 扫码 / 地址控件、B 站设置 tab（含「换一个身份」按钮）、功能页指向拓展设置的入口、两种「设置不合法」态（连接的、集成的）、健康卡（**先出设计稿，主人认了再照稿写**；含盘上遗留的同身份订阅，见 data-model）；AI 设置页「女仆写正文」一节（picker 切动态 / 直播，默认一行 + 按群例外表，例外表与链接预览共用一个件，ADR-0032）；账号排序、预览、问题框、日志筛选、密钥打码（统一密钥输入框）、素材库界面、旧版本数据清理界面、首访页与「正在搬家」界面与自愈退回提示（⑧ 的数据接口；「正在搬家」的进度今天只在开机那一段 503 的原话里（「BN 正在搬家(3/12)：…」），健康检查不说正在搬家，做界面时服务端补一个结构化的阶段与进度；搬家期间面板只显示进度、不去取各页的数据，搬完再进 —— 今天开着面板等它搬完，统计、历史这些不在重连刷新范围里的页会停在出错状态，要切页或刷新）、面板账号修改入口；首页改用直播监听的唯一判定；拓展页改成一个拓展一张卡（卡上标开了哪几口、页头按口筛选，ADR-0025 决策 13） | — | B 站替身清零 | 施工时重估 |
| 5 | 收尾：清扫剩余旧名、目录与文件名、测试归位、死代码、守卫补齐、托管文档与 docs/agents 同步；全仓包版本统一 `0.0.0-dev` | 机械活，一次做完 | 中文叫法棘轮清零 | 约 2 |
| 6 | alpha 配套：抖音拓展（`ctx.http` 的第一个拓展用户）；重议 Q76：`linkResolver` / `aiTools` 对拓展开不开，`commands` 只在抖音拓展真要自带指令时才议（`CommandProvider` 1.0 不造，见「以后再说」）；定桥的版本号；在 dev 上打 `v1.0.0-alpha.1` | — | — | 施工时重估 |

- 「方式」沿用最初分期表的施工指引：原第 3 期拆成 3a / 3b，链接预览与指令都在 3b；第 4、6 期没有对应的记录。
- 这些归期是 09-27 复核时补的，主人可调：第 2 期并入的格式函数与直播人数；3a 的中立部分同步拆分与密钥下发；3b 的装配抽出、监听判定与 `num`；第 4 期的首页判定与密钥输入框；第 5 期的包版本；以及下面「零碎施工项」整张表。
- 09-28 拍板的归期（ADR-0021 决策 60）已并进表：第 2 期的 `packages/http`；3a 的推送侧、`SourceContext` 的 `settings` 与 `http`、设置坏了只停那一处；3b 的契约 v3 推送侧加宽、桥迁 v3；第 4 期的按描述画与健康卡设计稿；第 6 期的 `ctx.http`。三层守卫的期次同日拍板，见下节。

## 中立性守卫的归期

判据与范围见 [architecture.md](./architecture.md)「守卫」；这里只写哪一期开、哪一期清零或必须绿。棘轮按「纪律」里那条规矩走。

| 期 | 开启 | 清零 / 必须绿 |
| --- | --- | --- |
| 1 | 切片 ④：出网点名表（棘轮，④a）、错误体（④b）、结果不手写（棘轮，④b）、事件载荷（棘轮，④c；总线事件载荷里不许有 `uid` 键、`Bili*` 类型、平台原始值的裸 string）；切片 ⑥：守卫 12（棘轮，按 import 判；解构与下标归 B 站替身）、B 站替身（棘轮） | — |
| 2 | 出图器零联网；守卫 10 的「批准的像素差清单」机制（快照早已覆盖全部卡种，10-02 查时 23 份），差异按清单裁决 | 两条都绿 |
| 3a | 咽喉三道：入口咽喉、出口咽喉、咽喉 e2e（逐条驱动全部发送路径，每条恰好一条截流记录、零外连）；守卫 1、17、22；守卫 11 修订版（边界匹配、词表自动生成、扫 contract；3a 开头以棘轮开）；uid 棘轮；`.platform` 决定棘轮（推送侧）；推送守卫①；推送守卫②（棘轮，词表同期加宽并扫 contract）；守卫 18 的保留 id 加上三个内置适配器的键 | 守卫 21b（进程内对拍）绿，即 3a 检查点；守卫 12 清零 |
| 3b | 守卫 21a（契约层对拍）、推送守卫③（假适配器对拍）、模板变量可满足性、AI 工具与技能约束 | 守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫②、出网点名表、事件载荷清零 |
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
| ⑫ | 订阅标签（ADR-0034）；顺手删旧的 `SubscriptionStateSchema` 与 contract 的死字段 `SubscriptionDTO.state` | ✅ 已落（标签表与订阅同住 `config/subscriptions.json` 的 `{ tags, subscriptions }`，`GET` / `PUT /api/subs/tags` 整张换；迁移修订号 15，名字里的中文逗号不拆（主人定）；备份同进同出、合并先按 id 再按名字；面板一个 `TagEditDialog` 收掉逗号文本框与编辑分组弹框。施工时定的几点写进 ADR-0034 的 🔗） |
| ⑬ | 特性键改名、直播拆成 `liveStart` / `liveStreaming`（独立的开关、目标、间隔与补报开播）、`PushKind` 的两层意思拆开；以特性键做键的配置一起改键（迁移表「特性键」到「文案」那几行）；守卫 13 前半开（10-02 开片，切成 ⑬a–⑬f，见表下「⑬ 开片」） | ✅ 已落（10-03） |
| ⑭ | 抽 `packages/http`：请求客户端、cookie 罐、浏览器身份、`websocket()`；删自定义 UA；出网点名表换路径。身份与 cookie 罐本期经注入的存储留在原处，3a 再挪进 `ctx` | 未开工 |
| ⑮ | 图库 `images/`：`<sha256>.<ext>`、`ImageRef`、嗅探、8MB 上限、同源读口；目录表加键 | 未开工 |
| ⑯ | 抓图核心服务：逐跳查重定向、超时、结果形状、`storeImage`。旧引擎本期由服务端直接调它拿 `ImageRef`，3a 改走 `ctx.fetchImage` | 未开工 |
| ⑰ | 引用方登记表 + 按引用清扫 + 新图宽限期；守卫：写图库的模块不在登记表里就判红 | 未开工 |
| ⑱ | 历史行改形：`identity`、`nameSnapshot`、头像换图库引用、`createdAt`、`repushOf`、`RepushSnapshot`（`kind` → `feature` 10-03 提前到 ⑬f）；盘上旧失败转 `unknown`；守卫 13 加固（重推原件每种载荷都有去向） | 未开工 |
| ⑲ | 推送历史拆两层：文字不设上限，图按天数清（90 / 60 / 30 / 15 / 7 / 3 / 1，默认 30），超期的行「图已清理」、不能重推；迁移换算老配置、不搬超期图与孤儿图 | 未开工 |
| ⑳ | 三处过渡目录并进图库：`history/img/`、`avatars/`、`assets/chat/`（女仆 AI 看图跟着读图库）；读口一起改；迁移把硬链接按摘要改名；目录表删两个过渡键；⑨ 复测 | 未开工 |
| ㉑ | 作品模型 `Post` / `PostImage` / `Creator` / `RichText` + 唯一取段函数；出卡改吃 `Post`；过滤键改名 | 未开工 |
| ㉒ | 直播卡输入：人数只收精确数（缺键不画）、封面走 `PostImage`、`startedAt` 改 ISO；B 站改存 `WATCHED_CHANGE` 的 `num`（10-02 从 3b 挪来） | 未开工 |
| ㉓ | 会员与醒目留言：`MembershipTier`、`SuperchatEvent.tier`、`templates.membership` 重做（顺手修图片空串不兜底）；舰长图标改本地资产（10-02 从 3b 挪来） | 未开工 |
| ㉔ | 皮肤字段改名、卡种键改名（含 `cardStyleByKind` 的键与它挪进 `defaults.cards.byKind`，10-02 从 ⑬ 挪来）、皮肤 schema 抬版；卡种中文名收一份 | 未开工 |
| ㉕ | 出图器零联网守卫：渲染页只许 `data:` 与本机图库，其余拦下计数；出网棘轮里 `image-renderer` 清零 | 未开工 |
| ㉖ | 统计改写：`PostEntry` / `LiveSessionEntry`、帧字段改名、`stats/posts`、粉丝行 `followers` / `sampledAt`；ADR-0027 服务端那半（按特性在记、开播公告不记、多收字段、最近作品缓存并入、删 `?uid=`、CSV 合列） | 未开工 |
| ㉗ | 运行记录 + 迁移时从 0.x 粉丝样本回填运行时长（ADR-0033 决策 3，必须先于 ㉘） | 未开工 |
| ㉘ | 粉丝样本降精度再合区间：最近 8 天原样、每天一趟压缩、迁移压 0.x 老样本；⑨ 复测 | 未开工 |
| ㉙ | 统计总开关；系统页「存储占用」的服务端；旧代的列表、大小、删除服务口 | 未开工 |
| ㉚ | 路由按资源整理（ADR-0036，10-03 主人定，**插在 ⑭ 之前做**）：照 ADR-0036 决策 4 的对照表只改路径、不改行为，server 改挂载、面板改调用方与缓存键、测试与文档跟上；素材库、来源、适配器、问题表那几组随各自那一片搬（决策 5） | 未开工 |

- 依赖：⑭ 与 ⑮ 互不依赖，都先于 ⑯；⑰ 先于 ⑲ ⑳；⑱ 要 ⑬ ⑮；⑳ 要 ⑲（超期的图不搬）；㉑–㉓ 要 ⑪ ⑮；㉔ 要 ⑬ ㉑–㉓；㉖ 要 ⑪ ⑬；㉗ 先于 ㉘；㉙ 要 ⑰ ㉖。每动一处盘上形状都抬 `MIGRATION_REVISION` 并补夹具。
- 改 contract 形状的片（⑫ ⑬ ⑱ ⑲ ⑳ ㉖ ㉙）面板同片跟上到「照旧能用」，面板的新界面仍在第 4 期。
- 设置键本期只改这几片碰到的：⑬ 以特性键做键的配置、⑲ 图片保留天数、㉙ 统计开关；`app` → `core.*` 的其余拆分随 3a「设置坏了只停那一处」（`app.logLevels` 的键、文案账本挪进 `core.templatesSeen` 也随这一步，10-02 ⑬ 开片时挪出）。
- 涨粉起点：压缩把最早那一小时换成小时末值，起点最多挪一小时，不算 data-model 里说的「截尾」，不另存起点；㉘ 落地时在 data-model 写明。
- **⑬ 开片（10-02）**：先勘察，再切成五小片，依次提交：
  - ⑬a 迁移器冻住 0.x 词表：`migration/` 里吃活词表的三处（附加项键与默认值、当前默认文案、推送种类）冻成 0.12 的原样，迁移测试造 0.x 输入改用冻住的字面量；产出一个字节不变，不抬修订号。✅ 已落（`migration/zero-vocabulary.ts` 与夹具 `migration/__tests__/zero-fixtures.ts`；0.12 的出厂全局设置用 `v0.12.0` 实跑的输出，`app` 里 B 站那两格也在）
  - ⑬b `packages/dynamic` 的 `PushKind` → `PostPushPart`（`post` / `post-images`），不落盘、不过 wire。✅ 已落（函数名照 naming.md 用 `Options`：`broadcastOptionsForPostPart`）
  - ⑬c 纯改名、行为不变：特性键 `dynamic` → `post`、`live` → `liveStart`、`liveGuardBuy` → `membership`，附加项 `atAllDynamic` → `atAllPost`、`atAllLive` → `atAllLiveStart`；文案 `templates.dynamic` / `dynamicVideo` → `post` / `postVideo`，账本跟着换键；`messageLayout.dynamic` → `post`（`live` 那组不改名，它管开播、正在直播、下播三种消息）；订阅顶层 `extras` → `extraTargets`；测试推送的 `kind` 改用特性键。迁移加一步「0.x 最新 → 1.0 改名」。✅ 已落（`migration/feature-renames.ts`，四张对照表都 `satisfies Record<0.x 的键, 1.0 的键>`，0.x 的键漏了去向编译不过；修订号 16；`FeatureFlagsObjectSchema` 改成从 `FEATURE_KEYS` 摊出来；备份版本抬到 4，拒收旧备份时只有 0.x 导出的才提「先装 0.12」）
  - ⑬d 直播拆键：新特性 `liveStreaming`（独立的开关与目标，间隔在 `defaults.liveStreaming.streamingIntervalHours`），`restartPush` → `defaults.liveStart.catchUpOnBoot`，`templates.liveOngoing` → `templates.liveStreaming`；补报走 `liveStart` 的路由、历史记成开播、不 @全体，文字与卡照旧用「正在直播」那一套；B 站的周期计时改成开着才计（今天关着也计、到推送闸才扔）；「监听开不开」手抄的三份清单都加上 `liveStreaming`，合成一个判定随 ㉖（ADR-0027 决策 1）。`schedule` 只搬走这两格，静音时段与断流接续随 3a 的设置分拆。新装默认照今天：`liveStreaming` 关、间隔 1 小时（范围 1–24，面板上限 23 顺手对齐成 24）、`catchUpOnBoot` 关。拓展订阅声明了开播与下播两种事件就露「正在直播」开关（`has.liveStatus` 那半随 3a）。✅ 已落：补报与周期靠新加的一档推送类型 `LivePushType.CatchUp`（11）分开，`engines.ts` 的翻译表各加一行，`liveTypeToPushKind` 收成 `featureToPushKind(liveTypeToFeature(t))`；迁移在 `migration/live-split.ts`，订阅那一步取第 0 代的全局值（设置那一步把 `pushTime` 折成间隔以后 0 与 1 分不开），修订号 17、备份版本 5；面板的继承基线改用真正的全局特性开关（原先拿出厂值，迁出来的全局「正在直播」开着时订阅上显示成关、还关不掉），规则页「直播推送阈值」段加全局开关「状态推送」；拓展那条路的周期在服务端也按「声明了开播与下播」认（`featuresForEvents`，面板与服务端同一份）。
  - ⑬e 守卫 13 前半。✅ 已落（清单 `migration/keyed-records.ts` + 判定函数 + 行为核对，做法见 data-and-migration「守卫 13」；订阅那一族的 1.0 步骤抽成纯函数 `toCurrentRow`，读写盘与守卫共用）
  - ⑬f 历史行的推送种类换成特性键（10-03 主人定从 ⑱ 提前）：盘上那一格 `kind` → `feature`，值 `dynamic` / `live` / `live-ongoing` / `live-end` / `guard` / `sc` / `special-danmaku` / `special-enter` → 对应的特性键；`/api/history?kind=` → `?feature=`、按天计数的键、重推闸、契约里的 `DailyHistoryCount`、面板 `PUSH_KIND_META` 改成按特性键做键；`PushKindSchema` 与 `featureToPushKind` / `pushKindToFeature` 删掉，全仓只剩特性键一套名字。迁移加在 `migration/history.ts` 的行级变换里，仍是一趟读写，⑱ 再往同一个函数里加别的字段，历史不会多迁一次；修订号抬一。✅ 已落（修订号 18；`?kind=` 与不是特性键的 `?feature=` 都回 400，和 `limit` / `since` 一个做法；面板的种类表叫 `FEATURE_DESCRIPTORS`（`config/push-features.ts`），分组 `PushFamily` 取值 `live` / `post` / `superchat` / `membership`；守卫 13 补了历史那一族，先红后绿；迁移耗时测试比值 4.05，仍在 5.5 以内）
  - 不归 ⑬ 的：`cardStyleByKind` 的键归 ㉔（它是卡种键，与卡片皮肤共用 `live` / `dynamic` / `sc` / `guard`，`live` 的新名 ㉔ 才定，分两趟改两边名字会对不上）；`app.logLevels` 归 3a（`dynamic` / `live` 并成 `bilibili` 要集成键）。历史行的推送种类原定 ⑬ 不改值、留到 ⑱（`featureToPushKind` 当桥）；10-03 主人定提前成 ⑬f：⑬d 之后两边已经一一对应，历史迁移是一趟读写、提前不会多迁一次，而 ⑱ 要等 ⑮ 的只有头像那一格。备份版本在 ⑬c 抬一次（⑫ 改了备份里订阅那一节的形状，当时漏抬）。
- 开片时要问主人的名字（词表没有的先问再用）：⑭ 请求客户端与 cookie 罐的类名；⑮ `ImageRef` 带不带扩展名；⑲ 图片保留天数的键名；㉔ 直播、榜单、词云、直播总结的卡种键；㉙ 统计总开关的键名。

## 分支与发 alpha

1. v0.12.0 之后的开发在 `dev-next`，1.0 在这上面做；`ci.yml` 已加上 dev-next。
2. dev 与 main 同步，只收小修。
3. dev 每有小修就合进 dev-next，保证 dev 始终是 dev-next 的祖先。
4. 发 alpha 时把 dev 快进到 dev-next，在 dev 上打 `v1.0.0-alpha.1`（发版流水线要求 tag 在 dev 上），全程不用 force。

代价：dev 上的每个小修都要往 dev-next 合一次；换来的是改造期间随时能从 dev 发 0.12.x 急修，不会连带发出 1.0 的活。

CLAUDE.md 与 `docs/agents/build-release.md` 的「分支」都还没提 dev-next，随第 5 期同步。

## alpha 之后、1.0.0 之前

| 项 | 怎么做 |
| --- | --- |
| 年度总结（ADR-0033）：「你和 BN」「你关注的创作者」两块，随时能看、12 月中旬提示一次；导出成「年度总结卡」更晚 | 面板几屏 + 年度统计接口 + `SystemNotice` 新 kind；数据地基已在第 2 期 |
| 桥帧改名（09-27 拍板；alpha 不动）：`forward` → `mergeForward`、`desc` → `description`、`picUrl` → `imageUrl`、能力名 `forward` 同改、能力名 `miniapp-card` → 原生分享，一趟改完。09-28 加一格：群入站消息的 `miniAppCardLinks` 改成入站链接的来源标记（正文 / 普通卡 / 原生分享卡，ADR-0029 决策 2） | 按方向走两步，合起来三拍：① BN 先同时认入站 `miniAppCardLinks` 的新旧两种写法（入站字段两步反过来走：BN 先认、插件再改发，ADR-0029 决策 2）；② Koishi、AstrBot 薄插件发新版：认 BN 发的新旧两种名字，入站改发新写法，回执改发结果形状（过渡期 `err` 照带，ADR-0026 决策 7）；③ 等用户都升上去，BN 再改发新名字、不再认回执的 `err`，桥的适配器里的新旧映射整个删掉。都要在 1.0.0 之前做完；插件只发一次版。`listAddressCandidates`、`connectionAuth` 对拓展开不开放同时看（见「以后再说」） |
| devtools 换 devframe（09-27 从「1.0 之后」提前） | 先做小试验：查清许可证与维护者，重新验证 devtools 不进生产产物（守卫 14 与构建后自检照旧）；试验过了再换 |
| 新手引导换 driver.js（09-27 从「1.0 之后」提前） | 先做小试验：验证引导锁（聚光灯外不能操作，⛔ 不许放开）、跨页面的步骤与晚挂上的锚点、能不能跟随界面皮肤；试验过了再换 |

## 零碎施工项

| 项 | 归期 |
| --- | --- |
| AI 写正文按目标选（ADR-0032）：`core.ai.writing` 两份，默认 `enabled: true`、`byTarget` 为空，升级后行为不变；模板正文总备好，默认开或任一例外开才生成 AI 正文；推送层逐目标挑正文，和 @全体 的分组叠成两维 | 3a（推送层与作品那份）/ 3b（直播总结那份，随 `live/` 装配） |
| 订阅标签（ADR-0034，issue 53）：标签登记表 `SubscriptionTag` + 订阅上的 `tagIds`、读写口、0.x 迁移一条；面板同期跟上（筛选与卡片角标按登记表读名字，订阅详情的「分组」文本框换成和「编辑分组」弹框同一个勾选组件，文案「分组」→「标签」） | 第 2 期（数据模型、迁移与面板跟上）；标签管理界面（改名、删除、排序，接口 `PUT /api/subs/tags` ⑫ 已有）第 4 期。10-02 主人真机看过 ⑫：建了删不掉（就是缺管理界面）、卡片左下角只写第一个标签、只是一行字不好看 —— 第 4 期卡片上把挂的标签全部显示成胶囊 |
| 目标标出所在连接 + 下拉换成自己的组件（ADR-0035，issue 55）：目标一律标平台图标 + 连接名，由一个函数从目标与连接表算出来；`TSelect` 改用 `PopoverShell` + `MenuItem` 拼（键盘、读屏器、焦点由测试钉住），`HourSelect` 与 `Logs` / `SkinEditor` / `RoastPushBox` 三处原生 `<select>` 一并换掉，驱动原生 select 的测试改成点开再选，加守卫拦裸 `<select>`，`packages/ui` 清单同步 | 第 4 期（随连接 / 目标表单） |
| 拓展的定时器收口（与守卫 22 同期）：宿主的 `ctx.setTimeout` 一次性定时器触发后自动从登记里放掉（今天要等拓展卸载才放）；桥的 `pendingTable` 与握手超时改用 `ctx.setTimeout`，结算或断开时 dispose | 3a |
| 拓展契约 v3：min 抬到 3，删 v1、v2 的退路（`legacy-v1.ts` 连同过时注释）；ctx 改成 `IntegrationContext` 加各自特有的一层，新增 `http`、`settings`，上报改 `void`、被拒记进 `reportRejections`；推送侧加宽到 `PlatformAdapterDef`（ADR-0024 决策 3，这一版不开的见决策 11）；`pickPerId` 改成「在当前 BN 装得了的版本里取最高」；索引规则放宽成「每个契约版本各留最新一条」；桥迁 v3，1.0 alpha 期间 v3 的桥只进预发布档 | 3b |
| 读设置的写法简化（待议，10-01 主人提）：格式只声明一处（写在集成定义里，面板要的字段由打包脚本从它导出进清单，作者不写第二份），ctx 按它定好类型，读只要一行 `ctx.settings.get().x`、读处不再传 schema；不学「改了设置就整个重启」（B 站改个间隔就要断开全部直播间） | 3a（B 站）/ 3b（契约 v3），到时拷问 |
| 核心读设置加 `core.` 前缀（⑥f 内存里核心读法暂不动）、面板 PATCH 的核心路径改 `core.*`；`/api/globals` 改名 `/api/settings`（10-03 主人定，ADR-0036，随 ㉚） | 随第 2、3 期改名；面板那半随第 4 期 |
| 面板改账号密码（10-02 主人定，不强制改）：服务端加一个改面板账号的接口，照 `config/persist.ts` 的写法写回 `bn.config.yaml`（保留注释、原子写、0600），改完会话随之失效、重新登录。Docker 主路径（设了 `BN_CONFIG`）环境变量只在首次开机生成这份文件时用一次、之后以文件为准，面板改了就生效；只有没设 `BN_CONFIG` 的旧式部署（每次开机「文件 < 环境变量 < 命令行」合并）在环境变量里设了 `BN_DASHBOARD_USER/PASS`、或根本没有配置文件时拒绝并说明，桌面版（token）与不要求登录的部署不显示入口；开机生成种子凭据时那句日志改成「登录后可在系统页修改」。面板入口随第 4 期 | 服务端随第 4 期一起做 |
| 日志级别的 `core` 键会和叫 `core` 的拓展撞名（`logging.levels` 是核心模块 + 集成键混放）：`core` 进保留 id 表，或把集成键分开放 | 随 `core.logging` 改名那期 |
| 桥迁 v3 时必须抬 `extensions/bridge/extension.json` 的 `version`（现在 `0.0.1`，同号发出去市场永远不提示更新）；具体号发 alpha 时定 | 3b 抬号，6 定号 |
| 渲染器运行时从 `s1.hdslb.com` 拉舰长图标（`packages/image/src/image-renderer.ts` 的 `GUARD_LEVEL_IMG`），改成本地资产：B 站在 `bilibili/` 声明 `guard` 体系时用 `ctx.storeImage` 把三档图标存成 `tier.icon`，出图器只内联引用。守卫 11 的 `hdslb` 会在这里变红 | 第 2 期 ㉓（10-02 从 3b 挪来：不挪的话出图器零联网过不了、会员卡只能画占位；`ctx` 3a 才有，本期由服务端直接调抓图服务存进图库，3a 改走 `ctx.storeImage`） |
| 补关注「-101 整批跳过、不降级」（已定未做，见 subscription-sources「B 站怎么实现」），随关注同步搬进 `bilibili/` | 3b |
| 直播监听的唯一判定（internal）：「开着」只看开关、不看有没有目标（ADR-0027 决策 1）；首页的「不会被监听」与直播就绪判断都改用它。已知 bug 就落在这条上（见「施工中顺手修」），别拖到最后 | 3b；首页在 4 |
| 密钥打码：schema 标 `secret: true`、服务端按 `MaskedSecret` 下发；面板那一半（统一密钥输入框） | 3a；面板在 4 |
| 原生分享：解析器交中立描述，由 OneBot 适配器去签。施工先查签名接口收不收通用参数，不收就在适配器内部放一张 appId → 预设的对照表（ADR-0029 决策 2） | 3b |
| 测试助手重复：scripts 6 处各算 repoRoot、internal 三份 BASE AI 夹具、面板 UpDialog 三份 renderDialog 与造目标、`extSub` 与 `makeExtSub` 重复、backup 两份 pickFile | 各区重写那期合并，没重写到的归 5 |
| 还在用正则扫 TS 源码的守卫迁上 AST 共用工具（09-29 定的规矩，见 architecture「守卫」开头）：devtools 隔离（服务端、面板各一份）、`constants-imports.test.ts`、`index-background-work-tracked.test.ts`（今天只钉形状）、面板 `walk.ts` / `blankComments` 的 13 个消费方与颜色 token 等处的内联剥注释、`font-reader-singleton`、`tour-anchors-exist`、`asset-dir`；碰到哪道先迁哪道 | 5（守卫补齐） |
| 统计的 `/overview` 被定时锐评与手动锐评**在进程内当 HTTP 请求打**（`statsRoute.request("/overview")`），为此统计子路由自挂了一份出错处理（④b 第 4 组）：把取数抽成函数、两处直接调，子路由的那份出错处理随之删掉 | 随 ADR-0027 的服务端那半（统计多收字段时本来就要动这里） |
| knip 报的 3 个老的未使用文件（`devtools/stub.ts`、两个 shape-pin；knip 不在 CI） | 5 |
| `constants-imports.test.ts` 按行判，多行 `export {…} from "zod"` 会漏；`UpDialog.test.tsx` 没有 JSX，应是 `.ts`；network-guard 夹具路径写了两处 | 5（守卫补齐） |
| 设置页的 AI 连通测试从 `routes/globals.ts` 挪进 `packages/ai`（出网点名表不给路由开白名单） | 最迟 3b 末（出网点名表清零） |
| 面板自己另有一份 `LoginSnapshot`（`status` 收窄成 `BiliLoginStatusValue`），和核心那份（`status: number`）对不上，留下 ④c 唯一一处对 WS `data` 的类型断言（`useAuthChannel`）。登录状态中立化（`subscription-auth-changed`、`AuthState`）时面板改吃核心那份，断言与面板那份类型一起删掉 | 3b |
| 桥协议的失败统一成结果形状（ADR-0026 决策 7）BN 那半：`result` 帧认 `code` + `message` + `upstreamCode?`，只带 `err` 的旧回执进门翻成 `unknown`；`error` 帧补 `code`；协议升 minor 并记进 PROTOCOL.md 的版本表；投递结果接住 `code`；假桥改发新形状（`fail()` 展开），「结果不手写」棘轮里假桥那两格随之删掉 | 3b（随桥迁 v3 与假桥搬家） |
| 拓展包没有 `ok()` / `fail()`，桥拓展 28 处只能手写结果；其中取图口的 404 回的是 `{ ok: false, err }`，不合错误体规矩，而错误体守卫只认 `apps/server/src` 造的回应，拓展造的看不见。契约 v3 要不要导出 `ok()` / `fail()`、错误体守卫要不要认拓展的调用栈，随契约 v3 定 | 3b |
| 出网点名表加不加一条判据：集成目录（`bilibili/`、`platforms/`、`extensions/*/src`）值 import `@bilibili-notify/http` 自己造客户端、绕过 `ctx.http` 就红 | 3a（有了 ctx 再定） |
| 全仓包版本统一 `0.0.0-dev`：剩 push、subscription、internal、image、ai、storage、extension 7 个包（api / blive / dynamic / live 在 3a 随包删掉；第 2 期新建的 `packages/http` 建时就用 `0.0.0-dev`）。⛔ 不做：extension 包版本对齐契约档位 + 守卫（兼容看清单 apiVersion 与 EXTENSION_API_RANGE，不看包版本） | 5 |
| 进程托管文档：孤儿自检、stdin 关停、数据目录与端口、载荷选版；桌面版和以后的插件照同一份 | 5 |
| `docs/agents/self-update.md`：数据代、开机顺序、回退后再升级，以及 0.x → 1.0 这一次旧文件保持原样 | 5 |
| 「面板」的英文统一叫 `dashboard`（`docs/agents/conventions/naming.md` 词表），剩下的旧名：首页组件 `pages/Dashboard.tsx` 让出这个词，照别的页面改叫 `pages/Overview.tsx`（界面上这一页叫「概览」）；出错页的「回首页」改「回概览」；桌面壳的 `panel_url`、`open_panel`、`open_panel_in_browser`（壳内部与托盘菜单的 id，面板不调，不算冻住的契约）。`skins/panel/` → `skins/dashboard/` 已改（ADR-0022 决策 10 下的 🔗） | 5 |
| 去掉 Standalone（只剩一种形态）之一：服务端代码。启动入口两个名字一起导出，`startServer` 为主，`startStandaloneServer` 作冻住的别名（ADR-0005 决策 4 下的 🔗），新 boot.mjs 先调新名、调不到再调旧名；`StandaloneServerHandle`、启动选项类型、`StandalonePuppeteer`、`standaloneContentBuilder`、`standalone-lifecycle.test.ts` 去掉前缀 | 1（⑥a 之前，⑥a 要重写的正是这个函数） |
| 去掉 Standalone 之二：「镜像 / 安装包自带的那一版」改叫预装版本 `preinstalled`（`imageVersion` / `imagePath` / `isImageVersion` 等）；环境变量改成 `BN_PREINSTALLED_VERSION` / `BN_PREINSTALLED_PATH`：0.x 的 boot.mjs 只写旧名 `BN_IMAGE_*`，所以新 boot.mjs 新旧两套都写，载荷先读新名、读不到再读旧名，旧名随换 Node 大版本那一版删；ADR-0022 决策 14 的冻结名单补上旧名与这个期限 | 5 |
| 去掉 Standalone 之三：中文「独立端」（CHANGELOG、ADR、发布公告这类历史记录不动）、面板连不上后端时那句「standalone 服务」、CLAUDE.md | 5 |
| 去掉 Standalone 之四：流水线脚本 `*standalone-version*.sh`、`create-standalone-github-release.sh` 与 `BN_STANDALONE_VERSION` 改名；流水线只能靠 dry-run 验，和打 alpha 前那一轮 dry-run 一起 | 6 |
| 文档同步：CLAUDE.md 与 `docs/agents/` 的 push、architecture、commands、events、devtools、self-update、extension-marketplace；补上 `subscriptions.md`（整篇讲 B 站 / 拓展两支、两个文件、两种键，1.0 后全错）、`build-release.md`（没有 dev-next 与 alpha 的打法）与 CLAUDE.md 的「分支」一节；CLAUDE.md「项目」一节里「`CONNECTION_PLATFORMS` 不加档、拓展连接走 `kind: "extension"`」那条（闭集与 `kind` 都已删掉，ADR-0024）；示例 yaml 写清每个键对应的环境变量（ADR-0022 决策 14） | 5 |

### 还没归期的（施工时定）

ADR-0024 ～ 0031 里定了做什么、没定哪一期做的项。

| 项 | 备注 |
| --- | --- |
| 连接设置的校验：保存时适配器在场就按 `settingsSchema` 校验、不过回 400；读盘逐条校验，不过的只隔离那一条，只有外壳坏了才挡开机（ADR-0024 决策 10） | 最迟在第 4 期之前：面板的「设置不合法」态在第 4 期 |
| 投递失败归核心：按目标逐个投递、只重试失败的那个（`rate_limited` / `unavailable` / `timeout` 退避，`indeterminate` 与其他码不重试）；出卡或 AI 失败降级、不整条重来；每个目标一行历史，失败带 code（ADR-0024 决策 15） | |
| 删掉自定义 UA 设置，身份一律由 `packages/http` 生成；老配置里这一格由迁移丢掉、新 schema 不留（ADR-0025 决策 7） | **第 2 期 ⑭**；「换一个身份」按钮随第 4 期的 B 站设置 tab |
| 健康的服务端那半：`SourceHealth = { summary }`、`/api/health/details`、短版 `/api/health` 只留四格，应用内更新靠 `version` 与 `startedAt` 认新进程（ADR-0025 决策 12） | 健康卡界面在第 4 期，先出设计稿 |
| 历史里存的旧失败转成 `{ code: "unknown", message: 原话 }`；应用内更新的 `reason` 从 kebab 改 snake（ADR-0026 决策 3、5） | 迁移条目随改盘上形状的那一期：历史那份 **第 2 期 ⑱**；更新的 `reason` 随动更新状态那一期 |
| ADR-0027 的服务端那半（唯一判定除外，它在 3b）：「在记」按特性分；开播公告不再记；统计多收现成字段、「最近作品小缓存」并进统计仓；历史接口删 `?uid=`；统计 CSV 的「UID」与「外部 ID」合成一列 | **第 2 期 ㉖**；面板那半在第 4 期 |
| 作品文字只有一种拼法：`posts/` 里唯一的取段函数（ADR-0028 决策 1） | **第 2 期 ㉑**（`posts/` 3a 才建，本期的落点施工时定）；进守卫 4 的点名表 |
| 模板变量 `{guard}` → `{tier}`、`{mdn}` → `{fanclub}`，资料加 `fanClubName?`，迁移改写主人的文案（ADR-0028 决策 3） | 最迟 3b：模板变量可满足性守卫那期要绿 |
| 醒目留言加可选 `tier`、金额按币种排版；会员档加可选 `announcement`，皮肤字段 `membership.text` → `membership.announcement`（ADR-0028 决策 4） | **第 2 期 ㉓** |
| 类型名后缀守卫的开启期（ADR-0023 决策 15） | 见「中立性守卫的归期」 |
| 启动器要不要更新（10-02 主人定）：拿预装版本判断，不给启动器另编号 —— 启动器与预装载荷同一个镜像或安装包发，预装版本（boot.mjs 传的 `BN_IMAGE_VERSION`，按命名表改叫 preinstalled、旧名兜底）就是启动器出自哪一版；载荷里记「启动器最后一次改动在 X 版」，预装版本比它旧就进 `SystemNotice`，提示拉新镜像 / 重新下载应用 | 随第一次改启动器的那一期 |
| 推送历史拆两层（10-02 主人定，ADR-0022 决策 9 下的 🔗）：文字不设上限、无设置项；图片保留天数改成选项 90 / 60 / 30 / 15 / 7 / 3 / 1、默认 30，超期的行显示「图已清理」、不能重推；清扫只数保留期内的引用，新图宽限期，引用方登记表 + 守卫；迁移换算老配置（超 90 压成 90，不在选项里往上取）、不搬超期的图与孤儿图。设置的键名施工时对 naming.md（随 `app` 拆进 `core.history` 那期） | **第 2 期 ⑰ ⑲ ⑳**；随第 2 期统一图库；面板的选项随第 4 期 |
| 年度总结的数据地基（10-02 主人定，ADR-0033 决策 3）：1.0 起记运行记录（每天跑了多少分钟）；迁移时先从 0.x 的粉丝样本算出运行时长写进去，再压缩粉丝样本 | **第 2 期 ㉗**，排在粉丝样本压缩 ㉘ 之前（不能晚：压缩以后 0.x 的心跳就没了） |
| 更新后弹「本次更新」（10-02 主人定，ADR-0005 决策 16 下的 🔗）：`SystemNotice` 新 kind，每个版本一次、主人手动关；标题「恭喜主人成功更新到 X 版本～」，内容是跨过的每一版的概述 + ⚠️ 段 + 完整说明链接，打包时从 CHANGELOG 抽进载荷；被自愈退回的只有标题；0.x → 1.0 那次与首访页合成一个；开发版不弹 | 服务端与打包脚本 **3b 末尾**（10-02 排）；面板随第 4 期 |
| 粉丝样本按时间降精度再合区间（10-02 主人定，ADR-0027 决策 8）：最近 8 天原样，满 8 天的每小时留末值、相邻同值合区间；每天一趟压缩；迁移照同规则压 0.x 的老样本，压之前先把运行时长算出来带给年度总结 | **第 2 期 ㉘**；迁移条目同期 |
| 数据统计总开关 + 存储占用（10-02 主人定，ADR-0027 决策 9、10）：开着才记、新装与升级默认开、关了不记但资料刷新照跑；关掉后数据留着、页面只留一段话，女仆 AI 与图片渲染同样处理；系统页「存储占用」按类显示与清理（统计、历史文字、历史图、女仆 AI、旧版本数据） | 服务端 **第 2 期 ㉙**（连同旧代的列表、大小、删除几个服务口）；面板随第 4 期（「旧版本数据清理界面」并进来） |

## 施工中顺手修

已查出的现存毛病，各归一期，随那一期的改动修掉。

| 毛病 | 期 | 怎么修掉 |
| --- | --- | --- |
| 面板的错误提示只认 `err` / `message` / `errors`，`{ error, scope, issues }`、`{ error, id }` 这些形状的原因全被吞掉（读代码得出，未真机验） | 1（切片 ④） | 错误体统一以后，`errorMessage` 只认 `code` + `message` 一种 |
| 搜人时风控与未登录都报成 404：`/api/subs/lookup` 把任何非 0 码都回成 `not_found`，还把 B 站的码塞在 `code` 里 | 1（切片 ④）挪码；3a 修分类 | ✅ 切片 ④ 已把 B 站的码挪进 `upstreamCode`，面板不再按状态码换成固定文案、直接显示服务端的话；3a `searchCreators` 返回结果形状、路由合成 `GET /api/sources/:sourceKey/creators?q=`，风控回 `rate_limited`、未登录回 `unauthorized`（HTTP 403：401 只留给看板自己的登录失效，面板见 401 就踢回登录框） |
| 拿登录二维码失败却回 `ok: true`：网络异常只打 warn 就返回、状态不变；其余抛错回 500 与一句固定英文，原因被吞 | 3a | 登录搬进 `bilibili/auth/`、走 `SourceAuth` 状态机时，`beginLogin` 按结果形状回失败 |
| 晚登记的适配器收不到对账：拓展的推送适配器在开机对账之后才登记，对账（今天的 `reconcile`）就调不到它 | 3a | 登记即 `start`（ADR-0024 决策 3） |
| AI 工具失败在面板上显示成功：工具失败时返回一段字符串，只有抛错才记失败 | 3b | AI 工具随 ADR-0030 改写时按结果形状返回 |
| 指令出错不回话：处理函数抛错只打 warn | 3b | `CommandDef.run` 返回结果形状；失败回「『{指令名}』没办成：{message}」，抛错回「出错了，详情在日志里」并记错误日志（ADR-0031 决策 1） |
| 开机关注同步改了 `followed` 却不发事件，面板不跟着变 | 3b | 关注同步搬进 `bilibili/`、`followed` 进 B 站的 `ctx.state`；补关注失败按 `follow_failed` 报进问题表，问题表变了发 `problems-changed` |
| 首页「不会被监听」只看有没有配直播推送目标，和服务端的判定对不上 | 3b 判定；首页在 4 | 见「零碎施工项」的直播监听唯一判定 |
| 没实现列 bot 方法的推送拓展建不了连接：列 bot 的接口回 404，面板说拓展没跑起来 | 4 | `listConnectionCandidates` 在 3a 改成必备；面板新建连接只走「挑一个候选 → 填字段」一条路 |
| 会员文案自定义开着、图片是空串时 `??` 不兜底官方图，推出 href 为空的图 | 2 | `templates.membership` 重做时修（`default` 的回退正好在这条路上） |

## 以后再说

1.0 不做、已知要回头的事。ADR-0021「以后再说」里的其余几条照那边。

| 项 | 什么时候再看 |
| --- | --- |
| 存盘的待发队列：补上「推送进行到一半进程崩了，这一条可能漏掉（最多一次）」（ADR-0024 决策 15 认下的代价） | 没定 |
| 时间处理换 Temporal、运行时升 Node 26（10-02 主人提、又放下）：我们跑的 Node 24 默认没有 `Temporal`（只在实验开关 `--harmony-temporal` 后面），Node 26.0.0 起默认带、2026-10-28 才转 LTS；浏览器里 Safari 只有预览版有、iOS 没有，桌面版在 macOS 上用的 WKWebView 也就没有 —— 服务端换了、面板换不了，仓里时间处理就分成两套。改动面今天不大：luxon 只在 `dynamic` / `image` / `live` 三个 B 站引擎包的 6 个文件里；升 Node 大版本有现成的闸（更新清单 `requires.nodeMajor` → 提示拉新镜像，v0.9.0-alpha.1 起有），ADR-0005 决策 4 的 `BN_IMAGE_*` 旧名兜底也约定随换 Node 大版本那一版删 | Node 26 转 LTS 之后，且 Safari 正式支持 Temporal 时再提 |
| `listAddressCandidates`、`connectionAuth` 对拓展开放（ADR-0024 决策 11） | alpha 之后桥帧改名时一起看 |
| 来源自带指令与指令重名的规矩；`CommandProvider` 登记表到那时连同设计（1.0 不造，ADR-0031 决策 1） | 第一个真要自带指令的拓展 |
| alpha 之间还改盘上格式的话怎么迁：格式版本加 1、从上一代迁，还是继续用迁移修订号从第 0 代重迁（测试者在 alpha 期间的数据会丢）；修订号在 alpha.1 冻住。选前者的话要写「上一代 → 这一代」的迁移器（`migration/zero-generation.ts` 只认 0.x；选代遇到「格式版本比我旧」那处报错就是给它留的位置，开代与搬文件的规矩照用），外加「什么改动要抬格式版本」的判据（schema 大多严格，加一个可选字段也会让旧版整份拒收） | 发 alpha 前定 |
| 删掉冻住的别名 `startStandaloneServer` 与旧环境变量名 `BN_IMAGE_VERSION` / `BN_IMAGE_PATH`（那时跑着的 boot.mjs 都写新名）：那一版在清单里抬 `requires.nodeMajor`，旧镜像报「需要新镜像」、不会装上；0.9.0 起每个更新器都认这一格（ADR-0005 决策 4 下的 🔗） | 下次换 Node 大版本 |
