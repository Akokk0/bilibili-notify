# ADR-0025：集成 —— 上下文、设置、请求客户端、问题与健康

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）。**未施工**；归期见 [ADR-0021](0021-neutral-core.md) 决策 60。
- **记录方式**：拷问当场落的定案。类型与目录的正本在 [docs/1.0/](../1.0/) 的 subscription-sources、extension-contract、architecture、data-model；本份只写定了什么、为什么、否了什么。
- **影响面**：新包 `packages/http`；`apps/server` 的装配、拓展宿主、设置加载、问题表、健康路由；`packages/extension`（契约 v3）；`apps/web` 的系统页、问题框、健康卡。
- **依赖**：[ADR-0021](0021-neutral-core.md)、[ADR-0019](0019-subscription-source-opening.md)（拓展设置与上报）、[ADR-0026](0026-failure-results.md)（失败规矩）。

## 背景

订阅来源、平台适配器、拓展各自拿一份 ctx，成员有重叠又不一致：推送侧叫 `config`、订阅侧叫 `settings`；B 站的请求客户端、cookie 与浏览器身份写死在 B 站的实现里，拓展要自己再造一套；问题上报只有来源能用，存在订阅运行态里；设置段校验不过就整台 BN 起不来。

## 决策

1. **「归属方」统一叫「集成」**：`bilibili/` 是一个集成，每个拓展是一个集成，内置的平台适配器也是。每个集成拿一个 `IntegrationContext { logger, state, secrets, redact, settings(schema), http, fetchImage, storeImage, reportProblem, resolveProblem, signal, onDispose }`；`SourceContext`、`PlatformAdapterContext` 在它上面加各自特有的。登记表的键类型叫 `IntegrationKey`，来源的 `SourceKey` 是它的一部分；`identity.sourceKey` 不变。拓展的 `activate(ctx)` 拿到它的 `IntegrationContext` 加各登记方法；来源与平台适配器特有的那一层（名单、上报、入站、自己的连接），和内置的一样经所登记实现的 `start(ctx)` 递进来，登记交回的把手只管注销（与 ADR-0024 决策 1、3「同一个接口」一致）。
2. **设置只有一个词 `settings`**：`connection.config` → `settings`、`configSchema` → `settingsSchema`、`configFields` → `settingsFields`；`config` 只指存储（`config/` 目录、`ConfigStore`、`config-changed`、`bn.config.yaml`、`BN_CONFIG`）。`SourceContext` 加 `settings(schema)`（`get` 与 `onChange`），和拓展同一个用法。
3. **设置按集成放**：集成的设置字段在登记集成时交（不挂在来源的描述符上，一个集成可能同时提供来源与适配器）。声明了 `settingsFields` 的内置集成在系统页各开一个 tab（今天只有 B 站；tab 名取它的 `label`，面板代码里不出现 `bilibili`），用通用的设置表单与对表门；拓展的设置只在拓展页，功能页面放指过去的入口；「运行」tab 只留核心参数。
4. **设置坏了只停那一处，不挡开机**（修订 ADR-0021 决策 42）：
    - 拓展段、`bilibili` 段校验不过：只停那一个集成，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起。
    - `core` 段逐格校验（每个顶层键一格，`defaults` 与 `ai` 再细一层）：坏的那格在内存里用默认值、盘上原文不动，问题表记一条「先按默认值跑」，主人在面板上重存那一格就清掉。
    - 只有信封坏了（解析不了）才挡开机。
    - 生命周期闸是唯一的例外：只有 `start` / `activate` 期间读设置失败可以抛错中止启动，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。
    - 理由：BN 起不来时，桌面壳连续失败几次就把这一版判死、自愈退回 0.12，而且进不去面板改设置；Docker 则反复重启。面板登录凭据在 `bn.config.yaml`，不在这些段里，退回默认值不会把门打开。
5. **内置集成走同一套生命周期**：`start(ctx)`、`AbortSignal` 中止、`onDispose` 收尾；运行状态只取 `running` / `failed` / `settings-invalid`，系统页、健康卡与 `status` 指令都读它。
    - 收尾的先后：宿主先调来源或适配器自己的 `stop()`，收掉它自己的活；再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾，替它收掉经 ctx 拿到的东西（websocket、定时器）。
