# ADR-0024：推送侧中立 —— 内置平台与拓展实现同一个 `PlatformAdapter`

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）。**未施工**；归期见 [ADR-0021](0021-neutral-core.md) 决策 60。
- **记录方式**：拷问当场落的定案。类型、目录与迁移条目的正本在 [docs/1.0/](../1.0/) 的 push、data-model、data-and-migration；本份只写定了什么、为什么、否了什么。
- **影响面**：`packages/internal`（平台表与连接、目标 schema 搬出）、`packages/push`、`apps/server` 的 `platforms/` 与 `push/`、`apps/contract`、`apps/web` 的推送目标页、`extensions/bridge`。
- **依赖**：[ADR-0021](0021-neutral-core.md)（中立核心）、[ADR-0025](0025-integrations.md)（集成上下文与设置）、[ADR-0026](0026-failure-results.md)（失败规矩）。

## 背景

订阅侧已经是「B 站与拓展实现同一个 `SubscriptionSource`」，推送侧还是两套：OneBot、QQ 官方机器人、webhook 走核心里写死的闭集 `CONNECTION_PLATFORMS`，拓展走 `kind: "extension"` 那一支。三路只读审计又查出推送侧没有一道守卫：拿到登记表就能绕过 `TargetDispatcher` 直接发送，链接回复和发给主人的两条路不经派发器，核心还按平台名做决定。

## 决策

1. **内置平台与拓展走同一条路**：OneBot、QQ 官方机器人、webhook 也作为普通的平台适配器登记，与拓展提供的适配器是同一个接口、同一张登记表。`CONNECTION_PLATFORMS` 这个闭集删掉；各平台的设置 schema 与平台信息表搬出 `internal`，由适配器自带，面板经描述接口拿。
    - 理由：留内置、拓展两套，就永远有一套没被对拍到。
2. **名字用 `PlatformAdapter` 一套**（推翻 ADR-0023 决策 2 的 `PushOutlet`）：`PlatformAdapter` / `PlatformAdapterDef` / `PlatformAdapterHandle` / `PlatformAdapterRegistry`、`registerPlatformAdapter`、`PlatformAdapterContext`、`PlatformAdapterDescriptor`；连接上的键叫 `adapterKey`。`PlatformDescriptor`、`TargetDispatcher`、清单的 `contributes.push` 不变。目录仍叫 `platforms/`，其中的登记表与分发挪到 `push/`。
    - `PlatformAdapterDescriptor` 描述一个适配器（它的脸与设置字段），`PlatformDescriptor` 描述一个聊天平台（名字、目标形状、地址叫法）。
    - 三个内置适配器的键是 `onebot`、`qq-official`、`webhook`，和 `bilibili` 一样是保留 id（守卫 18），拓展占不了。
    - 理由：当初改名是怕 `platform` 一词两义，这个歧义已经由订阅侧的 `sourceLabel` 消掉；多家机器人框架都这么叫；改回来要动的地方最少。
3. **成员**：
    - 描述：`descriptor { label, shortLabel, color, icon, settingsFields }` 与 `settingsSchema`。
    - 必备：`start(ctx)` / `stop()`（取代 `reconcile` / `dispose`；登记即 `start`，晚登记的也收得到）、`send`、`isAvailable`、`probe`、`listConnectionCandidates(signal)`。
    - 可选：`capabilities` / `probeCapabilities`（新增 `atAll`、`inbound`，原先按平台名判断的改成问能力）、`listAddressCandidates(connection, signal)`、`connectionAuth`（与订阅侧同一个 `AuthState`，结果是一份连接草稿）。
4. **新建连接只有一条路：挑一个候选，再填字段**。`ConnectionCandidate = { name, platform: PlatformDescriptor, settings, selfId?, via?, boundConnectionId? }`。平台固定的适配器返回写死的模板候选（OneBot 一个、QQ 官方机器人一个、webhook 四个），模板可以反复用；桥返回在线的 bot。
    - 理由：一条路的面板与对拍都只写一遍。
5. **webhook 是一个适配器，飞书 / 钉钉 / 企业微信 / 通用是它的四个模板候选**。冻结的通用 webhook JSON 里 `private` 写死 `false`（主人目标不可能是 webhook）。
    - 理由：webhook 是「怎么连」，不是一个平台；拆成四个会占掉 `feishu` 等平台键，而拓展的一个适配器本来也要能对多个平台。
