# ADR-0024：推送侧中立 —— 内置平台与拓展实现同一个 `PlatformAdapter`

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）。**3a / 3b 已落一部分**，现状见各决策下的 🔗；余下归第 4 期。
- **记录方式**：拷问当场落的定案。类型、目录与迁移条目的正本在 [docs/1.0/](../1.0/) 的 push、data-model、data-and-migration；本份只写定了什么、为什么、否了什么。
- **影响面**：`packages/internal`（平台表与连接、目标 schema 搬出）、`packages/push`、`apps/server` 的 `platforms/` 与 `push/`、`apps/contract`、`apps/web` 的推送目标页、`extensions/bridge`。
- **依赖**：[ADR-0021](0021-neutral-core.md)（中立核心）、[ADR-0025](0025-integrations.md)（集成上下文与设置）、[ADR-0026](0026-failure-results.md)（失败规矩）。

## 背景

订阅侧已经是「B 站与拓展实现同一个 `SubscriptionSource`」，推送侧还是两套：OneBot、QQ 官方机器人、webhook 走核心里写死的闭集 `CONNECTION_PLATFORMS`，拓展走 `kind: "extension"` 那一支。三路只读审计又查出推送侧没有一道守卫：拿到登记表就能绕过 `TargetDispatcher` 直接发送，链接回复和发给主人的两条路不经派发器，核心还按平台名做决定。

## 决策

1. **内置平台与拓展走同一条路**：OneBot、QQ 官方机器人、webhook 也作为普通的平台适配器登记，与拓展提供的适配器是同一个接口、同一张登记表。`CONNECTION_PLATFORMS` 这个闭集删掉；各平台的设置 schema 与平台信息表搬出 `internal`，由适配器自带，面板经描述接口拿。
    - 🔗 10-10 主人定（3a-22-2）：「闭集删掉、设置 schema 与平台信息表搬出 `internal`」这半句**留到第 4 期面板按描述画之后**一次做。面板的手写表单靠三份规则推出的类型编译、平台选择器靠平台表，现在搬走面板只能手抄一份，与「不手抄冻结类型」相冲。在那之前：三份规则原地改名 `…ConnectionSettingsSchema`，内置适配器的 `settingsSchema` 指向它们、候选从平台表现取；平台表的 `tint` 已改 `color`，「走哪种连法」一列换成 `adapterKey`；服务端只剩两处在读平台表：内置适配器取候选、webhook 适配器认平台名。
    - 🔗 10-11（3a-28）：`compose.ts` 提前到 3a-28 建（见 ADR-0021 决策 2 下的 🔗），但这一片它只登记 B 站来源与 B 站的开发场景；三个内置适配器仍由入口造、经 `registerBuiltinAdapters` 登记，挪进 `compose.ts` 归 3a-40（推送守卫① 同片收口）。
    - 🔗 10-11（3a-40 第一块）：三个内置适配器已挪进 `compose.ts`（构造在 `composeBuiltinIntegrations` 被调时、登记与启动在 `registerAdapters`），推送守卫① 已开张（`scripts/__tests__/import-boundaries.test.mjs`：核心不许 import `platforms/`，例外只有 `compose.ts`）。
    - 🔗 2026-10-28（4-13）：「设置 schema 与平台信息表由适配器自带，面板经描述接口拿」里描述接口那一半已落：`PlatformAdapter.descriptor()`、`GET /api/adapters`（形状见决策 3 下同日的 🔗）。闭集与平台表、三份规则搬出 `internal` 仍归 4-30。
    - 理由：留内置、拓展两套，就永远有一套没被对拍到。
