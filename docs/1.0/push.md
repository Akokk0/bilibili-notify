# 1.0 推送链路

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023 与 ADR-0024 ～ 0031（推送侧见 0024，集成与问题表见 0025，失败规矩见 0026，链接预览见 0029，指令见 0031）。

一条推送从来源交东西，到落进历史，要过六段。这份是 1.0 的那张图与各段的边界，文末列出与现行 `docs/agents/push.md` 的差异。数据形状见 [data-model.md](./data-model.md)；来源怎么交东西见 [subscription-sources.md](./subscription-sources.md)；拓展怎么提供平台适配器见 [extension-contract.md](./extension-contract.md)。

## 一句话

**来源只交中立数据，装配只出消息，路由只认订阅 id，投递只认连接。** 四段各切各的，谁都不许越界。B 站与拓展从第二段起走完全同一条链。

推送那头同理：OneBot、QQ 官方机器人、webhook 与拓展借来的 bot 实现同一个 `PlatformAdapter`，进同一张登记表；真正往外发只有 `TargetDispatcher` 一个口。

## 六段

| 段 | 住哪 | 干什么 |
| --- | --- | --- |
| ① 来源 | 服务端 `bilibili/`；拓展经 `extensions/` 收件口 | 把平台数据翻成 `PostReport` / `LiveSignalReport`，只带 externalId 上报（来源不知道订阅 id）；图先用 `ctx.fetchImage` / `ctx.storeImage` 存进图库，上报里只交 `ImageRef` |
| ② 装配 | 服务端 `posts/`（作品）、`live/`（直播与直播附加项） | 过滤 → 出卡 → AI 正文 → 套文案 → 按版式分组 → 交给发送 |
| ③ 路由与闸 | `packages/push` 的 `PushRouter` | 按订阅 id 查路由、过闸、选目标、收窄附加项、逐目标挑正文 |
| ④ 发送 | 同上 | 分条、按目标重试、@全体 分流 |
| ⑤ 投递 | 服务端 `push/` 的 `TargetDispatcher` → `platforms/` 里的 `PlatformAdapter` | 按目标所在的连接找适配器，真发出去；适配器登记表与分发在 `push/` |
| ⑥ 历史 | `history/` | 一行 = 一次推送 × 一个目标，失败带 code；存重推原件 |

### ① 来源

- 来源只管「和那个平台打交道」：拉数据或收上报、判新、翻成中立形状。判新、去重、限流归来源，BN 不兜底。
- B 站：拉动态翻成 `PostReport`，弹幕通道翻成 `LiveSignalReport`，按 uid（就是 externalId）经 `ctx.reportPost` / `ctx.reportLive` 上报。核心在进门那一刻按身份展开成每条订阅一份 `PostEvent` / `LiveSignal`，此后只见订阅 id（现在 `engines.ts` 里那层 `subscriptionIdOfUid` 适配消失）。
- 拓展：上报经宿主收件口核形状、毫秒换 ISO；图在上报之前已由拓展用 `ctx.fetchImage` / `ctx.storeImage` 存成 `ImageRef`。之后和 B 站一样由核心按身份展开。
- **交完就算完**：`reportPost` 保持 `void`（上报类都是，见 ADR-0025），来源交完就前移自己的锚点。投没投出去、失败了重不重试，归核心（见 ④），来源不知道。
- 直播「什么时候推」不在来源：核心的场次引擎决定开播、正在直播、下播、断流接续（见 [subscription-sources.md](./subscription-sources.md)「直播」）。

### ② 装配

中立装配住服务端，不开包，不认身份、不读平台原始数据。

| 步骤 | 规矩 |
| --- | --- |
| 过滤 | 第一步，对所有来源生效：`blockReposts` / `blockArticles` / `blockImages` / `blockVideos` 看 `Post` 上「有没有」；`allowKeywords` / `allowRegex` 与 `blockKeywords` / `blockRegex` 看文字。文字取自 `posts/` 里唯一的取段函数（过滤与 AI 看同一份字）。被过滤的作品在历史里留一行 `filtered`（一条订阅一行、带 `filteredBy`、只留痕不生产，ADR-0021 决策 34 的 🔗）；「屏蔽后提醒」那段走不到的代码 10-08 删掉（它从来没有设置项） |
| 出卡 | `packages/image` 的 `generatePostCard` / `generateLiveCard`，只吃中立形状、只内联图库引用、不联网。出卡失败就降级成纯文字 |
| AI 正文 | `packages/ai`。动态点评与直播总结都是「正文用 AI 写还是用模板写」，按目标选（`core.ai.writing`，ADR-0032）：模板正文总备好；默认开着或任一例外开着才生成 AI 正文；没配、AI 总开关关着或生成失败，全部用模板正文 |
| 套文案 | 全仓唯一的 `interpolate`（internal）；变量 `{name}`、`{postNoun}`、`{viewer}`、`{key}`，会员档名 `{tier}`（原 `{guard}`）、粉丝团名 `{fanclub}`（原 `{mdn}`） |
| 按版式分组 | internal 的版式分组，作品与直播共用一份；版式块：卡片、文字、链接（作品本身的地址）、正文链接、分条符。**正文链接**（09-27 拍板）：默认显示、默认跟在「链接」块后面同一条消息；把正文里 `kind: "link"` 的片段一个一行写成「显示文字 地址」，同一地址只列一次，没有就不占行；只认片段类型，不认来源（卡片上的链接点不了，靠它把地址带出去） |
| 交给发送 | 收成一个入口 `broadcast(subscriptionId, messages, feature)`（推送种类就是特性键，ADR-0023 决策 12）；`PushLike` 全仓一份 |

- **装配不管静音和免扰**：那是路由层的事。代价：免扰期间照样出卡、照样调 AI（花钱）再丢——主人知情拍板，推翻了先定的「装配前先判」（Q20）。
- **没配目标照样出卡**（不动）：引擎不许知道目标，发不出去是下游的事。
- **失败降级，不回给来源**：出卡失败发纯文字、AI 失败就全用模板正文，都不整条重来。作品装配入口是 `deliverPost`，它不把投递结果交回来源；投递失败由推送层按目标处理（④）、按目标落历史（⑥）。图集是这次推送里一个不带附加项键的 `extra` 锚点、不许 @全体；它没送到，那一行记成 `partial`。
- 串行：送达次序 = 发起次序，按订阅过 `createSerialQueue`，防「下播卡晚于新一场开播卡」。渲染闸另叫 `createRenderGate`。（3a-27 先把两把同名的闸合成了 internal 里的一把 `createSerialGate`，`PostQueue` 按订阅用它；改名拆分仍没做。）
- 直播附加项（词云、直播总结）的生产在 `live/`。

### ③ 路由与闸

`PushRouter`（原 `BilibiliPush`）只认订阅 id 与目标 id，不认平台，也不看订阅是哪个来源。

**1.0 的关键变化**：静音与免打扰只管推送，**推送层先算出目标、再判静音 / 免扰**。被挡下的每个目标落一行 `silenced`，存下重推原件；它不算推送，也不算失败。

