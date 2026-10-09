# 第 3a 期计划表：接口先行

3a 是整个 1.0 重构里最大的一期，单独一份计划表（10-07 主人定）。总计划见 [construction-plan.md](./construction-plan.md)：那里只留 3a 的范围一行与指向这里的链接，**各片的进度、每组开工时定的事、留给后面的尾巴都记在这份文件里**。

## 状态

| 项 | 现状 |
| --- | --- |
| 切片表 | 10-07 主人认了，从甲组与 3a-08 开始 |
| 已完成 | 27 / 43（10-08 新开两片 3a-43、3a-44，总数从 41 变 43；3a-01 至 3a-06、3a-08、3a-09、3a-11 至 3a-19、3a-23 至 3a-25、3a-33 至 3a-37、3a-43、3a-44；3a-07 并进 3a-28） |
| 迁移修订号 / 备份版本 | 35 / 9（3a 开工前） |

## 出期条件（检查点）

**B 站的作品全经中立接口运行、行为不变；B 站的直播仍由它自己那套老引擎处理，中立接口对它只是一层外壳，3b 再真正并过来；守卫 21b 绿；出图器零联网绿。**

10-07 主人定（选 A）。原先写的是「B 站全经中立接口运行、行为不变」，但合并两套直播场次引擎排在 3b，这两句对直播是矛盾的。直播是行为最复杂、最容易出回归的一块，「先用 e2e 钉住四种行为再合」留在 3b 不动。被否的备选：3a 就让 B 站直播的信号经中立接口进拓展用的那套场次引擎（等于把 3b 的主体提前，3a 再大一截）。

连带：守卫 21b 的清单里假来源要实现的直播那几项（`fetchLiveStatus`、`liveInteractions`）在 3a 对拍到哪一步，`3a-42` 开工时照这条出期条件定。

## 切片表


10-07 开片：四份只读勘察（订阅源、推送、抓图与出图、设置报错守卫；报告在 `.bn-design/s3a-survey-*.md`，不入库）合成下面这张表。**这是提案，主人认了才动手**；每组开工前把那一组的未决项一题一题问完，定案先落 ADR。

编号写 `3a-01` 起（带圈数字到 ㊿ 为止，第 2 期已用到 ㉚，不够排）。

**主干**（四份勘察一致）：`3a-08` 中立类型与登记表 → `3a-12` 集成宿主 → `3a-24` 纯搬 → `3a-25` 改名 → `3a-28` B 站接成来源 → `3a-40` 入口咽喉与 `compose.ts` → `3a-42` 进程内对拍（3a 检查点）。推送侧的适配器接口（`3a-20`）要等 `3a-12`；别的片大多挂在这条线的某一段上。

勘察现数（搬家前）：B 站四包非测试 47 个文件、10617 行，测试 53 个、15304 行；服务端非测试有 24 个文件 import 它们。代码里还没有 `SubscriptionSource`、`IntegrationContext`、`SourceContext`、`PostEvent`、`compose.ts`、`accounts/`，`bilibili/` 下只有 `settings.ts`。

| 片 | 做什么 | 依赖 | 动盘 |
| --- | --- | --- | --- |
| **甲 随时能做的小片** | | | |
| 3a-01 ✅ | `/api/health` 的 `moduleVersions` 删 api / dynamic / live 三格 | 无 | 无 |
| 3a-02 ✅ | 拓展定时器收口（一次性定时器触发后自动放掉；桥改用 `ctx.setTimeout`）+ 守卫 22 开张 | 无 | 无 |
| 3a-03 ✅ | 守卫 17 开张（`bilibili/`、`platforms/` 不许 import fs，开张即绿） | 无 | 无 |
| 3a-04 ✅ | 推送冻结线：webhook 出站 JSON 与桥的线上格式各钉一条快照（今天一条都没有，而 webhook 直接把内部载荷名写到线上）。推送侧几道棘轮的开张挪去 3a-41，和别的棘轮一起定时点 | 无 | 无 |
| 3a-05 ✅ | 卡片预览路由的出卡器接上图库解析 | 无 | 无 |
| 3a-06 ✅ | `dynamic` 与 `live` 两份一样的 `CommentaryClient` 换成 ai 包已有的 `CommentaryProvider`。另外三个「重名」（`PushLike`、`SubItemView`、`SubscriptionsView`）其实是名字相同、形状不同的两个东西，不能合并只能改名，挪去 3a-25 | 无 | 无 |
| 3a-07 → 并进 3a-28 | 档位表的中立取法：出图器的示例卡与卡片路由不再直接读 B 站档位表。10-07 现查：档位表住 `packages/internal`，纯搬（3a-24）不动它，所以它不是搬家的前置；要到 3a-28 档位表进来源描述符时才需要换取法，而那时才有登记表可以问。现在做只能造一层临时的注入 | — | — |
| **乙 接口骨架（纯新增，还没有 B 站调用方）** | | | |
| 3a-08 ✅ | 建 `integrations/` 目录，通用登记表从 `extensions/claim-table.ts` 搬来改名 `Registry` / `createRegistry`。原定「把来源接口那一整套类型先建出来」不做：照规范「没有实现者的接口不造」，各接口类型跟着第一个实现它的那一片落地（`KeyValueStore` 随 3a-10、`IntegrationContext` 随 3a-12、`SubscriptionSource` 一族随 3a-28） | 无 | 无 |
| 3a-09 ✅ | 拓展侧「上报问题」家族改名 `reportDiscrepancies`（上报出入），腾出 `reportProblem` 这个名字。原定的问题表本体并进 3a-12（今天没有上报方） | 3a-08 | 无 |
| 3a-10 | 集成的 `state` / `secrets` 存储宿主。排在 3a-12 之后、3a-26 之前做（第一个用户是 3a-26 的 cookie） | 3a-08、3a-12 | 备份（加两节） |
| 3a-11 ✅ | 抓图核心服务 `ImageFetcher`（建连接时判内网、每跳都判、8MB 流式截断、嗅探、存库）；图库的 `put` 磁盘写失败改回结果。**没做来源图的引用方登记**：现在还没有生产调用方，登记随第一个调用方做（3a-33、3a-35） | 无 | 无 |
| 3a-12 ✅ | 集成上下文：把「记下注册过什么、停下时按顺序收尾」从拓展上下文搬进 `integrations/`（`IntegrationContext { logger, signal, onDispose }`），拓展上下文建在它上面，行为不变。内置集成随 3a-20 / 3a-28 接上；运行状态没动；问题表挪到 3a-28 / 3a-30 | 3a-08 | 无 |
| 3a-13 ✅ | 密钥打码：schema 上标 `secret`，连接与设置接口按 `MaskedSecret` 下发，写回打码对象 400、没带保留、空串或 `null` 清空；连接新建走 POST（同 id 409）、编辑走 PATCH；面板三处密钥格统一成「打码胶囊 + 换一份 / 不换了」；备份脱敏按标记 | 无 | 无（连接凭据搬不搬加密存储 3a-22 再问） |
| **丙 推送侧** | | | |
| 3a-14 ✅ | 纯搬与改名：`registry` / `dispatch` / `sink/` 搬进 `push/`；`NotificationSink` → `TargetDispatcher` 等一批类名，只改名不改行为 | 3a-04 | 无 |
| 3a-15 ✅ | 投递结果改成结果形状：三个适配器各自把错误翻成标准码；历史行跟上，盘上旧失败转 `unknown` | 3a-04、3a-14 | 历史 |
| 3a-16 ✅ | 载荷改名（`forward-images` → `image-group`、段的判别键统一成 `kind`）+ 重推原件迁移 + 守卫 13 加重推原件这个根；线上格式由 3a-04 的快照保住不变 | 3a-04 | 重推原件 |
| 3a-17 ✅ | 出口咽喉：只有 `TargetDispatcher` 能发送；`sendToAddress`；链接回复改走它（今天唯一一条绕过派发器的真路径） | 3a-14、3a-15 | 无 |
| 3a-18 ✅ | 主人通知：`notifyMaster` 回结果形状、三个旧口合一；主人目标只许指向私聊目标（保存拒收、发送复检、迁移清空并在首访提示里说明） | 3a-15、3a-17 | 设置、备份 |
| 3a-19 ✅ | 指令回复改走 `sendToAddress`；咽喉 e2e（逐条驱动全部发送路径，每条恰好一条截流记录、零外连） | 3a-17、3a-18 | 无 |
| 3a-20（进行中，20a ✅、20b ✅） | 适配器接口，切四小片：20a ✅ 发送口改窄、删派发器里的临时目标；20b ✅ 分两步：20b-1 登记键换 `adapterKey`，20b-2 登记即 `start(ctx)` / 注销即 `stop()`，三个内置适配器与桥改接口；20c 能力 `atAll` / `inbound` 改问适配器；20d `/api/qq/*` 搬到 `/api/adapters` 底下。描述、候选、`settingsSchema` 与它们的读口随 3a-22 | 3a-12、3a-15、3a-17 | 无（连接形状先不变） |
| 3a-21 | 目标删 `platform` | 3a-20 | 目标、备份 |
| 3a-22 | 连接新形状（`adapterKey` / `settings` / `platformSnapshot`），删 `CONNECTION_PLATFORMS` 闭集；适配器的描述、`settingsSchema`、`listConnectionCandidates` 与 `/api/adapters` 的读口（3a-20 挪来） | 3a-21 | 连接、备份 |
| **丁 B 站搬家与接入** | | | |
| 3a-23 ✅ | 搬家前置：面板的登录态类型、`packages/ai` 都先脱开 `@bilibili-notify/api`（包不能反过来依赖服务端） | 无 | 无 |
| 3a-24 ✅ | 纯搬：四包 → `apps/server/src/bilibili/`（`blive` 并进 `bilibili/live/`），只改 import 路径；构建配方、装配脚本、守卫里写死的路径同一个提交带上。**独占工作区**，约 150 个文件 | 3a-01、3a-06、3a-23 | 无 |
| 3a-25 ✅ | 改名（单独一个提交）：按 naming.md 的词表；外部接口回应的起名；原字段名只留在回应上。**独占工作区** | 3a-24 | 无 |
| 3a-26 | B 站的 cookie 与浏览器身份进 `ctx`；`packages/storage` 的 `CookieStore` 退役 | 3a-10、3a-12、3a-25 | 密钥文件 |
| 3a-27 | `PostEvent` 信封与 `post-detected` 事件取代 `dynamic-detected`；`deliverWork` → `deliverPost`、`NeutralWork` 退场；B 站作品的统计多收字段；中立部分拆进 `posts/` | 3a-08、3a-24 | 无 |
| 3a-28 | （接线提醒：谁建了带内网守卫的请求客户端谁负责 `dispose()`，接进关停流程后剪线验一次）B 站实现 `SubscriptionSource`（搜人、取资料、名单驱动、上报作品与直播）+ `/api/sources`；档位表进来源描述符。另带问题表（全在内存）+ `ctx.reportProblem` / `resolveProblem` + `/api/problems` + 变更事件（3a-12 挪来；开工时先核这一片有没有真上报方，没有就整个随 3a-30） | 3a-12、3a-25、3a-27 | 无 |
| 3a-29 | `bilibili/auth/` 与 `SourceAuth` 状态机、`accounts/`；顺手修两处：拿二维码失败却回 ok、搜人把风控与未登录都报成 404 | 3a-10 至 3a-12、3a-26 | 备份（账号排序） |
| 3a-30 | B 站报错按因果分层（未登录 → 风控 → 各项请求失败，只报最上面那条）；删各引擎自己私聊主人的旁路（勘察数出比计划多两处；连同 B 站引擎窄接口上的 `sendPrivateMsg` / `sendErrorMsg` 与 `engines.ts` 的 `masterTellers`，3a-18 留下的）。问题表在这一片接上真上报，私聊节流与「已恢复」随它定 | 3a-28、3a-29 | 无 |
| 3a-31 | 「关了就不查」 | 3a-28 | 无 |
| 3a-32 | devtools 的 B 站部分搬进 `bilibili/devtools/` | 3a-24 | 无 |
| **戊 图** | | | |
| 3a-33 ✅ | 舰长图标运行时抓进图库（原写「改本地资产」，10-07 改）。**开工第一件事：给「来源声明的图」一家图库引用方**，否则存进去的三张徽章 24 小时后被清扫收走、会员卡徽章消失而门禁全绿 | 3a-05、3a-11 | 无（卡片快照字节会变，像素应不变） |
| 3a-34 ✅ | B 站作品、直播封面、附加块的图落进图库（`bilibili/images.ts`；出卡前才抓，预览路由同一条；出图器里的预取链没删，抓不到的图还靠它画，等出图器断网那一片） | 3a-11 | 无 |
| 3a-35 ✅ | B 站头像进图库（资料缓存 `avatar` 与 `avatarUrl` 两格都留、历史行开始有头像快照）；动态、直播、会员、醒目留言、词云、锐评六种卡的头像回来 | 3a-11 | 资料缓存；**会改卡片像素** |
| 3a-36 ✅ | B 站正文的表情图回来（10-07 主人定：只恢复表情；链接前与预约卡抽奖行前的三个小图标不回来，记进总计划「以后再说」） | 3a-34 | **会改卡片像素** |
| 3a-37 ✅ | 出图器零联网：渲染页开请求拦截并计数，删整条预取链；出网棘轮里出图器那条清零。必须排在所有图都已是引用之后 | 3a-33 至 3a-36 | 无 |
| **己 设置** | | | |
| 3a-38 | 核心设置分拆改名（`app` → `core.*` 一带；范围待问） | 无 | 设置、备份 |
| 3a-39 | 设置坏了只停那一处：核心逐格退默认，集成段只停那个集成 | 3a-28、3a-38 | 无 |
| **庚 收口** | | | |
| 3a-40 | 入口咽喉：删 `engines.api` 句柄，建 `compose.ts`（唯一能 import `bilibili/` 与适配器的文件）；守卫 1 开张、守卫 12 清零、推送守卫① 收到只剩它 | 3a-22、3a-28、3a-29 | 无 |
| 3a-43 ✅ | 一次推送一个对象（`PushRouter.push(push)`，`Push` 带按顺序排好的锚点 `PushAnchor`；订阅、总开关、静音与免扰只判一次；锚点按先后发）+ 被静音或免打扰挡下的推送照记历史（`silenced` 行、消息上的 `isSilenced`、可补发）。10-08 新开，定案见 ADR-0021 决策 34 的 🔗 | 3a-15、3a-16 | 无 |
| 3a-44 ✅ | 被过滤的作品在推送历史里留痕（`filtered` 行、`filteredBy`，一条订阅一行，只留痕不生产、不能补发；引擎出口 `onPostFiltered`）+ 删掉「屏蔽后提醒」那段走不到的代码 + 补发与原件去留改成按「还有没有没发的消息」判（3a-43 留下的洞）。10-08 新开，定案见 ADR-0021 决策 34 的 🔗、ADR-0017 决策 6 | 3a-43 | 无 |
| 3a-41 | 守卫 11 修订版、uid 棘轮、`.platform` 决定棘轮（开在 3a 开头还是搬完之后，待问） | 待问 | 无 |
| 3a-42 | 守卫 21b：假来源在进程内照内置那条路登记、逐项对拍。**3a 检查点** | 以上全部 | 无 |