6. **新中立包 `packages/http`**：
    - 从 B 站的实现里抽出请求客户端、cookie 罐与浏览器身份；每个集成一个客户端，经 `ctx.http` 拿；BN 自己的请求不用它。
    - cookie 由宿主自动存进该集成的 `secrets`。
    - `websocket(url, opts?)` 只负责用集成的身份建连、集成停下时自动关；帧、心跳、重连归集成。
    - 不加别的协议（SSE 需要时给请求加「原样交出响应流」的选项）；出站代理以后挂在这里。
    - 重试、退避、限流归集成（维持 ADR-0019 决策 53）。
    - 浏览器身份生成一次、存进该集成的 `state`，重启照用；只在发版把版本区间前挪、存的低于下限时升级，只升不降。
    - 1.0 对拓展整套开放。
7. **删掉自定义 UA 设置**：身份一律由 `packages/http` 生成，UA 与 `sec-ch-ua` 永远配套；B 站设置页加「换一个身份」按钮重新生成。ticket 请求固定用默认 UA 的特例随之消失（建仓时从老插件原样搬来，没有留下理由）。老配置里的这一格由迁移丢掉，新 schema 不留（ADR-0022 决策 4）。
    - 理由：填了自定义 UA，`sec-ch-ua` 仍是生成的 Chrome 身份，拼出一个自相矛盾的指纹；风控 -352 的第一嫌疑本来就是 TLS 指纹，不是 UA。
8. **`fetchImage` 走集成自己的客户端**（同一套 cookie、身份与默认头）：拦内网、8MB、嗅探、超时这一层只在 `fetchImage` 上，每一跳重定向都查；`ctx.http` 整体不拦内网（局域网里的 RSSHub 要连得上）。
9. **`state` 与 `secrets` 是同一个 `KeyValueStore { get, set, delete }`**（`get` 同步，宿主在 `start` 前读进内存；写由宿主原子落盘），差别只在保管：
    - `state`：明文，不进备份，不脱敏；单键 64KB、每个集成 1MB（ADR-0021 决策 39）；`http.` 开头的键归宿主（浏览器身份）。
    - `secrets`：用主密钥加密，一个集成一个文件（B 站的 `cookies.enc` 改名并入），只进完整备份；值里的每一段字符串都按原文脱敏（很短的不遮）；每个集成 256KB；`http.` 开头的键归宿主（cookie 罐）。
10. **ctx 上的调用被拒或失败**：
    - 上报类（`report*`、`reportProblem`、`resolveProblem`）保持 `void`：被拒或丢格记进该集成的 `reportRejections` 表并打 warn 日志，来源不知道；报的人不在名单里照旧静默忽略。拓展契约从 v2 的 reject 改成这样。
    - 请求类（`state` / `secrets` 的写与删、`fetchImage`、`storeImage`）返回结果形状，不抛错（码见 ADR-0026）：超上限或写了保留前缀回 `invalid`，磁盘写失败回 `unavailable`；取图 404 回 `not_found`，超 8MB、不是图、内网地址回 `invalid`，超时回 `timeout`，网络或上游 5xx 回 `unavailable`。
    - 理由：被拒都是来源自己的 bug，运行时改不了，回结果只会诱导它重报；B 站的上报被拒就是 BN 的 bug，靠对拍守卫兜。
11. **问题表只有一种形状，全在内存**（修订 ADR-0021 决策 16、47）：`Problem { reporter: IntegrationKey | "core", about?: { subscriptionId } | { connectionId }, code, message, since }`。
    - 一条生死规矩：报的人 `resolveProblem` 清；报的人停下，它报的全清；对象删了，关于它的全清。
    - 来源带 `externalId`，宿主换成订阅 id；平台适配器带 `connectionId`，宿主核它是不是这个适配器的；核心直接写，code 表明是哪个模块（如 `renderer_unavailable`）。
    - 签名分层：`IntegrationContext.reportProblem({ code, message, notify? })` 不带对象；`SourceContext` 在上面加 `externalId?`，`PlatformAdapterContext` 加 `connectionId?`。
    - 订阅卡、连接卡看关于自己的，问题框看全部；`GET /api/problems` 一次给全；变了发总线事件 `problems-changed`（只带键），经 `state` 频道，250ms 合并。
    - 订阅运行态不再存问题。
    - 理由：开机时关注同步与第一轮资料刷新几秒内就会重报；存盘换来的只是「报的人重启后得记得清掉上次报的」这个负担。