| # | 闸 | 依据 | 挡掉之后 |
| --- | --- | --- | --- |
| 1 | 生命周期 | disposed / generation | 静默 |
| 2 | 无订阅记录 | 按订阅 id 找 | 静默 |
| 3 | 总开关 | 折叠后的 `features[feature]` | 静默 |
| 4 | 无可用目标 | 路由 ∩ 目标 / 连接启用 | 历史落「无目标」行 |
| 5 | 附加项收窄成空 | 附加项三态表 | 静默，**不是**「无目标」 |
| 6 | 全局静音 / 免扰时段 | `core.muteEndsAt`（原 `mutedUntil`）、订阅折叠后的免扰时段（`defaults.quietHours`） | 每个目标落一行 `silenced` + 重推原件 |

**一次推送只判一次、按锚点发**（10-08 定，ADR-0021 决策 34 的 🔗）：引擎把一次推送整个交给 `PushRouter.push(push)`，里面是按顺序排好的锚点（本体、各个附加项；@全体 的锚点由推送层自己插在本体前）。第 2、3、6 三道在交进来的那一刻判一次，裁决管整次推送；第 4、5 两道在每个锚点发出时按目标判。锚点的内容并行做、按先后发：前一个发完才发后一个，空的跳过；@全体 只保证先后、不等结果。附加项先按三态表收窄、再记被挡：`silenced` 行里只有这个目标本来会收到的消息，每条带 `isSilenced: true`、没有结果，被挡的 @全体 不记。`push()` 在本体发完时返回，附加项在后台接着发，这条订阅的下一次推送不等它们。

- 只有「时间上的挡」（静音、免扰）才落 `silenced`；总开关关着、附加项收窄成空、目标所在的连接不支持 @全体，照旧静默、不落行。
- 支不支持 @全体 问适配器的能力 `atAll`，不按平台名判（见 ⑤「成员」）。
- **逐目标挑正文**（ADR-0032）：目标定了以后，按 `core.ai.writing` 逐个目标挑 AI 正文还是模板正文，例外写了听例外，没写用默认；这一维和 @全体 的分组叠在一起，@全体「先发、不等」的时序不变。直播总结发不发仍归附加项 `liveSummary`，这里只挑发出去的那条用哪份字。
- `silenced` 连带三处：不算「今日推送」与趋势（现 `countsAsDelivery`），追加补丁（词云、总结）时不被 `computeStatus` 重算成 failed，补发闸（`repushDenial`）放行。
- ⛔ 被挡时不弹警告卡，历史页也不加按状态筛选（09-05 否过）。

「会不会被监听」和「推不推」是两件事：前者核心有唯一判定（在 internal），后者是这几道闸。

### ④ 发送

- 一个目标的多条按序发，某条失败即中止该目标后续条。
- **按目标逐个投递，只重试失败的那个目标**，别的目标不重发。重不重试看结果里的 `code`（码表见 ADR-0026）：

  | code | 重试 |
  | --- | --- |
  | `rate_limited` / `unavailable` / `timeout` | 退避重试 |
  | `indeterminate`（结果不明，可能已经送到） | 绝不重试 |
  | 其他标准码与自定义码 | 不重试 |

- 目标不可达时照旧退避重试，**每次重试前复检这条订阅自己的路由**——防「取消了还在推」。
- @全体 那支同步发起、不 await，顺序靠它先于卡片交给投递。
- BN 不替适配器限流、去重：重试只在核心按目标做。
- 推送层对每个目标回调一次 `PushSendResult`（原 `PushSendInfo`），历史按它落行。
- 代价：推送进行到一半进程崩了，这一条可能漏掉（最多一次）。存盘的待发队列仍未决。

### ⑤ 投递

内置平台（OneBot、QQ 官方机器人、webhook）与拓展实现同一个 `PlatformAdapter`、进同一张登记表：留内置、拓展两套，就永远有一套没被对拍到。`CONNECTION_PLATFORMS` 这个闭集删掉；各平台的设置 schema 与平台信息表搬出 `internal`，由适配器自带，面板经 `/api/adapters` 拿描述。

#### 名字

| 名字 | 原名 | 管什么 |
| --- | --- | --- |
| `TargetDispatcher` | `NotificationSink` / 多路分发 `MultiplexSink` | 按目标所在的连接找适配器；**唯一能发送的**（见「出口咽喉」） |
| `PlatformAdapter` | 不变 | 一种连接怎么真发出去；内置的在 `platforms/` |
| `PlatformAdapterDef` / `PlatformAdapterHandle` / `registerPlatformAdapter` | 拓展契约的 `PushExtensionDef` / `PushSourceHandle` / `registerPushSource` | 交进登记表的一整包（适配器 + 描述 + `settingsSchema`）、登记后拿回的把手、登记口；内置与拓展同一个 |
| `PlatformAdapterRegistry` | `AdapterRegistry` | 适配器登记表，和分发一起在 `push/` |
| `PlatformAdapterContext` | — | 适配器拿到的环境：`IntegrationContext`（ADR-0025）加推送侧特有的：自己的连接（`connections()`、`onConnectionsChanged`）、关于连接的问题上报（`reportProblem` / `resolveProblem` 多一格 `connectionId`）、入站 `inbound`（`private` / `group` 两个成员都在，适配器只报 `connectionId`，平台由宿主按连接补） |
| `PlatformAdapterDescriptor` | 拓展契约的 `ExtensionPushView` | 描述**一个适配器**：`{ label, shortLabel, color, icon, settingsFields }`。第 3 版契约的适配器不带这一格（适配器自己的「脸」这一期不造）：拓展的描述以清单为准、由宿主填，内置的随第 4 期 |
| `PlatformDescriptor` | 不变（`tint` 改叫 `color`） | 描述**一个聊天平台**：`{ platform, label, shortLabel, color, icon?, targetKind: "session" \| "endpoint", scopes, addressNouns }`；`inbound`、`atAll` 从这里挪成适配器的运行期能力 |
| `ConnectionCandidate` | 拓展的 `ExtensionBotView`（`listBots` 的元素） | 新建连接时供挑的候选 |

- ⚠️ 按连接的 `adapterKey` 找适配器，**不按平台名找**（分发键 `connectionDispatchKey` 删掉）：拓展借来的 bot 平台名是开放字符串，一个适配器也能对多个平台（webhook 就是）。内置三个的键是 `onebot` / `qq-official` / `webhook`，和 `bilibili` 一样进保留 id；拓展的键就是拓展 id。
- 适配器内部原来拆成的两半（`Connector` / `PlatformDialect`）没有单独的消费者，3a-20b-1 已平铺进 `PlatformAdapter` 后删掉，不另起名。
- 清单的 `contributes.push` 不改名。

#### 成员