- 能并行的：甲组七片互不相干；`3a-08` 之后 `3a-09` / `3a-10` / `3a-11` 三线并行；丙组的 `3a-14` 至 `3a-19` 与乙组、丁组的文件面基本不交。`3a-24`、`3a-25` 各自独占，期间别的活不许改服务端那 24 个文件。
- 动盘的片各抬一次迁移修订号（现 35）；动备份形状的各抬一次备份版本（现 9）。
- 勘察里标了「推断、没验」的：`apps/server/vite.config.ts` 的 `alwaysBundle` 缺 `md5` / `luxon` / `protobufjs` / `jieba-wasm`（没跑装配自检），`3a-24` 动手时现验。
- 勘察顺手核出的：守卫 18 的保留 id 早已落地（`packages/internal/src/constants.ts` 的 `RESERVED_INTEGRATION_KEYS` 里已有三个内置适配器的键），不是 3a 的活。
- 未决项四份报告合计 64 条，分三类：会改这张表形状的，现在一题一题问；只卡某一片的，那一片开工时问；文档自己写着「施工时定」的，记在那一片。
- 3a-11 两个提交：`f58edee3`（`put` 回结果）与抓图服务。施工时定的：
  - 只有带内网检查的请求走 npm `undici` 的 `fetch` 加自己的连接池，别的请求照旧走 Node 自带的 `fetch`，B 站请求线上一个字节不变（头序测试原样绿）。原因：Node 自带的 `fetch` 不收 npm `undici` 的连接池。
  - `FetchOptions.addressCheck`（内联函数类型，不新增具名类型）与 `maxBodyBytes`、`HttpClientOptions.lookup`、`HttpClient.dispose()`；生产默认 `requirePublicAddress`（`packages/http/src/public-address.ts`）。一个名字解析出多个地址、任何一个是内网就整个拒。
  - 抓图：cookie 只外发不摄入；重定向由抓图服务自己一跳一跳跟，调用方这次传的头只发给起点那个源；单跳 15 秒、最多 5 跳。失败码：401 / 403 `unauthorized`、404 / 410 `not_found`、429 `rate_limited`、其余 4xx `invalid`、5xx 与连不上 `unavailable`。
  - `postFromReport` / `liveCardInputFromReport` 拿到非 `invalid` 的存图失败改成抛（原来静默少图，今天走不到）。推送历史遇磁盘写失败整行不写，保持现状。
  - `packages/http` 的 `engines.node` 抬到 `>=24.0.0`（`undici` 8 要 22.19 以上）；`undici` 进 catalog，lockfile 里只有一份，打进服务端 bundle 后装配自检照过。
  - 留着的：HTTPS 那条路只手验过（SNI 与证书按原主机名），仓里没有证书夹具所以没有用例；带守卫的连接池按判定函数的身份建，每次传新的箭头函数会多一个池，要传固定引用；`fetch-through-mirrors.ts` 与 `packages/image` 各一份 `readCapped` 没收（后者随 3a-37 删）。
- 3a-13 前半 `801b49fe`：标记两档（`secret` 面板打码 + 备份抹；`backupOnly` 面板照显、备份抹），另有一位 `url` 只管备份里抹成地址占位还是空串。联合按值走（OneBot ws 的 `url` 不是密钥、webhook 的是）。备份被抹的叶子改前改后逐个相同、整份输出逐字节相同。盘点核出的事实：WS `state` 频道今天不带任何设置；连接的编辑今天是整条覆盖（后半要改成只提交改过的格）；面板的 `buildPatch` 会把没变的值也发出去（后半要让它跳过打码对象）；拓展连接 `config` 里的密钥这一片不覆盖（随 3a-22）。
- 3a-13 后半 `bacad6d1`（主人定的交互：照拓展设置页，清空 = 点「换一份」后留空保存，不加「清除」按钮）：
  - 服务端：`routes/secret-view.ts`（`connectionView` / `globalConfigView`，只打 `secret` 一档）、`routes/masked-cells.ts`（写入体里带打码对象就 400、issues 指到那一格）；`store.createConnection`；AI 的哨兵字符串与配套函数全删；`/api/ai/test` 按解析前的原始体判断密钥格带没带。
  - 契约：`SecretCellView`、`SecretCellDraft`、`ConnectionView`、`AISettingsView`、`AIProviderProfileView`、`GlobalConfigView`。
  - 面板：`components/secret-cell.tsx`（从拓展设置页抽出来复用，不是新组件）；连接表单的草稿里不放打码对象，「已存着」另记，存盘由 `types/connection-credentials.ts` 的 `connectionPatch` 算；`buildPatch` 加一条规则「两边都是打码对象的格不进 PATCH」（AI 页用）；webhook 列表行副标题直接显示打码字符；死掉的 `maskWebhookUrl` 删了。
  - 守卫：面板那张手写的「哪种连接哪几格是凭据」的表与 schema 的 `secret` 标记逐分支对拍（`apps/web/src/types/__tests__/connection-credentials-schema.test.ts`）。
  - 留着的：拓展连接 `config` 里的密钥仍明文下发（随 3a-22）；`headers` 的值面板照旧显示；面板自己的几份「是不是密钥」判断（`field-labels.ts`、`formatDiffValue.ts`、`connection-fields.ts`）没并；面板里不读密钥格的十几处仍标域类型 `GlobalConfig` / `Connection`。
  - 真机待看：① OneBot 连接的 token 是胶囊，只改名保存后还连得上，「换一份」留空保存后被清掉；② OneBot 三种连法互相切换后保存不报错、token 还在；③ webhook 的地址与 secret 都是胶囊、列表副标题是打码字、只改名后照常推送；④ QQ 官机编辑时扫码回填，密钥栏自动变成输入框显示新值；⑤ 三种平台各新建一条，凭据栏是普通输入框，保存后列表里立刻是打码；⑥ 智能女仆页三把 key 的「换一份 / 不换了」，只改模型名保存后 key 不丢、「有改动」的提示会消失，「试一句」没动 key 时用已存的；⑦ 拓展设置页的密钥格和改前一样；⑧ 浏览器开发者工具里 `GET /api/connections`、`GET /api/settings` 的回应搜不到明文密钥。

### 丙组（10-07 起）

- 3a-14 分两个提交：`3bc63da5` 纯搬（`platforms/registry.ts`、`platforms/dispatch.ts`、`sink/multiplex.ts` → `push/`，只改 import）与改名提交。改名：`NotificationSink` + `MultiplexSink` → 一个 `TargetDispatcher`（住 internal，8 个方法；`PushRouterOptions.dispatcher` 取其中 5 个的 `Pick`），工厂 `createTargetDispatcher`、文件 `push/target-dispatcher.ts`；`BilibiliPush` → `PushRouter`（`push-router.ts`），它的 `sink` 选项与变量 → `dispatcher`；`PushSendInfo` → `PushSendResult`、`SendContext` → `SendMeta`、`QQSendVerdict` → `QQSendResult`、`AdapterRegistry` → `PlatformAdapterRegistry`、投递结果上的 `synthetic` → `isSynthetic`。
- 盘点核出的事实：这批名字没有一个经 `@bilibili-notify/extension` 导出；`isSynthetic` 住在被导出的 `DeliveryResult` 上，但只有宿主的 devtools 截流闸写、宿主自己读，不上线也不落盘。两份线上格式快照的期望值没动。
- 这一片没做、留给后面的：`InboundSinks` → `InboundHandlers`（devtools 里已有同名不同形的接口，入站这块 3a-20 整个重做时一起改）；`PushMessageOutcome` → `PushMessageResult`（随 3a-15 的结果形状）；`PushMessageRole` 的新名（文档写「施工时定」）；日志前缀 `[sink]` 三处（改日志文字不算只改名）。
- 棘轮：B 站替身 `engines.ts` 25 → 20，`master-notifier.ts` 与 `packages/push/src/index.ts` 清零摘掉，`push-router.ts` 2；「结果不手写」两条跟着文件改名、数不变。推送守卫① 还没开张（归 3a-41），所以「基线降到 3 处」现在没有数可记。

### 丁组（10-07 起）