2. **名字用 `PlatformAdapter` 一套**（推翻 ADR-0023 决策 2 的 `PushOutlet`）：`PlatformAdapter` / `PlatformAdapterDef` / `PlatformAdapterHandle` / `PlatformAdapterRegistry`、`registerPlatformAdapter`、`PlatformAdapterContext`、`PlatformAdapterDescriptor`；连接上的键叫 `adapterKey`。`PlatformDescriptor`、`TargetDispatcher`、清单的 `contributes.push` 不变。目录仍叫 `platforms/`，其中的登记表与分发挪到 `push/`。
    - 🔗 10-09（3a-20b-1）：`Connector` / `PlatformDialect` 两半没有单独的消费者，不改名，直接平铺进 `PlatformAdapter` 后删掉。适配器上的登记键也叫 `adapterKey`（内置三个是 `onebot` / `qq-official` / `webhook`）；连接上落这一格之前，「连接归谁管」由 `connectionDispatchKey` 现算。
    - 🔗 10-09（3a-20b-2）：`start(ctx)` / `stop()` 已落，登记即启动、注销即停止。`PlatformAdapterContext` 这一片有的成员：集成上下文的 `logger` / `signal` / `onDispose`，加 `connections()`（归这个适配器的连接，现读）与 `onConnectionsChanged(fn)` —— 主人定的形状，与拓展推送源把手同形（被否：宿主替适配器逐条连接起停）。`inbound` 还没进上下文。3b 写拓展契约文档时要讲清：每次发送连接都会递到手上，只调 HTTP 接口的适配器不用管连接名单，维持长连接的才需要对账。
    - 🔗 现状（3b-46，10-25）：拓展契约文档已按这句写了「连接名单要不要管」一小节，样板摘自假源拓展的假适配器；`scripts/__tests__/contract-samples.test.mjs` 守卫钉住文档样板与源码一字不差。
    - `PlatformAdapterDescriptor` 描述一个适配器（它的脸与设置字段），`PlatformDescriptor` 描述一个聊天平台（名字、目标形状、地址叫法）。
    - 三个内置适配器的键是 `onebot`、`qq-official`、`webhook`，和 `bilibili` 一样是保留 id（守卫 18），拓展占不了。
    - 理由：当初改名是怕 `platform` 一词两义，这个歧义已经由订阅侧的 `sourceLabel` 消掉；多家机器人框架都这么叫；改回来要动的地方最少。