| 类 | 成员 | 说明 |
| --- | --- | --- |
| 描述 | `descriptor`、`settingsSchema` | `descriptor` 就是 `PlatformAdapterDescriptor`；`settingsSchema` 校验连接的 `settings`，面板照 `settingsFields` 画表单 |
| 必备 | `start(ctx)` / `stop()` | 取代 `reconcile` / `dispose`。登记即 `start`：晚登记的拓展也一样起来，不用等下一次连接变更才补 |
| 必备 | `send`、`isAvailable`、`probe` | 真发、此刻发不发得出、探一次通断；`send` 与 `probe` 回结果形状（见「结果与失败」）。通断由宿主「拉」：每分钟调一次 `probe`（原来 5 分钟），见「连接通不通」 |
| 必备 | `listConnectionCandidates(signal)` | 列新建连接的候选（见「新建连接」） |
| 可选 | `capabilities` / `probeCapabilities` | 运行期能力，新增 `atAll`、`inbound`；原先按平台名判断的（@全体 分流、审批能不能收回复）一律改问能力。能力是三态，不算失败结果 |
| 可选 | `listAddressCandidates(connection, scope, signal)` | 列可挑的地址，只查 `scope` 那一种（如 QQ 官方机器人的会话与频道，频道带 `parentAddress` 与 `parentName`）；读口 `GET /api/connections/:id/addresses?scope=` |
| 可选 | `connectionAuth` | 扫码之类的建连接流程（如 QQ 官方机器人扫码建号），与订阅侧同一个 `AuthState`，结果是一份连接草稿。三个方法：`begin(signal)` 发起（回任务号、此刻的状态、建议的问询间隔秒数）、`state(taskId, signal)` 读状态（可反复读，不带草稿、不清草稿）、`takeDraft(taskId)` 取走草稿（`settings` 里归这次认证管的那几格，状态到了 `logged-in` 之后成功一次，取走即清）。任务表归适配器、任务号由适配器发；三个方法都不依赖 `this`、都不许抛。路由是 `/api/adapters/:adapterKey/auth` 一组三个口（3a-29 QQ 半已落）。状态取值是 `AuthState` 的并集里建连接用得上的几种：QQ 官方只发 `awaiting-scan` / `logged-in` / `error`，**不发 `expired`**（它只指「已经登着的登录失效了」，建连接没有这回事；二维码过期报 `error` 并带一句话，10-11 回头改）也不发 `confirming`（没有「已扫、等确认」） |

内置适配器也是集成，走同一套生命周期：`start(ctx)`、`AbortSignal` 中止、`onDispose` 收尾；收尾时宿主先调适配器自己的 `stop()`，再中止 `ctx.signal`、跑经 `onDispose` 登记的收尾；运行状态只取 `running` / `failed` / `settings-invalid`（ADR-0025 决策 5）。

#### 新建连接：只走候选

- 只有一条路：挑一个候选，再填字段。`ConnectionCandidate = { name, platform: PlatformDescriptor, settings, selfId?, via?, boundConnectionId? }`。
- 平台固定的适配器返回写死的**模板候选**：OneBot 一个、QQ 官方机器人一个、webhook 四个。模板的 `settings` 是默认值、不带 `boundConnectionId`，可以反复用。
- 桥返回在线的 bot。候选里的完整平台描述由契约的门给一个造中性描述的函数（住零依赖的子路径），桥用它填、再盖上自己知道的图标。
- 候选的读口挂在现成的 `/api/adapters/:adapterKey/` 前缀下，内置与拓展同一个口；面板读的旧口 `/api/ext/:id/bots` 在同一个提交里删掉。
- 适配器登记（`registerAdapters`）一次性：失败不复位、再调直接拒。
- 连接的 `platform` 只来自挑中的候选。
- 后果：新建连接要适配器在跑；清单里的静态数据拿不到平台列表（推送侧的平台列表改由运行期的候选给）。已有连接的脸读连接上的 `platformSnapshot`，不等适配器。

#### webhook

webhook 是**一个**适配器，飞书 / 钉钉 / 企业微信 / 通用是它的四个模板候选：webhook 是「怎么连」，不是一个平台；拆成四个会占掉 `feishu` 等平台键，而一个适配器本来也要能对多个平台。冻结的通用 webhook JSON 里 `private` 写死 `false`（主人目标不可能是 webhook）。

#### 连接与目标

`connections.json` 回答「用谁发」，一条连接就是一个 bot；`targets.json` 回答「发到哪」；订阅按目标 id 引用。

```ts
type Connection = {
  id: string; name: string; enabled: boolean;
  adapterKey: IntegrationKey;   // 找适配器用；拓展的就是拓展 id
  platform: string;         // 开放字符串，只来自挑中的候选
  settings;                 // 归适配器的 settingsSchema 校验
  platformSnapshot;         // PlatformDescriptor 去掉 platform 那一格，只有宿主写
  probeState?;              // 对象，三态取值在它的 status 里，只有宿主写
};

type PushTarget =
  | { id; name; connectionId; enabled; kind: "session"; scope; address; parentAddress?; reachability? }
  | { id; name; connectionId; enabled; kind: "endpoint"; managedBy: "connection"; reachability? };
```

- 连接上删掉 `kind`、顶层的 `connector`、`extensionId`（并进 `adapterKey`）；`transport` 留作 OneBot 适配器私有的设置。
- **目标上删掉 `platform`**：它只是连接平台的一份拷贝，两处一改就漂。平台一律经 `connectionId` 从连接取，主人身份比对的平台也是。补两道守卫：改 `connectionId` 时比新旧连接的平台；整节替换（备份恢复）时校验连接身份没变。
- 连接不在了的目标只隔离那一条，不连累别的；作用域键（链接预览按群的那张表）去掉平台前缀。
- 托管目标（webhook 这种连接本身就是终点）按 `targetKind` 是 `endpoint` 判，不再按平台闭集。
- 凭据按 `secret: true` 打码下发（见 data-model.md）。

#### `platformSnapshot`

连接上存一份 `PlatformDescriptor` 去掉 `platform` 那一格。适配器不在场（拓展停了、桥没连上）时，面板照样画得出已有的连接；「面板异步拿描述、拿不到怎么兜底」那一题因此不用答。

| | |
| --- | --- |
| 谁写 | 只有宿主：新建时照候选抄、列候选时按平台名刷新、迁移时填、备份里带回；POST / PATCH 带来的一律忽略 |
| 谁读 | 面板上连接的脸与目标编辑器（`scopes`、`addressNouns`）、托管目标同步（`targetKind`）、目标的 scope 校验 |
| 谁不读 | 推送层（认 `adapterKey` 与能力）、适配器；主人身份认 `connection.platform` |

快照变了不许触发适配器重连。

#### 连接设置的校验

- 保存时：适配器在场就按它的 `settingsSchema` 校验，不过回 400 并带原因；不在场先存下。
- 读盘时：逐条校验，不过的只隔离那一条——不交给适配器、不投递；面板显示「设置不合法」与原因；盘上原文不动。BN 照常开机。这是宿主替连接报的问题：进问题表、不私聊，记在那条连接所属适配器的名下。
- 只有外壳（`id` / `name` / `adapterKey` / `platform`）坏了才挡开机。
- 撤下的旧形状写成明确的名单：适配器没登记不等于存量（拓展是晚加载的）。
- 「坏条目不许被悄悄吃掉」的初衷保留：隔离是显式的，面板与问题框都看得见。现行「坏的内置连接开机就抛错」翻掉。