- 3a-23 开工前定的（主人选 A）：**AI 包用一个过渡的小接口脱开 B 站接口包**。`packages/ai` 自己声明只含它用到的七个查询方法的 `BiliLookups`，服务端照旧把 B 站客户端递进来；六个 B 站工具的名字与行为不变。**这个接口 3b 做「来源自带 AI 工具」时必删**，不从包里导出成正式的东西。被否的备选：现在就做最终形态（3a 再大一截，ADR-0030 是按 3b 排的）；3a 期间先把工具摘掉（现查：六个内置女仆技能全靠这六个工具，摘了全不可用，13 个测试文件要删了再写回，而 3b 还远）。面板的登录状态类型同片改从契约包拿（architecture.md 已写明）。
- 3a-23 已落（`f13cca2b`）：`packages/ai/src/tools.ts` 的 `BiliLookups`（七个方法，不从包入口导出）；登录状态的定义在 `apps/contract/src/auth.ts`（`BiliLoginStatus`、`LoginSnapshot`，名字没改，3a-29 换 `SourceAuth`），面板的 `types/auth.ts` 只转出；服务端 `auth/login-status-wire.ts` 把契约的值与 api 包的枚举两头钉住（哪边加减一档都编译不过）。`packages/ai` 与 `apps/web` 的依赖里都没有 api 包了。棘轮（主人同意）：面板 `types/auth.ts` 9 → 2，新登记契约 `auth.ts` 5、服务端那份 6，净增 4 —— 定义挪了地方、名字故意没改。
- 3a-24 已落（两个提交）：`e7c1d89d` 先在原地把四包测试里 32 处过不了服务端编译设置的写法修掉（全在测试，正式代码零处），`fcdfddb4` 才是搬家，所以搬家那个提交只动路径。落点：`apps/server/src/bilibili/{api,dynamic,live}/`，`blive` 平铺进 `live/`（`client.ts` / `codec.ts` / `events.ts` / `parser.ts` 与几份 proto）；`blive` 的出口文件不留，引用方直接指到具体文件，另三个目录的 `index.ts` 留着。被搬的文件内部的相对引用原样不动（不带 `.js`），新写的跨目录引用带 `.js`。四个包壳连同各自的 CHANGELOG 删了（从没发过 npm，git 历史里有），`blive` 的 README 跟到 `bilibili/live/README.md`。
  - 构建：服务端多了四个直接依赖（`jieba-wasm`、`luxon`、`md5`、`protobufjs`），都登进了 `apps/server/vite.config.ts` 的 `alwaysBundle`。**勘察时的推断验过了**：拿掉这四条，`vp run build:update-payload` 照样退出 0，产物里却留着四个裸引用（载荷里没有 node_modules，运行期才炸）。拦它的是 `scripts/__tests__/assemble-server-bundle.test.mjs` 的「bundle 自包含」那条：只拿掉 `luxon` 一条，它连同另外两条起包的用例一起红。所以漏登记靠全量测试拦，光跑装配命令看不出来。
  - 守卫：B 站替身摘掉 13 条共 85 处（搬进了放行目录）；出网守卫的范围断言换掉两个旧根；「结果不手写」的 `follow.ts: 1` 跟着文件换了路径、数不变。
  - 真机脚本（10-07 主人定：放 B 站自己的目录，进 `__tests__` 是因为它们本来就算测试那一类，守卫 17 不扫测试目录、文件名不带 `.test` 所以不会被自动跑）：五个脚本在 `apps/server/src/bilibili/live/scripts/__tests__/`，从此也在服务端的类型检查范围里；原来靠 `node --experimental-transform-types` 吃构建产物，包没了之后吃不到，改成在 `apps/server` 下 `vp exec tsx src/bilibili/live/scripts/__tests__/<脚本>` 直接吃源码。`pb-walk.ts`（离线的那只）实际跑通了，另外三只要登录态、伦伦酱没跑。
  - 测试数：搬家前后都是 998 个文件、13883 条。
- 3a-25 开工前定的（10-07，主人逐题拍板）：
  - **主播的叫法按「最后住哪」定**：以后留在 `bilibili/` 的叫 `up`；data-model 改名对照表点了名、要拆进核心的直接叫 `creator`，一步到位。
  - **这一片只改名字**：行为、形状、线上格式、盘上数据都不变。要连带改形状的、后面的片本来就要换掉的、取值，一律不碰。
  - **9 个没有任何调用方的接口方法先删**（`fbd2b5b8`，连同 4 个类型、9 个地址常量）：关注分组 4 个、验证码 2 个、零散查询 3 个。
  - **类名叫 `Api`，不加平台前缀**（主人：已经限定在 `bilibili/` 下了）。撞名才加 `Bili`：B 站设置的类型撞了拓展清单里的 `SettingsSchema`，所以叫 `BiliSettings` / `BiliSettingsSchema`。
  - **命名规范补了四条**（`3e5f6801`）：不缩写（`Ai`、`Api` 除外）、不用 TS `enum`、`Fields` 后缀、外部接口的地址常量叫「名词 + `_URL`」。
  - 改名的全表在子代理的施工单里，落地后以提交为准；盘点报告在 `.bn-design/s3a-25-rename-inventory.md`（不入库）。
  - **这一片不动的，归谁**：登录那一族（`BiliLoginStatus`、`LoginSnapshot`、`BiliDataServer`、`UserCardInfo` 与 `UserCard` 的字段，字段和取值在线上）→ 3a-29；`work-delivery.ts` 整个文件 → 3a-27；房间会话一族、`LiveType`、`LivePushType`、`LiveNotify…`、`ListenerManager…`、`RoomContext…`、`LiveData` → 3b 合并两套直播引擎时；`RefreshOutcome` / `FollowOutcome` / `WorkDeliveryOutcome`、直播事件的 `price`、登录轮询失败的 `reason` → 改名要连带改形状，归各自动形状的那一片；事件种类的取值 `"danmu"` → 是取值，没定哪一片改；TS `enum` 剩下的三个（`BiliLoginStatus`、`LivePushType`、`LiveType`）跟各自那一族走。
  - **没有着落的三组**（文档写了要合并或删掉，但没写在哪一片做，排到相关的片时问主人）：① `PushLike` / `SubItemView` / `SubscriptionsView`（动态、直播、AI 各一份，data-model 写「各合成一份」）连同 7 个 `…Like`、`LiveMonitorInput`、`DynamicCardStyle`、带 `Sub` 缩写的那几个；② 直播内部的 `MasterInfo` 一族（含 `getMasterInfo`、`masterName`、`masterAvatarUrl`，data-model 写「删掉，拆进 `Creator`」）；③ `DynamicEngineConfig`、`DynamicTimelineManager`、`SubManagerView`（data-model 写「随包消失」）。
  - **直播的串行闸没改名**：对照表写的新名 `createSerialQueue` 已经被 `packages/internal/src/util/serial-queue.ts` 占了，而且两份不是一回事（核心那份按键分队、能关门；B 站这份一条链、没有键）。合不合、叫什么，等主人定。
- 3a-25 已落（三个提交）：`fbd2b5b8` 删 9 个死方法 → `eefbc908` 三个 `enum`（`GuardLevel`、`WsOp`、`PostFilterReason`）换常量对象 → `eb03f6fa` 改名（121 个文件）。测试数前后一样（998 个文件、13883 条），线上格式快照没动，B 站替身棘轮降 27 处、摘掉 5 条。
  - 落地时定的三处（表里没有，伦伦酱照规范定的）：`getBuvid3` 没改（类里已有私有的 `fetchBuvid3` 管真正走网络那一半，公开这个是读缓存的外壳，和 `getMyselfInfoCached` 同理）；`badgeFromMedal` 机械改会变成 `medalFromMedal`，主人定叫 `fanMedalOf`（和旁边的 `guardLevelOf` 一个写法；伦伦酱先起的 `fanMedalFromMedalInfo` 把 B 站的原字段名抄进了函数名，被主人问住）；`RoomHelpers` 自己那个 `getLiveRoomInfo` 不是 `Api` 的方法，属于房间会话一族，没动。
  - 留着的旧名（文字，不是标识符）：`routes/cards.ts` 两条报错文案里的 `getLiveRoomInfo` / `getUserSpaceDynamic`、面板 `field-labels.ts` 里的「向 B 站 getMyselfInfo 探活」、devtools 一处描述。它们是给人看的字，改了就不是「一个字节不变」；而且把内部方法名写给主人看本身就不对，归文案那一片收。
  - 留着的不一致：`template-renderer.ts` 的 `renderSpecialDanmaku` / `renderSpecialUserEnter` 形参还叫 `uname`（模板变量的入口），直播事件上已经是 `name`。
  - 跟着方法改了名的日志文字：`api.ts` 里 19 处重试标签，加上 cookie 刷新那三句日志里的 `getCookieInfo` → `fetchCookieInfo`。没有测试按这些字断言。
- 3a-35 开工前定的（10-07，主人选 A）：**「头像没换就不重抓」靠资料里两格都留来判断** —— `avatar`（图库里的那张图）与 `avatarUrl`（上次抓图用的来源地址），地址没变就不抓；不用迁移。被否的备选：把来源地址存进集成的状态存储（要等 3a-10）、每次都重抓。
- 3a-35 开工时又定的（10-07，主人都选 A）：分两半做——**资料半**（头像进图库写 `avatar`、历史行带快照、锐评卡读图库；不改像素）先落，**卡片半**（五种卡的头像回来；会改像素，观众头像另有题）后做。**头像单独一档缩放**：宽 480、只取第一帧、转 webp；缩放版抓不到**不回退原图**，这一轮没头像、下一轮刷新再试（被否：复用作品图的 1280 档并回退原图，会把大图或动图存成头像）。**新建订阅时当场抓头像再回应**，抓不到不让建订阅失败（被否：先回应、等轮询再补，中间的推送没头像）。「要不要抓」：来源地址和记着的 `avatarUrl` 不同，或有地址却没有 `avatar`；后一条让迁移来的老数据在开机冷刷时补上，不用迁移。
  - **资料半已落**（10-07，`a3632df4`）：`fetchAvatar` / `syncProfileAvatar` 在 `bilibili/images.ts`；三个写入点（新建订阅、首轮采样、开机冷刷）都接上，冷刷的头像另起一条活、同时最多 3 张、不拖名字更新；历史行的 B 站头像快照、锐评卡读图库（没有 `avatar` 时退回地址）。施工时补定的规矩：**资料里只要有 `avatar`，`avatarUrl` 就是那张图的来源地址** —— 抓到两格一起换；抓不到且原来有头像，两格都不动（下一轮地址仍不同会再试，期间显示旧头像）；抓不到且原来没头像，只记新地址。B 站替身棘轮 `push-history.ts` 5 → 4。
  - 资料半留着的：`index.ts` 里 devtools 造动态场景那处仍读 `avatarUrl`（归 3a-32）；`index.ts` 给粉丝轮询传抓图服务那一行、路由里现建抓图服务那一处都没有运行期的接线测试（必填字段靠类型钉着）；面板的 `no-referrer` 绕行与搜索候选头像是第 4 期的活。
  - 资料半真机待看（都没验）：① 用现有数据开机，几分钟内各 B 站订阅的资料里补上 `avatar`，面板头像改走同源地址，日志里没有成片的「头像抓取失败」；② 新建一个 B 站订阅，建好就有头像，存储占用里「订阅资料」涨了；③ 之后的推送，历史行带头像；④ 锐评卡的头像正常；⑤ 几十个订阅的冷刷不触发风控（头像走图床，不走接口，但没实测）。
  - **卡片半已落**（10-07，`01890aee`）。开工时又定的（主人都选 A）：**转发框里原作者的头像恢复**，在 `fetchPostImages` 里和配图一起现抓（去头像之前出图器就是这样画的）；**主播头像出卡那一刻按订阅 id 现读资料**（读口 `avatarOf`，两个引擎都给），不抄进订阅视图——伦伦酱第一版施工单写的是抄进视图，子代理查出视图只在开机与订阅变更时重建，迁移来的老数据要到重启才有头像，改掉了；**预览里没订阅的 UP 现抓头像**（被否：不画，预览会比真推送少一块）。观众头像照总计划：醒目留言用帧里自带的地址，上舰卡出卡前调一次 `fetchUserInfoInLive`；失败都只是没头像、卡照出。词云的出卡入口改成和别的卡一样收图库引用。名字主人都认：`avatarOf`、`repostAvatarUrlOf`、`subscribedAvatar`、`fetchGuardViewerAvatar`、文件 `bilibili/live/viewer-avatar.ts`。
  - **问过、主人定不改的**（10-07）：主人提出「B 站在自己的地盘可以用自己的词，守住中立接口就行」，伦伦酱核过定案（ADR-0021 决策 1「没有后门」）后问要不要给 `bilibili/` 放开词表；主人定**维持现在的命名规范**，`bilibili/` 里照旧按词表起名。⛔ 别再提放开。
  - 卡片半留着的：`MasterInfo.userface` 现在只写不读（3b 改 MasterInfo 一族时一起删）；上舰观众头像那次查询撞风控只记 warn、不进退避（归 3a-30）；预览对「已订阅但资料里还没头像」的 UP 也会现抓一张，不写资料（同一地址同一份字节，和资料将来存的是同一张图）；子代理在会话结束时被中断，词云服务端那半是主会话补完的。
  - 卡片半真机待看（都没验）：① 动态卡外层作者头像、转发框里原作者头像；② 开播卡与直播中卡的主播头像；③ 上舰卡的观众与主播头像，上舰密集时那次查询不触发 -352；④ 醒目留言卡的观众头像；⑤ 词云卡头像；⑥ 卡片预览「真实拉取」已订阅与没订阅两种都有头像；⑦ UP 换头像后下一张卡跟上、不用重启；⑧ 现有数据开机几分钟后推出的卡有头像；⑨ 默认皮肤头像回来之后各卡的版式（头像那一列）。