3. **成员**：
    - 描述：`descriptor { label, shortLabel, color, icon, settingsFields }` 与 `settingsSchema`。
    - 必备：`start(ctx)` / `stop()`（取代 `reconcile` / `dispose`；登记即 `start`，晚登记的也收得到）、`send`、`isAvailable`、`probe`、`listConnectionCandidates(signal)`。
    - 可选：`capabilities` / `probeCapabilities`（新增 `atAll`、`inbound`，原先按平台名判断的改成问能力）、`listAddressCandidates(connection, signal)`、`connectionAuth`（与订阅侧同一个 `AuthState`，结果是一份连接草稿）。
    - 🔗 10-10（3a-22-3）主人定：`listAddressCandidates` 的签名多一个参数，`(connection, scope, signal)`，只查那一种会话 —— QQ 的群 / 私聊是内存里现成的、频道要现去平台拉，不带参数就得每次全拉。返回一排平的 `{ address, name?, parentAddress?, parentName? }`，失败走结果形状；读口 `GET /api/connections/:id/addresses?scope=`。`/api/adapters`（各适配器描述的列表）归第 4 期、新建连接候选的读口归 3b，3a 里不建。
    - 🔗 10-11（3a-29，主人定）：修订上一条 🔗 里「`/api/adapters`……3a 里不建」的前半：只有各适配器描述的列表归第 4 期；`/api/adapters` 这个前缀由 `connectionAuth` 的三个口在 3a-29 先建（路径与方法见 ADR-0036 决策 5 下的 🔗）。新建连接候选的读口仍归 3b。
    - 🔗 10-11（3a-29 QQ 半，主人定）：「结果是一份连接草稿」落成 `connectionAuth` 的三个方法 —— `begin(signal)`（发起，回任务号、此刻的状态、建议的问询间隔秒数）、`state(taskId, signal)`（读状态）、`takeDraft(taskId)`（取走草稿）。回包是「状态 + 草稿」两格，分开给：`AuthState` 的 `logged-in` 不加结果格，密钥不混进会被反复读的状态里；草稿只在取的那一下出现，取走即清（成功取走一次，之后这个任务号找不到）。草稿是适配器这次认证拿到的、归它自己 `settingsSchema` 管的那几格 `settings`（QQ 是 `appId` 与 `appSecret`），面板并进表单后由主人点保存，走现有的 `POST /api/connections`。任务表归适配器、任务号由适配器自己发，路由不持有状态。读状态的 GET 被读时由适配器去问一次上游（QQ：问到成功就把草稿收进任务表、之后不再问）；「无副作用」指对调用方反复读结果一样、不清草稿、回包不带草稿，没人开着弹窗就没有发往上游的请求。二维码在状态里直接带图片数据（`qr: { dataUrl, expiresAt }`），不走图库引用（见 `docs/1.0/subscription-sources.md`）。草稿不单起类型名，形状直接写在 `takeDraft` 的返回值与回应类型里。被否：两个都 POST；查结果用会清草稿的 GET；服务端自己定时去问上游；给 `AuthState` 的 `logged-in` 加可选的结果格。
    - 🔗 10-11（3a-29，主人定）：`connectionAuth` 不发 `expired`，二维码过期报 `error` 并带一句话（QQ：「二维码已过期，请重新生成」）。起因：`AuthState` 的 `expired` 改成只指「已经登着的登录失效了、要重新登录」（见 ADR-0021 决策 45 下的 🔗），而建连接没有「已经登着的登录」，码过期只是这一次没办成。`AuthState` 的 `scanned` 同时换成 `confirming`，QQ 没有「已扫、等确认」，也不发它，所以 QQ 实际只发 `awaiting-scan` / `logged-in` / `error` 三种。被否：两边各说各的；两件事都报 `expired` 靠 `message` 分。
    - 🔗 2026-10-14（契约第 3 版，主人定）：**适配器自己的「脸」这一期不造**。第 3 版契约里适配器不带 `descriptor` 那一格：拓展的描述以清单为准、由宿主填；内置的随第 4 期（面板改成按适配器的描述画）。
    - 🔗 2026-10-28（4-13，主人照拟稿批）：**描述写成必备方法 `descriptor()`**，不写字段：名字是给人看的字，要在出字那一刻按当前语言取（ADR-0037 决策 1），登记表的视图只拷一次数据成员、字段会冻住（与 `Source.descriptor` 是字段不对称，B 站来源收字时照这个改）。内置三个的脸：OneBot「OneBot v11 / OneBot / #3b82f6」、QQ 官方「QQ 官方机器人 / QQ官方 / #14b8a6」（同平台表那两行），webhook「Webhook / Webhook / #94a3b8」（一个适配器管四个平台，新写）；都不带 `icon`（描述的图标格是图片 data URL，内置图标今天是面板按平台名画的，平台表 4-30 才搬）。**内置三个的 `settingsFields` 先是空表，随 4-29 和表单一起设计**（主人选甲）：三份规则没写字段说明、OneBot 按连法分三支要条件显示、请求头是键值表、webhook 地址的占位按平台换，今天的设置项都表达不了，怎么表达看表单怎么画。拓展的由宿主照清单填、每次读按当前语言盖好译文，拓展自己交的照旧拒（对拍表 `descriptor` 一行记「不开」，同 `Source.descriptor`）。读口 `GET /api/adapters` 回 `{ adapters: [{ key, descriptor }] }`，照 `/api/sources`：内置取登记表、拓展取装载器那份清单（停着、没起来的也列），等装载器头一轮扫完再答；不带 `has`（扫码、列地址），4-29 读的时候再加。内置适配器报问题时的写者名（私聊引子「刚刚 xxx 报告」）从适配器键换成描述的全名。
    - 🔗 2026-10-14（3b-52，主会话照规矩定）：**OneBot 小程序卡能力的重探收到宿主**。重探的节奏（今天适配器自己 60 秒节流）与「探不出来不推翻已探实的答案」那条规矩由宿主管，契约不加成员；与连接通断同一片做。
    - 🔗 2026-10-17（3b-52 落成）：派发器记每格最后探实的答案并按连接节流 60 秒；OneBot 删了自己的节流、「不推翻」与全部自发探测（通道就绪、HTTP 对账）。主人定：能力只靠宿主那一轮与链接预览按需探，连上后最多一分钟面板才有结果。
4. **新建连接只有一条路：挑一个候选，再填字段**。`ConnectionCandidate = { name, platform: PlatformDescriptor, settings, selfId?, via?, boundConnectionId? }`。平台固定的适配器返回写死的模板候选（OneBot 一个、QQ 官方机器人一个、webhook 四个），模板可以反复用；桥返回在线的 bot。
    - 理由：一条路的面板与对拍都只写一遍。
    - 🔗 2026-10-14（契约第 3 版，主人定）：**候选里的完整平台描述由契约的门给一个造中性描述的函数**。函数住零依赖的子路径，桥用它填、再盖上自己知道的图标；候选的形状与核心同一份。
    - 🔗 2026-10-14（契约第 3 版，主会话照规矩定）：**连接候选的读口**挂在现成的 `/api/adapters/:adapterKey/` 前缀下，内置与拓展同一个口（兑现上面 3a-29 那条「新建连接候选的读口仍归 3b」）；面板读的旧口 `/api/ext/:id/bots` 在同一个提交里删掉。