#### 这一版不对拓展开放

`listAddressCandidates`（alpha 之后桥帧改名时再考虑）、`connectionAuth`、描述里的条件显示与键值表字段。（10-11：前两个成员运行时也不开放 —— 宿主登记拓展适配器时把它们摘掉，带了也不认；主人认为这两个成员对桥有用，开放留到 alpha 之后改桥协议时连同拓展契约、桥协议、仓外两个桥插件一起设计。）对拍逐成员核：要么走通，要么在「不开」名单里写明理由。

#### 入站

内置适配器的入站也经 `ctx.inbound`：宿主核归属、平台取自连接，不再由适配器自报；适配器停下之后再交来的丢掉并记一行。回调包叫 `InboundHandlers`（原 `InboundSinks`）。私聊的号叫 `address`（原 `userId`）；群消息的群号叫 `address`（原 `groupId`）、发言者叫 `senderId`（原 `userId`，与 `selfId` 成对；不用 `author`，那是作品作者）。桥协议帧不改名，由桥的适配器映射。

#### 结果与失败

按 ADR-0026：一次操作的结果一律是 `{ ok: true, … } | { ok: false, code, message, upstreamCode? }`，抛错只留给 bug。

- `DeliveryResult`（`send` 的结果）与 `ProbeResult`（`probe` 的结果）改成这个形状，`err` 删掉。平台自己的码（OneBot 的 retcode、QQ 的错误码、HTTP 状态）放 `upstreamCode`，不占 `code`；各平台的码翻成哪个标准码，施工时逐个适配器定。附带的 `latencyMs` 与截流标记 `isSynthetic`（原 `synthetic`）照留。
- `ProbeResult` 原来的 `ok: null`（这个适配器没有探测协议），按码表是 `unsupported`。
- 适配器抛错算 bug：宿主在边界接住，按 `unavailable` 处理并记错误日志。
- 桥的回执进门时翻成结果形状；说不清原因的记 `unknown`。协议统一后插件直接回结果形状，只带 `err` 的旧写法才要翻（ADR-0026 决策 7）。
- 连接上的探测状态叫 `probeState`（原 `testStatus`），是对象，三态取值在它的 `status` 里；只有宿主写。不迁移，开机重探。路由 `/api/connections/:id/probe`（原 `/test`）。
- 目标的可达性记在 `reachability.changedAt`（原 `testStatus.lastCheckedAt`，只在通断翻转时写）。

#### 连接通不通

通断由宿主「拉」，契约不加成员，适配器自己不报通断：

- 宿主每分钟调一次现成的 `probe`（原来 5 分钟），连续两次探不通算断。探测结果改成**状态变了才写盘**（原先每轮都写连接文件并广播）。原先拟的「OneBot 补 WS 看门狗」撤掉。🔗 已落（3b-52）：探测整段住 `apps/server/src/push/connection-probe-engine.ts`（`createConnectionProbeEngine`，`runtime/engines.ts` 只接线）。每条启用的连接各自探、一轮里并行，同一条上一次没探完就跳过它；单次连通探测限时 30 秒，到点算一次 `timeout` 失败（契约里 `probe` 不收 `signal`，到点宿主只是不再等，适配器那边的请求不会被取消）；限时只罩连通探测，不罩顺路补探能力。失败的计数只在内存里。`rate_limited` 是对端活着：不算失败也不算通，状态与计数都不动，记一行 warn。探不了的连接（webhook）记成 `unsupported`，只在变成它时写一次。后台写下的 `lastCheckedAt` 是「状态变的那一刻」，手动探测每次都写（引导靠它每次都变），格名不改。适配器不在场（拓展停了）的连接不探、不报。
- 私聊与清的规矩全在宿主：运行中断了（连上过又断）才私聊；启动后一直没连上的、主人改设置造成的只进表；主人的私聊目标走的就是这条断了的连接，就不发、不再试、恢复后不补；探通了清掉，并只对真私聊过的补「已恢复」。🔗 已落的判法：「连上过」指自从开机或改设置之后通过过（设置指纹变了、或由停用改成启用，从头算）；「主人的私聊目标走这条连接」按报的那一刻的主人目标算；私聊与否在这次中断开始时定下，中断里不翻（主人中途换了目标也不补发）；探不通的码是 `not_configured` / `not_found`（接入没了、没配好，主人去动手才会好）的一律只进表。同一次中断原因变了只换文案，不再私聊。停用的连接清掉它的问题且不补「已恢复」；被删的连接，关于它的问题由问题表的 `clearConnection` 清。
- 宿主替连接报的几条记在那条连接所属适配器的名下（一条桥接入带倒的几条连接，60 秒窗口会并成一句）。🔗 已落的问题码：`connection_unreachable`（连续两次探不通，文案走服务端字典 `problem.connection.unreachable`，恢复句 `problem.connection.recovered`）与 `connection_settings_invalid`（见下）。宿主不为这两个码造保留名单、也不拒收适配器用同名码——先例是 3b-41 宿主替拓展报 `settings_invalid` 也没保留。
- **手动「测试」**（`POST /api/connections/:id/probe`）走引擎的 `probe(id, { manual: true })`：只算恢复，不算失败。每次都写盘；探通了当场清「连不上」并算「连上过」；不通只写盘，不加失败次数（连点两次「测试」凑不出一条私聊）；回 `rate_limited` 什么都不动，结果仍回给面板。路由自己不再写 `probeState`。
- 「连接设置不合法」也由宿主报：每轮探测前、以及每次 `config-changed { connections }` 时按适配器的 `settingsSchema` 对一遍设置（连接变更时只做这一步记账，不探测，不然探测写回又触发连接变更成了死循环），不合法的记 `connection_settings_invalid`、只进表、不私聊，原因取 `settingsIssueMessage`；好了、停用、适配器不在场都清，不补「已恢复」。设置不合法的连接派发器探测必回 `not_configured`，`probeState` 仍照 3a-22-2 记成不通并带原话，但不再另开一条「连不上」，设置刚变成不合法时先前开着的「连不上」也一并清掉。
- 每分钟探 QQ 官方那个接口有没有频率限制：调研结论是官方文档没有给出数字，照「每分钟一次」走；被限流（429 翻成的 `rate_limited`）按上面算中立，不会误报断联。
- 适配器特有、探测看不出来的事仍走 `reportProblem({ connectionId })`。🔗 已落（QQ 官方网关连不上）：`gateway_offline`，从开机或掉线起连续不在线满 60 秒才报（QQ 约每 30 分钟主动要求重连一次，几秒内回来，不算故障），只进表不私聊（推送走 REST，不受网关影响），READY / RESUMED 清；连接停用、删掉或换设置时补一次清。文案 `qqOfficial.gateway.offline` / `offlineNoReason`。
- **OneBot 小程序卡能力的重探**也收到宿主：节奏与「探不出来不推翻已探实的答案」那条规矩由宿主管，契约不加成员。🔗 已落：派发器（`push/target-dispatcher.ts`）记每条连接每一格最后一次探实的答案，适配器回「还不知道」的格沿用，适配器自己给的明确答案（含真发时收到 1404 翻成的「不支持」）照收；`probeConnectionCapabilities` 按连接节流 60 秒，窗口内拿记着的答案；连接设置指纹变了或连接没了，记忆与节流一起丢。OneBot 删掉了自己的节流、「不推翻」以及全部自发探测（通道就绪、HTTP 对账），能力只靠宿主那一轮（探通后任一格还是「未探测」就补探）与链接预览按需探。
- **已知的残余**：① 手动「测试」与后台那一轮可能同时探同一条连接，各探一次、各写一次（手动不受后台的在途闸管）。② 后台每 60 秒一轮、宿主的能力重探窗口也是 60 秒，两者节奏碰上时一次补探可能被窗口挡掉、拖到下一轮，最长约两分钟才补上；改不改窗口另定。③ 主人连接断着时，别的来源要私聊的问题（登录失效、风控）仍会去发、发不出去、再按五档重试（今天就是这样，`refreshMasterReachability` 没合进来）。

