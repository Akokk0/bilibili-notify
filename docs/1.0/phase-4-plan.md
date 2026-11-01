# 第 4 期计划表：面板按描述画

和 3a / 3b 一样单独一份计划表。总计划见 [construction-plan.md](./construction-plan.md)：那里只留第 4 期的范围一行与指向这里的链接，**各片的进度、开工时定的事、留给后面的尾巴都记在这份文件里**。

## 状态

| 项 | 现状 |
| --- | --- |
| 切片表 | 10-27 五路只读勘察合成草稿（57 片），当天主人定第一波就开、主会话单线做；10-28 主人定第 4 期一直单线、删掉 4-10，同日答完片表的 11 题（见「定案」）：4-53 拆成五片，新开 4-55（墙上时间跟全局时区）；主会话照 Q1b 另拆出 4-56（包字典），共 59 片；10-28 主人在 4-14 定另起 4-57（醒目留言示例做到中立），共 60 片 |
| 已完成 | 29 / 60（10-27 落 4-01、4-02、4-03、4-04、4-05、4-07、4-08、4-09、4-12；10-28 落 4-06、4-11、4-56、4-13、4-14、4-15、4-16、4-17；10-30 落 4-19、4-20、4-18、4-21、4-31；10-31 落 4-22、4-23、4-35、4-24、4-55；11-01 落 4-25、4-26） |
| 迁移修订号 / 备份版本 | 53 / 23（4-24 落成；第 4 期开工前为 52 / 22） |

## 出期条件

照 [construction-plan.md](./construction-plan.md) 分期表与「中立性守卫的归期」第 4 期那两格，加上 3b 带过来的余格与多语言那一条：

- B 站替身清零（分期表第 4 行、守卫归期第 4 行）。`identityColor` 的 B 站分支照 Q5 由描述符声明，不进放行名单。
- 3b 留下的棘轮余格清零（3b 出期条件下的 🔗，主人 10-26 定「余下的等第 4 期」）：守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫②，连同 `import-boundaries`。3b 收尾时的数是守卫 11 三格 20 处、uid 两格 41 处、`.platform` 核心一格 3 处与面板五格 29 处、推送守卫② 三格 60 处。
- 写死的中文在放行名单外清零（ADR-0037 决策 16；Q1）：面板、服务端、各包与 contract 都算。
- 中文叫法棘轮开张（4-09 已开；清零归第 5 期）。
- 守卫 21b「这版不开」里等第 4 期的 N01 / N05 / N09 / N15 转成对拍；N14（面板四页）写明由面板测试钉。
- 全量门禁全绿。

## 切片表

10-27 开片：五份只读勘察（来源、健康、数据、AI 与文字、守卫与设计稿五路；报告在 `.bn-design/s4-survey-*.md`，不入库）合成下面这张表，关键事实回代码抽查过。**表里的文件数是估的，行号是 10-27 `a37996246` 上的**，各片开工时用到哪条核哪条。

规模：小 ≤ 5 个源文件；中 6–20；大 > 20，或牵涉线上格式与迁移。「盘」写「是」的要抬迁移修订号，备份版本开工时核。单线做，前置就是先后。

**每片通用**（写进每片的施工要点）：
- 面板 UI 动手前对 `packages/ui/README.md`，缺的纯展示件进库并改清单。
- 本片碰到的文件里写死的中文收进字典：面板的进面板字典，服务端的进服务端字典，各包与 contract 的进 internal 的包字典（Q1b；4-56 落了之后才有，在那之前碰到的包里的字先留着）。同时写中文女仆层：交互与提示用女仆口吻，标题、导航、栏名、数据名平实（construction-plan「以后再说」，10-11 主人定）。
- 本片清掉的棘轮格当片下调（写死的中文、B 站替身、中文叫法等）。
- 多片都会动的热点文件：`apps/contract/src/rest.ts`、`apps/server/src/index.ts`、`Targets.tsx`、`System.tsx`、`Dashboard.tsx`、`Ai.tsx`、`header.tsx`。

