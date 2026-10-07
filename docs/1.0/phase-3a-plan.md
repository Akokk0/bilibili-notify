# 第 3a 期计划表：接口先行

3a 是整个 1.0 重构里最大的一期，单独一份计划表（10-07 主人定）。总计划见 [construction-plan.md](./construction-plan.md)：那里只留 3a 的范围一行与指向这里的链接，**各片的进度、每组开工时定的事、留给后面的尾巴都记在这份文件里**。

## 状态

| 项 | 现状 |
| --- | --- |
| 切片表 | 10-07 主人认了，从甲组与 3a-08 开始 |
| 已完成 | 9 / 41（3a-01 至 3a-06、3a-08、3a-11、3a-14；3a-13 做了前半；3a-07 并进 3a-28） |
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
| 3a-13（前半 ✅） | 密钥打码的服务端半：schema 标 `secret: true`，接口与 WS 按 `MaskedSecret` 下发，备份脱敏改读这个标记；面板同片跟到照旧能用。**已落**：标记（`markSecret` / `markBackupOnly`）、共用打码函数、备份脱敏按标记。**未做**：接口下发换形与面板，等主人定面板上密钥格的交互 | 无 | 无（连接凭据搬不搬加密存储 3a-22 再问） |
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
| 3a-23 | 搬家前置：面板的登录态类型、`packages/ai` 都先脱开 `@bilibili-notify/api`（包不能反过来依赖服务端） | 待问 | 无 |
| 3a-24 | 纯搬：四包 → `apps/server/src/bilibili/`（`blive` 并进 `bilibili/live/`），只改 import 路径；构建配方、装配脚本、守卫里写死的路径同一个提交带上。**独占工作区**，约 150 个文件 | 3a-01、3a-06、3a-23 | 无 |
| 3a-25 | 改名（单独一个提交）：按 naming.md 的词表；外部接口回应的起名；原字段名只留在回应上。**独占工作区** | 3a-24 | 无 |
| 3a-26 | B 站的 cookie 与浏览器身份进 `ctx`；`packages/storage` 的 `CookieStore` 退役 | 3a-10、3a-12、3a-25 | 密钥文件 |
| 3a-27 | `PostEvent` 信封与 `post-detected` 事件取代 `dynamic-detected`；`deliverWork` → `deliverPost`、`NeutralWork` 退场；B 站作品的统计多收字段；中立部分拆进 `posts/` | 3a-08、3a-24 | 无 |
| 3a-28 | （接线提醒：谁建了带内网守卫的请求客户端谁负责 `dispose()`，接进关停流程后剪线验一次）B 站实现 `SubscriptionSource`（搜人、取资料、名单驱动、上报作品与直播）+ `/api/sources`；档位表进来源描述符 | 3a-12、3a-25、3a-27 | 无 |
| 3a-29 | `bilibili/auth/` 与 `SourceAuth` 状态机、`accounts/`；顺手修两处：拿二维码失败却回 ok、搜人把风控与未登录都报成 404 | 3a-10 至 3a-12、3a-26 | 备份（账号排序） |
| 3a-30 | B 站报错按因果分层（未登录 → 风控 → 各项请求失败，只报最上面那条）；删各引擎自己私聊主人的旁路（勘察数出比计划多两处） | 3a-09、3a-29 | 无 |
| 3a-31 | 「关了就不查」 | 3a-28 | 无 |
| 3a-32 | devtools 的 B 站部分搬进 `bilibili/devtools/` | 3a-24 | 无 |
| **戊 图** | | | |
| 3a-33 | 舰长图标改本地资产。**开工第一件事：给「来源声明的图」一家图库引用方**，否则存进去的三张徽章 24 小时后被清扫收走、会员卡徽章消失而门禁全绿 | 3a-05、3a-11 | 无（卡片快照字节会变，像素应不变） |
| 3a-34 | B 站作品、直播封面、附加块的图落进图库 | 3a-11 | 无 |
| 3a-35 | B 站头像进图库（资料缓存 `avatarUrl` → `avatar`、历史行开始有头像快照）；动态、直播、会员、醒目留言、词云、锐评六种卡的头像回来 | 3a-11 | 资料缓存；**会改卡片像素** |
| 3a-36 | B 站正文小图标、表情、附加块行图标回来（待问做不做） | 3a-34 | **会改卡片像素** |
| 3a-37 | 出图器零联网：渲染页开请求拦截并计数，删整条预取链；出网棘轮里出图器那条清零。必须排在所有图都已是引用之后 | 3a-33 至 3a-36 | 无 |
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

### 丙组（10-07 起）

- 3a-14 分两个提交：`3bc63da5` 纯搬（`platforms/registry.ts`、`platforms/dispatch.ts`、`sink/multiplex.ts` → `push/`，只改 import）与改名提交。改名：`NotificationSink` + `MultiplexSink` → 一个 `TargetDispatcher`（住 internal，8 个方法；`PushRouterOptions.dispatcher` 取其中 5 个的 `Pick`），工厂 `createTargetDispatcher`、文件 `push/target-dispatcher.ts`；`BilibiliPush` → `PushRouter`（`push-router.ts`），它的 `sink` 选项与变量 → `dispatcher`；`PushSendInfo` → `PushSendResult`、`SendContext` → `SendMeta`、`QQSendVerdict` → `QQSendResult`、`AdapterRegistry` → `PlatformAdapterRegistry`、投递结果上的 `synthetic` → `isSynthetic`。
- 盘点核出的事实：这批名字没有一个经 `@bilibili-notify/extension` 导出；`isSynthetic` 住在被导出的 `DeliveryResult` 上，但只有宿主的 devtools 截流闸写、宿主自己读，不上线也不落盘。两份线上格式快照的期望值没动。
- 这一片没做、留给后面的：`InboundSinks` → `InboundHandlers`（devtools 里已有同名不同形的接口，入站这块 3a-20 整个重做时一起改）；`PushMessageOutcome` → `PushMessageResult`（随 3a-15 的结果形状）；`PushMessageRole` 的新名（文档写「施工时定」）；日志前缀 `[sink]` 三处（改日志文字不算只改名）。
- 棘轮：B 站替身 `engines.ts` 25 → 20，`master-notifier.ts` 与 `packages/push/src/index.ts` 清零摘掉，`push-router.ts` 2；「结果不手写」两条跟着文件改名、数不变。推送守卫① 还没开张（归 3a-41），所以「基线降到 3 处」现在没有数可记。

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