#### 原生分享与链接入站

链接预览（ADR-0029）落在适配器这一侧的部分：

- 解析器交中立描述 `{ appId, title, description, imageUrl, pagePath, webUrl, iconUrl? }`（`LinkPreview.nativeShare`），由 OneBot 适配器去签，签不了就回图片。现行签卡写死的 `type: "bili"` 删掉。`appId` 填 B 站 QQ 小程序真实的 appid（施工时从真分享卡里读出来核）；OneBot 签名接口不收通用参数，就在适配器里放一张 appid → 预设的对照表；旧重推原件迁移补同一个 appid。
- 载荷种类 `"miniapp-card"` 改 `"native-share"`，类型随 `NativeShare…`；能力格 `miniAppCard` 改 `nativeShare`。桥帧里的能力名（`miniAppCard`）与载荷种类（`miniapp-card`）照旧不改，进 alpha 后两步改名。
- OneBot 入站的 B 站域名预筛删掉：该不该回预览由解析器的 `matches` 说了算，适配器不认识任何一家来源。64KB / 8 层的上限保留。
- 入站链接的来源标记：适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" | "nativeShare" }[]`，取代 `miniAppCardLinks`；正文里的链接仍由核心从 `text` 里挑、核心内部记成 `"text"`；规矩是「原生分享卡里的链接不回预览」。桥帧里那一格（`miniAppCardLinks`）照旧，进 alpha 之后两步改名的清单，由桥的适配器映射；它是插件发给 BN 的入站字段，两步反过来走：BN 先同时认新旧两种写法，插件再改发新的（ADR-0029 决策 2）。不用 `linkPreviews` 做名字：它与 BN 回出去的 `LinkPreview` 同词两义。
- 回复形式 `replyForm` 取 `image` / `nativeShare` / `text`，面板上是「回图片 / 回原生分享 / 回文字」。「回文字」发的是：作者名 + 作品文字（经作品取段的那一个函数，限长），不带链接（群友的消息里已有链接）。
- 链接预览回卡不走推送链，全局静音与免扰都管不到，所以 `linkPreview` 留一个总开关（默认关）与冷却 `cooldownSec`，见 [data-model.md](./data-model.md)。

#### 线上格式

- 通用 webhook 的 JSON（`forward`、`ts`…）永远不改，改名只改到适配器内部，有快照守卫。
- 桥协议的帧（`forward`、`desc`、`picUrl`…）alpha 期间不改，1.0.0 之前按两步改完，改成什么名字见 [construction-plan.md](./construction-plan.md)；在那之前改名只改到桥的适配器内部，有快照守卫。

### ⑥ 历史

一行 = 一次推送 × 一个目标。同一次推送的后续消息（@全体 / 图集 / 词云 / 总结）追加到同一行。投递失败按目标记：每个目标一行，失败带 code，可以手动补发。

| 字段 | 1.0 |
| --- | --- |
| 行类型 | `HistoryEntry`（不改名：后缀表里「列表、日志、账本里的一条」用 `Entry`）；追加新行的入参叫 `NewHistoryEntry`（原 `HistoryRecordInput`），里面的目标叫 `targetId` |
| 身份 | 行上带 `identity: { sourceKey, externalId }`，不再分「B 站行 / 拓展行」两套格 |
| 快照 | `nameSnapshot`；`avatarSnapshot` 是图库引用（所有来源都有头像快照了） |
| 时刻 | `createdAt`（ISO） |
| 推送种类 | 那一格叫 `feature`（原 `kind`），值直接用特性键名：`post` / `liveStart` / `liveStreaming` / `liveEnd` / `membership` / `superchat` / `viewerChat` / `viewerEnter`（原 `specialDanmaku` / `specialUserEnter`）；`featureToPushKind` 删掉；`/api/history?feature=`、按天计数的键同一套 |
| 投递结果 | 每条消息的结果是结果形状：失败带 `code` + `message`（与 `upstreamCode?`），原来那格 `err` 原话删掉。旧历史里的失败迁成 `{ code: "unknown", message: 原话 }`，统计与重推按 `unknown` 处理 |
| 重推关系 | `repushOf` / `HistoryRepushMessage`（原 `retryOf` / `HistoryRetryMessage`；retry 只指传输层自动重试 `maxRetries`） |

| 态 | 判据 |
| --- | --- |
| `no-targets` | 有推送、但一个可用目标都没有 |
| `delivered` | 有结果且全到 |
| `failed` | 本体（第一条 `role: "main"`）没到 |
| `partial` | 本体到了、别的没到 |
| `silenced` | 被静音 / 免扰挡下；追加补丁时**不被重算成 failed** |

**重推原件与图**：

- 每行存重推原件，原件类型叫 `RepushSnapshot`（代码里的 `DraftSchema` / `DRAFT_GONE`，和锐评草稿撞词；字段 `v` → `version`）；原件里的图（卡片图、自存图）与头像快照都按内容摘要存进统一图库 `images/<sha256>.<ext>`，行里只存引用。取消 `history/img/`（⑳d 已落：历史行的配图格叫 `image`、头像快照叫 `avatarSnapshot`，原件的图格是一个引用字符串）。
- 按目标挑过正文的，行里存的是那个目标实际收到的正文，重推照它发（ADR-0032）。
- 原件图上的 `own`（标「复用历史那份 / 原件自己存的」）与 `mime` 删掉（⑳d 已落）：图按摘要进图库、按引用清扫，两处不再有区别，格式随引用走。原件每一张图（含 composite 第二张起）自己 `put` 进图库，同字节只落一个文件，重推每试一次不再多写一份；原件的 `drop` / 整天清掉只删 JSON，不删图。
- 原件里的载荷种类与字段（`forward-images` → `image-group`；小程序卡那一种按原生分享的中立描述改字段）由迁移改写，进守卫 13 的清单；和活的载荷改名同一期（`image-group` 3a、原生分享 3b，10-03 定）。
- 保留期清理那一趟按引用全局清扫图库，引用方含历史行、重推原件、资料缓存、AI 会话。不再「按日删日文件时连图一起删」。
- 人工重推走 `PushRouter` 的单目标发送，所以静音 / 免扰 / 总开关天然不参与，退避重试与重试前复检照有。**补发闸放行 `silenced` 行**：主人静音期间被挡下的，事后可以补发。