6. **`PlatformDescriptor = { platform, label, shortLabel, color, icon?, targetKind: "session" | "endpoint", scopes, addressNouns }`**：`tint` 统一改叫 `color`；`inbound`、`atAll` 从这里挪成运行期能力。
7. **连接的形状 `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot, probeState? }`**：`platform` 是开放字符串，只来自挑中的候选；`kind`、`connector`、`extensionId` 删掉（`extensionId` 并进 `adapterKey`）；`transport` 留作 OneBot 适配器私有的设置。`probeState` 是对象，三态取值在它的 `status` 里。
8. **连接上存 `platformSnapshot`（`PlatformDescriptor` 去掉 `platform` 那一格）**：
    - 只有宿主写：新建时照候选抄、列候选时按平台名刷新、迁移时填、备份里带回；POST / PATCH 带来的一律忽略。
    - 谁读：面板上连接的脸与目标编辑器、托管目标同步（看 `targetKind`）、目标的 scope 校验。推送层与适配器不读它。
    - 快照变了不许触发适配器重连。
    - 理由：适配器不在场（拓展停了、桥没连上）时，面板照样画得出已有的连接；「面板异步拿描述、拿不到怎么兜底」那一题因此不用答。
9. **目标上删掉 `platform`**，平台一律经 `connectionId` 从连接取（它早就只是一份拷贝）。
    - 补两道守卫：改 `connectionId` 时比新旧连接的平台；整节替换时校验连接身份没变。
    - 连接不在了的目标只隔离那一条；作用域键去掉平台前缀。
    - `PushTarget = { id, name, connectionId, enabled, kind: "session", scope, address, parentAddress?, reachability? } | { …, kind: "endpoint", managedBy: "connection", reachability? }`。
10. **连接设置的校验**：保存时适配器在场就按 `settingsSchema` 校验，不过回 400 并带原因；不在场先存下。读盘时逐条校验，不过的只隔离那一条（不交给适配器、不投递；面板显示「设置不合法」与原因，进问题框；盘上原文不动），BN 照常开机。只有外壳（id / name / adapterKey / platform）坏了才挡开机。撤下的旧形状写成明确的名单。
    - 「坏条目不许被悄悄吃掉」的初衷保留：隔离是显式的，面板与问题框都看得见。
11. **这一版不对拓展开放**：`listAddressCandidates`（alpha 之后桥帧改名时再考虑）、`connectionAuth`、描述里的条件显示与键值表字段。对拍逐成员核：要么走通，要么在「不开」名单里写明理由。
12. **内置适配器的入站也经 `ctx.inbound`**：宿主核归属、平台取自连接，不再由适配器自报。
13. **只有 `TargetDispatcher` 能发送**（出口咽喉）。它另开 `sendToAddress(connectionId, address, payload)`，给链接预览的回复与指令回复用：不进路由、不过闸、不落历史，但要查 `isAvailable`、结果带 code、由截流统一记，不重试。链接回复原先现造的临时目标删掉。
    - 🔗 10-09 施工时主人定：三个适配器都要知道对方是群还是私聊，光一个地址字符串不够，所以第二个参数收成 `SessionRef { scope, address }`，签名 `sendToAddress(connectionId, session, payload)`（被否：加第四个参数；群与私聊各开一个方法）。连接停用回 `not_configured`，不可达回 `unavailable`。截流闸从包适配器改成接在派发器调适配器的那一处，这样能碰 `send` 的文件只有派发器一个。适配器的发送口这时还吃整个目标，派发器内部临时拼一个，3a-20 改窄后删。
14. **发给主人**（细化 ADR-0021 决策 57）：`notifyMaster(payload: string | NotificationPayload)` 返回结果形状，审批预览卡也走它；发送时复检主人目标是私聊，不是就拒发（`invalid`）；PATCH 把主人目标改成群目标直接拒收。
15. **投递失败归核心**：
    - `reportPost` 保持 `void`，来源交完就前移自己的锚点；
    - 核心按目标逐个投递，只重试失败的那个：`rate_limited` / `unavailable` / `timeout` 退避重试，`indeterminate` 与其他码不重试；
    - 出卡或 AI 失败就降级（纯文字、不带点评），不整条重来；
    - 每个目标一行历史，失败带 code，可以手动补发。

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