| 片 | 做什么 | 文件面 | 前置 | 盘 | 规模 |
| --- | --- | --- | --- | --- | --- |
| **甲 服务端小片与结构性前置** | | | | | |
| 4-01 ✅ | 剧集 / 课程 / 合集三类动态进附件的视频卡（ADR-0028 决策 1）。落成（10-27，`fd342ae18`）：`PGC_UNION` 没做；附件标题不算作品文字 | `apps/server/src/bilibili/dynamic/` 与出卡 | 无 | 否 | 中 |
| 4-02 ✅ | 新建拓展订阅的种资料改走资料缓存的单一写者，只在没有资料时种（主人 10-27 定，3b 收尾残余）。落成（10-27，`4d0d670cf`）：写口新方法 `seed(id, build)`，`build` 只在要种时跑（头像那时才存） | `routes/subscriptions.ts`、`runtime/profile-cache.ts` | 无 | 否 | 小 |
| 4-03 ✅ | 宿主自己的抓图口：核心抓会员自定义图不再借 B 站客户端（construction-plan 零碎施工项，原写「第 4 期之前」）。落成（10-27，`cadddf077`）：`AppRuntime.imageFetcher`；浏览器身份每次开机现生成、不落盘；B 站替身 `index.ts` 2 → 1 | `index.ts`、`compose.ts`、抓图接线 | 无 | 否 | 小 |
| 4-04 ✅ | `RestartAbility` 不能重启的支路改 `code + message`，删面板 `whyNoButton` 那份抄写。落成（10-27，`63d1e0284`）：码 `source_run` / `unsupervised`；两句话合成服务端一份进字典 `restart.cannot.*`（取面板那版措辞）；路由每次现问 | contract、`routes/system.ts`、面板一处 | 无 | 否 | 小 |
| 4-05 ✅ | 皮肤 `updatedAt`、市场 `fetchedAt`、升级 `checkedAt` 三格改带时区的 ISO（ADR-0019 决策 62 的 🔗）。落成（10-27，`1d0c2403d`）：三格 UTC ISO；内置皮肤不带 `updatedAt`（原来恒为 0） | 3 个 contract、3 个生产者、1 个面板缓存键 | 无 | 否 | 小 |
| 4-06 ✅ | devtools 剩的三件（ADR-0031 决策 2）。落成（10-28，`e860aaf19`）：ADR-0031 那句例子就地改写成「经 B 站自己的轮询上报」；核心场景以 `core` 认领、id 加 `core.`、描述符加宿主填的 `provider`；`creator` 种类宿主按来源名单核；`sub` / `target` / `connection` 只给核心；适配器挑自己的连接没做（没有使用者）；「进场」uid 改必填；「登录状态」改成替登录口喊变更；替身 `pick-select.tsx` 2 → 0 | `internal/devtools.ts`、`server/devtools/`、`bilibili/devtools/`、`web/devtools/` | 无 | 否 | 中 |
| 4-07 ✅ | 改面板账号密码·服务端（construction-plan 零碎施工项）。落成（10-27，`7dda68a64`）：`PUT /api/session/credentials`，要报当前密码；新密码 8–256 位、账号去首尾空白后非空；码 `not_configured`（旧式部署 / 没有配置文件）、`unsupported`（桌面）；种子凭据那句日志留给 4-49；残余：已开着的 WS 连接不随改密断开 | `routes/session.ts`、`config/persist.ts`、contract | 无 | 写启动配置，不是数据迁移 | 中 |
| 4-08 ✅ | `/api/settings` 的核心那份挂到 `core` 下、PATCH 核心路径改 `core.*`（ADR-0036；architecture 写明「随第 4 期」）。落成（10-27，`1bd3bd1b6`）：回 `{ core, bilibili, onebot, … }`，contract 加 `SettingsResponse`；PATCH 顶层只认 `core` 与登记过的集成键，别的 400（`settings.patch.unknownKeys`）；逐格原因的路径与请求体对得上；面板抽 `hooks/useSettings.ts`；系统页字段码改 `core.*` | 服务端 2–3、面板 24 | 无 | 否（只改线上形状） | 中 |
| 4-09 ✅ | 中文叫法棘轮开张（construction-plan 守卫归期第 4 行）。落成（10-27，`49feee903`）：`scripts/__tests__/chinese-terms.test.mjs`，开张 65 个文件 298 处；日志参数照算；`UID` 只认大写；统计页四个文件按「动态」放行（ADR-0021 决策 50） | `scripts/__tests__/` | 无 | 否 | 小 |
| ~~4-10~~ | ~~面板字典按区拆文件~~ —— 删掉（10-28 主人定）：它只为让并行的界面片不撞同一个 JSON，第 4 期一直单线，不成立 | | | | |
| 4-11 ✅ | 设置规则 → 设置项的导出函数，规则只写一份（construction-plan「读设置的写法简化」，10-14 主人定第 4 期）。落成（10-28，`ddf33ecc3`）：`settingsFieldsFromSchema`；加载时的对表搬进 `internal/schema/`；门开构建子路径 `@bilibili-notify/extension/build`，桥与假源的清单设置项由构建导出；详见提交说明 | `packages/internal/src/schema/`、`packages/extension`、桥、假源 | 无 | 否 | 中 |
| 4-12 ✅ | `GET /api/sources`：每个来源 `{ key, descriptor, has }`，停用 / 启动失败的拓展也列；`SourceDescriptor` 补格；面板 `useSources()`；对拍 N09 的服务端半。落成（10-27，`acb6b6180`）：B 站钮颜色改定值 `#fb7299`、不再跟皮肤（主人定）；`Subs.tsx` 替身 18 → 27（主人点头，随 4-15 去 `BILI_PLATFORM` 哨兵时消）；`featureHints` 挪 4-27、`membershipPrograms` 随 4-26、`has.preview` 随 4-14；拓展描述取装载器那份清单（按当前语言） | `internal/source.ts`、`routes/sources.ts`、B 站与拓展来源、清单 schema、contract、web hook | 无 | 否 | 中 |
| **乙 服务端读口与机制** | | | | | |
| 4-56 ✅ | 包字典与取字口（Q1b）：internal 新开一份两端共用的包字典（平实版 + 中文女仆层，形状同两端那套）；面板与服务端建字典时合进来，启动时把取字口交给包（ADR-0037 决策 1 那条路）；键的类型从这份 JSON 推，`i18n-dicts` 守卫跟上。只立机制、收一两处当样例，大头归 4-53e。落成（10-28）：主人定两份字都住 `texts/` 底下 —— 先把出厂文字搬到 `texts/builtin/`（子路径改叫 `@bilibili-notify/internal/texts/builtin`，单独一个提交），包字典是 `@bilibili-notify/internal/texts`（`packageText` / `bindPackageText` / `withPackageDicts` / `PACKAGE_DICTS`，口子的细节见 ADR-0037 决策 6 下 4-56 那条 🔗）；两端的 `DICTS` 不变、建 store 时才垫包字典（两端的接线测试比的是同一个模块对象）；「两端各交一次取字口」改由取字调用守卫数入口文件顶层的那一句来钉（入口文件本来就不扫，放行名单数不到它）；样例收了指令前缀与别名的三句校验报错，写死中文棘轮 `schema/commands.ts` 那一行删掉 | `packages/internal/src/` 新子路径与 `locales/`、两端 `i18n/`、守卫 | 无 | 否 | 中 |
| 4-13 ✅ | 内置适配器自带描述（`PlatformAdapter` 加 `descriptor`）、`GET /api/adapters` 描述列表；内置适配器的问题引子改用描述的 `label`（今天是适配器键）。ADR-0024 决策 1 前半。落成（10-28）：描述写成必备方法 `descriptor()`（出字那一刻按当前语言取）；内置三个只交脸、不带图标，`settingsFields` 先是空表（主人选甲，随 4-29）；读口回 `{ adapters: [{ key, descriptor }] }`，照 `/api/sources` 合登记表与装载器两张表，不带 `has`；拓展的描述由宿主照清单填。照每片通用那条收了碰到的六个文件的 62 处字（拟稿只数了五个文件 47 处，漏了 `extensions/context.ts` 的 15 处）；两句停下原因（`stopReason`）在登记那一刻取字，改成现取要动 `integrations/context.ts`，留给 4-53c | `internal/push-source.ts`、`platforms/` 三个、`push/`、`routes/adapters.ts`、contract | 4-11 | 否 | 中 |
| 4-14 ✅ | 卡片真实预览改走 `Source.fetchPreview`（对拍 N05）：请求按 `subscriptionId`，没实现的来源用示例；B 站实现从 `routes/cards.ts` 搬进 `bilibili/`。清 `cards.ts` 五道棘轮与 `Cards.tsx` 替身。落成（10-28，三个提交）：开工题主人定**回落示例并说原因**（回应 `sampleReason`）、**拓展这一版不开**（同 `auth`）；签名 `fetchPreview(identity, PreviewOptions, signal): Result<PreviewReport>`，直播那一支交与 `fetchLiveStatus` 同一份的详情（`LiveCardInput` 住出图包、internal 引不到）；作品的「第几条」保留、改名 `nth`；SC / 上舰收的人取订阅名、付款人取来源登录口；删前查引用的订阅称呼改用身份标签（「B 站 · uid」）；**SC 示例仍借 B 站价目表**（主人定另起 4-57，import 边界与 uid 各留 1）；面板全局「从订阅里挑一条」、按订阅覆盖对所有订阅开放；收字 138 处（卡片路由 60、卡片页 71、来源路由 6、登记表 1），叫法改中性、交互句写女仆层；**`field-labels.ts` 只换五格**（主人定，整表随 4-53b）；**B 站 `source.ts` / `dynamic-poller.ts` 两个文件留给 4-53c**（主人定，见 4-53c 那行）；verify-ui 真页面看过（挑订阅、回落原因、按订阅列出全部订阅、收字后的页面） | `internal/source.ts`、`bilibili/`、`routes/cards.ts`、contract、`Cards.tsx` | 4-12、4-08；开工时问预览失败回落示例还是报错 | 否 | 大 |
| 4-15 ✅ | 经接口搜人与新建订阅（对拍 N01）：`GET /api/sources/:key/creators`、新建订阅的门问登记表、关旧 `/search` `/lookup`、风控与未登录不再折成 404；面板 `Subs.tsx` 新建流程按来源（去 `BILI_PLATFORM` 哨兵）。捎 3b 审查 R25 留着的那截：拓展回执包装层自己坏掉时的 `invalid` 记进出入（要改 `readResult` 的形状，Q11）。清 `subscriptions.ts` 四道棘轮与 `Subs.tsx` 替身 27。落成（10-28，四个提交）：拟稿主人照准；R25 那截单独一个提交（`readResult` 交出壳坏了的原因，取资料记进出入，搜人没有人可挂照旧只回 `invalid`）；搜人口 `GET /api/sources/:sourceKey/creators` 经推送链路的 `searchCreators`（与女仆同一道串行闸），来源的失败码原样回（风控 429、没登录 403、超时 504、不在册 404、候选不合规矩 502、链路没挂上 503）；三个旧口删了（`/api/subscriptions/search`、`/lookup`、`/api/ext/:id/lookup`），contract `ExtensionLookupResponse` 改名 `CreatorsResponse`；B 站候选头像起来之后经 `ctx.fetchImage` 抓进图库；新建订阅一道门问登记表（在册就认，不在册的再看装没装成订阅源拓展），B 站不再单走一支、也由候选种资料；**施工中撞上拓展契约对拍，主人改定只种不刷**（不带资料就只建订阅，B 站「新建当场刷一次」那几条测试删了）；对拍 N01 转 P52；面板新建弹窗一套流程（平台一排列在册的全部来源、只有一个不画；提示句由 contract 新叫法函数 `creatorSearchHint` 拼，列举的拼法也住字典；单个 UID 预览卡与翻页删了）；收字 64 处（订阅路由 13、拓展路由 18、订阅页 33），交互句写女仆层，「拓展 id 不合法 / 不合规矩」两种说法并成一句；叫法改中性（「添加 UP 主」→「添加订阅」、页内搜索「搜索订阅的名字或 id…」、复制提示「已复制」）；棘轮：`subscriptions.ts` 五道清零、`app.ts` 入口槽 3 → 1（只剩没有读者的 `CreateAppOptions.api`，随 4-16 拆）、`Subs.tsx` 替身 27 → 6、叫法与写死中文清零、`extensions.ts` 写死中文清零；上传超限那句的「拓展包」在建路由时取字，同 4-14 的「图片」「字体文件」随 4-53c；verify-ui 真页面看过（B 站按 UID 搜出带头像的候选、挑中进配置弹层；名字搜在没登录时 B 站回空表；两颗以上平台钮只在测试里看过，工作区开发数据没装拓展） | `routes/{sources,subscriptions}.ts`、`search-source-creators.ts`、contract、`Subs.tsx` | 4-02、4-12、4-08 | 否 | 中 |
| 4-16 ✅ | 入口 `api` 槽拆除：`createApp` 不再收 B 站 `Api`、入口不再递 `builtins.bilibili.api()`。清入口槽、import 边界与替身 `index.ts` 最后 1。4-15 之后 `CreateAppOptions.api` 已经没有读者，只剩入口递它。落成（10-28，两个提交）：拟稿主人照准；`CreateAppOptions.api`、入口递的 `builtins.bilibili.api()` 与 `BuiltinIntegrations.bilibili` 整格一起删（B 站来源自己的 `api()` 留给它的开发场景）；入口咽喉 ① `Api` 1 → 0、③ 名单清空（判据成了「不许再有 `bilibili` 那一格」，真扫另钉 `BuiltinIntegrations` 还在）、④ 棘轮表清空（上限 0）；import 边界 `app.ts` 1 → 0；B 站替身 `index.ts` 1 → 0；`index.ts` 写死中文 16 → 10：收开机 503 那句话的四处（三个键，改成每个请求现取）、第 0 代不在了那句、锐评草稿过期的私聊（小时数取 `DRAFT_TTL_MS`），平实底写平实话、女仆层留今天的原话；留着的 10 处归 4-53c（见那行） | `index.ts`、`app.ts`、`compose.ts` | 4-03、4-14、4-15 | 否 | 小 |
| 4-17 ✅ | 健康短版削成四格、详情口契约化（ADR-0025 决策 12）；`modules` 同提交搬去详情、首页改读详情。落成（10-28，`902052ad1`）：拟稿主人照准；短版 `HealthResponse` 只剩 `status` / `version` / `startedAt` / `uptime`，开机段与完整的 app 同一份（`healthResponseOf(runtime)` 改名 `healthResponse()`、不再看运行时）；详情口进契约 `HealthDetailsResponse { moduleVersions, modules, configScopes }`，`moduleVersions` 跟着搬（要不要显示归稿 1 的数据清单），短版那四格不重复带，`ConfigScopeMeta` 从配置仓搬进契约；推送链路没挂上时 `modules` 四个 false；面板新 `hooks/useHealthDetails.ts`（键 `["health", "details"]` 挂在 `["health"]` 底下，顶栏刷新照旧连它一起刷；5 秒、`retry: 0`，只在首页与新手进度挂着时问），首页四个模块改读它，兜底照旧（动态 `?? loggedIn`、其余 `?? false`，这个 B 站登录态兜底随 4-38 换）；勘察查出施工单没列的两个读者同一个提交改：新手进度毕业卡的图片 / AI 两条尾巴（导览 3 秒轮询的失效名单换成详情键）、装配自检查核心包版本没降成 0.0.0 的那两条（改问详情口）；首页新开整页渲染的测试（主人准）；收字 0（`Dashboard.tsx` 83 处：健康卡 36 归 4-38、其余归 4-35 / 4-53b；`derive.ts` 1 处、`config/store.ts` 58 处只改注释与类型来处，归 4-40 / 4-53c），棘轮全不变；verify-ui 真页面看过（改前改后健康卡同为 5 / 8，详情口 5 秒一问） | contract、`routes/health.ts`、`Dashboard.tsx` 一处 | 4-08 | 否 | 小 |
| 4-18 ✅ | 运行状态读口（对拍 N15）与健康详情的集成格：`/api/sources` 补 `status`；详情口给核心格、集成格、问题计数、同身份遗留订阅组。运行态由宿主投影（Q3）：内置来源按「在不在册 + `start` 抛没抛」得 running / failed，宿主在登记那一刻记下失败原因；拓展照装载器的八档；灯色再叠问题表；`Source` 不加成员。落成（2026-10-30）：拟稿主人照准；运行支保留旧三格，新增核心五格、归并集成格、同次问题表的总数与分组数、遗留身份重复组；核心问题只计组头。来源表必带 status、明确失败带 failure，内置启动失败释放键后仍保留，成功重登清旧失败、正常撤下移除；拓展八档及原因归装载器，多口合一格，纯推送零连接不占格（坏连接仍计），卸载不留失败来源。摘要读取失败不改启动结论；未知明确给 unknown，图片 / AI false 只给 not-ready。SourceStatusReader.running 保留业务在册闸；N15 → P53（53 对拍 / 2 未拍、总 55），既有 seam 覆盖。13 个面板测试文件的 18 个来源夹具补 status，生产 UI 不动，4-19 开机支与短版四格不动，保留 4-20 账号接口。既有中文收 0，新加健康摘要失败提示一键及女仆层；三棘轮相对新 dev 不变（4985 / 242 / 75），不落盘 | `subscriptions/source-status.ts`、`subscriptions/registry.ts`、装载器读口、`routes/{health,sources}.ts`、contract | 4-12、4-17、稿 1 认过的数据清单 | 否 | 中 |
| 4-19 ✅ | 开机段答结构化的搬家阶段与进度（Q6）。落成（10-30）：拟稿主人照准；`HealthDetailsResponse` 分开机 / 运行两支（`StartupHealthDetailsResponse` / `RunningHealthDetailsResponse`），判别格 `phase` 为 migrating / starting / running；开机只带 `{ step, total, label }` 进度或 null，运行支保留原三格；步号取现有迁移回调 `min(done + 1, total)`、当前共 27 步，整代创建完清空进度并切 starting；首个回调前不编造进度。详情口沿用会话与桌面 token 闸，短版严格四格；其他业务口照旧 503。`useHealthDetails` 缓存完整回应、select 只交运行支，现有首页与导览沿用兜底；门禁查出装配自检仍把详情 200 当就绪，同步改用已有 `waitForBooted` 等完整 app 后再查版本；4-18 / 4-41 未做。收字 0、棘轮不变，`index.ts` 既定 10 处与未改动的迁移文件归 4-53c；迁移产出与修订号不动 | `index.ts`、`app.ts`、`routes/health.ts`、contract、`useHealthDetails.ts` | 4-17 | 否 | 小 |
| 4-20 ✅ | 账号模块服务端。落成（2026-10-30）：拟稿主人照准；`GET /api/accounts` 回 `AccountsResponse { accounts: AccountView[] }`（来源键、原登录态、可选账号名与图库头像），只列在册且有登录口的来源、等装载器 settle 后现读；来源读口抛错整次 503。`core.accounts.order` 经既有 settings 口读写，未知 / 重复键保存原样、读取只认首次在册账号，遗漏的按登记先后追加；来源回册恢复原位。accounts 与 order 都可缺、无默认落盘，null 删键，修订号 / 备份版本维持 52 / 22，完整与脱敏备份均往返验证。拓展 auth 继续关闭、Source 成员不变；失效沿用登录 / globals / 拓展事件，面板接线归 4-40。已有 HTTP / 配置仓 / 备份 seam 验证，P01 对拍补聚合账号列表；收 schema 四处字进包字典并补女仆层，中文棘轮 4989 → 4985，叫法 242、替身 75 不变 | `apps/server/src/accounts/`、settings schema、路由、contract | 4-12、4-08 | 不落默认、不抬号（主人照准） | 中 |
| 4-21 ✅ | 坏格读口（Q4a）：核心 / 集成 / 拓展设置的「原值与原因」—— 非密钥格回原值 + 原因，密钥格只回原因（照规则上的 `secret` 判；整格里有一格是密钥就整格按密钥，如桥的接入名单带 token）；`getInvalidSettings` 那句禁令改成「密钥格的原文不出门」；连接的逐格原因；备份导出前读的「只给路径」坏格口。落成（2026-10-30）：主人照准拟稿 A；`GET /api/settings/invalid`、`GET /api/ext/:id/settings/invalid` 回 `InvalidSettingsResponse`，`secret: false` 带原值与缺键标记，`secret: true` 不带原文、掩码或摘要；规则递归查 `secret`，拓展同时认清单 `secret` / `generate`，桥名单含 token 时整格保密。原因按校验种类安全投影，不回自定义原话。`GET /api/system/backup/preview` 只回 `defaultedSettings` 路径，整段读坏列段根；导出仍用内存默认值，备份格式不变。既有拓展值视图移除坏密钥格，连接坏态 / 密钥声明未知态只用固定遮挡，正常密钥协议不动。内部原文账本与对外安全投影分层，原样落盘规则不变。收字 20，写死中文 4985→4965；主人批准 `store.ts` 58 与 `settings-problems.ts` 51 处留 4-53c（后者仅类型改动），叫法 242 / 替身 75 不变；生产 UI 留 4-45 | `config/store.ts`、`routes/{settings,extension-settings}.ts`、`secret-view.ts`、备份服务、contract | 无 | 否 | 中 |
| 4-22 ✅ | 订阅坏行隔离（Q4b）。落成（2026-10-31）：主人逐题照准五题；仅文件级坏法挡开机，逐行错误与重复 UUID 整组隔离。坏行 JSON 值由私有原槽位布局原样带回日常与批量写口，来源 + 外部 id 与合法 UUID 占位；同 id 同身份好行普通改删照常。完整/脱敏备份仅好行，合并/覆盖保留本机坏行，预览先无副作用校验、正式写再验与既有回滚；无新增 HTTP。`onInvalidSubscriptionsChanged(count)` 接 `core / subscriptions_invalid` 聚合问题，只安全数量/固定提示、不私聊；`getSubscriptionIds()` 保护启动/删除后的资料缓存与头像引用。现有包去重足够，未改 packages。store 58 与 bootstrap 1 共59处收字/删除，中文4914→4855、叫法241/替身75不变；index.ts10处主人续准4-53c，settings-problems.ts51未碰；迁移/备份52/22不动，UI留4-45 | `config/store.ts`、备份服务、问题接线、启动/缓存清扫、测试与字典 | 无 | 否（盘上形状不变） | 中 |
| 4-23 ✅ | 素材库的 8 个口从 `/api/cards` 搬 `/api/library`（ADR-0036 决策 1、5），删前查引用照旧；Cards 两个 picker 改调。落成（10-31）：图片 / 字体的 GET 列表与 POST 上传共用复数资源路径，GET / DELETE 各自 `:id`；旧 8 口退役，无别名。contract 补四个回应类型，两个 picker、缩略图与缓存键同步；收字 26 处，写死中文 4855 → 4829，叫法 241 / 替身 75 不变，迁移 52 / 备份 22 不抬。统筹真页面上传、引用拒删、解除保存后删除、直播封面共用图库、双图序号与口吻切换通过；字体 GET 为 CLI 回环补证，390 宽仍有横溢出及既有 field-labels warning，不宣称全部边界或卡片 PNG 渲染已验 | 新路由、`routes/cards.ts`、`app.ts`、contract、两个 picker | 4-14 | 否 | 中 |
| 4-24 ✅ | 落盘键 `ai.search.engines` → `ai.search.scenes`、dynamic → post。落成（2026-10-31，代码 `ae50f32f8`）：主人三题及迁移事实入字典 5 处叫法精确增量均批准；新袋整袋优先、新 post 优先，不以旧补新，null/坏值保留隔离，现代 schema 不双读旧键。零代修订 52→53，备份 22→23 仅同版恢复，加密与数据格式版本不动。作品、直播、锐评读者及面板真实 draft/PATCH 使用新键；直播总结和 AI 点评沿既有布尔参数接线回归，AIScene 类型/取值及参数命名后续待分配，本片不动。Q7 三项仍用“引擎”及旧字段码，仅 packIsland 显示投影，留 4-36；另有两处旧搜索键注释待后续清理，本片未改，尚未排期。收字 207（schema 3、零代 58、锐评 9、备份 6、AI 页 125、搜索字段 label/hint 6）；field-labels 余 212 主人续准 4-53b，index 10 / settings-problems 51 继续 4-53c。相对 4-35 后 dev 三棘轮 4821 / 240 / 74→4614 / 238 / 74；server 平实字典叫法 11→15、女仆层新增 1 为批准的真实迁移叫法，其他净减 7，不改判据/白名单。原 seam 刻画/红绿、四组破坏恢复及片级/整合门禁通过，统筹独审 13 文件 412 条通过。统筹真页面 7 次 PATCH、逐次及交错开关、假 key 遮挡/切后端、刷新/重启持久化、四 Tab、两尺寸和口吻通过；console 两轮均 0、server level≥50 为 0、无外网拦截记录，恢复假数据与 active[]、SIGINT 停服清端口/标签。导航仅确认键盘 Enter，未遍历全部模型分支/语言，390 宽旧 header 652 溢出仍归 4-39/40 | schema、迁移、实际读者、`Ai.tsx`、搜索字段标签、备份 envelope、原 seam 测试与字典/守卫 | 无 | **是**（本片唯一修订 53、备份 23） | 大 |
| 4-55 ✅ | 墙上时间跟全局时区（Q10；construction-plan 零碎施工项「其余服务端墙上时间跟不跟全局时区」那一行列的几处逐个过）：免打扰 `inQuietHours`（连同 `push-router.ts` 的调用与开发版免扰时钟 `devtools/clock.ts`）、私聊静音的 `describeUntil`、`packages/ai/src/tools.ts` 的 `stamp` / 开播于 / 最后活动三处日期改读核心 `timezone`；`roast-scheduler.ts`（锐评窗口按全局时区切、cron 却按服务器时区，Q11）、`profile-refresh.ts`、`dynamic-poller.ts` 三条 `CronJob` 与 `stats/extension-source.ts` 的 `CronTime` 按墙上时刻排的跟、只按间隔跑的不动；开发版 `devtools/scenarios/timers.ts` 的下次触发显示跟上。桌面版不在东八区、改过 `TZ` 的 Docker 用户免打扰会按时差挪一次，发版说明写一句。落成（10-31，Q1—Q9均主人批准）：墙钟cron收旧timer后按新时区未来格排，同值不重排、不补跑；纯间隔、退避与在途闸不改。共同IntegrationContext时区读口/通知统一供内置与拓展activate/source/adapter，按层回收且同步/异步异常隔离，撤B站私有时区接线，新增P54与共同成员对拍。全新1.0契约仅strict新清单1/0，旧同号1格式不合记unreadable、旧2/3记incompatible，均不import旧包；市场同号元数据局限已明示，不加兼容/新轴。开发时钟现读今天/时区并显示请求与完整实际日期/IANA/偏移，mute同epoch换当地显示。统计真实点位registry-source.ts仍60秒，followers-sample-gap.ts的CronTime只估间隔不动。中文共收34节点，server21plain/17maid、包6plain/5maid、web2plain；棘轮4580/235/74，原77、server27、manifest33、市场卡23逐项按已批延期记账。完整片级门禁和三轮隔离真页均完成；拒装5条预期HTTP400 console与1次索引连接阻断如实留证，自建服务/标签/注入已清。迁移53/备份23及包version不变，不捎4-48 | `util/quiet-hours.ts`、`push-router.ts`、`runtime/{mute-command,roast-scheduler,profile-refresh}.ts`、`dynamic-poller.ts`、`stats/extension-source.ts`、`packages/ai/src/tools.ts`、两处 devtools | 无 | 否 | 中 |
| **丙 组件库** | | | | | |
| 4-25 ✅ | 自家下拉：`TSelect` 改 `PopoverShell + MenuItem`、`HourSelect` 与三处手写 `<select>`（`Logs.tsx`、`SkinEditor.tsx`、`RoastPushBox.tsx`）换掉、裸 `<select>` 守卫（ADR-0035 后半） 落成（11-01）：TSelect / HourSelect 与三处原生选择器已统一，补裸 select AST 守卫、UiTextProvider / useT 即时取字接线。 | `packages/ui/src/form-controls.tsx`、README、三处调用、守卫 | 主人已定不加搜索、保持平铺；Q3–Q6已批 | 否 | 中 |
| **丁 不等稿的界面片**（不出稿的理由见「设计稿」） | | | | | |
| 4-26 ✅ | 订阅卡 / 详情 / 显示工具按描述符：「UID」改身份标签、复制外部 id、会员档从描述符取。落成（2026-11-01，`e19d199bc`、`2252775d9`、`2b755e8c0`，守卫修复 `91b582d69`）：公共 `/api/sources` 完整交会员体系与附加项，拓展 manifest 仍拒两格；订阅及共享显示读者接线，原始外部 id / 前导零保留。单来源且含本项隐藏徽章，多来源、来源表未知或缺项显示；未知不冒充未安装。会员按体系与档键、实际 rank 读取，custom / 空档不造门槛或预览档；来源 / 语言刷新保留 dirty 与隐藏未知值。提前完成 4-27 的 scope、CSV 合列与部分规则能力接线，4-27 不整片销账；4-28 搬表未做。已批 20 个 web 生产文件收字 704，三棘轮 4551 / 235 / 74→3847 / 122 / 30，精确统计例外与真实 B 语境 plain5 / maid3 已钉；7 个既有 B 源节点续延 4-53c。片级门禁、统筹独审及 18 组隔离真页完成，业务 HTTP 本地 fixture 不证明落盘或真实 PNG；主人通过面板 shell 停服，SIGTERM / tsx force killing 如实留证，端口已空。详见文末 4-26 现状 | `pages/up/`、`utils/up-display.ts`、`config/membership-programs.ts` | 4-12、4-08、4-15 | 否 | 中 |
| 4-27 | 规则页按 `featureHints` 露节（N09 面板半；清单收 `featureHints` 随这一片）、scope 页签、统计 CSV「UID / 外部 ID」合成一列（ADR-0027 决策 7）、面板三处「动态」兜底改取描述符。清替身 `Rules`、`PerUpEditor`、`sections`、`scope-tabs`。🔗现状（4-26，2026-11-01）：scope 页签、CSV 单身份列与当前来源叫法、通用作品兜底，以及 Rules / PerUpEditor / sections 按已声明特性、附加项、会员体系露格已提前完成；未知隐藏值保留。`featureHints` 及清单接入尚未做，本片保持未完成，开工时只核剩余工作，不重复迁移或计数 | `pages/rules/`、`Rules.tsx`、`scope-tabs.tsx`、`stats/csv.ts`、`Stats.tsx` 一处 | 4-12、4-08 | 否 | 中 |
| 4-28 | 档位表搬进 `bilibili/`、由描述符下发；`internal/bilibili-guard.ts` 退役（清替身 1、词汇 `hdslb` 1）。🔗现状（4-26，2026-11-01）：公共描述符下发与 web 会员读者已迁，面板不再直读 B 站静态会员表；表本体及服务端 / 出图读者搬家、旧子路径退役仍未做，不因本片下发而销账 | `internal/bilibili-guard.ts`、`bilibili/`、出图读者 | 4-26、4-14 | 否 | 小 |
| 4-29 | 连接 / 目标表单按描述画：内置也读候选、删 `domain.ts` 的 `makeEmptyConnection`（3b-40 留）、平台 / 字段 / scope / 地址称呼由描述与候选驱动、徽章读 `/api/adapters`；服务端「列候选时按平台名刷新 `platformSnapshot`」（ADR-0024 决策 7，3b-40 留）。清面板 `.platform` 五个文件 29 处与 `domain.ts` 替身。另接 4-13 留下的三件：内置三个适配器的连接配置项（条件显示、键值表、按候选换的占位、字段说明进包字典，ADR-0024 决策 3 下 10-28 的 🔗）、`/api/adapters` 加 `has`（扫码、列地址）、拓展卡上的 `push` 那格改读这里后删掉 | `Targets.tsx`、`types/{domain,connection-fields}.ts`、`platform-meta.tsx`、`link-preview-settings.tsx`、`routes/adapters.ts` | 4-13、4-08 | 否 | 大 |
| 4-30 | 平台闭集、平台表、三份连接规则搬出 `internal`，删 `./platform-registry` 子路径（冻结的 `migration/zero-platforms.ts` 不动）；保留键在装配根收齐（ADR-0024 决策 1 后半）。清推送守卫②、核心 `.platform` | `internal/{platform-registry,schema/targets,identity}.ts`、`platforms/`、守卫与约 15 个测试 | 4-29 | 否 | 大 |
| 4-31 ✅ | 拓展页一个拓展一张卡、卡上标开了哪几口、页头按口筛选（ADR-0025 决策 13）。落成（10-30）：全部／推送／订阅单选，按拓展计数，双口卡与开关唯一；缺省 `provides` 标能力未知，显式空表标未声明业务口，不猜归属；只推送口画连接数。安装成功切回全部，市场传送落唯一卡，减少动态也定位；上传保留结果弹窗，关闭再定位，失败不跳转。复用现有展示件与渲染/API 替身测试，三个生产文件收字 51 处，中文 4965→4914、叫法 242→241、替身 75 不变 | `Extensions.tsx`、上传安装两件 | 无 | 否 | 小 |
| 4-32 | 目标一律标平台图标 + 连接名（一个计算函数）：目标页、订阅详情、目标胶囊、链接预览、周报胶囊、五个点名下拉（ADR-0035 前半） | 计算函数 + 约 10 个调用点 | 4-25、4-29、4-26 | 否 | 中 |
| 4-33 | 功能页指向拓展设置的可点击入口（停用 / 失败也能去，ADR-0025 决策 1；今天只有提示字） | `Targets.tsx`、`Subs.tsx` 等 | 4-29、4-15 | 否 | 小 |
| 4-34 | 日志等级入口：系统页按集成列（来源、三个内置适配器、每个拓展），拓展详情页自己那一格。清 `System.tsx` 替身里日志那几处 | `System.tsx` 那一节、`ExtensionDetail.tsx` | 4-12、4-13、4-43 | 否 | 中 |
| 4-35 ✅ | 首页「不会被监听」计数去掉 B 站限定（判定本体 3b-14 已落）。落成（2026-10-31，代码 `ed4ad8ae0`）：主人逐题批准局部未知态与收字 8 / 39 / 36 分工；所有来源只按 enabled 与折好的 `needsLiveMonitor` 逐订阅计数，不按身份合并，不加登录或来源状态过滤。直播 pending / error（含旧缓存失败）明确未知，同读口顶部人数为「—」；订阅或默认开关未全不报计数，成功空订阅仍是已知空集；恢复后重算。不扩 contract / Source，不改其他 KPI、健康卡或顶栏。直播卡 8 处与新提示进面板字典及女仆层，Dashboard 中文 83→75，余 39 主人批准续延 4-53b、健康 36 继续 4-38；相对 4-23 后 dev 三棘轮 4829 / 241 / 75→4821 / 240 / 74。既有 seam 的刻画、红绿与 9 组破坏验证恢复均通过，片级 check / typecheck / web 构建及 web + contract + scripts 全绿。统筹主聊天真页面验过 9 数据集、未知及缓存失败恢复、口吻与 1280 / 390；订阅链接键盘 Enter 到 /subs 通过，未宣称 pointer 自动点击通过；console error / warning 均 0→0、服务端 level≥50 为 0、无外网拦截记录，服务与标签已收。迁移 / 备份 52 / 22 不动 | `Dashboard.tsx`、现有测试、面板字典与三格棘轮 | 4-08 | 否 | 小 |
| 4-36 | AI 页尾巴：指针没着落时抢默认实例（construction-plan「AI 实例按每一家隔离之后留着的几件」第一件）、工具失败句显示与技能勾选框显示标签（3b-32 留）、「引擎」用户看得见的三处（那一节的副标题、说明里「引擎开关出厂全关」、字段码 `ai.search.engines.*`，Q7） | `pages/ai/model-ops.ts`、`Ai.tsx`、`ai-chat/messages.tsx`、`MaidSkills.tsx` | 4-08、4-24 | 否 | 小 |
| 4-37 | 跨来源叫法（Q8）：「勤奋 UP」称号与 AI 工具小条进字典，用 `{creatorNoun}` / `{postNoun}` 拼，叫法照 contract 的 `sourceNounsOf`（一个来源用它的，零个 / 多个落中性词）。带创作者的小条按那位的来源（B 站照旧「查看 UP主资料」「查看最近动态」）；「搜索 UP 主」→「搜索创作者」；称号按这张榜涉及的来源，全是 B 站订阅时「勤奋UP主」、混着拓展订阅时「勤奋创作者」（B 站字面从「勤奋 UP」变「勤奋UP主」，主人知情）。提示词里那处不动（决策 11） | `stats/roast*.ts`、`packages/image` 锐评块与图标、`packages/ai/src/tool-label-texts.ts`、面板锐评卡 | 4-56 | 否 | 中 |
| **戊 等稿的界面片** | | | | | |
| 4-38 | 健康卡照稿重做：核心一排、集成一排、账号进集成格、运行灯、问题、同身份遗留订阅；`api` 格与过时注释去掉。清 `Dashboard.tsx` 替身 | `Dashboard.tsx`（可拆出健康卡组件） | 稿 1、4-18、4-20 | 否 | 大 |
| 4-39 | 顶栏问题框：读 `/api/problems` 与 `problems-changed`（面板今天零读者）、问候语后显示问题；撤掉 B 站账号那一行（账号已在健康卡有家）；右上告警改标题与分类（合不合并看稿） | 新 hook 与组件、`header.tsx`、`useStateChannel.ts`、`alert-shell.tsx` | 稿 1、4-38 | 否 | 中 |
| 4-40 | 账号页与多账号：系统 → 账号按来源列行、拖动排序；头部第一位 + 下拉；AI 对话头像同头部；新手引导登录步按来源生成。清替身 `header`、`ai-chat/index`、`onboarding`、`System.tsx` 账号几处 | `System.tsx` 账号节、`header.tsx`、`ai-chat/`、`onboarding/` | 稿 1、4-20、4-39、4-43 | 否 | 大 |
| 4-41 | 正在搬家全屏闸：搬完之前只画进度、不挂业务页；搬完统一作废旧查询 | `App.tsx`、`useBackendReachable.ts`、`shell-states.tsx` | 稿 2、4-19 | 否 | 中 |
| 4-42 | 生命周期提示：首访页（皮肤重做、旧数据留作备份、主人目标重选、不收的拓展、全新开始）、本次更新、开代失败、自愈退回，接已读（服务端齐，面板零消费） | 新页面与提示主机、`App.tsx` 接线 | 稿 2、4-41、4-31 | 否 | 中 |
| 4-43 | 系统页照稿 3 换骨架：节拆成各自文件、排好入口，内容照搬 | `System.tsx` 拆分 | 稿 3、4-08 | 否 | 中 |
| 4-44 | B 站设置 tab：通用表单、字段取自 4-11 的导出（登录心跳范围随之与 schema 的 5–180 对上，今天面板是 1–1440）；「换一个身份」按钮与身份重置口（ADR-0025 决策 7） | 系统页新节、服务端重置口、contract | 稿 3、4-43；开工时问「换一个身份」何时生效（今天身份在来源 `start` 时读入） | 否 | 中 |
| 4-45 | 两种「设置不合法」态（连接的、集成的）与拓展设置坏态：原值与原因；备份导出提示按默认值导出的格；订阅坏行的显示 | `Targets.tsx` 一处、系统页、拓展设置页、备份弹窗 | 稿 3（或稿 1 的问题框）、4-21、4-22、4-29、4-44 | 否 | 中 |
| 4-46 | 存储占用与旧版本数据：七行用量、可清的几类、图库清扫、逐代列表与删除保护（服务端齐，ADR-0027 决策 17） | 系统页新节与组件 | 稿 3、4-43 | 否 | 中 |
| 4-47 | 统计总开关与关闭态：关着时统计页只留一段话与开启入口（ADR-0027 决策 9；面板今天零读 `stats.enabled`） | `Stats.tsx`、系统页一格 | 稿 3、4-43、4-27 | 否 | 小 |
| 4-48 | 语言 / 口吻开关（ADR-0037 决策 3、7；口吻默认维持女仆，Q9）、时区那一格（Q10） | 系统页一节、`i18n/` | 稿 3、4-43、4-55 | 否 | 小 |
| 4-49 | 改面板账号密码的入口（接 4-07；桌面与不要求登录的不显示）；种子凭据那句日志一起改 | 系统页一节 | 稿 3、4-43 | 否 | 小 |
| 4-50 | 素材库顶层页与图 / 字体共用的选择器（data-and-migration「素材库与皮肤」） | 新页面、两个 picker 合一、导航 | 稿 4、4-23 | 否 | 大 |
| 4-51 | AI 页「女仆写正文」一节：picker 切作品 / 直播、默认一行 + 按目标例外；例外表与链接预览共用一个件（ADR-0032；服务端已齐，`Ai.tsx` 零读 `writing`） | `Ai.tsx`、`link-preview-settings.tsx`、新共用件 | 稿 5、4-36、4-29 | 否 | 中 |
| 4-52 | 订阅标签管理（改名、删除、排序，整表 PUT）与卡上全部标签胶囊（ADR-0034；今天卡上只取第一个） | `pages/up/`、新管理弹框 | 稿 6、4-26 | 否 | 中 |
| **己 收字与收尾** | | | | | |
| 4-53a | 收字：卡片页与皮肤编辑器里没有界面片碰到的文件 | `Cards.tsx`、`CardSkinEditor.tsx`、`pages/cards/`、`pages/skins/` 一带 | 无 | 否 | 中 |
| 4-53b | 收字：面板其余页与配置表（如 `field-labels.ts`）。4-14 只换了 `field-labels.ts` 的五格（删 `roomId` / `uid` / `offset`、加 `subscriptionId` / `nth`），整表的字仍归这片（主人 10-28 定）；4-24 主人批准仅收搜索三项 label/hint 共 6 处，余 212 续延本片；4-55主人批准市场卡仅收不兼容提示3节点为web2平实键，`pages/extensions/marketplace-section.tsx`其余23处续延本片 | `apps/web/src/` 其余 | 无 | 否 | 中 |
| 4-53c | 收字：服务端剩下的字（含迁移里「勤奋 UP」那句报错）。另接 4-14 留下的 `bilibili/source.ts` 与 `bilibili/dynamic/dynamic-poller.ts`（主人 10-28 定），先想清三件：B 站描述符的「B 站 / UP主 / 动态」要出字时才取，得把 `Source.descriptor` 改成读时现取（同 4-13 适配器的 `descriptor()`）；中文叫法棘轮放过 `bilibili/` 目录却不放过共用字典里的 `bilibili.*` 键；认 B 站时间文字的「刚刚 / 秒 / 分钟」不是给人看的话、写死中文棘轮却在数。另接 4-16 留下的 `index.ts` 10 处（主人 10-28 照拟稿定）：帮助指令 3 处（别名「帮助」是输入，决策 9 说三种语言都认，跟另外四个指令文件一起收）；日志 7 处（拒绝裸奔启动那句、内存日志的弹幕探针、开机清扫五句：决策 13 日志不翻，守卫只因字符串在日志调用外面才数到，改写法还是改判据到时再问） 另记4-55主人续准：mute3、index10、bilibili/source7、dynamic-poller7沿原节点保留；共同ctx新增五文件27处（integrations/context4、bilibili/context1、push/adapter-context7、subscriptions/source-context2、extensions/loader13）明确留本行，不扩新增节点。 | `apps/server/src/` | 无 | 否 | 中 |
| 4-53d | 收字：出图包的卡片字 | `packages/image/src/` | 4-56 | 否 | 中 |
| 4-53e | 收字：其余各包与 contract（internal、ai、ui、http、push、storage、contract）。设置校验的报错改成校验发生时才取字（zod 4 的 `error` 写成函数，ADR-0037「仍未决」那条的结论）；加载时就取成常量的字表（如卡种名）改成出字时取（ADR-0037 决策 1）；`ui` 那 26 处用属性传进来还是同样交取字口，施工时定 另记4-55主人批准：ai/tools.ts50为模型文字，按ADR-0037决策11不翻、这里只做分类账；internal/schema/extension-manifest.ts33处只改契约结构，校验文案现取随本行收，不默认因重编号豁免。 | `packages/*/src/`、`apps/contract/src/` | 4-56 | 否 | 大 |
| 4-57 | 醒目留言示例做到中立：预览的 SC 示例今天借 B 站的价目表（`superchatEventFromLiveEvent` 按金额定档）与照 B 站抄的时长表；要不借任何平台的规矩出档位与时长（4-14 主人定另起一片）。清卡片路由 import 边界与 uid 棘轮各剩的 1 | `routes/cards.ts`、面板 SC 示例字段 | 4-14 | 否 | 小 |
| 4-54 | 收尾：`BILIBILI_SOURCE_KEY` 搬出 `internal`；`identityColor` 的 B 站分支改由描述符声明（Q5：描述符加一格「颜色按外部 id 算」，B 站声明；读者六处，面板显示工具、统计、首页，服务端锐评出图从来源登记表取）；推送路由日志标签不再分 B 站（`push-router.ts`，照规矩直接改）；出期条件逐条核数清零；21b 那四行转对拍；全量门禁 | 散 | 其余全部 | 否 | 中 |