5. **webhook 是一个适配器，飞书 / 钉钉 / 企业微信 / 通用是它的四个模板候选**。冻结的通用 webhook JSON 里 `private` 写死 `false`（主人目标不可能是 webhook）。
    - 理由：webhook 是「怎么连」，不是一个平台；拆成四个会占掉 `feishu` 等平台键，而拓展的一个适配器本来也要能对多个平台。
6. **`PlatformDescriptor = { platform, label, shortLabel, color, icon?, targetKind: "session" | "endpoint", scopes, addressNouns }`**：`tint` 统一改叫 `color`；`inbound`、`atAll` 从这里挪成运行期能力。
    - 🔗 10-09（3a-22-1）：`atAll`、`inbound` 已成每条连接的运行期能力（三态，适配器回答）。「还不知道」时三处各按原来的做法（主人定）：单发 @全体照发、锐评审批不让开、链接解析设置照列；判断只有一份（`shouldSendAtAll` / `canReceiveReply` / `listsForLinkParsing`），服务端与面板共用。`GET /api/connections/capabilities` 收成一级并含拓展连接。
7. **连接的形状 `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot, probeState? }`**：`platform` 是开放字符串，只来自挑中的候选；`kind`、`connector`、`extensionId` 删掉（`extensionId` 并进 `adapterKey`）；`transport` 留作 OneBot 适配器私有的设置。`probeState` 是对象，三态取值在它的 `status` 里。
    - 🔗 10-10（3a-22-2）已落：形状照此；迁移修订号 40、备份版本 13。迁移自带冻结的 0.x 平台表，直连连接照它填 `adapterKey` 与快照，拓展连接的 `adapterKey` 取原 `extensionId`、快照填认不出的平台用的中性占位（等 22-3 桥列候选时刷新）。
    - 🔗 2026-10-14（3b-52，主人定）：**探测与连接状态改成宿主「拉」**。宿主每分钟调现成的 `probe`（原来 5 分钟），连续两次探不通算断，契约不加成员；`probeState` **只在状态变了才写盘**（今天每轮都写连接文件并广播）。私聊与清的规矩全在宿主，适配器不报通断（见 ADR-0025 决策 11 下的 🔗）。10-13 晚定的「OneBot 补 WS 看门狗」撤掉。
    - 🔗 2026-10-17（3b-52 落成）：探测住 `push/connection-probe-engine.ts`，每条连接并行探、单次限时 30 秒；`probeState` 只在状态变了才写，手动「测试」每次都写。
8. **连接上存 `platformSnapshot`（`PlatformDescriptor` 去掉 `platform` 那一格）**：
    - 只有宿主写：新建时照候选抄、列候选时按平台名刷新、迁移时填、备份里带回；POST / PATCH 带来的一律忽略。
    - 谁读：面板上连接的脸与目标编辑器、托管目标同步（看 `targetKind`）、目标的 scope 校验。推送层与适配器不读它。
    - 快照变了不许触发适配器重连。
    - 理由：适配器不在场（拓展停了、桥没连上）时，面板照样画得出已有的连接；「面板异步拿描述、拿不到怎么兜底」那一题因此不用答。