- 3a-36 开工前定的（10-07，主人选 A）：**只恢复表情图**。正文里视频链接、抽奖链接前的小图标和预约卡抽奖行前的小图标**不回来**——查提交 `235f6d9a`：它们是写死在出图器里的 SVG，不是 B 站给的数据（数据里只有图标名字、没有地址），图库不收 SVG，要回来得新造「SVG 转位图」的流程；归为装饰，记进总计划「以后再说」。表情是正文的一部分、数据里带地址，出卡前和配图一起抓：单独一档（宽 128、只取第一帧、webp），抓不到不回退原图、那个表情照旧画文字。被否：三个小图标一起恢复；整片不做。
  - 已落（10-07，`d954315d`）：`emojiUrlsOf(item)` 从原始动态（含转发的每一层）读「表情文字 → 图片地址」，`fetchPostImages` 第三参加 `emojiUrls`，和配图、头像同一步、同一个并发上限抓；头像与表情共用一段「只抓缩放版、不回退」的内部函数。模板没动：表情画 17 像素见方，128 宽的图绰绰有余。
  - 真机待看（都没验）：① 带表情的动态，卡上表情是图不是「[doge]」这样的字；② 转发动态里内外两层的表情都是图；③ 一条有十几种不同表情的动态，出卡没有明显变慢；④ 图床真的给得出 128 宽的表情缩放版（没联网验过，给不出的话所有表情都会退成文字，日志里有「表情图抓取失败」）。
- 3a-37 开工前定的（10-08，主人都选 A）：**链接预览的视频封面这一片顺手抓进图库**（它是 3b 才中立化的功能，但不抓的话断网后到 3b 之间没有封面；被否：留给 3b）。**拦下的请求记日志 + 出图器内部一个只增的计数**（每次出卡有被拦的就记一条警告：几个、哪些域名、地址不带参数；计数只给测试断言用；面板上的提示留给问题表（当时排在 3a-09，10-09 并进 3a-12），不做两遍。被否：现在就在面板上露出来）。断网后只有地址没有引用的图画占位、锐评卡不再退回头像的远端地址，是定案里写明的结果，不另问。
  - 开工时又定的（10-08，主人选 A）：**拦截的口子开在浏览器适配层**（`runtime/puppeteer.ts` 的 `page()`），对每一个渲染页无条件开——出卡、压图、示例预览、探活都经它，本机与远程 Chrome 同一套；只放行 `data:`，没有主机或协议白名单。被否：由出图器每次用页面前自己开（四类调用方、17 处假页面都要改，漏一处就是一个没闸的页）。新名字主人看过：`isEmbeddedUrl`、`PageOptions.onBlockedRequest`、`BlockedRequestHandler`。
  - 伦伦酱自己定、交付时请主人过目的五条：被拦的请求直接掐断（不回一张假图）；「出图只认引用」放在这一片做、单独一个提交；零联网用「扫描交给页面的 HTML」证明，不加起真 Chrome 的测试；删掉空了的 `start()` / `stop()` 与 `resolveBg` 里没有调用方喂得出的两支；jsdom 这一片不动。
  - 已落（10-08，三个提交 `be2fe735` / `047db6ed` / `32d7ebcc`）：
    - 请求闸：先挂监听再开拦截（反过来请求没人处理，`setContent` 会挂到超时）；闸没开成的页直接关掉、不交出去。记账：调用方传了回调就归它（出图器一张卡汇总一条警告：拦下几个、去了哪些主机，不带路径与参数；另有一个只增的内部计数），没传的由适配层逐个记一条。
    - 出图器里整条预取链删掉（缓存、B 站域名白名单、缩放后缀、并发抓取、`inlineRemoteImages`），`image-renderer.ts` 从 1221 行到约 900 行；出网点名表与 B 站替身棘轮里出图器那两行、`roast-deliver.ts` 那一行都删了。
    - 链接预览的视频封面出卡前经 `fetchPostImages` 抓进图库（`LinkParserOptions.imageFetcher`，和引擎共用同一个抓图服务）；锐评卡没有图库头像就画首字母圆牌。顺带修：抓图服务本身抛错时作品图那条路原来不接异常、整张卡发不出去，现在和「抓不到」一样处理。
    - `pictureUrl` / `coverUrlOf` 只认引用，只有地址的画占位（直播封面是「暂无封面」图，会员徽章块收起）；示例卡的视频封面、九张图、舰长徽章都改成引用。基线快照 23 份字节不变（测试夹具 `fixtures/image-refs.ts` 顶替「抓进图库」那一步）。
    - 零联网测试 `zero-network.test.ts`：八张卡正向（输入全是引用）加四张反向（输入故意只给远端地址），交给页面的 HTML 里都扫不出网络地址。验红时发现：预取链还在的时候这条测试没有牙（塞进去的远端图会被预取换成占位），删掉之后才红得出来。
  - 留着的：① 锐评卡的头像与词云卡的头像在出图器入口的类型还是裸字符串，靠调用方保证交来的是 data URL，交了远端地址会被闸掐掉并记账，类型没收紧；② 零联网扫描只看 `src=` / `href=` 与 CSS `url(`，`@import "…"`、`image-set("…")`、`srcset=`、`poster=` 不在范围内（这些有适配层的闸兜着）；③ 压图、示例预览、探活三条路只有适配层的闸与日志，没有各自的用例；④ `runtime/link-parser.ts` 多了一处对 `bilibili/images.js` 的引用（核心里同样的已有四处），链接解析中立化（3b）时一起还；⑤ `index.ts` 把同一个抓图服务传给引擎与链接解析那两行没有运行期的接线测试；⑥ 测试夹具 `image-refs.ts` 里「作品哪些格子长图」的名单是照 `bilibili/images.ts` 的 `mapPostImages` 手抄的，两份没有守卫对齐；⑦ `neutrality.md` 说 `packages/image/src` 里不许出现 `node:http(s)`，实际守卫只查调用、不查 import，小漏口；⑧ ~~jsdom 在 `packages/image` 的运行时代码里已经没人用，退场另开一小片~~（10-08 已做：`packages/image` 里降成只给测试用的依赖，载荷不再带它的 worker 与默认样式表，`patches/jsdom.patch` 删掉；装配自检过、bundle 入口在空目录里加载不炸，没真机起过服务）。
  - 真机待看（都没验，没起过真 Chrome）：① `data:` 请求进不进回调、带几十兆字体的页有没有变慢；② `setContent` 会不会因为漏处理的请求等满 15 秒；③ 冷启动后并发出几张卡，「2×2 平铺」有没有复发；④ 远程 Chrome 两种连法上拦截可不可用；⑤ 被掐断的 `<img>` 与 CSS 背景画成什么；⑥ `about:blank`、`blob:`、皮肤 CSS 的 `url("")` 会不会冒出请求；⑦ 关页瞬间在途请求有没有未处理的拒绝；⑧ 全卡种各出一张，日志里没有「渲染页拦下」，链接预览封面有图，锐评卡没头像时的圆牌；⑨ 像素门（同一会话里改前改后互比）；⑩ 示例预览与面板预览的观感。
- 3a-16 开工前定的（10-08）：
  - **图集载荷三件一次做完**（主人选 C）：种类名 `forward-images` → `image-group`、字段 `forward` → `mergeForward`、`images[]` 的元素由 `ForwardImage` 换成 `PostImage`（它本来就有宽高，QQ 官机的多图 markdown 不丢尺寸），重推原件只迁这一次形状。被否：只改种类名与判别键；`PostImage` 留给 3a-27（那一片管作品事件，不是推送载荷）。
  - **设置里「合并转发」的键这一片一起改**（主人选 A）：`imageGroup.forward` → `imageGroup.mergeForward`、`imageGroupForward`、`forwardMinTimeoutMs` → `mergeForwardMinTimeoutMs`；它原先没有任何一片认领。连带：迁移改名、备份版本 9 → 10、面板与接口跟改；和原件的迁移共用一次修订号。能力表里的 `forward` 键与桥帧改名仍在 3b（总计划「桥帧改名」）。
  - 伦伦酱照规矩直接定、主人过目的：判别键统一成 `kind` 管到全仓内部（载荷的段、引擎内部的推送段、消息编排的段、订阅变更的一步），外部协议的原名不动（桥的协议帧、OneBot 的消息段）；契约包转给拓展的载荷类型跟着变，桥拓展一起改、协议帧由桥自己映射（同 3a-15）；守卫 13 用「冻一份 0.x 载荷种类表 + 每种一份旧原件过迁移再过现行 schema」；原件的 `version` 不抬；图库里的图放进直播推送不归这一片（设计文档没定形状，留给 3b 合并直播引擎）；图集里的图适配器照旧用 `url` 发，`ref` 只是带着，这一片不加「按引用取字节」的路。
  - 施工中补的一处（10-08，伦伦酱按「一次改齐」加的范围）：图集设置的开关 `enable` → `enabled`。两份设计文档都这么定（data-model 的 `imageGroup: { enabled; mergeForward }`、data-and-migration 的改名行），它和 `mergeForward` 在同一个设置对象里、走同一次迁移，合用这次的修订号。存盘的设置里已经没有别的叫 `enable` 的键。
  - 已落（10-08，两个提交 `de011411` / `09672ccc`）：
    - 载荷：`image-group` / `mergeForward` / `PostImage`，`ForwardImage` 删掉；判别键 `kind` 管到载荷的段、引擎内部的推送段（它上面的 `forward` 也改成 `mergeForward`）、消息编排的段、订阅变更的一步及其两份视图。三个内置适配器与桥拓展各自映射回线上的旧名，webhook 请求体、OneBot 消息、桥协议帧的快照只改输入、期望没动。
    - 「取出带地址的图」收成服务端内部的 `platforms/image-group.ts`（`imageGroupUrls`，回只有地址与尺寸的新对象，图库引用不跟出去）；桥拓展够不着服务端代码，保留自己那一份。没有地址的图发送时跳过：今天没有「只有引用」能走到图集的路（生产方只有 B 站动态的图集，必有地址；拓展作品的图集恒空）。
    - 重推原件按新形状落盘，图集的图是完整的 `PostImage`（带 `ref`）；原件引用的图清点时把图集图的 `ref` 也算上。旧原件由迁移改写，不做读时兼容；开机路径上先迁移再读数据，顺序成立。`version` 没抬，`miniapp-card` 没动。
    - 设置：`imageGroup.forward` → `mergeForward`、`imageGroup.enable` → `enabled`（全局与逐订阅覆盖）、连接上的 `forwardMinTimeoutMs` → `mergeForwardMinTimeoutMs`、引擎视图上的 `imageGroupForward` / `imageGroupEnable` → `imageGroupMergeForward` / `imageGroupEnabled`。修订号 36 → 37（只抬一次），备份版本 9 → 10（旧的 9 按开发期规矩拒收）。
    - 守卫 13 的新做法在 `migration/__tests__/repush-snapshot-payloads.test.ts`：冻一份 0.x 载荷种类表 `ZERO_PAYLOAD_KINDS`，每种造一份旧原件走整趟迁移，再用真的原件仓读回来；现行载荷多一种、0.x 表多一种没交代（编译不过），或某种迁完读不回来、迁完还留着 0.x 的名字（红）。`miniapp-card` 登记为 3b 再改。原有按词表判定的那套没动。
    - 面板：规则页保存条不再把图集设置打平成顶层键（改名后 `enabled` 会撞上字典里「启用 / 通用」那一条），字典键改成 `imageGroup.enabled` / `imageGroup.mergeForward`；标签、提示、分区与文案没动。逐订阅那份投影在没有覆盖时给空对象，开关整段覆盖照旧按格报两条。
  - 留着的：① 能力表里的 `forward` 键、桥帧里的 `forward` / `forward-images`、通用 webhook JSON 里的旧名是线上格式，归 3b「桥帧改名」；② `webhook.ts` 小程序卡那支仍是原样直通，3b 改字段时要补映射，否则内部名会漏到线上；③ 契约包没有转出 `PostImage` 这个类型名（以前 `ForwardImage` 也没转出）；④ 引擎内部视图类型上还有七八个叫 `enable` 的格（`bilibili/live/push-like.ts`、`dynamic/push-like.ts`、`room-context.ts`，不落盘），这一片没动；⑤ 图集设置的 0.x 一侧在改名表里用的是字面量，没有进 `zero-vocabulary.ts`；⑥ QQ 私域 markdown 那支在图集里全是没有地址的图时会落到通用路径、得到空数组，之后怎么走没读（今天走不到）；⑦ `docs/1.0/architecture.md` 守卫 13 那一行说词表是四套、`data-and-migration.md` 说已并成三套，两份文档对不上，没核是哪边对（守卫本身这一片的变化已写进那一行）；⑧ dev 面板的投递捕获行现在印 `image-group`；⑨ 图库里的图放进直播推送仍然没有路，留给 3b。
  - 真机待看（都没验）：① 重新搬家后（修订号 37），规则页的图集开关与合并转发、逐订阅覆盖、连接表单里合并转发的超时，值都还在；② 保存条的改动明细里这两格的标签与分区、点明细跳到对应的格；③ 一条带图集的动态：合并转发开与关各一次，OneBot、QQ 官机（多图 markdown 的尺寸）、webhook 收到的内容和以前一样；④ 历史里一条旧的图集推送能重推；⑤ 薄插件经桥收到的图集与以前一样；⑥ 旧的开发期备份（版本 9）导入时被拒且提示说得清。