动盘只有 4-24（已落：修订号 52 → 53、备份 22 → 23）；4-20 开工时核要不要抬号。

## 顺序

单线做（10-27 主人定第一波主会话单线做，10-28 定第 4 期一直单线）。照前置排，推荐的先后：

1. 第一波已落：4-01 至 4-09、4-11、4-12（4-10 删掉）。
2. 4-56 包字典，先立：之后碰到包里文件的片才收得了那里的字。
3. 服务端读口：4-13 至 4-24、4-55；稿 1 排在 4-18 之前（它定读口要哪些数据）。
4. 4-25 组件库、不等稿的界面片 4-26 至 4-37。
5. 稿 2 至稿 6 各排在自己那几片之前，主人认了再照稿写；等稿的界面片 4-38 至 4-52。
6. 收字 4-53a 至 4-53e、4-57，最后 4-54 收尾。

## 定案

片表的 11 题主人 10-28 逐题答完：

- **Q1 写死的中文收到多少**：甲，第 4 期末放行名单外全部清零，包与 contract 也收；4-53 拆五片。问时的现数（4-11 之后）：361 个文件 5325 处 = 面板 137 / 3046、服务端 162 / 1518、各包 62 / 723（internal 397、ai 157、image 112、ui 26、http 20、push 6、storage 5）、contract 2 / 38。
- **Q1b 包里的话走哪套字典**：甲，internal 的包字典（形状同两端那套，两端合进来，启动时把取字口交给包）。被否：按谁显示分三处放；包只出码、两端各翻（两端共用的约 435 句要抄两份，3b-12 那条 🔗 说过会长歪）。代价：面板包带上只在服务端用的约 300 句。机制拆成 4-56。
- **Q2 哪些界面出稿**：甲，下面「设计稿」那六份，加不出稿清单；不出稿的做完照 verify-ui 截图给主人看。
- **Q3 运行状态读口的形状**：甲，宿主投影（见 4-18）。被否：`Source` 加运行态成员（今天没有实现者）。
- **Q4a 坏格的原值怎么出门**：甲，非密钥格回原值 + 原因，密钥格只回原因（见 4-21）。被否：一律只回路径 + 原因（与五份文档写的「显示原值」不合）。
- **Q4b 订阅坏行放哪**：甲，留在原文件、写回时原样带回（见 4-22）。被否：挪进隔离文件（多一个文件、占修订号）。
- **Q5 `identityColor` 的 B 站分支**：乙，描述符声明（见 4-54）。被否：一律「来源键:外部 id」（每位 B 站 UP 颜色全变）；进放行名单。
- **Q6 搬家进度放哪**：甲，开机段也答详情口（见 4-19）。被否：新开一个口；短版 `status` 加值（违 ADR-0025 决策 12）。
- **Q7 「引擎」三件的归期**：甲，改键本期做（4-24），用户看得见的三处随 4-36，注释留第 5 期「清扫剩余旧名」。
- **Q8 跨来源叫法**：甲，按来源取叫法（见 4-37）。被否：「勤奋 UP」当固定梗名进放行名单。
- **Q9 口吻默认**：维持女仆。不管默认哪种，收字时都要把交互句的女仆版写进女仆层、平实底改写成平实话。
- **Q10 时区那一格**：甲，露出，其余墙上时间也跟（新开 4-55）。问时推荐从「露出、其余不跟」改成了这一个：面板摆着「时区」、免打扰却不听它会误导人；10-20 R1 甲的原文是「这次不跟」。
- **Q11 没定归期的残余**：照推荐。R25 留着的那截随 4-15，锐评 cron 随 4-55；其余不进第 4 期：3b 审查修完「留着的」R6 与 R3 两截、`push.md` 的按码退避重试、推送适配器登记表不等 `adapter.stop()`、`integration.dispose` 不等订阅源 `stop`、AI 实例隔离后的后四件、`s3b-review-rest.md` 里标 low 的 18 条。