12. **健康**：`SourceHealth = { summary: string }`，只给健康卡与 `status` 指令一行字；订阅卡的「暂停 / 不可用」改看运行状态与问题表。健康卡分两排：核心（持久化、订阅、推送、卡片、AI）与集成（每个集成一格，推送适配器有连接才占格；灯按运行状态与问题分四色）。数据放 `/api/health/details`；短版 `/api/health` 只留存活探测要的 `status`、`version`、`startedAt`、`uptime`（应用内更新靠 `version` 与 `startedAt` 认新进程），B 站的格子删掉。卡片的界面第 4 期先出设计稿再重做。
13. **拓展页一个拓展一张卡，不按口分节**（2026-10-01 主人拍板）：卡上用小标签写它开了哪几口（推送 · 订阅 · ……），页头一排按口筛选；卡上按口才有的那几行（推送那口的「N 条连接」）开了哪口画哪行。取代设计稿 V1 的「按口子分两节」。
    - 理由：`contributes` 按口声明，一个拓展可以开好几口。按口分节的话，开两口的拓展在两节各出一张卡、两个开关，装好后的「传送」只落在第一张上；1.0 起口子还会多（`devtools`，以后可能有 `linkResolver`、`commands`、`aiTools`），分节越分越多、重复越来越多。按拓展列，以后加口只是多一种标签、多一个筛选。
    - 被否的备选：保留分节、两口都开的单放一节（口一多就说不清该放哪）；按「主要的那一口」归节（清单要多写一格，哪口算主要说不清）。

## 取代与修订的旧条款

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0019 决策 36「设置读不了，拓展不起」 | 保留并延伸到内置集成；运行中的 `get()` 不抛 | 4 |
| ADR-0019 决策 60「拓展详情页的『上报问题』框」 | 改名 `reportRejections`，与来源自报的问题分开 | 10 |
| ADR-0021 决策 7「`health()` 交状态行」 | 细化：只交一行字 | 12 |
| ADR-0021 决策 16、47「问题表存在订阅运行态里」 | 修订：问题表全在内存 | 11 |
| ADR-0021 决策 22「`fetchImage` 交回 `ImageRef`」 | 修订：返回结果形状，走集成自己的客户端，逐跳查重定向 | 8、10 |
| ADR-0021 决策 38「契约 v3 的 ctx 清单」 | 修订：加 `http`、`settings`；上报改 `void` | 1、6、10 |
| ADR-0021 决策 40「`ctx.secrets` 存在 `secrets/<来源>/`」 | 修订：与 `state` 同一个接口，一个集成一个文件 | 9 |
| ADR-0021 决策 42「`core`、`bilibili` 段校验不过 BN 起不来」 | 推翻：只停那一处，`core` 逐格退默认 | 4 |
| ADR-0021 决策 48「健康页与 status 指令按来源列」 | 细化：健康卡分核心与集成两排 | 12 |
| ADR-0022 决策 8「订阅运行态留资料缓存与问题表」「内置来源只会有 B 站一个」 | 修订：问题表不存盘；内置集成还有三个平台适配器 | 9、11 |
| 拷问中途：问题表分两级 | 修订：一种形状，全在内存 | 11 |

## 明确不做

- **保留自定义 UA，或按它推算 `sec-ch-ua`**：原因见决策 7。
- **问题表存盘，或按「来源本身 / 订阅」分两级、按「核心 / 集成 / 订阅 / 连接」四种对象各有存法**：原因见决策 11。
- **`core` 段一格坏就起不来，或整段退回默认**：前者会触发自愈退版本，后者一格坏就丢掉全部设置。
- **上报被拒时把结果回给来源**：原因见决策 10。
- **BN 自己的请求也走集成的客户端**：客户端带着集成的身份与 cookie，BN 自己的请求不该冒用。

## 后果

- 重启后的头几秒，订阅卡上的问题红字会先消失，等来源重报。
- cookie 里不机密的值（比如登录账号的 uid）也会在日志里被遮掉。
- `core` 某格退回默认时行为会变（过滤、静音、新手引导），靠问题框亮出来。
- 契约 v3 再多一处不兼容：上报从 reject 改成 `void`。