- 3a-43 开工前定的（10-08，都是主人定的，全文在 ADR-0021 决策 34 的三条 🔗）：「被挡」记在消息上（`isSilenced`）；一次推送是一个对象、时间上的挡只判一次（主人提出，取代了伦伦酱问的「混合行怎么算」「补发按钮按什么判」两题）；发送接口不要「开一次推送、再一轮一轮交」的三步，改成一个函数交一个完整对象（主人提出，顾问也这么看）；内容并行做、按**锚点**先后发，@全体 也是锚点、只保证先后不等结果（主人提出）；名字 `Push` / `PushAnchor` / `anchors` / `PushRouter.push`；面板低调显示（标签「已静音」、首页不列、一颗补发）；被屏蔽的作品只留痕不生产，另开 3a-44。伦伦酱照设计直接定的：附加项先收窄再记被挡；被挡的 @全体 不记；本体锚点至多一个且排最前；锚点之间互不中止；引擎侧的类型名 `PostPush` / `PostPushAnchor` / `LivePush` / `LivePushAnchor`。
  - 已落（10-08，两个提交 `29a9c6ff` / `f103f3ae`）：
    - 推送层只剩 `PushRouter.push(push)`，旧的逐轮广播入口删掉、不留转接；订阅、总开关、静音、免扰在交进来那一刻判一次，路由复查与附加项收窄每个锚点发出时判；本体发完就返回，后面的锚点在后台发并登记进关停流程。引擎侧动态、直播两份接口各只剩一个 `push`；`LivePushType` 删了词云、总结两档（查实只在服务端内部用，没有落盘、没有过线）。
    - 下播改成「下播卡 → 词云 → 总结」三个锚点一次交出去：词云与总结和出卡并行做（开始的时刻从「下播卡发完」提前到「轮到这次推送、出卡之前」，弹幕快照也取在那一刻），发送按锚点先后；串行队列只包到本体发完。作品的主卡与图集同理是一次推送。
    - `silenced`：闸序改成 无订阅 → 总开关 →（每个锚点）无可用目标 → 附加项收窄成空 → 静音 / 免扰；被挡的每个该收的目标落一行，消息带 `isSilenced: true`、没有结果，照存重推原件。`computeStatus` 的真值表在施工回报里，要点：本体被挡即 `silenced`；本体送到、附加项被挡算 `delivered`。补发闸放行 `failed` / `partial` / `silenced`，补发不过静音、免扰、总开关，不带 @全体。不动盘，修订号 37 不变。
    - 面板：标签「已静音」（未激活灰）、按钮「补发（N 条）」、首页最近推送不列、不弹小卡；三处「期间推送直接丢弃」的文案改成「不发出去、记在推送历史里、可以补发」。
  - 留着的：① **补发一行带附加项的 `silenced` 行时，本体补完的那一瞬间这一行算 `delivered`**；补发若恰好在这时被关停打断，这一行就停在已送达、没有按钮、原件已删，剩下的词云 / 总结补不了（交付时问主人：按钮与原件的去留改成按「还有没有没发的消息」判）；② 补发闸放行哪三种状态这句判断在 `history/repush.ts` 与 `routes/history.ts` 各写了一份，等 ① 定了一起收；③ `countsAsDelivery` 的名字仍然名不副实，设计文档写着「施工时定」，等主人定名；④ 三句没改、现在读起来不准的话：历史页补发按钮的悬停提示「没送到的，让女仆再补一次」放在 `silenced` 行上、`/mute` 的说明没提会记历史可补发；⑤ 没有一条从推送层到盘上的端到端用例，三段各自钉着；⑥ 历史列表每行问一次能不能补是一次 `stat`，静音一晚后一页会多很多次；⑦ 约定在三层各接住一次拒绝，可以收成一处；⑧ `docs/1.0/data-model.md`、`construction-plan.md`、`architecture.md` 与 ADR-0023、ADR-0019 里还提到已经删掉的 `PostPushPart` / `broadcastToFeature`，是设计期的改名表与历史记录，没逐条改；⑨ 「送达次序 = 发起次序」对附加项现在按锚点、不按订阅队列，已写进 ADR-0021 与 push.md。
  - 真机待看（都没验）：① 下播：下播卡先到，词云、总结按这个先后到，总结写得比词云快时也排在词云后面；② 22:59 下播、23:00 免打扰开始，总结照发；反过来在免打扰里下播，整次都不发、历史里一行「已静音」，早上点补发，下播卡、词云、总结一起补出来、不 @全体；③ 全局静音期间来一条动态 + 图集、一次上舰，各自落行，面板首页不列、不弹小卡；④ 开播 @全体：没有管理权限的群里卡片不被 @全体 拖住；⑤ 版式把卡片和文字都藏了，只发附加项、不 @全体；⑥ 历史页「已静音」的灰、展开逐条、补发后今日推送数对得上；⑦ 静音一晚后的落盘量与历史列表的加载速度；⑧ 词云与下播卡同时出图时出图器的负载。
- **核心包出口整理（10-09 主人提、定 A）**：`packages/internal` 今天一个大门全导出（全仓 558 个文件从同一个路径引），`constants.ts` 2109 行、148 个导出，成了「不知道放哪就放这」的抽屉。排在 **3a 全部做完之后单独一片**：按领域分子路径、把 `constants.ts` 按领域拆散、加一条守卫防止再长回去；开工前先勘察，分法拿给主人定。被否：现在插队做（3a 剩下的片都要在新分法上重改一遍，而且类型还没落定）；不整。在那之前各片守住一条：**不再往 `constants.ts` 里加新东西**，新类型放进对口的文件。
- 3a-20 开工前定的（10-09）：
  - **切成四小片，一片一个提交**：20a 发送口改窄；20b 登记键换 `adapterKey` + 登记即 `start(ctx)`、注销即 `stop()`（三个内置适配器与桥）；20c 能力 `atAll` / `inbound` 改问适配器（服务端三处读点）；20d `/api/qq/*` 四个口搬到 `/api/adapters` 底下（面板三处调用跟着改）。
  - **这一片不造的**（伦伦酱照主人当天三次「没有真使用者的不提前造」的取向直接定，没单独问）：适配器的描述（名字、颜色、图标）、`settingsSchema`、`listConnectionCandidates` 与读它们的 `/api/adapters` 读口 —— 读者是 3a-22 的连接新形状与第 4 期的面板，随 3a-22；运行状态没有读者，不建；`connectionAuth` 要的 `AuthState` 在 3a-29。
  - 20a（主人定，两题）：**发送口按去向分两支，各只带用得到的几格**；开关与平台的检查只留派发器一份；假目标删掉（被否：一种形状摘六格、假目标只是变小；拆成两个方法）。三个类型的名字：`SessionRef`（加 `parentAddress`）、`EndpointRef`、合起来 `DestinationRef`（被否：`SendDestination`、`PushTargetRef`）。
  - 20a 已落（10-09，`9a284f70`）：`send(connection, destination, payload)` / `isAvailable(connection, destination)`；类型都从 `PushTarget` 上 `Pick` 出来。派发器里一处 `refusal`：目标或连接停用回 `not_configured`，目标与连接的平台对不上回 `invalid`（这一句 3a-21 删 `target.platform` 时跟着删）；`provisionalTarget` 删了；截流回调入参改成 `{ connection, destination, target, payload }`，`target` 为 `undefined` 就是直接发到会话（原来的 `isProvisional` 删了）。webhook 发出去的请求一个字节没变。契约包多转出类型 `DestinationRef`，契约版本号没升。
  - 行为变了的：① 经目标发送时，派发器现在自己拒停用的目标与连接。三个内置适配器的 `send` 以前不查开关（只在 `isAvailable` 里查），靠调用方先过闸；现在多一道兜底，正常流程走不到。② webhook 与桥以前不查「目标的平台和连接对不对得上」，现在派发器统一查；配置仓写入时本来就强制两者一致、连接的平台也不许改，所以正常数据不受影响。③ 桥：停用现在先于「找不到 bot / 会话」判。④ 适配器日志里会话去向不再打目标 id，改打 `scope:address`；几句失败原因的文字跟着变。
  - 照规矩直接定、主人没逐条表态的：截流回调删 `isProvisional`；新文件 `platforms/destination-label.ts` 的 `describeDestination`（日志里认去向用的短标签）；词表加 `Destination`「去向」。
  - 20b 定的（10-09）：主人定上下文怎么把「自己的连接」交给适配器 —— **现读的连接名单 + 「变了叫我」的订阅**，与拓展今天拿到的把手同形（被否：宿主替它逐条起停，OneBot 的反向监听好几条连接共用一个端口、桥一条接入驮着好几个 bot，逐条起停要另记一本账，而且要推翻已经给第三方的接口；这一小片不动连接）。**3b 写拓展契约文档时要讲清**：每次发送连接都会递到手上，只调 HTTP 接口的适配器不用管连接名单；维持长连接的才需要对账，给一段样板。伦伦酱把 20b 再拆成两步：先换键，再换启停。
  - 20b-1 已落（10-09，`809a99ad`）：登记键从 `platforms: string[]` 换成单个 `adapterKey`，内置三个是 `onebot` / `qq-official` / `webhook`，拓展的由宿主填成拓展 id；`connectionDispatchKey` 把 webhook 那一族收成 `"webhook"`（连接上落 `adapterKey` 之后，3a-22，这个函数退役）；`Connector` / `PlatformDialect` 两个半边接口平铺进 `PlatformAdapter` 后删了（没有单独的消费者），契约包不再转出这两个名字，契约版本号没升。每条连接仍找到原来那个适配器。失败原因里「adapter=…」「no platform adapter for …」对 webhook 那一族的连接现在印 `webhook` 而不是 `feishu` 等。
  - 20b-2 已落（10-09，`719ad6a2`）：`reconcile?` / `dispose?` 换成必备的 `start(ctx)` / `stop()`；`PlatformAdapterContext` = 集成上下文的 `logger` / `signal` / `onDispose` 加 `connections()`（归自己的连接，现读）与 `onConnectionsChanged(fn)`。登记表 `register(adapter, ctx)` 即启动、把手 `dispose()` 即停止（`stop` 失败只记 warn）；视图上不再有 `start` / `stop`。内置三个由 `push/builtin-adapters.ts` 的 `registerBuiltinAdapters` 在 `createEngines` 之前登记，各有一份集成上下文；引擎里三处 `reconcile` / `dispose` 循环删了。拓展适配器的上下文建在拓展自己的集成上下文上（`push/adapter-context.ts` 两边共用）。桥：`start` 只订变更、不立刻对账（与从前「开机对账跑在拓展装载之前」一致），接入名单（设置）变了仍由它自己那个 `reconcile()` 对账。`IntegrationContext` 这个类型搬进了 `packages/internal`（`PlatformAdapterContext` 要继承它、契约包要转给桥；工厂留在服务端，与 `ServiceContext` 的分法相同）。契约版本号没升。
  - 20b-2 照规矩直接定、主人没逐条表态的：`createPlatformAdapterContext`、`registerBuiltinAdapters` 两个名字与文件；`IntegrationContext` 搬家；桥文件里的本地类型 `BridgeAdapter`（多一个 `reconcile()`，不进契约）；`ctx.inbound` 与定时器这一片没进上下文（内置适配器的入站与定时器仍走工厂选项）。
  - 20b-2 留着的：① `registerBuiltinAdapters` 中途登记失败的回收没有测试；② `start` 抛了时它已经订下的变更订阅由集成上下文 / 拓展卸载兜底收，登记表自己不收。真机待看（没验）：开机后 OneBot 的正向长连接与反向监听照常起来、QQ 官方照常连上；面板上改一条连接（停用、改地址）后对应的长连接跟着断开 / 重连；关机不卡。
  - 留着的：① `EndpointRef` 的 `scope` 一格 —— 定案里目标的新形状端点那支没有 `scope`，而 webhook 冻结的 JSON 有，3a-21 / 3a-22 动目标形状时要给它另找来源；② OneBot 的 `isAvailable` 仍不查去向种类（端点目标挂到 OneBot 连接上要到 `send` 才失败，今天就这样）。
  - 真机待看（没验）：重启后桥、webhook、OneBot、QQ 官方各推一条照常送达（新加的那道平台检查不误拦）；停用一个目标后它不再收到推送；指令回复、链接回复照常。