开工时才问的（只卡一片）：4-14 预览失败回落示例还是报错；4-25 下拉要不要搜索框、按连接分组还是平铺；4-44「换一个身份」写了之后何时生效。

## 设计稿

主仓 `.bn-design/` 里没有能直接用的第 4 期稿（勘察查过：`extensions-v2` 按口分节、与 ADR-0025 决策 13 冲突；综合管理稿是旧探索；皮肤编辑器稿与本期无关）。下面全是新稿，放 `.bn-design/`、不入库，主人认了再照稿写。

| 稿 | 覆盖哪几片 | 出稿时一起看的 |
| --- | --- | --- |
| 稿 1 健康卡 + 顶栏问题框 + 账号 | 4-18 的数据清单、4-38、4-39、4-40 | 右上告警与问题框合不合并；集成排的粒度（推送适配器有连接才占格）；账号格怎么画、头部下拉；旧 `api` 格去掉；设置不合法与订阅坏行进不进问题框（construction-plan「和问题框一起设计」） |
| 稿 2 生命周期 | 4-41、4-42 | 首访必须确认还是可以稍后；四种提示共用一个主机还是分开；搬完怎么进 |
| 稿 3 系统页重排 | 4-43 至 4-49、4-34、4-47 的开关位置、4-45 的集成坏态 | 系统页今天五节，本期要加 B 站 tab、存储、统计开关、语言 / 口吻、时区、改密码、日志等级 |
| 稿 4 素材库 | 4-50 | 分类、引用关系怎么显示、删除被拒怎么说 |
| 稿 5 AI 页「女仆写正文」与共用例外件 | 4-51（4-36 的失败句可顺带看） | 例外件抽到哪一层（链接预览一行两格三态，AI 一行一格布尔） |
| 稿 6 订阅标签管理 | 4-52 | 管理入口放哪、排序交互 |