9. **目标上删掉 `platform`**，平台一律经 `connectionId` 从连接取（它早就只是一份拷贝）。
    - 补两道守卫：改 `connectionId` 时比新旧连接的平台；整节替换时校验连接身份没变。
    - 连接不在了的目标只隔离那一条；作用域键去掉平台前缀。
    - 🔗 10-09（3a-21）已落：两格都删了，迁移修订号 39、备份版本 12。推送路由不再读平台，改问派发器的 `supportsAtAll(targetId)`（主人定；3a-22 改问适配器能力时只换它里面的实现）。「改 `connectionId` 时比新旧连接的平台」在旧连接已经不在时放行（正常操作造不出悬空目标，这条路留给手动修数据）。「整节替换」那道守卫落成三种：只换连接则有目标挂着的连接平台不能变，只换目标则同 id 改挂按前一条判，两节一起换不比。`reachability`（`testStatus` 改名）这一片没做。
    - 🔗 10-09 主人改定：**目标建好之后焊死在它那条连接上**，`connectionId` 不许改 —— 上面「改 `connectionId` 时比新旧连接的平台」那道守卫因此不需要了（换机器人改连接自己的参数；面板编辑目标时能换连接是新建与编辑共用一个弹窗带出来的缺陷）。「整节替换时校验连接身份没变」落成一条统一的规矩：替换前后都在的同 id 目标，连接不许变，它那条连接的种类与平台也不许变。上一条 🔗 里讲改挂的两句作废。
    - 🔗 2026-10-12（3a-41）`.platform` 决定棘轮已开（`scripts/__tests__/platform-decisions.test.mjs`）：**两个平台值比相等（`a.platform !== b.platform` 这一类）不算「按平台名做决定」**，正是本条决策要求的那种比较 —— 它问的是「是不是同一个身份」，两边都不是某个具体平台的名字，写不出「如果是 QQ 就……」；`config/store.ts` 里「连接的平台不能改」那几对比较因此不进棘轮表（把它们记进一道要清零的表，等于让守卫与定案打架）。这是对「核心读 `.platform` 只许构造身份、显示、记日志」那句话的一种读法，主会话照方案定，主人可否决。扫面板、面板另记一张表（主人 10-12 定）。
    - `PushTarget = { id, name, connectionId, enabled, kind: "session", scope, address, parentAddress?, reachability? } | { …, kind: "endpoint", managedBy: "connection", reachability? }`。
10. **连接设置的校验**：保存时适配器在场就按 `settingsSchema` 校验，不过回 400 并带原因；不在场先存下。读盘时逐条校验，不过的只隔离那一条（不交给适配器、不投递；面板显示「设置不合法」与原因，进问题框；盘上原文不动），BN 照常开机。只有外壳（id / name / adapterKey / platform）坏了才挡开机。撤下的旧形状写成明确的名单。
    - 🔗 10-10（3a-22-2）已落，施工时定的几处：「不过的只隔离那一条」不存标记、每次用时按在场的适配器现算；PATCH 只在补丁带了 `settings` 时才验（被隔离的连接照样能改名、能停用）；恢复备份不验 `settings`，进来后不合法的照读盘隔离；新建连接要适配器在场；`platformSnapshot` / `probeState` 是宿主独写，客户端带来的一律忽略、盘上坏了不挡开机。
    - 「坏条目不许被悄悄吃掉」的初衷保留：隔离是显式的，面板与问题框都看得见。
    - 🔗 2026-10-14（3b-52，主人定）：**连接设置不合法由宿主报**，进问题表、不私聊，记在那条连接所属适配器的名下；只隔离那一条（本条原文，规范 `settings-validation.md` 第 5 条本来就这么写）。
    - 🔗 2026-10-17（3b-52 落成）：问题码 `connection_settings_invalid`；每轮探测前与每次连接变更时记账，连接变更时不探测。
11. **这一版不对拓展开放**：`listAddressCandidates`（alpha 之后桥帧改名时再考虑）、`connectionAuth`、描述里的条件显示与键值表字段。对拍逐成员核：要么走通，要么在「不开」名单里写明理由。
    - 🔗 10-11（3a-29，主人定）：这一版仍不对拓展开放，**运行时也照这个来**：宿主登记拓展适配器时把 `listAddressCandidates` 与 `connectionAuth` 摘掉再登记，带了也不认（有测试钉着）；此前只在类型上排除，用 JS 写的、或绕过类型的拓展带了这两个成员就是活的。主人认为这两个成员对桥有用（挑群、扫码建连接）；开放要连同拓展契约、桥协议与仓外两个桥插件一起设计，留到 alpha 之后改桥协议时一次做。被否：现在就开放（单独成片）；运行时不管、只在类型上排除。
    - 🔗 现状（3b-46，10-25）：推送守卫③已落在 `apps/server/src/__tests__/extension-contract-parity-e2e.test.ts`；`listAddressCandidates` / `connectionAuth` 两行按本决策记「不开」，运行时剥离由 `apps/server/src/extensions/__tests__/context-grants.test.ts` 钉着。