- 3a-12 开工前定的（10-09，主人定，四题）：
  - **问题表连同 `reportProblem` / `resolveProblem` 不在这一片**，跟第一个真会报问题的片落地：3a-28（B 站接成来源）建表与入口，3a-30（报错分层）接真上报。3a-09 那天写的「并进 3a-12」是伦伦酱没查到底：往表里报的入口在上下文上，而这一片内置集成接不上（`start(ctx)` 在 3a-20 / 3a-28）、拓展契约里没有这个成员（契约 v3 在 3b）、核心的问题码全仓零命中，表建了仍然没人写。被否：给拓展上下文先加这两个成员、让假来源拓展当第一个上报方（测试替身不算实现者）；照原计划空建。
  - **这一片只把「记下注册过什么、停下时按顺序收尾」从拓展上下文里搬进 `integrations/`**，拓展上下文建在它上面，行为不变。内置集成这一片不接（适配器 3a-20、B 站 3a-28）。
  - **不拆成两个概念、不另起名**：它就叫集成上下文（`IntegrationContext`），生命周期是它自带的一面，和后缀表里 `Context` 那一行「带生命周期、日志、signal」的说法一致。被否：把机件单独立成 `IntegrationLifecycle` / `IntegrationScope`（Koishi 的 `EffectScope` 是这么做的，查过；它的插件能嵌套、状态挂在作用域上，咱们的集成是平的、运行状态在装载器里管，拆出来的对象太薄）。
  - 已落（10-09，`049761d7`）：`integrations/context.ts` 的 `createIntegrationContext` 交出 `IntegrationContext { logger, signal, onDispose }` 与宿主握着的把手（`track` / `refuse` / `disposed` / `dispose`）；收尾先后照旧：置已停 → `onStopping` → 中止 `signal` → 钩子（后登记先跑、总时限 30 秒）→ 拆名册。拓展上下文里的名册、钩子、时限全换成用它；在跑的动作与解析改成听 `signal`，两段手写的逐个叫停删掉。`DISPOSE_TIMEOUT_MS` 搬到新文件。拓展契约、日志文字、现有测试的断言都没动。
  - 照规矩直接定、主人没逐条表态的：运行状态这一片不动、不改名（内置集成没接上，没有读者）；日志的 `[ext:<id>]` 前缀不改成按来源的字段（那是改日志文字）；选项名 `stopReason` / `onStopping`。把手的类型名 `IntegrationContextHandle` 交付后问过，主人定保留（后缀表 `Handle` 那行补了一句）。
  - 留着的：① 拓展的 `ExtensionContext` 上看不见 `signal`（契约 3b 才加；拓展提供的适配器自 3a-20b-2 起经 `PlatformAdapterContext` 看得见）；② `IntegrationContext` 的其余成员各随其片（存储 3a-10、`http` 3a-26、问题上报 3a-28）；③ `redact`、`fetchImage` / `storeImage` 绑到上下文还没有哪一片点名。
  - 真机待看（没验）：停用一个在跑的拓展（桥），面板上它停下、挂载的地址不再应答；点了动作还没回来时停用，动作被叫停。
- 3a-09 开工前定的（10-09，主人定）：**这一片只做改名腾位**，问题表本体（内存表、`/api/problems`、变更事件、私聊节流与「已恢复」）并进 3a-12，和 `ctx.reportProblem` 同一小片落地（同一天 3a-12 定题时又挪到 3a-28 / 3a-30，见上一条）—— 今天全仓没有一处会往问题表里报，照「没有实现者的接口不造」，先例是 3a-08。**这一族的词用 `Discrepancy`（出入），不用定案原写的 `Rejection`** —— 「被拒」只对三种结果里的一种（ADR-0023 决策 14、ADR-0025 决策 10 下有 🔗）；界面上那个框叫「上报出入」。
  - 已落（10-09，`19b55e39`）：`SubscriptionReportProblem` → `ReportDiscrepancy`；容器 `ReportProblemLog` → `ReportDiscrepancyTable`（照后缀表「内存里按键查的表」）；三处回调 `onSubscriptionReportProblem` / `extensionReportProblem` / 拓展直播的 `reportProblem` 成员都叫 `onReportDiscrepancy`；ctx 里那个唯一出口 `reportProblem` → `recordDiscrepancy`；契约 `ExtensionReportProblemView` → `ReportDiscrepancyView`、字段 `reportDiscrepancies`；事件与 WS 帧 `extension-report-discrepancies-changed`；五个文件名 `report-problems` → `report-discrepancies`；这一族的局部变量、注释、界面与假来源拓展的文案一并换。纯改名，行为没变；`reportProblem` 这个名字从代码里腾空了。
  - 留着的：① `ExtensionDTO` 还没改名 `InstalledExtensionView`（不在这一片）；② `outcome` 的三个取值 `rejected` / `dropped` / `skipped` 没动；③ `SkillProblem` / `MaidSkillProblemDTO` 用 `Problem` 指的不是问题表里的一条，是既有违例，没在这一片改。
  - 真机待看（没验）：订阅源拓展报一条坏的，详情页出现「上报出入」框、条数与原因照旧；框不用刷新自己更新。
- 3a-19 开工前定的（10-09，主人定）：指令这一半做 ADR-0031 决策 1 的前两件（`CommandSpec` 改名 `CommandDef`、`run(values, ctx)` 的 `reply` 回到发指令的会话，文字和图都能发），`run` 返回结果与失败文案留给 3b，`login [来源]` 等来源的登录接口；咽喉 e2e 能真驱动的真驱动，走不到发送那一步的列成带理由的名单（被否：给服务入口开假出图器、假 B 站接口的测试接缝）。
  - 已落（10-09，`7a69a45e`）：
    - 分发器每收到一条私聊现造这条消息的 `reply`，经 `sendToAddress` 回到「来的那条连接 + 发信人的私聊」；分发器自己的回话（未知指令、参数写错）与锐评审批的 y / n 确认也用它。各指令不再在构造时拿 `reply`。登录二维码经同一个 `reply` 发图，`sendQr` 删掉。没送到记一条 warn、不抛。
    - 服务端主动发的（定时锐评的审批预览、报错提醒）仍走 `notifyMaster`。
    - 开发版「模拟一条指令」的场景改用主人目标所在的连接；没有主人目标时明确报错。
    - 咽喉 e2e `apps/server/src/__tests__/egress-throat-e2e.test.ts`（约 3 秒）：清单 11 条，驱动 8 条（订阅广播、通知主人、目标测试、AI 试一句、锐评投递、人工重推、指令回复、审批预览卡），没驱动 3 条并各带理由（卡片发送要浏览器、登录二维码要向 B 站申请、链接回复要查 B 站）。每条驱动的路恰好一条截流记录；末尾一条用例核对「驱动到的」与清单一致。定案原文的「指令回复与登录二维码」拆成了两条，免得半条没驱动的挂在「驱动」名下。
  - 行为变了的：指令的回复以前一律发到主人目标那条连接，现在回到消息进来的那条连接上的那个私聊（同一平台配了两条连接、从另一条发指令时才看得出区别）。
  - 留着的：① `run` 仍不返回结果，指令出错只打日志不回话（3b，ADR-0031 决策 1 第三件）；② 回调类型 `CommandReplyHandler` 是这一片新起的名字；③ 登录二维码经 `reply` 发图只有单元测试，真服务里没走过；④ 经桥进来的指令没在 e2e 里驱动（e2e 用的是一条指向本机的 OneBot 连接）；⑤ e2e 没驱动的三条只有各自的单元 / 路由测试与 3a-17 的结构守卫兜着。
  - 真机待看（都没验）：① 私聊发 `status`、`help`、`mute`，回复回到同一个私聊；② 敲一个不存在的指令，建议也回到同一个私聊；③ `login` 的二维码图与那句说明都收到；④ 锐评审批回 `y`，确认的回话回到同一个私聊；⑤ 卡片发送、链接回复各手动走一次（e2e 没驱动）。
- 3a-18 开工前定的（10-09，主人定，ADR-0021 决策 57 下有 🔗）：「强制私聊」一次删干净（适配器发送口的第四个参数、拓展契约的类型、桥一起改，不留到 3a-20）；删除的正好是主人目标时拒绝；备份格式版本抬到 11。
  - 已落（10-09，`824f5dfa`）：
    - `PushRouter.notifyMaster(文字或消息体)` 回结果形状，三个旧口删掉；没配主人 `not_configured`、不可达或已销毁 `unavailable`、不是私聊 `invalid`；它只发、不记 error 日志。
    - 「强制私聊」全删：`TargetDispatcher.sendPrivate`、`sendToTarget` 的 `private`、适配器 `send` 的第四个参数、OneBot 与桥里读它的分支；通用 webhook 的 `private` 一格保留、写死 `false`；截流面板「是否私聊」改成按目标自己算。契约版本没升，桥发给插件的帧没变。
    - 主人目标只许指向私聊目标，判据只有一处 `isPrivateTarget`（`internal` 的常量入口，面板也用它）：设置保存、改目标、删目标、恢复备份四个写入口拒收；发送时复检；开机读盘不拒开机。
    - 迁移：指向群或已经不在的主人目标清空，记进「没带过来的」，首访提示 `migrated` 多一格 `masterTargetCleared`。修订号 37 → 38，备份版本 10 → 11。
    - 面板：主人目标下拉只列私聊目标，存着的值不合规时多一行不可选的「已失效」并说明；锐评审批能不能开跟着同一个判据。三句文案主人已同意。
  - 行为变了的：① 主人目标指向群时不再能开锐评审批；② 通知主人没送到时（没配、不可达）现在记一条 warn，以前静默；③ 设置里只改别的格子时不查主人目标，盘上留着的旧值不挡别的设置保存。
  - 留着的：① `bilibili/` 里 B 站引擎自己的 `sendPrivateMsg` / `sendErrorMsg`（7 处调用）没动，`engines.ts` 的 `masterTellers` 转调 `notifyMaster`，3a-30 删旁路时一起删；② 首访提示那句「原来的主人目标不是私聊，女仆已经帮主人清空了，请到系统页重新选一个」还没有地方显示（面板今天不显示任何迁移提示，首访页在第 4 期），数据已经带到；③ `index.ts` 里迁移后记提示的那一行没有直接的测试；④ `packages/ui` 的 `TSelect` 选项多了可选的 `disabled`。
  - 真机待看（都没验）：① 用真实 0.x 数据重新搬家到修订号 38，主人目标是私聊的原样留着；② 系统页主人目标下拉只有私聊目标；③ 把主人目标那条目标改成群、或删掉它，被拒并看到说明；④ `status` 等指令照常回复、登录二维码照常私聊送到；⑤ OneBot 群推送与私聊推送各发一条都正常（删了强制私聊分支）；⑥ 通用 webhook 收到的 JSON 里 `private` 是 `false`。