不出稿：只换字或改取数据、布局不动的 4-26、4-27、4-29、4-33、4-35、4-36；ADR 已写清版式或组件的 4-31（ADR-0025 决策 13）、4-25 与 4-32（ADR-0035）；4-47 统计页的关闭态。

## 照规矩直接定的 / 从第 4 期销账的

- **日志筛选销账**：等级、来源、正文与参数、日期筛选都在（`Logs.tsx`，客户端筛最近 500 条），分期表那四个字已经做掉。
- **统一密钥输入框销账**：`packages/ui/src/secret-cell.tsx` 已是正本，7 个调用点；随各页重画复核即可。登录密码与备份 PIN 不是配置密钥，不换。
- **推送历史保留期面板半销账**：七档选项、过期「图已清理」、禁重推都在（`System.tsx`、`History.tsx`、`routes/history.ts`）。
- **首页直播监听唯一判定**：判定本体 3b-14 已落、首页文案已用它，只剩 4-35 那个 B 站限定。
- **候选刷新快照的触发点不提题**：ADR-0024 决策 7 已写「列候选时按平台名刷新」。
- **内置适配器描述从哪交不提题**：ADR-0024 决策 1 定「适配器自带」，挂 `PlatformAdapter.descriptor`。
- **卡片预览本期中立化、旧搜人本期关口不提题**：construction-plan 与棘轮行内原因都写明第 4 期。
- **`accounts/` 与多账号整套在第 4 期**：construction-plan 写明；拆成 4-20（服务端）与 4-40（面板）。
- **`core.accounts.order` 缺键 = 登记顺序、默认不落盘**：照 3b-10 / `voice` 的先例，开工时核要不要抬号。
- **同身份遗留订阅组由服务端算**：ADR-0025 决策 12 定健康数据住 `/api/health/details`。
- **顶栏账号撤出排在健康卡之后**：分期表原文「账号挪到健康卡各集成那一格」，中途不能让账号没地方显示。
- **备份默认值提示走「只给路径的坏格读口」、下载内容不变**：construction-plan 原文。
- **素材库做全套**：ADR-0036 定搬口、data-and-migration 定通用选择器；选择器缠 react-query 留 `apps/web`，其中纯展示的网格件进 `packages/ui`。
- **拓展页以 ADR-0025 决策 13 为正本**：决策原文「取代设计稿 V1 的按口子分节」，V2 稿作废。
- **AI 实例遗留只做第一件**（4-36）：construction-plan 只把「指针没着落时抢默认实例」排进第 4 期，其余见 Q11。
- **推送路由日志标签**：`push-router.ts` 改成一律「来源键:外部 id」，只影响日志格式（4-54）。
- **「引擎」注释归第 5 期**：分期表第 5 行「清扫剩余旧名」。
- **包字典的机制单拆一片（4-56，主会话 10-28 照 Q1b 拆，可否决）**：每片都要收自己碰到的文件里的字，包里的字要有地方进；机制放在 4-53e 里的话，排在它前面碰到包的片（4-13、4-14、4-37、4-55 等）都收不了。