## 附加项

生产与推送仍是两个问题：

- **@全体 没有「生产」**：只有推不推。1.0 只有 `atAllPost` 与 `atAllLiveStart` 两把；只有开播能 @全体，周期「正在直播」不能。目标所在的连接支不支持 @全体，问适配器的能力 `atAll`。
- **词云 / 直播总结**在 `live/` 生产，三道全看折叠值、不看目标：开播时攒不攒弹幕 → 下播时要不要算 → 生产者自己弃权（热词不足等回 `undefined`；总结的 AI 版没做出来不算弃权，所有目标用模板那份）。产出是 `undefined` 的**根本不发起广播**，和「收窄成空」看起来一样、成因相反。
- 附加项的逐目标三态表、注册表照旧；盘上以特性键 / 附加项做键的设置由迁移改键（见 [data-and-migration.md](./data-and-migration.md)）。

## 主人通知与问题上报

推送层告诉主人只有一个口 `notifyMaster(payload: string | NotificationPayload)`（合掉 `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg`），经 `TargetDispatcher` 发到主人目标，返回结果形状；审批预览卡这种带图的也走它。

适配器上的 `sendPrivate` 与「强制私聊」标志 `{ private: true }` 删掉，适配器只有普通的 `send`：主人要是在面板上选了群目标，强制私聊会把群号当成 QQ 号去调「发私聊」，要么报错、要么错投。私聊的要求挪到主人目标上，守三道：

- 选的时候：`master.targetId` 必须指向私聊目标（schema 校验，面板下拉只列私聊目标）；PATCH 把它改成群目标直接拒收。
- 发的时候：`notifyMaster` 复检主人目标是私聊，不是就拒发，回 `invalid`。
- 迁移时：指向群目标的清空，首访页提示重选。

| 通路 | 受静音管？ | 说明 |
| --- | --- | --- |
| 主人通知 `notifyMaster`（出错告诉主人、审批预览卡） | 否 | 发到主人目标 |
| 指令回复（`CommandDef.run` 的 `reply`） | 否 | 经 `sendToAddress` 回到发指令的那个会话，不再发到主人目标那条连接；挡掉的话主人只会看到指令毫无反应 |
| `ctx.reportProblem({ …, notify: true })` | 否 | 集成定严重度、写事实句（平实，不称呼主人、不写面板与指令；口吻与引子由宿主按口吻加工，见 extension-contract.md「问题上报」）；核心按「同一报的人（`reporter`）、同一 code 60 秒一次」节流；同时进面板问题框。🔗 3a-30 已落（只在内置来源的 `SourceContext` 上，由 `problems/problem-notifier.ts` 发；真送到才算、没送到限次再送、清掉时补「已恢复」） |
| `ctx.reportProblem({ … })`（不带 notify） | — | 只进面板问题框，不私聊。🔗 3a-30 已落（B 站的「没登录过 / 主动退出」与「拉动态失败」就是这一种） |
| `engine-error` | 否 | 只剩流水线错误（如出卡失败）；`source` 改成中立模块名（施工时定）；出图连续失败只提醒一次。🔗 3a-30 之后今天的发射者只剩作品投递出图失败（`post-delivery`）与直播「重连流程内部异常」（`live-engine`），经 `MasterNotifier` 私聊、面板红条看得到 |

来源级问题（关注同步失败等）一律走 `reportProblem`，不再走 `engine-error`；拿不到直播状态不归来源报，由核心调 `fetchLiveStatus` 拿到失败时自己记。**登录问题不由来源报**：有登录口的来源，宿主订它的 `auth.onChange`、按 `AuthState` 自己报与清（`expired` 进表并私聊、`logged-out` 只进表、`logged-in` 清并对私聊过的补「已恢复」），记在来源名下，宿主写整句并带指路；B 站不再报 `auth_lost`。平台适配器也经 `ctx.reportProblem` 报适配器特有的问题，带 `connectionId`，宿主核这条连接是不是这个适配器的，不是就拒收；连接通断不归适配器报，由宿主探（见 ⑤「连接通不通」）；连接卡看关于自己的，问题框看全部（ADR-0025 决策 11）。问题进表于是有三条路：集成自己报、宿主看登录状态报、宿主探连接报，外加宿主自己的事。

私聊时宿主按口吻把话说完整：女仆层「主人，刚刚 <名字> 报告：<message>」、平实版「<名字> 报告：<message>」，名字取来源描述符的 `label`、拓展清单的 `name`；恢复句用「主人，好消息，<名字> 报告：<恢复句>」，没给 `recoveryMessage` 用一句带名字的通用说法。宿主自己写的整句（核心设置读不懂、宿主替拓展或连接报的几条、登录那一条）不加「X 报告」。

今天进面板右上「组件告警」（`engine-error`）的几种，1.0 的去向（10-03 对着代码列的，按上表与 ADR-0025 决策 11 下 10-03 的 🔗 推出来，3a 照它落）：

| 今天 | 1.0 |
| --- | --- |
| 动态引擎「账号未登录」「账号被风控」「获取动态信息失败，错误码 …」 | B 站的问题，按因果分层只报最上面那条开着的：未登录 → 风控 → 各项请求失败 |
| 直播「[房间] 获取个人信息失败 / 异常」（连弹幕前取「我是谁」） | 没登录时是未登录的症状，只记日志；登录着还失败，算 B 站的请求失败 |
| 直播「[房间] … 已停止该房间监测」「… 重试 N 次后放弃监听」 | 关于这条订阅的问题（B 站带 `externalId` 报），订阅卡与问题框看得到；根问题开着时由它引起的只记日志 |
| 「生成动态图片失败」、拓展作品出图失败 | **留在组件告警**：这一次出卡失败、已降级成纯文字推出去；连续失败只提醒一次；`source` 换成中立模块名 |
| 直播「重连流程内部异常」（兜底接住的意外抛错） | 是 bug 一类（ADR-0026：抛错只给 bug），进不进组件告警施工时定 |

🔗 **落成（3a-30，10-11）**，逐行对着代码：