- 3a-17 开工前定的（10-09，主人定，ADR-0024 决策 13 下有 🔗）：「发给谁」收成一个值 `SessionRef { scope, address }`（从会话目标的类型上取，不手抄），签名 `sendToAddress(connectionId, session, payload)`；临时目标搬进派发器内部、适配器接口这一片不动；截流闸搬到派发器这个口。照码表不用问的：连接停用回 `not_configured`，不可达或没有适配器回 `unavailable`。
  - 已落（10-09，`27443da8`）：
    - `TargetDispatcher.sendToAddress`：不进路由、不过闸、不落历史、不重试、不触发投递回调；挡下时打一条 warn。链接回复改走它，接线从 `index.ts` 抽到 `runtime/link-reply.ts`。
    - 登记表的 `list()` 只给不含 `send` 的视图 `PlatformAdapterView`（运行时也真的没有）；带 `send` 的完整适配器只有 `push/registry.ts` 的 `sendableAdapters` 一个取法，开发版用 `deriveAdapterRegistry` 在原表上派生一张包过能力注入的表。
    - 截流：派发器在马上要调适配器的那一处问 `interceptSend`（`createEngines` 多一个同名的口，只有开发版传）。主人选的是「包派发器」，落成了「派发器在最后一步问一下」：位置是同一个口，连接不在、适配器不在这些检查在截流开着时照常生效。
    - 守卫 `scripts/__tests__/egress-throat.test.mjs`：除了 `push/target-dispatcher.ts`，谁引 `sendableAdapters` 就红。
  - 行为变了的：链接回复原先不查就发；现在连接停用或不可达时直接不回，只留一条 warn。
  - 留着的：① ~~派发器里的 `provisionalTarget`（临时目标）要等 3a-20 把适配器的发送口改窄才删，届时一起定适配器自己查开关、查平台、webhook 读目标名这些事~~（3a-20a 已了）；② `index.ts` 里「链接解析的 `send` 用的是 `createLinkReplySender`」「开发版把 `interceptSend` 传给引擎」这两行接线没有测试够得着（`index.ts` 的装配 3a-40 搬进 `compose.ts`），引擎往派发器递的那一跳有测试；③ 派生表按下标把视图和完整适配器对上，对不上会抛；④ 截流面板里 `sendToAddress` 的那种记录目标名显示成「群 地址」/「私聊 地址」，契约没加新格。
  - 真机待看（都没验）：① 群里发一个视频链接，卡片照常回到那个群；② 把那条连接停用后再发链接，不回，日志里有一条 warn；③ 开发版开截流后发链接、点目标测试，截流列表各多一条，群里没有真消息；④ 关截流后恢复真发。
- 3a-44 开工前定的（10-08，主人定，全文在 ADR-0021 决策 34 第三条 🔗）：一条订阅记一行、目标空着；状态 `filtered`、行上 `filteredBy`（主人嫌 `block` 这个词重，而且六种原因里有一种是没命中白名单，「过滤」才是总称）；面板标签「已过滤」、展开写具体原因；引擎出口 `onPostFiltered` / `FilteredPost`；删「屏蔽后提醒」。
  - **伦伦酱问错的一题**：「屏蔽后提醒怎么处理」是照代码里读到的 `settings.filter.notify` 问的，没去核设置的 schema。它在独立端从来没有设置项，那段代码生产里走不到。主人选的「删掉」结果只是删死代码；伦伦酱当时说的「要删设置、迁移、修订号 37 → 38、备份 10 → 11、再搬一次家」都不成立，修订号仍是 37、备份版本仍是 10。
  - 已落（10-08，三个提交 `cd0a55b6` / `0b0f5d16` / `43f383bb`）：
    - 补发的洞：预检与补完删不删原件都按「这一行还有没有没送到或被挡下的消息」（现成的 `unsentIndices`）判；「能补、共几条、差几条」由历史视图那一处统一算，REST 与 WS 都带，面板只认这一格；一颗还是两颗按钮、按钮文字仍照 ADR-0017 决策 8 按状态分。伦伦酱中途裁成过「按条数分」，那会让「@全体 已到、本体失败」的失败行多出一颗整行重发、再 @ 一次全体，推翻了决策 8，当轮改回。
    - 过滤留痕：`filtered` 行（一条订阅一行、`targetId` 为空、`filteredBy`、一条「摘要 + 换行 + 原帖链接」的文字），不出卡不抓图不调 AI 不存原件不能补发，不进历史仓的在途表；原因词表 `PostFilterReason` 搬进 `internal`；B 站动态引擎与拓展作品各一个 `onPostFiltered`；`targetId` 为空的两种行在补发闸、视图、统计、首页列表、小卡各处改成按状态分。原帖链接取自来源那头（B 站是这条动态的页面，拓展是上报的地址），`Post` 上没有地址那一格。摘要按统计那边的 `POST_SUMMARY_MAX_CHARS`（200）截。
    - 删掉的：`blockedNotice`、引擎侧类型 `PostFilterSettings`（去掉 `notify` 后就是 `PostFilterRules`）、两处发提醒的分支与相关测试。
  - 留着的：① 行里的原帖链接是纯文字、不能点（历史消息只有文字、图、图文三种）；② 动态开关关着的订阅在过滤之前就返回，不留痕；③ 被过滤的行也带头像快照，会让那张头像多被引用一段时间；④ `docs/adr/0019`、`docs/1.0/subscription-sources.md`、`construction-plan.md` 的历史记录里还提到屏蔽提醒，没逐条改；`docs/1.0/architecture.md` 守卫 21b 的对拍清单里的「屏蔽后提醒」一项已划掉；⑤ `postNoun` 少了一个用处，现在只进 AI 提示词与装配；⑥ `countsAsDelivery` 仍待主人定名；补发按钮悬停提示与 `/mute` 说明两句措辞仍待主人定（3a-43 留下的）。
  - 真机待看（都没验）：① 开一条屏蔽规则后发一条会命中的作品：历史里实时多一行「已过滤」，展开看得到原因，首页不列、不弹小卡、没有补发按钮；② 行里摘要与链接的样子；③ 已静音的一行带词云与总结，补发到一半重启，重启后按钮还在、能把剩下的补完；④ 开着面板时刚发生的失败行立刻有按钮，补发途中按钮上的条数跟着变。
- 3a-33 开工前定的（10-07，主人选 A）：**舰长图标运行时抓进图库，不随包带**。B 站来源启动时从 B 站静态站抓三张图进图库，新增一家引用方「来源声明的图」保住它们不被 24 小时清扫收走；抓不到时徽章那一块收起。切片表里这一片原来的标题「改本地资产」作废。被否的备选：把 B 站官方图标放进仓库随载荷走（是在开源仓里再分发 B 站的美术素材）；自己画替代图标。
- 3a-33 已落（`fa76a5fd`）：新模块 `guard-icons.ts`（主人定单开，没并进 `membership-event.ts`；起初放在 `bilibili/` 根上，目录整理时挪进 `live/`），对外三件事 `ensure()` / `iconOf(tierKey)` / `refs()`；图库引用方 `IMAGE_REFERRERS.sourceDeclared`「来源声明的图」，存储占用归「其它图片」。
  - 和原设想不一样的两处：① **不是开机就抓，是 B 站直播引擎起来时才抓**（有 B 站订阅才会起）。无条件抓会让一批真起服务、本来不联网的测试被外网闸判红；没订阅时不抓不丢功能，首条上舰与卡片预览出卡前都会补抓。② 抓图用的请求客户端是装配处自带的一个，不借 B 站接口那个（抓静态图不用登录态，也不该把 cookie 带出去），关停时在 drain 段关掉；它带的 B 站请求头常量住在 `guard-icons.ts`，装配处只引用。
  - 留着的：自定义上舰文案没填图时、以及兜底文字那一支，推送里附的仍是档位表里的 B 站地址。现查：这条路今天把「图的地址」落成一个**链接段**交给推送平台，BN 自己不抓，所以不挡出图器零联网；但「把图库里的图放进直播推送」现在没有路（内容构造器只收地址或字节），归推送侧收（3a-16 载荷那一片时一起看）。
  - 留着的：出卡前 `await ensure()`，B 站静态站连不上时这一条上舰卡会多等一次抓图超时（5 分钟内最多一次）。
  - 真机待看（都没验）：① 有 B 站直播订阅时开机，日志里没有 `[guard-icons] …失败`，面板存储占用「其它图片」多三张；② 会员卡的徽章画得出来；③ 断网开机不变慢，恢复后首条上舰能补抓；④ 过 24 小时三张还在；⑤ B 站静态站要不要 Referer（现在带了）。
- 3a-34 开工前定的（10-07，主人选 A）：**B 站作品的图在过滤之后、出卡之前才抓**，被屏蔽的动态一张图都不抓。和拓展「上报时就抓好」的时机不同，落地时在 ADR-0021 决策 22 下补一条 🔗 说明。被否的备选：检测到作品就抓（被屏蔽的白抓，靠清扫收走）。
- 3a-34 开工时又定的四条（10-07，主人都选 A）：
  - **图库存缩放版**（宽 1280、质量 80、只取第一帧、转 webp，和出图器今天抓的是同一份），缩放版抓失败再试一次原图；图上的 `url` 照旧留原图地址。被否：存原图（常超 8MB 被拒，而这些图 24 小时后就被清扫收走）。
  - **用 B 站接口自己的请求客户端抓**（`fetchImage` 走集成自己的客户端是定案），给 `Api` 开一个只读窄口；舰长图标那个自建的无 cookie 客户端并过来。被否：先用无 cookie 的自建客户端、等 3a-12 / 3a-26 再换。真机待看：图床收到登录 cookie 之后的反应。
  - **放 `bilibili/images.ts`**（根下，三样都在里面：`scaledImageUrl`、`fetchPostImages`、`fetchLiveCover`）。这一步是 B 站集成自己调 `fetchImage`，不是核心的中立一步。被否：按归属拆到 `dynamic/`、`live/` 三处。
  - **确定要出卡时才抓**：关了出图、渲染器不在、版式把卡片块藏了就一张都不抓；⛔ 这个判断不看静音与免扰（ADR-0021 决策 34：静音期间照样出卡）。被否：过滤一通过就抓。**3a-28 开工时要重看**：B 站改成「上报作品」之后过滤和出卡在核心手里，这个时机还保不保得住到时问主人。
  - 施工中又定的两条（10-07）：「要不要出卡」里只问版式的那半句收成通用的 `isBlockVisible(layout, type)`（住 `packages/internal` 的消息版式文件，直播、作品投递、B 站抓封面三处共用；被否：只管直播的 `wantsLiveCard`）。**舰长图标的自建客户端留到 3a-28 再并**（主人选 A）：`Api` 建得比运行时装配晚，现在并要改装配顺序，而 3a-28 做档位表声明时这块本来就要动；到时并到集成自己的客户端上并删掉 `guardIconHttp`。
  - 落地后留着的：`index.ts` 里建抓图服务那一行没有专门的测试（漏传编译不过，传错客户端没人拦）；预览路由每次请求现建一个抓图服务（便宜，没缓存）；链接预览的视频封面（`runtime/video-card.ts`）仍只有地址，3b 的活；推送侧图集地址（`extractGallery`）没动；`packages/image` 里 `attachment.tsx`、`rich-text.tsx` 关于图标与表情的「到 3a」注释留给 3a-36。
  - 真机待看（都没验）：① 推一条带图的动态、一条视频动态、一条转发，卡上的图与封面和从前一样（像素应不变）；② 开播卡与直播中卡的封面正常；③ 日志里没有 `[bilibili-images] 抓图失败`；④ 抓图沿用 B 站接口客户端的默认头（`Accept` 是 JSON 那套，只多带 Referer），图床不拒；图床域名和登录 cookie 的域不同，按理收不到 cookie，抓包确认一次；⑤ 一条被屏蔽的动态之后，面板存储占用里「作品配图」不涨；⑥ 面板卡片预览「真实拉取」的动态与直播，图和真推送一致。
