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

    🔗 **2026-10-03 ⑭ 开片拷问定**（一次一题，勘察见 construction-plan「⑭ 开片」）：
    - **对外面做成通用底座**：一个 `client.fetch(url, options)`，回 `HttpResponse`（状态码、响应头、原始字节，要文本或 JSON 时现转）；接中止信号；重定向逐跳交给调用方检查；非 2xx 不抛，由调用方判；网络断与超时照 ADR-0026 回结果形状（`timeout` / `unavailable`），不抛错。B 站今天的「非 2xx 就抛、自动解析 JSON、只取第一跳」与 -101 探测钩子挪进 B 站那层的薄包，B 站行为不变。被否：原样搬、到 ⑯ 再加宽（同一个对外面设计两次，第一次的要返工）。
    - **名字**：`HttpClient` / `HttpClientOptions` / `HttpResponse`，方法叫 `fetch`（naming「走网络取数用 `fetch…`」）；cookie 罐 `CookieJar`（不叫 `CookieStore`：`Store` 只指存盘的仓库）；一条 cookie 的数据形状 `Cookie`（原 `BACookie`）；`BrowserIdentity` 不改。词表加了这三个概念。
    - **身份这次不落盘**：`HttpClient` 收现成的身份；「生成」与「按版本区间只升不降」写成纯函数；B 站那层照旧每次启动生成一个，3a 有了 `state` 再接「读存的 → 升 → 写回」。被否：⑭ 临时找个地方存（塞进 cookie 那份加密文件要改格式、牵连备份，单开文件要加目录表项），到 3a 又搬一次。
    - **`websocket(url, { headers?, signal? })` 这次做出来、B 站弹幕切过去**：默认带身份的 UA 与这个地址该带的 cookie（罐子按域名、路径、过期筛），握手头和今天一致；`sec-ch-ua` / `Origin` 不加，要真机看过 B 站的反应再定。`signal` 先留着，3a 接上 `ctx.signal` 就是「集成停下自动关」。
    - **cookie 存盘时机照旧**（扫码成功、刷新那一整串跑完）；罐子加 `load()` / `clear()` 原地换，客户端从此是长期有效的同一个；罐子留「变了」的通知口，3a 接到 `secrets` 上才实现上面「由宿主自动存」那条。被否：现在就一变就存 —— 刷新那一串（探测、换票、刷新、确认）中间会落下半截状态，存储位置 3a 还要再搬。
    - **罐子先做不要依赖的规则**（RFC 6265）：IP 主机只认原样、`Domain` 必须匹配请求的主机。公共后缀（拒 `Domain=com` 这类）等 3a 把 `ctx.http` 开放给拓展时再做、到时评估依赖。眼下的限制：漏判时 cookie 只会在同一个集成自己连的几个站之间串，串不到别的集成。
    - **默认头**：包里只管身份那几个头与 cookie；`Origin` / `Referer` / `sec-fetch-*` / `priority` 是 B 站特有的，留在 B 站那层、构造客户端时交进去，核心不带任何平台的默认值。

    🔗 **2026-10-03 ⑭a 施工时定**：
    - **换号计数**：罐子每次 `load()` / `clear()` 计数加一（`CookieJar.epoch`），`fetch` 一进来就记下；回来时对不上，这份响应属于上一个会话，`Set-Cookie` 不收、响应照常交回。这是「客户端长期有效」的配套 —— 从前换号重建罐子，迟到的旧响应只会落进旧罐子。刷新链里每跨一次 await 都比对 gen（加密那两步之后、取 correspond 页之后原先缺着，从前旧链握着旧罐子不咬人，这次补上并有测试钉着），换号以后旧链不再发请求。
    - **头的顺序也是指纹**：发出去的头按「默认头、这次请求的头、调用方没写的身份头、`Cookie`」排，身份头是「没写才补，补在后面」；B 站那层把 UA 与 `sec-ch-ua` 三件按改造前的位置写全（`packages/api` 的 `bilibili-wire-headers.test.ts` 钉着）。🔗 10-03 ⑭c 之后更正：「改造前的位置」起初取的是 `initClient` 那张表（UA 第二），可改造前每次开机都会调一次 `setUserAgent`，旧 `setHeader` 先删再从末尾加回，生产上实际发的一直是 UA 排在默认头最后；⑭a 起照表发，等于悄悄改了生产的头序。主人定恢复成生产上那个顺序，测试的期望与来源注释一起改了。要不要往真浏览器的顺序靠，以后单独做、真机验过再定。
    - `FetchOptions`：`beforeHop` 每一跳（含第一次请求）发出之前都调，回失败即否决、原样交回；`maxRedirects` 跟满以后遇到的 3xx 原样回，不造失败码；`cookies: "send-only"` 只带不收（B 站「只取第一跳」用它，免得把短链站的 cookie 收进罐子）。被调用方的 `signal` 中止回 `indeterminate`（请求可能已经到了对端、结果不明，也正好「绝不自动重试」），中止原因是超时的算 `timeout`。`HttpResponse` 带 `isSuccess`（2xx），`json()` 回结果形状、不是 JSON 回 `invalid` 不抛。
    - B 站那层的薄包叫 `ApiClient`，保住今天的 `get` / `postForm` / `redirectLocation`：它们和 naming「走网络取数用 `fetch…`」不合，可七八个测试按这几个名字打桩，3a 把 B 站搬成 `bilibili/` 集成时一起改名。

    🔗 **2026-10-03 ⑭b 施工时定**：
    - `HttpClient#websocket(url, { headers?, signal? })` 回一个窄接口 `WebSocketLike`（不把 `ws` 的类型漏给下游）；建连只在 `packages/http/src/websocket.ts` 一处。握手头自成一套：`Cookie`（罐子里这个地址该带的；`wss:` 按 `https:`、`ws:` 按 `http:` 查）→ `User-Agent`（身份的）→ 调用方给的头；不带客户端的默认头，也不带 `sec-ch-ua` / `Origin`（真机待验）。和改造前弹幕的握手名序一致，有测试钉着。
    - 给错地址时 `websocket()` 同步抛错（和 `new WebSocket` 一样当 bug）；3a 把 `ctx.http` 开放给拓展时，拓展传坏地址不再是 BN 的 bug，到时再定要不要回结果形状。
    - B 站那层的口叫 `openDanmakuSocket`；`getCookiesHeader()`（整罐倒出）删掉；blive 的 `createSocket` 改成必填、只收地址，不再自己拼握手头，`ws` 依赖移出 blive，两个真机脚本也走同一个口。
    - cookie 按域名、路径、过期、`secure` 筛以后，比今天少带的只有挂在别的子域、或限定了路径的那几种，和真浏览器一致；弹幕连上能不能照常收消息，记进真机待验。
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
    - 🔗 **2026-10-03**（主人拍板）：面板顶栏问候语后面那一行不再显示任何一个来源的登录文字（今天它直读 B 站登录状态的文案，是 B 站替身），改读问题表：没问题只显示问候语，有问题显示一句「有 N 件事要主人看看」、点开是问题框。登录失效这类问题因此只在问题框、健康卡与私聊里各出现一次，不在顶栏再说一遍。样子随第 4 期健康卡与问题框的设计稿一起出。
    - 🔗 **2026-10-03**（主人拍板，起因是一次 B 站没登录，每开一次机主人就收到三条私聊：直播引擎「获取个人信息失败 code=-101」、「弹幕连接建立失败，已停止该房间监测」、动态引擎「账号未登录」，三条都是症状，真正该说的「登录失效，去扫码」一条没有 —— `auth-lost` 只在「登录着、掉线了」那一下发，开机时 cookie 就已失效不算掉线，动态引擎靠它闭嘴的那道也就没生效）：
      - **一个报告方内部按因果分层，同时只报最上面那一条开着的根问题，下面的只记日志。** B 站的层级：未登录（`auth_lost`）→ 风控（`risk_controlled`）→ 各项请求失败（拉动态、取个人信息、连弹幕、关注同步、刷资料……）。没登录时碰到的风控也算未登录的症状；登录着也会被风控（-352 的头号嫌疑是 TLS 指纹），那时风控才是自己的根问题。
      - **根问题按状态报，不按变化报**：开机时就没登录也要报；带 `notify`，文案写清该怎么办。清掉以后下一层的问题照常报，因它停掉的监听也拉起来。
      - **不同的报告方互不遮挡**：核心不排等级、判断不了谁是因谁是果，B 站的 `auth_lost` 不压拓展或核心的问题；和根问题无关的（比如填的 UID 不存在）也照常报。
      - 被否的备选：全局「按最大等级报」—— 会把别的报告方、以及与登录无关的问题一起压掉；只按 code 节流 —— 一个根因引出几个 code，照样一次收好几条。
      - 3a 搬 B 站时实现，测试钉两条：用失效的 cookie 开机，问题表一条、私聊一条；已登录时被风控，只报风控那一条。
      - **清掉时私聊「已恢复」，由核心统一发**（同日主人拍板）：只有当初真私聊过主人的那条（没被节流吞掉）清掉时，补一句「已恢复：<当初那条的文案>」，同样按报告方加 code 节流。风控这类自己恢复的，主人该知道它什么时候好了；主人亲手修好的，多一句确认也不吵；各来源不再自己写恢复私聊（今天动态引擎的「动态检测已恢复正常」随 3a 删掉）。
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