## 施工记录

各片落成的要点写在切片表那一行；要展开的另起一节记在这里。

## 真机

不当硬门槛；第 4 期收口时主会话给一张十条以内的短清单。

🔗现状（4-23，2026-10-31）：素材库 8 口及现有读者已迁至 `/api/library`，旧口退役；图 / 字体 picker 与字体大小提醒收字 26 处，写死中文实扫 4855 → 4829，中文叫法 241、B 站替身 75 不变。代码与片级门禁已就绪，当前施工工具没有可用浏览器，真页面验收待补，故本行暂不标 ✅、完成数仍为 23 / 60；通过最终验收后再记 24 / 60。4-50 的顶层页 / 选择器合一、4-57 的 SC 示例与已有 4-53c 延期均不扩范围。

🔗现状（4-23，2026-10-31）：统筹使用主聊天可见的内置浏览器补验，素材路由与 picker 真页面主要流程通过；原施工会话浏览器不可见及当时待验记录保留为历史。保存引用后图 / 字体拒删、解除并保存后删除、直播封面共用图库、双图轮换序号与口吻切换均已实测；字体 GET 通过 CLI 回环读取补证，未称浏览器字体预览。390 宽有横溢出，既有 field-labels warning 已记录；JS error 为 0，服务端 level 50 / 60 为 0。未人为遍历大字体、非法文件等全部边界，也未做卡片 PNG 渲染。素材与注入清空，服务 SIGINT 退出 0、标签关闭、视口复位、端口清空。本片标 ✅、完成数记 24 / 60；4-24 / 4-35 未落成，不计入。

