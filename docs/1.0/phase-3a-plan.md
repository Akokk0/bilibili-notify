# 第 3a 期计划表：接口先行

3a 是整个 1.0 重构里最大的一期，单独一份计划表（10-07 主人定）。总计划见 [construction-plan.md](./construction-plan.md)：那里只留 3a 的范围一行与指向这里的链接，**各片的进度、每组开工时定的事、留给后面的尾巴都记在这份文件里**。

## 状态

| 项 | 现状 |
| --- | --- |
| 切片表 | 10-07 主人认了，从甲组与 3a-08 开始 |
| 已完成 | 18 / 41（3a-01 至 3a-06、3a-08、3a-11、3a-13、3a-14、3a-23 至 3a-25、3a-33 至 3a-37；3a-07 并进 3a-28） |
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
| 3a-09 | 问题表（全在内存）+ `/api/problems` + 变更事件；拓展侧「上报被拒记录」家族改名腾出 `reportProblem` 这个名字；私聊节流与「已恢复」 | 3a-08 | 无 |
| 3a-10 | 集成的 `state` / `secrets` 存储宿主 | 3a-08 | 备份（加两节） |
| 3a-11 ✅ | 抓图核心服务 `ImageFetcher`（建连接时判内网、每跳都判、8MB 流式截断、嗅探、存库）；图库的 `put` 磁盘写失败改回结果。**没做来源图的引用方登记**：现在还没有生产调用方，登记随第一个调用方做（3a-33、3a-35） | 无 | 无 |
| 3a-12 | 集成宿主：`IntegrationContext` 的构造、生命周期与运行状态；拓展与内置集成收成同一套。最大的一片，开工时再切三小片 | 3a-08 至 3a-11 | 无 |
| 3a-13 ✅ | 密钥打码：schema 上标 `secret`，连接与设置接口按 `MaskedSecret` 下发，写回打码对象 400、没带保留、空串或 `null` 清空；连接新建走 POST（同 id 409）、编辑走 PATCH；面板三处密钥格统一成「打码胶囊 + 换一份 / 不换了」；备份脱敏按标记 | 无 | 无（连接凭据搬不搬加密存储 3a-22 再问） |
| **丙 推送侧** | | | |
| 3a-14 ✅ | 纯搬与改名：`registry` / `dispatch` / `sink/` 搬进 `push/`；`NotificationSink` → `TargetDispatcher` 等一批类名，只改名不改行为 | 3a-04 | 无 |
| 3a-15 | 投递结果改成结果形状：三个适配器各自把错误翻成标准码；历史行跟上，盘上旧失败转 `unknown` | 3a-04、3a-14 | 历史 |
| 3a-16 | 载荷改名（`forward-images` → `image-group`、段的判别键统一成 `kind`）+ 重推原件迁移 + 守卫 13 加重推原件这个根；线上格式由 3a-04 的快照保住不变 | 3a-04 | 重推原件 |
| 3a-17 | 出口咽喉：只有 `TargetDispatcher` 能发送；`sendToAddress`；链接回复改走它（今天唯一一条绕过派发器的真路径） | 3a-14、3a-15 | 无 |
| 3a-18 | 主人通知：`notifyMaster` 回结果形状、三个旧口合一；主人目标只许指向私聊目标（保存拒收、发送复检、迁移清空并在首访提示里说明） | 3a-15、3a-17 | 设置 |
| 3a-19 | 指令回复改走 `sendToAddress`；咽喉 e2e（逐条驱动全部发送路径，每条恰好一条截流记录、零外连） | 3a-17、3a-18 | 无 |
| 3a-20 | 适配器接口 `PlatformAdapter`（`start` / `stop`、描述、候选必备、能力）+ 登记表（登记即 `start`）+ 三个内置适配器改接口 + `/api/adapters` | 3a-12、3a-15、3a-17 | 无（连接形状先不变） |
| 3a-21 | 目标删 `platform` | 3a-20 | 目标、备份 |
| 3a-22 | 连接新形状（`adapterKey` / `settings` / `platformSnapshot`），删 `CONNECTION_PLATFORMS` 闭集 | 3a-21 | 连接、备份 |
| **丁 B 站搬家与接入** | | | |
| 3a-23 ✅ | 搬家前置：面板的登录态类型、`packages/ai` 都先脱开 `@bilibili-notify/api`（包不能反过来依赖服务端） | 无 | 无 |
| 3a-24 ✅ | 纯搬：四包 → `apps/server/src/bilibili/`（`blive` 并进 `bilibili/live/`），只改 import 路径；构建配方、装配脚本、守卫里写死的路径同一个提交带上。**独占工作区**，约 150 个文件 | 3a-01、3a-06、3a-23 | 无 |
| 3a-25 ✅ | 改名（单独一个提交）：按 naming.md 的词表；外部接口回应的起名；原字段名只留在回应上。**独占工作区** | 3a-24 | 无 |
| 3a-26 | B 站的 cookie 与浏览器身份进 `ctx`；`packages/storage` 的 `CookieStore` 退役 | 3a-10、3a-12、3a-25 | 密钥文件 |
| 3a-27 | `PostEvent` 信封与 `post-detected` 事件取代 `dynamic-detected`；`deliverWork` → `deliverPost`、`NeutralWork` 退场；B 站作品的统计多收字段；中立部分拆进 `posts/` | 3a-08、3a-24 | 无 |
| 3a-28 | （接线提醒：谁建了带内网守卫的请求客户端谁负责 `dispose()`，接进关停流程后剪线验一次）B 站实现 `SubscriptionSource`（搜人、取资料、名单驱动、上报作品与直播）+ `/api/sources`；档位表进来源描述符 | 3a-12、3a-25、3a-27 | 无 |
| 3a-29 | `bilibili/auth/` 与 `SourceAuth` 状态机、`accounts/`；顺手修两处：拿二维码失败却回 ok、搜人把风控与未登录都报成 404 | 3a-10 至 3a-12、3a-26 | 备份（账号排序） |
| 3a-30 | B 站报错按因果分层（未登录 → 风控 → 各项请求失败，只报最上面那条）；删各引擎自己私聊主人的旁路（勘察数出比计划多两处） | 3a-09、3a-29 | 无 |
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
| 3a-39 | 设置坏了只停那一处：核心逐格退默认，集成段只停那个集成 | 3a-09、3a-12、3a-38 | 无 |
| **庚 收口** | | | |
| 3a-40 | 入口咽喉：删 `engines.api` 句柄，建 `compose.ts`（唯一能 import `bilibili/` 与适配器的文件）；守卫 1 开张、守卫 12 清零、推送守卫① 收到只剩它 | 3a-22、3a-28、3a-29 | 无 |
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
- 3a-37 开工前定的（10-08，主人都选 A）：**链接预览的视频封面这一片顺手抓进图库**（它是 3b 才中立化的功能，但不抓的话断网后到 3b 之间没有封面；被否：留给 3b）。**拦下的请求记日志 + 出图器内部一个只增的计数**（每次出卡有被拦的就记一条警告：几个、哪些域名、地址不带参数；计数只给测试断言用；面板上的提示留给 3a-09 的问题表，不做两遍。被否：现在就在面板上露出来）。断网后只有地址没有引用的图画占位、锐评卡不再退回头像的远端地址，是定案里写明的结果，不另问。
  - 开工时又定的（10-08，主人选 A）：**拦截的口子开在浏览器适配层**（`runtime/puppeteer.ts` 的 `page()`），对每一个渲染页无条件开——出卡、压图、示例预览、探活都经它，本机与远程 Chrome 同一套；只放行 `data:`，没有主机或协议白名单。被否：由出图器每次用页面前自己开（四类调用方、17 处假页面都要改，漏一处就是一个没闸的页）。新名字主人看过：`isEmbeddedUrl`、`PageOptions.onBlockedRequest`、`BlockedRequestHandler`。
  - 伦伦酱自己定、交付时请主人过目的五条：被拦的请求直接掐断（不回一张假图）；「出图只认引用」放在这一片做、单独一个提交；零联网用「扫描交给页面的 HTML」证明，不加起真 Chrome 的测试；删掉空了的 `start()` / `stop()` 与 `resolveBg` 里没有调用方喂得出的两支；jsdom 这一片不动。
  - 已落（10-08，三个提交 `be2fe735` / `047db6ed` / `32d7ebcc`）：
    - 请求闸：先挂监听再开拦截（反过来请求没人处理，`setContent` 会挂到超时）；闸没开成的页直接关掉、不交出去。记账：调用方传了回调就归它（出图器一张卡汇总一条警告：拦下几个、去了哪些主机，不带路径与参数；另有一个只增的内部计数），没传的由适配层逐个记一条。
    - 出图器里整条预取链删掉（缓存、B 站域名白名单、缩放后缀、并发抓取、`inlineRemoteImages`），`image-renderer.ts` 从 1221 行到约 900 行；出网点名表与 B 站替身棘轮里出图器那两行、`roast-deliver.ts` 那一行都删了。
    - 链接预览的视频封面出卡前经 `fetchPostImages` 抓进图库（`LinkParserOptions.imageFetcher`，和引擎共用同一个抓图服务）；锐评卡没有图库头像就画首字母圆牌。顺带修：抓图服务本身抛错时作品图那条路原来不接异常、整张卡发不出去，现在和「抓不到」一样处理。
    - `pictureUrl` / `coverUrlOf` 只认引用，只有地址的画占位（直播封面是「暂无封面」图，会员徽章块收起）；示例卡的视频封面、九张图、舰长徽章都改成引用。基线快照 23 份字节不变（测试夹具 `fixtures/image-refs.ts` 顶替「抓进图库」那一步）。
    - 零联网测试 `zero-network.test.ts`：八张卡正向（输入全是引用）加四张反向（输入故意只给远端地址），交给页面的 HTML 里都扫不出网络地址。验红时发现：预取链还在的时候这条测试没有牙（塞进去的远端图会被预取换成占位），删掉之后才红得出来。
  - 留着的：① 锐评卡的头像与词云卡的头像在出图器入口的类型还是裸字符串，靠调用方保证交来的是 data URL，交了远端地址会被闸掐掉并记账，类型没收紧；② 零联网扫描只看 `src=` / `href=` 与 CSS `url(`，`@import "…"`、`image-set("…")`、`srcset=`、`poster=` 不在范围内（这些有适配层的闸兜着）；③ 压图、示例预览、探活三条路只有适配层的闸与日志，没有各自的用例；④ `runtime/link-parser.ts` 多了一处对 `bilibili/images.js` 的引用（核心里同样的已有四处），链接解析中立化（3b）时一起还；⑤ `index.ts` 把同一个抓图服务传给引擎与链接解析那两行没有运行期的接线测试；⑥ 测试夹具 `image-refs.ts` 里「作品哪些格子长图」的名单是照 `bilibili/images.ts` 的 `mapPostImages` 手抄的，两份没有守卫对齐；⑦ `neutrality.md` 说 `packages/image/src` 里不许出现 `node:http(s)`，实际守卫只查调用、不查 import，小漏口；⑧ jsdom 在 `packages/image` 的运行时代码里已经没人用，退场另开一小片。
  - 真机待看（都没验，没起过真 Chrome）：① `data:` 请求进不进回调、带几十兆字体的页有没有变慢；② `setContent` 会不会因为漏处理的请求等满 15 秒；③ 冷启动后并发出几张卡，「2×2 平铺」有没有复发；④ 远程 Chrome 两种连法上拦截可不可用；⑤ 被掐断的 `<img>` 与 CSS 背景画成什么；⑥ `about:blank`、`blob:`、皮肤 CSS 的 `url("")` 会不会冒出请求；⑦ 关页瞬间在途请求有没有未处理的拒绝；⑧ 全卡种各出一张，日志里没有「渲染页拦下」，链接预览封面有图，锐评卡没头像时的圆牌；⑨ 像素门（同一会话里改前改后互比）；⑩ 示例预览与面板预览的观感。
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
- 3a-15 的拓展边界（伦伦酱照既有设计定的）：投递结果改形状时，仓里的桥拓展与契约类型这一期不动，宿主在拓展边界上把拓展交回的旧形状翻成新形状；契约 v3 与桥迁 v3 仍在 3b。3a 与 3b 之间没有发版，仓外的 v2 拓展不受这段中间态影响。

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