12. **内置适配器的入站也经 `ctx.inbound`**：宿主核归属、平台取自连接，不再由适配器自报。
    - 🔗 2026-10-16（3b-40，停下之后的那一条主人定，形状主会话照规矩定）：**已落**。适配器交入站时 meta 只带 `connectionId`，宿主补上平台再交下一层；核归属与关于连接的问题上报共用一个判法（按原始连接表看 `adapterKey`）。适配器停下之后再交来的入站丢掉并记一行，与上下文里别的口子停下之后一律拒绝一致 —— 宿主拦不住适配器自己的代码去调，只能在门口拒收。
13. **只有 `TargetDispatcher` 能发送**（出口咽喉）。它另开 `sendToAddress(connectionId, address, payload)`，给链接预览的回复与指令回复用：不进路由、不过闸、不落历史，但要查 `isAvailable`、结果带 code、由截流统一记，不重试。链接回复原先现造的临时目标删掉。
    - 🔗 10-09 施工时主人定：三个适配器都要知道对方是群还是私聊，光一个地址字符串不够，所以第二个参数收成 `SessionRef { scope, address }`，签名 `sendToAddress(connectionId, session, payload)`（被否：加第四个参数；群与私聊各开一个方法）。连接停用回 `not_configured`，不可达回 `unavailable`。截流闸从包适配器改成接在派发器调适配器的那一处，这样能碰 `send` 的文件只有派发器一个。适配器的发送口这时还吃整个目标，派发器内部临时拼一个，3a-20 改窄后删。
    - 🔗 10-09（3a-20a）适配器的发送口改窄了：`send` / `isAvailable` 只收 `DestinationRef`，按去向分两支 —— 会话那支是 `SessionRef { scope, address, parentAddress? }`，端点那支是 `EndpointRef { id, name, scope }`（webhook 写进冻结 JSON 的三格），都从 `PushTarget` 上取。连接与目标的开关、目标与连接的平台对不对得上，只在派发器查一份，适配器不再各查一遍；派发器里临时拼的那个目标删了；截流回调拿到的是去向，外加经目标表发送时的那条目标。
14. **发给主人**（细化 ADR-0021 决策 57）：`notifyMaster(payload: string | NotificationPayload)` 返回结果形状，审批预览卡也走它；发送时复检主人目标是私聊，不是就拒发（`invalid`）；PATCH 把主人目标改成群目标直接拒收。
15. **投递失败归核心**：
    - `reportPost` 保持 `void`，来源交完就前移自己的锚点；
    - 核心按目标逐个投递，只重试失败的那个：`rate_limited` / `unavailable` / `timeout` 退避重试，`indeterminate` 与其他码不重试；
    - 出卡或 AI 失败就降级（纯文字、不带点评），不整条重来；
    - 每个目标一行历史，失败带 code，可以手动补发。
    🔗 **2026-10-10**（3a-27 之后的现状）：「核心按失败种类重试」仍**没有做、没有排期**，与 3a-27 无关：作品入口 `PostQueue` 不重试，装配途中的意外抛错只记错误日志；推送层按目标的退避重试（发送层 `sendToTarget`）是另一件事、早就在。引擎交完就前移时间线这一条已落（见 ADR-0019 决策 66 下同日的 🔗）。