- B 站目录整理（10-07，主人看了搬完的目录说乱，拍板现在理）：`live/` 从 30 个文件平铺改成根上 10 个加三层子目录 `protocol/` / `session/` / `recap/`，测试跟着各自测的文件走；`guard-icons.ts` 从根上挪进 `live/`；`api/`、`dynamic/` 不动（各 9 个，且有几个本来就要走）。纯挪位置，54 个文件，受影响范围的测试数不变。定案 ADR-0021 决策 1 🔗。第三层伦伦酱先起的是 `wordcloud`，不准（里面还有 AI 总结的请求器），主人定叫 `recap`（下播后的回顾），词表加了一行。
- 丁组的施工顺序：3a-23 与 3a-13 后半合回之后做 3a-24（纯搬，独占工作区）→ 3a-25（改名，独占）；这两片期间不开别的会改服务端的活。丙组的 3a-15 起、戊组的 3a-34 / 3a-35 都排在 3a-25 之后（它们要改的文件正是被搬的那批）。
- ~~3a-15 的拓展边界（伦伦酱照既有设计定的）：仓里的桥拓展与契约类型这一期不动，宿主在拓展边界上把旧形状翻成新形状~~ **10-08 主人推翻**：全仓只留一份投递结果，不手抄旧形状、不加翻译层 —— 核心是一等公民，和它不合的地方按它的标准改。桥拓展与契约包这一片跟着一起改：契约包导出 `ok()` / `fail()`，桥里手写的结果都换成它们。桥和薄插件之间的线上协议不动（只带 `err` 的回执由桥翻成 `unknown` + 原话），协议回执的统一（ADR-0026 决策 7）与契约 v3 仍在 3b。契约版本号这一片不升；3a 与 3b 之间不发版，受影响的只有开发期手上按旧契约打好的拓展包。
- 3a-15 开工前定的（10-08）：对端明确回了失败、只给一个适配器没有对照的数字码时，`code` 用 `unknown`、数字码放 `upstreamCode`（主人选 A，失败规矩第 6 条加第三种情形；被否：`invalid`，是猜；自定义码 `upstream_rejected`，多造一个词）。伦伦酱照规矩直接定、主人过目的：耗时只在成功那一支；发出之后的超时一律 `indeterminate`，`timeout` 只留给发出之前；发送层与派发器自造的失败按码表字面取（找不到 `not_found`，没适配器 / 持续不可达 / 已停用 `unavailable`，路由被移除 `conflict`）；历史接口给面板的失败这一片就换成 `code` + `message`；按标准码重试不归这一片；旧失败行没有原话时填「没有送达，对端没说原因」；连接与目标上的 `testStatus.err` 这一片不迁（3a-21 / 3a-22 整个换掉，排期不是例外）。
  - 已落（10-08，两个提交 `ce82b95a` / `831b2a56`）：
    - `DeliveryResult` / `ProbeResult` 是 `Result` 的别名，耗时只在成功那一支；三个内置适配器按码表翻错误，平台的码进 `upstreamCode`（HTTP 状态写成 `"http:502"`，和数字的 retcode 分得开）；适配器抛错由派发器在边界接住记 `unavailable`；`PushMessageOutcome` → `PushMessageResult`。
    - 契约包导出 `ok()` / `fail()` 与 `Result` / `Failure` / `FailureCode`（「只放类型」的唯一例外，两个不带状态的纯函数）；桥拓展的投递与探活结果都用它们造，`BridgeSendOutcome` / `BridgePingOutcome` 改成 `…Result`。协议帧一个字节没动。
    - 历史行的结果按结果形状落盘（判别联合，老形状的失败读不进来，所以必须先迁移再开历史仓，现状如此）；补丁行也过 schema 再写，截流标记这类格不再进盘。迁移没有「一步接一步」的链：从第 0 代一趟产出最新形状，修订号 35 → 36 只是让开发期迁出来的那一代重迁；新加的一步排在原有三处早退之后，行与补丁行都走得到。备份不含历史行，备份版本不动。
    - 历史接口与 WS 给面板的消息：失败带 `code` + `message` + `upstreamCode?`，耗时照旧不过线（子代理第一版把结果原样铺开、带出了耗时，主会话按原来「不外泄内部字段」的决定改回）；面板两处改读 `message`。锐评投递的失败带着码走到接口。
    - 「结果不手写」棘轮删了 11 行、95 处。
  - 子代理按码表字面定、主会话接受的：桥里三种「已停用」`not_configured`；对端回 2xx 但内容不是约定的样子 `invalid`；桥发出后没等到回执或在途断开 `indeterminate`，探活没等到回应 `timeout`；小程序卡签卡这一步超时 `timeout`（消息还没发）、签卡收到 HTTP 404 按 `unsupported`。
  - 行为跟着变的：失败行不再记耗时；`testStatus` 失败时不带耗时。
  - 留着的：① 历史行 schema 的 `code` 只认标准码表，将来码表删码，带那个码的旧行会被当坏行跳过；② `bootstrap.ts`「推送引擎还没起来」与 `index.ts` 链接回复「connection not found」两处的码没有用例钉着（后者 3a-17 改走派发器时一起收）；③ 链接回复直接调适配器，适配器抛错在这条路上没人接（3a-17）；④ QQ 官机的 REST 请求没有任何超时，产不出 `timeout` / `indeterminate`；⑤ 定时锐评的 `RoastRunOutcome.failed[]` 仍只带原话，码不上线（要带得改 contract）；`DeliverOutcome` 按后缀表该改名 `RoastDeliveryResult`，没动；⑥ 桥的 `protocol.ts` / `blob-route.ts` 与假桥的手写结果是线上字节，随 3b 协议统一；⑦ `extensions/bridge/PROTOCOL.md` 里「`err` 直接展示给用户」那句在协议统一前仍然成立；⑧ 契约形状变了但契约版本号没升，开发期按旧契约打好的拓展包与新宿主不兼容；⑨ `silenced` 行没有任何切片认领，等主人指位置。
  - 真机待看（都没验）：① **主仓下次开机会从 0.x 的原始数据重迁出新的一代**（修订号变了；10-07 之后在开发版里产生的历史、改过的设置留在旧的那一代里，不带过来），迁完旧失败行显示原话、码是 `unknown`；② 三个适配器对真实平台的失败：断网、错 token、目标不存在、限频，各自落的码和面板上显示的话；③ 薄插件对新桥拓展收发正常；④ 面板历史页失败行的原因显示正常；⑤ 测试连通、测试推送按钮在失败时的话。

## 已定的事

- **10-07 直播在 3a 只做外壳**（见「出期条件」）。

## 各组开工记录

（每组开工时在这里加一小节：那一组问过主人的题与答案、施工时定的要点、留着的尾巴、真机待看。）

### 甲组（10-07）

- 3a-01 `fc0db31d`：`moduleVersions` 只剩 storage / subscription / push / image / ai 五格；装配自检改看其中两格。面板本来就不读这一格。
- 3a-02 `69c41707` + 守卫 22 `scripts/__tests__/extension-bare-timers.test.mjs`：拓展的一次性定时器触发后自己从登记里放掉，触发后再 dispose 是空操作；桥的握手窗口与回执超时改走 `ctx.setTimeout`。守卫 22 的判据：裸调用与挂在 `globalThis` 等全局对象上的定时器调用、`node:timers` 的 import、`createServer`、不带 `noServer: true` 的 `WebSocketServer`；开张即绿，没有白名单。
- 3a-03 `89cb662a` `scripts/__tests__/integration-no-fs.test.mjs`：守卫 17 开张即绿，没有白名单也没有棘轮。四包搬进 `bilibili/` 时要过这道闸。
- 3a-04 `41f06b20`：两份刻画测试，`platforms/__tests__/webhook-wire.test.ts`（通用 JSON 五种载荷的完整请求体、请求头、`private` 的现状；钉钉 / 飞书 / 企业微信各五种载荷压成的文字）与桥的 `wire-frame.test.ts`（适配器交给传输层的请求）。施工时核出的事实：载荷是**五种**不是四种（多一个 `miniapp-card`）；只有通用 webhook 把内部名直接写到线上，三家机器人方言只发文字，但压文字时读 `kind` 与段的 `type`，改名写歪文字会变，所以也钉了；桥的代码与 `PROTOCOL.md` 没有不一致。
- 3a-05 `321e652d`：预览路由的出卡器传上 `resolveImageRef`。路由本来就拿得到图库，没有新增传参。接线测试用一份「徽章是图库引用」的档位表走 `POST /preview`。
- 3a-06 `47c4fe0d`：见切片表那一行。勘察没点出的一处：`packages/ai/src/tools.ts` 里还有第三个 `SubItemView`，3a-25 一起处理。
- 3a-07 并进 3a-28（理由见切片表那一行）。甲组到此做完。

### 乙组（10-07 起）

- **集成宿主住 `integrations/`**（主人选 A）。里面放：`IntegrationContext` 的构造、生命周期、运行状态、通用登记表。不放：各张具体的登记表与来源 / 适配器专用的 ctx（各自的功能目录）、B 站与平台适配器的实现、拓展特有的装载与市场、`compose.ts` 的登记清单、抓图与小存储的本体。问题表放哪 3a-28 开工时问（表本体 10-09 先并进 3a-12，同一天又挪到 3a-28 / 3a-30）。
- 乙组的顺序照「没有实现者的接口不造」调过：问题表的第一个上报方在 3a-30 / 3a-39，往里报的入口 `ctx.reportProblem` 要等集成真拿到上下文（3a-28），所以表本体跟到 3a-28 / 3a-30（10-09 主人定），3a-09 只做改名腾位、3a-12 只建集成上下文；集成存储（3a-10）的第一个用户是 3a-26 的 cookie，随它前一步做。现在就有用户的先做：3a-11（B 站头像与配图进图库马上要用）、3a-13。
- 3a-11 开工前定的两条（10-07 主人拍板）：
  - **抓图防 DNS 重绑定**：内网判定做在真正建连接用的那一次解析上，不做「先解析检查、再正常发请求」。BN 多跑在家里的局域网或 Docker 里，图链又来自外部内容与第三方拓展。被否的备选：不防。
  - **图库的 `put` 整个回结果**：磁盘写失败回 `unavailable`、不再抛，调用方改看返回值（先用刻画测试钉住现有的降级行为）。被否的备选：`put` 照抛、只在给集成用的 `storeImage` / `fetchImage` 那一层转换（同一件事两种写法）。
  - 服务叫 `ImageFetcher`、工厂 `createImageFetcher`、依赖包 `ImageFetcherDeps`，住 `images/image-fetcher.ts`；对外两个函数的签名照 subscription-sources.md。
- 3a-13 开工前定的（10-07 主人拍板）：**这一片只做下发打码，不动盘**。连接凭据在盘上照旧明文存在 `config/connections.json`；搬不搬进加密存储，3a-22（连接换新形状，本来就要动这份文件、抬修订号与备份版本）开工时带上这一题再问，迁移只写一次。被否的备选：这一片就搬（3a-22 还得再搬一次）；现在就定「永远不搬」。
- 3a-08：只搬登记表。`entries()` 没有调用方，没加。补了一份直接钉三条规矩的单测 `integrations/__tests__/registry.test.ts`（原来只经挂载点与 upgrade 的测试间接盖着）。