- **集成宿主住 `integrations/`**（主人选 A）。里面放：`IntegrationContext` 的构造、生命周期、运行状态、通用登记表。不放：各张具体的登记表与来源 / 适配器专用的 ctx（各自的功能目录）、B 站与平台适配器的实现、拓展特有的装载与市场、`compose.ts` 的登记清单、抓图与小存储的本体。问题表放哪 3a-09 开工时问。
- 乙组的顺序照「没有实现者的接口不造」调过：问题表（3a-09）的第一个上报方在 3a-30 / 3a-39，它的私聊节流与「已恢复」又要 3a-18 的主人通知，所以挪到 3a-18 之后；集成存储（3a-10）的第一个用户是 3a-26 的 cookie，随它前一步做。现在就有用户的先做：3a-11（B 站头像与配图进图库马上要用）、3a-13。
- 3a-11 开工前定的两条（10-07 主人拍板）：
  - **抓图防 DNS 重绑定**：内网判定做在真正建连接用的那一次解析上，不做「先解析检查、再正常发请求」。BN 多跑在家里的局域网或 Docker 里，图链又来自外部内容与第三方拓展。被否的备选：不防。
  - **图库的 `put` 整个回结果**：磁盘写失败回 `unavailable`、不再抛，调用方改看返回值（先用刻画测试钉住现有的降级行为）。被否的备选：`put` 照抛、只在给集成用的 `storeImage` / `fetchImage` 那一层转换（同一件事两种写法）。
  - 服务叫 `ImageFetcher`、工厂 `createImageFetcher`、依赖包 `ImageFetcherDeps`，住 `images/image-fetcher.ts`；对外两个函数的签名照 subscription-sources.md。
- 3a-13 开工前定的（10-07 主人拍板）：**这一片只做下发打码，不动盘**。连接凭据在盘上照旧明文存在 `config/connections.json`；搬不搬进加密存储，3a-22（连接换新形状，本来就要动这份文件、抬修订号与备份版本）开工时带上这一题再问，迁移只写一次。被否的备选：这一片就搬（3a-22 还得再搬一次）；现在就定「永远不搬」。
- 3a-08：只搬登记表。`entries()` 没有调用方，没加。补了一份直接钉三条规矩的单测 `integrations/__tests__/registry.test.ts`（原来只经挂载点与 upgrade 的测试间接盖着）。