## 取代与修订的旧条款

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0011 决策 1「连接与目标各长一根 `kind` 轴」、决策 3「`connection.platform` 闭集、`target.platform` 开放」、决策 5「webhook 的 provider 升格成 platform」、决策 7「分发键 `connectionDispatchKey`」 | 推翻：连接的 `kind` 删掉；`platform` 开放、只来自候选；目标不再存 `platform`；webhook 是一个适配器、四个模板候选；分发按 `adapterKey` | 1、4、5、7、9 |
| ADR-0011 决策 11、14 下 09-27 挂的 🔗「平台那一层改叫 `PushOutlet`」 | 作废：平台那一层仍叫 `PlatformAdapter`；决策 14 里适配器内部拆出的两半（`Connector` + `PlatformDialect`）的名字仍施工时定 | 2 |
| 连接上的顶层 `connector` 字段（内置直连的连法） | 删掉：`transport` 是 OneBot 适配器私有的设置 | 7 |
| ADR-0012 决策 7「推送侧不造新词，`PushExtensionDef` 装适配器 + 描述 + config 字段表」 | 修订：交的是 `PlatformAdapterDef`（适配器 + 描述 + `settingsSchema`），内置与拓展同一个 | 1–3 |
| ADR-0012 决策 45「拓展连接走 `kind: "extension"` 那一支」 | 修订：`kind` 删掉；「一条连接就是一个 bot、接入是拓展自己的设置」不变；平台来自候选 | 4、7 |
| ADR-0019 决策 16「静态声明全住清单」 | 修订：推送侧的平台列表改由运行期的候选给 | 4 |
| ADR-0021 决策 8 里的 `PushOutlet` | 改回 `PlatformAdapter` | 2 |
| ADR-0021 决策 57「`notifyMaster(text)`」 | 修订：收文字或消息体，返回结果形状 | 14 |
| ADR-0023 决策 2「推送侧叫 `PushOutlet`」 | 推翻：改回 `PlatformAdapter` 一套 | 2 |
| 拷问中途：推送侧内置与拓展「严 / 宽」两套 | 作废：同一个接口 | 1 |
| 拷问中途：`PushOutlet` 成员里的 `configSchema` / `configFields` / `outletKey` | 修订：`settings` 一族（ADR-0025 决策 2）、`adapterKey` | 2、3 |
| 拷问中途：描述里的 `platforms?` 与候选二选一 | 删掉：只有候选一条路 | 4 |

## 明确不做

- **推送侧内置与拓展各一套接口**：原因见决策 1。
- **新建连接两条路并存**（适配器声明平台列表、候选可选），或**宿主维护平台表、由适配器上报**：原因见决策 4。
- **webhook 拆成四个适配器**：原因见决策 5。
- **目标上保留 `platform`**：它只是连接平台的拷贝，两处一改就漂。
- **BN 侧替适配器限流、去重**：维持 ADR-0019 决策 53 的精神，投递重试只在核心按目标做（决策 15）。

## 后果

- 新建连接要适配器在跑；清单里的静态数据拿不到平台列表。
- 推送进行到一半进程崩了，这一条可能漏掉（最多一次）。
- 约 50 个非测试文件、78 个测试文件要动（勘察时量的），面板的连接与目标表单改由描述驱动。

## 仍未决

- **存盘的待发队列**：补上决策 15 认下的「推送途中崩掉会漏」。
- **`listAddressCandidates`、`connectionAuth` 对拓展开放**：alpha 之后桥帧改名时一起看。

🔗 2026-11-01（4-29）：面板连接 / 目标表单改读描述与候选。

- `GET /api/adapters` 交 `{ key, descriptor, has }`，`has.connectionAuth` / `has.listAddressCandidates` 取实际方法；本版拓展两项仍为 false。内置字段经自己的设置 schema 导出，`ConnectionSettingsField` 增加条件 `when`、记录表 `record`、分支草稿 `variants`、候选平台提示 `byPlatform`、监听地址提示 `listener`；普通拓展清单仍只开放原有标量字段，形状钉住不跟着扩张。
- 分支草稿由 schema 默认值与分支元数据生成，声明可保留的共用字段，传输切换不丢既有凭据；名称与字段说明在出字时从包字典取。授权说明 `auth.description / warning / experimental` 属于适配器描述；QQ 扫码草稿同时交 `botType: public` / `sandbox: false`，面板只合并草稿，不认这些平台私有键。
- 新建连接统一先选适配器、再读候选；仅一个未绑定候选时自动选中，多个候选由用户选。面板工厂只复制候选，不再持有内置默认值。编辑时保留平台身份；字段和凭据标记来自描述，作用域与地址称呼来自连接快照。描述未返回时不展开凭据表单。`ExtensionDTO.push` 已删除，徽章改读适配器描述与连接快照；候选自己的图标直接按候选描述画。图片仍须经过面板的安全 data URL 判据。
- 列候选成功后，配置仓按同一 `adapterKey + platform` 刷新已有连接快照；不匹配的不变，快照相同不写盘、不广播。只更新快照，不触碰设置、身份或运行状态；适配器按设置指纹判断重连，快照更新不会触发重连。
- 守卫按主人批准精确登记五个完整展示表达式（每个恰好一次）；面板旧五文件 29 处业务棘轮清空。三份规则暂留 internal，平台词计数 32→49，随 4-30 一起搬出；核心旧平台表三处也留 4-30。迁移修订号 53、备份版本 23 不变。