🔗现状（4-35，2026-10-31）：上文「只剩 4-35 那个 B 站限定」已完成，本片计入 25 / 60；4-23 验收注里「4-35 未落成」保留为当时记录。真页面证据由统筹在其 browser2 取得，截图的 before 是操作 / 夹具切换前，并非改代码前；并非每个数据集都有独立前后截图，部分场景由真实 DOM 观察覆盖。链接经键盘 Enter 进入订阅页并返回首页，pointer 自动 click 两次未起效，不据此宣称鼠标通过或推定产品 bug。既有 header 652px 横溢出、健康卡 / 资源卡与头部布局不在本片验收范围；390 下新增提示正常换行。收尾代理 SIGINT 退出 130、dev 退出 0（信号退出符合预期），四端口无监听、标签关闭、视口复位；无开发注入、真实账号、AI、发送或 B 站请求。


🔗现状（4-25，2026-11-01）：代码 `acae0809e`。主人逐题批准 Q1–Q6;本片无搜索、不按数量换控件,列表保持平铺/原排序筛选与默认。TSelect/HourSelect 和 Logs/SkinEditor/RoastPushBox 三处原生 select 统一,保受控字符串接口、合法空值/未知值原样不可用、disabled 与按关闭原因回焦。PopoverShell 锚点 portal fixed 避让限高、useDismiss.insideRefs、MenuItem option/id/tabIndex/ariaSelected 已接;菜单 mousedown 阻止默认聚焦但不挡 pointer/touch/wheel,拖动/滚动/cancel/异项不提交,首次 Esc 隔离父层。UiTextProvider/UiText 出口、内部 useUiText 默认 packageText,AuthedApp 交真实 useT,四类 form-controls 使用时取字。Q6 守卫仅识别真实具名 Provider t 注入/本地 useT、明确入口中 Provider/hook 共享的 React const context 默认函数、真实 useUiText 的 ui.* 键/参数/时机,遮蔽/别的 context 与工厂仍红,ALLOWLIST 空。裸 select AST 守卫识别 JSX/真实 React createElement 及已知别名,无白名单;动态标签/转交工厂/跨文件包装仍需审查。4-32 图标+连接名查询/helper 与真实接线未提前做。