| 今天 | 落成 |
| --- | --- |
| 动态引擎「账号未登录」「账号被风控」「获取动态信息失败，错误码 …」 | 「账号未登录」不再发组件告警（`-101` 一律不告警，未登录层看登录状态：运行中掉了或开机发现登录已失效是私聊 + 进表，没登录过 / 主动退出只进表）；风控进问题表并私聊（`risk_controlled`），**直播预检被拦也报到同一个风控层，原先无声、现在会私聊**（这一条是这一片新增的私聊，主会话还要问主人认不认）；获取动态失败进问题表（`dynamic_fetch_failed`）**只进表、不私聊**（主人定稿；与上面表里「各项请求失败」私聊的字面有出入）。三条都不再走 `engine-error` |
| 直播「[房间] 获取个人信息失败 / 异常」 | **只记日志**，并进随后那一条停监（弹幕连接没建起来，或重连用尽放弃监听）去报；单独报一条来源级的没有人会清，因为失败的那个房间不再重试 |
| 直播「[房间] … 已停止该房间监测」「… 重试 N 次后放弃监听」 | 关于这条订阅的问题（订阅级，`live_monitor_stopped`，私聊 + 进表）；受限房单列 `live_room_restricted`；根问题（未登录、风控）开着时存下不报，根问题清掉那一刻补报；同一分钟内多个房间停监只私聊第一个 |
| 「生成动态图片失败」、拓展作品出图失败 | 留在组件告警，且**只剩这一条**（原先还有一条直发私聊）；文案带「已降级为纯文字推送，请检查图片插件状态」；连续失败只提醒一次，发射出去就算提醒过、不再因没送达重试；`source` 是 `post-delivery`，中立命名没动 |
| 直播「重连流程内部异常」 | **留在组件告警**（`live-engine`），是 bug 一类，主人该看见 |

另外「已下播但没收到下播事件」那一条原先也私聊，3a-30 删了（主人定），只留 warn 日志。

## 不走这条链的旁路

| 旁路 | 差在哪 |
| --- | --- |
| 主人通知 `notifyMaster` | 发给主人目标（必须是私聊目标，发送时复检），不受全局静音管；返回结果形状 |
| 手动发一条（连接自测、卡片预览发送、AI 试一句、锐评投递） | 走同一套重试与投递，但不查路由、不落历史 |
| 链接预览回复 | 不进 `PushRouter`：`link-preview/` 的闸门过完（冷却键「群 + 解析器 + canonicalId」），经 `TargetDispatcher.sendToAddress` 回到消息进来的那个会话；解析经 `LinkResolver` 登记表 |
| 指令回复 | `CommandDef.run(values, ctx: { reply(payload), signal })` 返回结果形状；`reply` 经 `sendToAddress` 回到发指令的那个会话，`login [来源]` 的二维码（取自 `AuthState`）也经它发图。返回失败时框架回「『{指令名}』没办成：{message}」；抛错回「出错了，详情在日志里」并记错误日志 |

`TargetDispatcher.sendToAddress(connectionId, session, payload)`（`session` 是 `SessionRef { scope, address, parentAddress? }`）只给后两条用：不进路由、不过闸、不落历史；但要查 `isAvailable`，结果带 code，由截流统一记，不重试。链接回复原先现造的临时目标删掉。

### 出口咽喉：只有 `TargetDispatcher` 能发送

所有往外发的路——按路由的广播、人工重推、手动发一条、主人通知、链接预览回复、指令回复——最后都经 `TargetDispatcher`。登记表对外只给不含 `send` 的视图，`send` 只经 `TargetDispatcher` 的特权句柄；拿到登记表也绕不过它直接发。守卫见下文「推送侧的守卫」。

## 边界：谁不许知道什么

- **来源不许知道目标。** 推不推、推给谁归 BN。
- **装配不许认身份、不许读平台原始数据。** 一段步骤所有来源共用，往来源那头另加一步，别的来源就静默漏掉。
- **出图器不许联网。** 图只认图库引用。
- **推送层不许知道平台。** 只认订阅 id 与目标 id；找适配器认 `adapterKey`，@全体、能不能收回复问适配器的能力。核心读 `.platform` 只许用在身份构造、显示、日志。
- **适配器不许认识来源。** 不按哪一家的域名预筛链接，签原生分享不写死来源；该不该回预览由解析器的 `matches` 说了算。
- **只有 `TargetDispatcher` 能发送。** 见「出口咽喉」。
- **MessageBus 不在这条链上。** 状态通知（`live-session-changed`、`post-detected`…）去统计与面板，与推送载荷两条路。

## 推送侧的守卫

完整的守卫表见 [architecture.md](./architecture.md)「守卫」；推送侧这几道（ADR-0021 决策 59、60）：

| 守卫 | 判据 | 期 |
| --- | --- | --- |
| 出口咽喉 | 登记表对外只给不含 `send` 的视图，`send` 只经 `TargetDispatcher`；源码扫描的白名单只剩它 | 3a |
| 咽喉 e2e | 开截流 + 守卫 2，逐条驱动全部发送路径（广播、`notifyMaster`、目标测试、卡片发送、AI 试一句、锐评投递、人工重推、链接预览回复、指令回复与登录二维码、审批预览卡），每条恰好一条截流记录、零外连 | 3a |
| 推送守卫① | 核心不 import 适配器的实现（`platforms/`），例外只有 `compose.ts` | 3a |
| 推送守卫② | 推送平台专有词棘轮，词表加 `\bQQ[A-Z]`、`ws-reverse`、`transport`、`get_mini_app_ark`、`c2c`，范围纳入 contract。🔗 3a-41（10-12）已开：`scripts/__tests__/platform-vocabulary.test.mjs`，开张现数 17 个文件 147 处；`user_id` / `group_id` 连驼峰也认，`webhook` 不进词表，`compose.ts` 整文件白名单，`platforms/`、迁移模块、`bilibili/` 不扫 | 3a 开，3b 末清零 |
| `.platform` 决定棘轮 | 核心读 `.platform` 只许身份构造、显示、日志。🔗 3a-41（10-12）已开：`scripts/__tests__/platform-decisions.test.mjs`，核心 2 个文件 4 处、面板另记一张表 5 个文件 23 处；两个平台值比相等（平台对平台）不算决定 | 3a 开，3b 末清零 |
| 推送守卫③ | 假适配器对拍：一个假平台适配器（给假源拓展加 `contributes.push`，或另起一个假适配器拓展，施工时定）逐成员走 `PlatformAdapter`；必须有的行：`atAll` 为假、`inbound`、endpoint 托管、能力接口列拓展连接、登记即 `start`、内置与拓展入站都经宿主校验 | 3b |
| 主人目标 | 守卫 19 加固：PATCH 改成群目标拒收，`notifyMaster` 发送时复检 | 随该项 |
| 重推原件 | 守卫 13 纳入重推原件的载荷种类与字段 | 随该项 |

归期（ADR-0021 决策 60）：3a 适配器接口与登记表、内置适配器与模板候选、`/api/adapters`、连接与目标的新形状与迁移；3b 契约 v3 推送侧加宽、桥迁 v3；第 4 期面板按描述画连接与目标表单。

## 要改的时候

| 想干的事 | 动哪儿 |
| --- | --- |
| 加一把特性 | `FEATURE_KEYS`；历史行的 `feature` 直接用特性键，不另写同名列表；迁移清单守卫会逼你补迁移 |
| 加一个附加项 | `EXTRA_KEYS` + 附加项注册表；来源在 `descriptor.supportedExtras` 声明 |
| 改一条作品推送的步骤 | `posts/` 的 `deliverPost` 一处 |
| 改直播卡怎么发 | `live/` 的直播装配；什么时候推在 `live/` 的场次引擎 |
| 改历史行记什么 | `history/`；盘上形状变了要进迁移模块 |
| 加一个推送平台 | 写一个 `PlatformAdapter`：内置的进 `platforms/`，或做成拓展经 `registerPlatformAdapter` 登记；设置由它的 `settingsSchema` + `settingsFields` 声明，平台由它的候选给。推送层与面板一个字不动 |
| 改某种连接怎么连、有哪些设置 | 那个适配器自己（如 OneBot 的 `transport`） |
| 加一条往外发的路 | 只能经 `TargetDispatcher`（按目标，或 `sendToAddress`），并补进咽喉 e2e 的清单 |
| 改链接预览回什么 | `link-preview/` 与各 `LinkResolver`；原生分享怎么签在 OneBot 适配器 |
| 加一个订阅平台 | 写一个订阅源拓展，这条链一个字不动 |

## 与现行 docs/agents/push.md 的差异

| 现在 | 1.0 |
| --- | --- |
| ① 引擎在 `packages/dynamic` / `packages/live` / `runtime/extension-*.ts` | 来源在 `bilibili/` 与 `extensions/` 收件口；四个 B 站包删掉 |
| ② 适配段：`liveTypeToFeature` / `liveTypeToExtra`（`liveTypeToPushKind` ⑬f 已删）、`subscriptionIdOfUid` | 整段消失：推送种类就是特性键（B 站引擎内部的 0 / 3 / 9 在 `bilibili/` 里翻）；uid → 订阅 id 由核心在进门处按身份展开（来源只报 externalId） |
| 装配在 `packages/dynamic`（`deliverWork`）与 `packages/live`（`pushLiveNotify`） | 在服务端 `posts/` 与 `live/` |
| 拓展作品只按文字过滤，类型开关不看 | 过滤看 `Post` 上有没有，对所有来源生效 |
| 拓展作品套进 B 站动态类型出卡 | 渲染器只认 `Post` |
| 卡里的图是地址：远端走白名单预取，拓展图转 data URL | 只认图库引用，出图器不联网，B 站域名白名单删掉 |
| 主卡发送失败往外抛：B 站不前移锚点、下一轮整条重来，拓展只记日志；图集失败吞掉 | `reportPost` 是 `void`，来源交完就前移锚点；核心按目标逐个投递、只重试失败的那个，按 code 分退避与不重试；出卡 / AI 失败降级；每个目标一行历史带 code |
| 静音排在推送层所有查询之前，被挡不落行 | 先算目标再判，被挡的每个目标落 `silenced` 行 + 重推原件 |
| B 站开播与周期「正在直播」共用 `feature: "live"` | 拆成 `liveStart` / `liveStreaming` / `liveEnd` |
| 两套直播计时（B 站 `room-session*`、拓展直播计时器） | 核心一个场次引擎 + `fetchLiveStatus` |
| 历史行按支记：B 站 `uid` + `unameSnapshot` / `uavatarSnapshot`；拓展 `extensionId` + `externalId`、只存名字 | 行带 `identity`；`nameSnapshot` / `avatarSnapshot`（图库引用） |
| 历史种类 `dynamic` / `live` / `live-ongoing` / `live-end` / `guard` / `sc` / `special-danmaku` / `special-enter` | 特性键名（⑬f 已落） |
| 历史图在 `history/img/`，随日文件删 | 统一图库，按引用清扫 |
| `BilibiliPush` / `NotificationSink` / `MultiplexSink` | `PushRouter` / `TargetDispatcher`；`PlatformAdapter` 名字不变 |
| 平台闭集 `CONNECTION_PLATFORMS`、平台信息表与各平台连接 schema 在 `internal`；拓展连接走 `kind: "extension"` 那一支 | 内置与拓展同一个 `PlatformAdapter`、同一张登记表；schema 与描述由适配器自带，面板经 `/api/adapters` 拿 |
| 新建连接：内置按平台表选，拓展列在线 bot（`listBots`） | 只有一条路：挑候选（`listConnectionCandidates`）再填字段；平台固定的适配器返回模板候选 |
| webhook 族占四个平台键 | 一个 `webhook` 适配器、四个模板候选；冻结 JSON 的 `private` 写死 `false` |
| 连接带 `kind` / `connector` / `extensionId`，分发键 `connectionDispatchKey` | `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot, probeState? }`，分发按 `adapterKey`；`transport` 是 OneBot 适配器私有的设置 |
| 目标存 `platform`（连接平台的拷贝） | 删掉，经 `connectionId` 从连接取；补两道守卫；悬空目标只隔离那一条 |
| 坏的内置连接开机就抛错；拓展连接只核外壳 | 存时适配器在场就校验、不过回 400；读时逐条隔离；只有外壳坏才挡开机 |
| 适配器 `reconcile` / `dispose`，只在开机与连接变更时 reconcile | `start(ctx)` / `stop()`，登记即 `start` |
| 内置入站在装配处直通分发、平台由适配器自报 | 都经 `ctx.inbound`，宿主核归属、平台取自连接 |
| @全体、能不能收回复按平台名判 | 问适配器的能力 `atAll` / `inbound` |
| `DeliveryResult { ok, latencyMs, err? }`、`ProbeResult.ok: boolean \| null`；历史存 `err` 原话 | 结果形状带 `code`，平台码进 `upstreamCode`；旧历史失败迁成 `unknown` |
| 链接回复现造临时目标、直调适配器的 `send`，不查 `isAvailable` | `TargetDispatcher.sendToAddress`；只有 `TargetDispatcher` 能发送 |
| 链接解析 `createLinkParser`；OneBot 入站按 B 站域名预筛，签卡写死 `type: "bili"`；入站 `miniAppCardLinks` | `link-preview/` + `LinkResolver`（门叫 `LinkPreviewer`，`createLinkPreviewer`），设置 `linkPreview`（总开关、默认、回复形式、按目标的例外、`cooldownSec` 五格）；删预筛，按中立描述签；入站链接 `sharedLinks` 带来源标记 |
| 出错告诉主人经 `engine-error` 按来源 60 秒节流 | 来源级问题走 `reportProblem`，按来源 + code 60 秒节流 |
| 主人私聊走 `sendPrivateMsg` 等三个方法 + 适配器的强制私聊；指令回复发到主人目标那条连接 | 一个 `notifyMaster(payload)`，返回结果形状、发送时复检私聊；强制私聊删掉；指令回复经 `reply` → `sendToAddress` 回到发指令的会话 |
| 连接 `testStatus`、`/api/connections/:id/test`、`/api/push/test`；目标 `testStatus.lastCheckedAt` | `probeState`（对象，三态在 `status`）、`/probe`、`/api/targets/:id/test`；`reachability.changedAt` |
| 订阅顶层 `extras`（按目标三态表）；载荷 `"forward-images"`；小程序卡 `desc` / `picUrl` / `path` / `jumpUrl` | `extraTargets`；`"image-group"`；原生分享的中立描述 `description` / `imageUrl` / `pagePath` / `webUrl`，另有 `appId`、`iconUrl?`（桥帧照旧，由适配器映射） |
| `PushSendInfo`；重推原件 `DraftSchema` / `DRAFT_GONE` | `PushSendResult`；`RepushSnapshot`；`HistoryEntry` 不改名 |