🔗现状（4-25，2026-11-01）：净收中文节点29=form-controls7+Logs1+SkinEditor13+RoastPushBox8,三棘轮4580/235/74→4551/235/74,迁移53/备份23不变。主人逐项批准保留：atoms2（上传中、Donut占比）→4-53e;Logs15→4-53b（下载错误2、正文搜索1、其他顶栏控件4、计数状态5、加载/错误/空态3）;SkinEditor107→4-53a（主体86、恢复快照1、同步toast1、上传1、壁纸非下拉字段4、同步模式弹窗9、滑杆默认/清除3、局部颜色输入2）。原“减少动态效果”节点留在主体,未搬成两层字典。不得把本片延期用于后续新增节点。

🔗现状（4-25，2026-11-01）：已有公开 seam 刻画/目标 AssertionError 红绿完成,12 组行为/接线/裸 select 唯一破坏及 Q6 三组精确守卫破坏均字节恢复、同命令恢复绿。包先构建;完整 build/check/typecheck 退出0,受影响 web/contract/scripts/UI/desktop/internal 测试490文件6063通过、2既有跳过。隔离临时数据/AI关/空账号连接与回环网络,真页遍历日志、系统/外观抽屉、卡片及编辑器、AI目标、统计推送、规则时段与devtools;1280/390同尺寸操作前后截图,真实鼠标事件时序/拖动、滚轮与 Chromium CDP 原生触屏滚动防误选、窄单位和同 DOM 口吻切换均留证。公开 ModalShell+TSelect 浏览器组合另验点击焦点、首次Esc、Tab和第二次Esc;抽屉/Dock 沿真实业务页面验证。首次console两条是自制来源fixture漏supportedFeatures导致,修正fixture后本页操作2→2,其余操作无新增error;Modal补验0→0。未验实体手机/Safari/真实IME输入法或读屏器;首轮服务原始日志被补验脚本覆盖,首轮level≥50=0的清理计数保留,第二轮完整日志及level≥50=0另存。两轮网络阻断0、无真实AI/推送/外站调用,active[]、自起服务/标签/端口已收净。完成数27→28,其余59片的原定分工不变。

🔗现状（4-26，2026-11-01）：本片计入 29 / 60。来源公共 HTTP 描述符完整保留 `membershipPrograms` / `supportedExtras`，不等于拓展清单开放：manifest 及其形状钉仍严格拒收两格。显示、身份复制、会员规则 / 文案 / 卡片选择、scope 页签与 CSV 读当前来源；`externalId` 不转数值，快照名非空时保留原文，缺资料才回身份标签。主人新定徽章规则适用于所有来源：来源表已知且仅一项、命中当前身份时隐藏；多项、表未知或缺条目时显示；has 缺省表示未知，来源表未读到不报未安装。固定会员档按实际 rank 排序，最低可以是 4；custom / 空档仅编辑体系默认，不造档位或门槛。停用 / 失败 / 无可枚举档位不发会员预览，全家福继续其他卡；刷新来源或语言不清 dirty，不改隐藏未知体系、档位、附加项或路由。4-27 提前完成项与 4-28 未搬表范围见各自行，二者均未整片计入。

🔗现状（4-26，2026-11-01）：按已批 20 个 web 生产文件净收中文节点 704，写死中文 4551→3847、中文叫法 235→122、B 站替身 74→30；迁移 53 / 备份 23 不变。交互提示补中文女仆层，标题、标签与数据名保持平实。`bilibili/source.ts` 本片仅接描述符，既有 7 节点（两项设置名、B 站 / UP主 / 动态三叫法、作品轮询与登录检查两日志标签）主人续准 4-53c，描述符出字时现取与该片一起做；未触碰的 dynamic-poller 7 及其他已批延期不扩新节点。统计例外只迁到 web zh-CN 三个完整键、仅放行“动态”，真调用读者闭集钉在 Stats / CSV，缺读者或 History / Rules 复用均红。真实 B 语境仍精确计数 plain5 / maid3，不放行字典前缀：健康 dynamic 标签归 4-38，登录提示归 4-38/40（余字 4-53b），作品检查 / 登录心跳设置归 4-44（来源出字 4-53c），日志等级说明随 4-38/44、剩余元数据 4-53b。其余页面收字仍按 4-53a/b 分工，未打包豁免整份字典。

🔗现状（4-26，2026-11-01）：平台决定守卫经隔离 TypeScript symbol / 值流精确识别真实描述符入口、不可变别名、已证明参数与 JSX props；只豁免描述对象本身及 status / absent 的运行态判断，label 等按名字分叉仍红。静态身份 sourceKey 显示 fallback 才可认，未知调用 / 字符串混入 / 假导入 / 遮蔽仍沿旧规则；字段写入沿真实别名链双向撤信任。既有 seam 目标红绿、生产源码破坏及恢复均留证；核心3 / 面板29、ALLOWLIST 空、通用 source-scan 语义未放宽。受影响 web / contract / scripts 368 文件 4336 通过、2 跳过，服务端相关 4 文件143通过，片级 Biome / typecheck / web build 通过；独审修复后54条平台守卫通过。统筹另跑相关10文件213通过1跳过、internal / contract build、scripts56文件875通过2跳过、全仓typecheck均 exit0；不称全仓 lint / test / build 或 dev 合入后复验。

🔗现状（4-26，2026-11-01）：统筹以既装 Puppeteer / Chrome 验 18 组真页（订阅、规则、卡片、统计、历史、首页、系统、390宽订阅、详情、单来源统计、四种来源异常与四种会员不可预览场景），1280×800 / 390×844 同尺寸操作前后截图，每组 console error 0→0、warning0，后端 level≥50 为0。证据 `/private/tmp/bn-4-26-coordinator-review.md` 与 `/private/tmp/bn-4-26-ui-evidence/`。业务 sources / subscriptions / stats / history / settings / preview 由浏览器本地 HTTP fixture 响应；详情显式保存实为 POST /api/subscriptions，证明页面提交和本地往返，不证明服务端落盘；1px 卡图不证明真实 PNG 渲染。未逐项遍历全部语言、空白快照、dirty 卡片皮肤保存、全局会员逐档保存、toast / 上报出入真实事件入口；相关自动测试结果单列。唯一空数据、AI关、空账号连接 / 目标、非回环网络截断，未用 devtools，active=[]、浏览器已关。停服曾被自动审批拒绝，最终主人通过面板 shell 停止，runner 收 SIGTERM、tsx 报 force killing；统筹已核8787/5173无监听、runner14195 / Vite14241不存在、工作区干净，不记 SIGINT 优雅 exit0。390宽旧 header 652px 横溢出继续归4-39/40。
