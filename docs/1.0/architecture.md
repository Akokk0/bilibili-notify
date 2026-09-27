# 1.0 架构：中立核心

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

分层、目录地图、接口族与登记表、装配根、总线、守卫。类型与字段见 [data-model.md](./data-model.md)；各接口的细节见 [subscription-sources.md](./subscription-sources.md)；推送链见 [push.md](./push.md)；拓展能拿什么见 [extension-contract.md](./extension-contract.md)；盘上布局见 [data-and-migration.md](./data-and-migration.md)；施工分期见 [construction-plan.md](./construction-plan.md)。

## 一句话

**核心里出现「B 站」这个概念就算越界。** B 站的东西要么搬回 `bilibili/`，要么变成核心的一个中立概念、由 B 站去实现。B 站和拓展都只是来源：B 站直接实现中立接口，拓展由宿主转成同一组接口。**没有后门。**

## 三层

| 层 | 是什么 | 包括 |
| --- | --- | --- |
| 一等：中立核心 | 名字、类型、数据形状、文档都不带平台味；来源只往里交东西 | 订阅、推送路由与闸、出卡与皮肤、AI、统计与锐评、历史与重推、粉丝、链接卡、指令框架、账号、面板；醒目留言、会员、特别弹幕、特别进场、词云、直播总结 |
| 二等：B 站 | 内置来源，住服务端 `bilibili/`，直接实现 `SubscriptionSource` 等中立接口 | B 站接口、弹幕通道、动态与直播信号、扫码登录、关注同步、B 站链接解析器；给醒目留言 / 会员 / 特别弹幕 / 特别进场 / 词云 / 总结填数据 |
| 2.5 等：拓展 | 外部来源，只从 `@bilibili-notify/extension` 这扇窄门进，由宿主转成同一组中立接口 | 订阅源拓展（如抖音）、桥、推送出口 |

```
B 站模块（信号 · 接口 · 扫码）──SubscriptionSource 等接口──┐
                                                          ├─→ 中立核心 ─→ 推送 · 出卡 · 历史 · 统计
拓展 ──窄门契约──→ 宿主（extensions/）──转成同一组接口─────┘
```

- **中立接口族是全集，拓展契约是它的子集。** 两边的区别只在谁写、住在哪、开放多宽。
- 产品名 bilibili-notify 与包作用域 `@bilibili-notify/*` 是品牌，不改。
- 机器人框架（Koishi / AstrBot）不当核心的宿主，引擎层不给它们留钩子。以后要做完整插件，走「薄插件 + 插件托管一个 BN 进程（吃同一份更新载荷）+ 桥借 bot」；还缺的零件：桥 token 自动配对、AstrBot 侧的 Node 运行时。

## 方向原则

| 方向 | 用什么 | 例子 |
| --- | --- | --- |
| 来源 → 核心：「发生了什么」 | 事件（经 `SourceContext` 上报） | 作品、直播信号、资料、问题、关注变了 |
| 核心 → 来源：「帮我做什么并给结果」 | 接口调用 | 搜人、拉资料、查直播状态、解析链接、执行指令、调工具、预览 |

理由：把请求 / 回应做成事件，就要手工重造函数调用自带的东西（对号、超时、取消、报错、类型）；来源没实现某个请求时，事件只能干等超时，接口在登记那一刻就知道有没有。拓展的事件由宿主转进 MessageBus，**拓展拿不到总线本身**，所以伪造不了核心事件。

## packages/

判据：**中立的留在 `packages/`，B 站与宿主装配进服务端。** `packages/` 物理上 import 不到 `apps/server/src/bilibili/`，中立性由目录结构直接守住。

| 包 | 层 | 放什么 | 相对现在的变化 |
| --- | --- | --- | --- |
| `internal` | 一等 | 域模型（订阅、身份、作品 / 直播模型、特性键表）、schema、零依赖工具（显示名、计数与时间格式、身份索引、串行队列、重试等）。零依赖工具走子路径——根入口带 zod，面板拿不到 | 工具收成一份，面板与服务端共用 |
| `push` | 一等 | `PushRouter`：按订阅 id 路由、闸、附加项 | 类名改掉 |
| `image` | 一等 | 作品卡、直播卡、榜单等中立卡种 + 皮肤；附加块按 card / video / goods 直接渲染；不联网，只内联图库引用 | 解析 B 站 JSON 的代码、B 站域名白名单、大航海等级表搬走 |
| `ai` | 一等 | 生成器、人格、核心中立只读工具；看图（`describe_image`）与联网搜索照留核心 | 删掉对 B 站包的 import；来源专有工具经 `AiToolProvider` 登记 |
| `storage` | 一等 | 持久化底层（原子写、写道）、主密钥与加密 | `CookieStore` 随 B 站进 `bilibili/` |
| `subscription` | 一等 | 订阅仓、身份唯一的规则 | 去掉 `findByUid` |
| `ui` | 一等 | 纯展示组件 | 新增统一的密钥输入框、素材选择器 |
| `extension` | 2.5 的门 | 拓展契约 v3 | 见 [extension-contract.md](./extension-contract.md) |
| `api`、`blive`、`dynamic`、`live` | 二等 | — | 搬进 `apps/server/src/bilibili/` 各成子目录，包删掉；中立部分进服务端 `posts/` 与 `live/`；api 删掉 7 个没人调的方法 |

`apps/contract` 是一等：服务端与面板之间所有请求、响应、WS 帧的唯一来源。

搬 B 站四个包（约 8,800 行、43 个测试文件）之前先断开别的使用方：面板的登录态类型改从 contract 取，image 的大航海等级表归 B 站，ai 的 B 站查询工具改由 B 站登记。第三方依赖（cron、md5、qrcode、protobufjs、ws、luxon）并进服务端。

### 共享件归位

| 东西 | 进哪 |
| --- | --- |
| 两个及以上包或应用要用的纯逻辑、常量、中文名表 | internal（零依赖子路径） |
| wire 上的形状 | contract |
| 纯展示组件 | ui |
| B 站专属 | 服务端 `bilibili/` |
| 持久化底层 | storage |

internal 不当杂物间。已扫出、要在 1.0 收掉的重复（🔴 = 几份之间已经有行为分歧，在它所属那一期里最先收；各项归哪一期见 [construction-plan.md](./construction-plan.md)）：

- 🔴 卡种中文名 5 张表、两套键（dyn / dynamic）→ internal
- 🔴 「要不要开直播监听」3 套判据（首页 4 键读未合并的 routing，服务端 6 键读合并后的）→ internal，全仓唯一判定
- 🔴 「N 分钟前」4 份 → `formatAgo`（⛔ 首页「正在直播」不写「N 分钟前开播」：面板只列在播的，「开播」多余，`dashboard-live-now.test.tsx` 钉着，收的时候别顺手加上）；带正负号的增量 4 份（负号两种、零两种写法）→ 并进 `formatCount`
- 🔴 B 站动态转纯文字两个同名函数（AI 工具那份丢掉转发）、B 站风控码集合（-412 各处不一，见 subscription-sources「风控码」）与响应解包（手写约 5 处）→ `bilibili/`
- 串行队列至少 11 处手写 → `createSerialQueue`（含按键分队）；两个同名不同义的 `createSerialGate`（internal、live 各一）拆成 `createSerialQueue` 与 `createRenderGate`
- `isPlainObject` 15 份、两种判据，internal 正本没导出 → internal 零依赖子路径
- 深比较（稳定序列化 2 份、键序敏感的比较 5 处）、重试 3 套、本地日键 / 日轴 / 时区参数（`tzOffset` 与 `tz` 两种写法）→ internal
- 时刻显示至少 7 份 → internal（精度差异有的是刻意的，逐条确认，别一刀切）
- 字节数写法约 12 处、woff2 提示句抄 4 份 → internal
- 生效特性：面板 3 处以写死的默认值为底 → internal 零依赖入口；`SubItemView` 由它产出
- 原子写：服务端三份逐字相同的私有副本 + 约 8 种各写各的临时文件写法 → storage 的 `atomicWriteJson`；`update/durable-json.ts` 并进来（见 data-and-migration「持久化底层与关停」）
- 资产存储三份 → 一份 `createAssetStore`；两个皮肤库 → 一份 `createSkinStore`
- 漏在 contract 外的 wire 类型：`/api/health` 在面板手抄 5 份、备份格式两份且 PIN 只在面板校验（服务端不验）、登录态 4 种形状 → contract
- 密钥打码：服务端 `maskSecret`、contract 的 `MaskedSecret`、面板 `SecretChip` 已成套，面板组件进 ui
- 零碎：webhook URL 打码两份、`LogLevel` 两份（只在 internal 留一份，contract 转口）、`PushKind` 同名不同义（见 data-model「特性键与推送种类」）、`escapeRegExp` 两份、HTML 去标签两份（一个解实体一个不解，合并前先定解不解）
- 大航海等级表与等级名、`GuardLevel` → `bilibili/`
- internal 里放错的：B 站视频链接识别、`LoginSnapshot` → `bilibili/`；`BiliEvents` / `DynamicDetectedEvent` 改成中立事件、留在核心；链接卡闸门配置（`LINK_REPLY_FORMS` / `LINK_LIMITS`、link-cards schema）是核心的，留 internal；没人用的 `withLock` 删；`deterministic-uuid` 搬回唯一的使用方（`config/store.ts`）；更新镜像前缀搬进 contract

## apps/server/src/

按功能分目录，B 站的全部放顶层 `bilibili/`。

```
compose.ts         组装根：登记 B 站的各个实现与拓展宿主（整个核心只有它能 import bilibili/）
subscriptions/     订阅、资料刷新、身份唯一闸、SubscriptionSource 登记表与接口定义
accounts/          账号：系统 → 账号、排序、汇总各来源登录态
images/            图库：fetchImage / storeImage 的落点、按引用清扫
push/              路由、闸、免扰、多路分发、TargetDispatcher、出错告诉主人
posts/             作品装配：推一条 Post，不管来自哪里
live/              中立场次引擎（场次、断流接续、定时、在播表）、直播装配与附加项生产
link-cards/        链接卡：闸门、出口、LinkResolver 登记表
commands/          指令框架 + 通用指令（help / mute / report / status）+ CommandProvider 登记表
roast/             锐评：生成、审批、定时、投递（从 stats/ 拆出）
stats/             统计仓与聚合（含粉丝时序、seen）
history/ ai/ skins/ library/ maid-skills/
process/           进程基础件：puppeteer、资源采样、宿主看护（孤儿自检与 stdin 关停、重启能力）
extensions/        拓展宿主：生命周期、ctx、市场、安装、设置、视图 + 收件口
bilibili/          B 站：SubscriptionSource 实现、auth/（扫码登录）、LinkResolver、指令、AI 工具；原四个包各成子目录
bilibili/devtools/ B 站的 DevtoolsProvider，只在开发版登记
runtime/           只留 service-context、message-bus、引擎编排（engines.ts 拆三份）
routes/ ws/ outlets/ config/ backup/ update/ devtools/ logs/ types/ util/
```

- 中立装配住服务端，不开新包：作品装配在 `posts/`，直播装配与直播附加项的生产在 `live/`。装配把来源交来的 `PostEvent` / 直播信号做成要发的消息，步骤见 [push.md](./push.md)「装配」。
- 原 `runtime/extension-*` 那批文件按功能归 `posts/`、`live/`（中立场次引擎）、`subscriptions/`、`stats/`。
- jieba 的 wasm 跟着 `live/` 进打包清单，改完要跑 `vp run build:update-payload`。
- 被否的备选：适配文件散进各功能目录（B 站代码散在十几处，守卫只能靠文件名约定）；`sources/bilibili/` + `sources/extension/`（多一层，还把 BN 自己的中立逻辑挂成了「对接拓展」）。
- `bilibili/devtools/` 被否的备选：放 `src/devtools/bilibili/`、B 站句柄从外面注入。

面板（`apps/web`）：

- 页面私有的件回到 `pages/<页>/`，`components/` 只放至少两处复用的件。
- 文件名全部 kebab-case（组件与 hook 也改；要改名的连测试 172 个，其中 52 个只改大小写，得用两步 `git mv`）。
- 每个接口只在 `services/<域>.ts` 写一次，类型从 contract 取；纯逻辑进 `utils/`，不另开 `lib/`。
- 读来源一律经 `GET /api/sources` 的 descriptor，删掉所有 `isBili` 分叉。

## 接口族与登记表

核心只认一组中立接口。每种接口一张登记表，键都是 `SourceKey`（`"bilibili"` 或拓展 id，不加前缀；分派读 `identity.sourceKey`）。接口全文见 [subscription-sources.md](./subscription-sources.md)。

| 接口 | 管什么 | 登记表 |
| --- | --- | --- |
| `SubscriptionSource` | 订阅一个人：搜人、拉资料、直播状态、登录、预览。共 10 个成员（descriptor、必备 4 个、可选 5 个）；没有「新建 / 启用订阅」钩子，订阅变化只经 ctx 的 `onSubscriptionsChanged` | `subscriptionSources` |
| `LinkResolver` | 群里的链接 → 链接卡 | `linkResolvers` |
| `CommandProvider` | 来源自己的私聊指令 | `commandProviders` |
| `AiToolProvider` | 来源专有的 AI 工具与技能 | `aiToolProviders` |
| `DevtoolsProvider` | 开发版的造状态 / 造事件场景 | `devtoolsProviders`（只在开发版） |
| `PushOutlet` | 推送侧：把消息交给某种连接 | `pushOutlets` |

```ts
interface ClaimTable<T> {           // 现成的 createClaimTable，补一个 entries()
  get(key: SourceKey): T | undefined;
  claim(key: SourceKey, value: T): { dispose(): void };   // 一个键一个主人；只撤自己那行；撤了能再登
  entries(): Iterable<[SourceKey, T]>;
}
```

键为什么不需要前缀：不带点的拓展 id 本就只留给官方源（第三方必须写成 `<命名空间>.<名字>`），`ExtensionIdSchema` 再把 `bilibili` 列为保留 id，手动放进目录的拓展也撞不上内置来源。原先按订阅 `kind` 分派认不出是哪个拓展的问题，由身份摊平成 `{ sourceKey, externalId }` 解决。

## compose.ts 装配

整个核心只有 `compose.ts` 能 import `bilibili/`；`index.ts` 只管启动。

```ts
const bili = createBilibili(options);
subscriptionSources.claim("bilibili", bili.source);
linkResolvers.claim("bilibili", bili.linkResolver);
commandProviders.claim("bilibili", bili.commands);
aiToolProviders.claim("bilibili", bili.aiTools);
if (isDev) devtoolsProviders.claim("bilibili", bili.devtools);
```

拓展在清单的 `contributes` 里按需声明，宿主启用时以拓展 id 登进对应的表、把撤销把手交给生命周期；停用、卸载即撤，不用重启。1.0 对拓展开放哪些键见 [extension-contract.md](./extension-contract.md)。

## 核心功能怎么接来源

分派按 `identity.sourceKey` 查登记表，不再点名 B 站。来源上报只带 externalId，核心按身份展开到订阅；来源看不到订阅 id。

| 功能 | 核心负责 | B 站实现 | 拓展 |
| --- | --- | --- | --- |
| 推送 | 按订阅 id 路由、闸、附加项；中立装配；按身份把上报展开成每条订阅一份 | 拉动态、把弹幕通道翻成直播信号，按 externalId 上报 | 报订阅事件（同样只带 externalId），宿主翻好交装配 |
| 直播 | 唯一的场次引擎、定时调 `fetchLiveStatus`、在播表、「会不会被监听」的唯一判定 | 直播信号 + `fetchLiveStatus` + `liveInteractions` | 直播信号，可选 `fetchLiveStatus` |
| 出卡 | 中立卡种、皮肤、卡种注册表；图只认图库引用 | 动态翻成 `Post`、附加块翻成三种中立数据、用 `ctx.fetchImage` 抓图 | 宿主把作品翻成作品卡 |
| 搜人 | `GET /api/sources/:sourceKey/creators?q=`，去重用 identity；按 id 取人不另开路由，搜索已认 id（09-27 拍板） | `searchCreators`（UID、主页链接、名字都认） | `searchCreators`（契约的 `lookup` 改名） |
| 链接卡 | 闸门与出口 | `LinkResolver` | 1.0 暂不开 |
| 指令 | 框架与 `help` / `mute` / `report` / `status` | `CommandProvider`（`login`）；`health()` 交一行 | 1.0 暂不开；`health()` 交一行 |
| AI | 生成器、人格、中立只读工具与内置技能 | `AiToolProvider` | 1.0 暂不开 |
| 资料、头像与粉丝 | 定时调 `fetchProfile`；增量、时序、头像进图库、显示名链 | `fetchProfile` | `fetchProfile` 或主动 `reportProfile` |
| 统计与锐评 | 中立统计仓与聚合；「那天有没有在看」按 seen | — | — |
| 账号 | 系统 → 账号、头部、新手引导登录步 | `auth` | 可选 `auth` + `ctx.secrets` |
| 预览 | 卡片页预览、按订阅覆盖 | `fetchPreview` | 可选 `fetchPreview` |
| 健康与问题 | 健康页回 `sources[]` + 核心模块；问题框与私聊节流 | `health()`、`reportProblem` / `resolveProblem` | 同左 |
| 备份与日志脱敏 | 备份信封按来源分格（内容就是各来源的 `ctx.secrets`）、日志按真实密钥值脱敏 | `ctx.secrets` + `ctx.redact` | `ctx.secrets`、`ctx.redact` 与 secret 字段自动覆盖 |
| 历史与重推 | 全部 | — | — |

现在服务端有 22 个非测试文件直接 import B 站的包，其中 routes/subs、routes/auth、routes/cards、routes/health、app.ts 是核心在点名 B 站——这些都要改成经登记表。

## 总线事件

MessageBus 仍是唯一的事件通道（「绝不写转发器」那条铁律不变）。1.0 总线只留一套**按订阅 id 发**的中立事件：来源只报 externalId，核心在进门那一刻按身份展开成订阅 id；统计只剩一个适配器（`bindStatsRecorder`）；WS 转给面板的也是中立事件，contract 里的 WS 载荷类型直接从总线事件表推导。事件名一律「名词-过去分词」。

| 事件 | 载荷 | 替掉的 |
| --- | --- | --- |
| `post-detected` | `PostEvent` | `dynamic-detected`；拓展作品也发 |
| `live-session-changed` | `LiveSessionChange` | `live-state-changed`、`extension-live-session`、`extension-live-changed` |
| `live-viewers-changed` | `{ subscriptionId, currentViewers?, totalViewers? }` | 原来的人数文字 |
| `subscription-auth-changed` | `{ sourceKey, status, detail }`，status 是 `AuthState` 的状态值，detail 用 contract 里该来源的登录 wire 类型 | B 站四个登录事件；原载荷的 `kind` 改叫 `sourceKey` |
| `followers-refreshed` | 按订阅 id 的粉丝刷新条目 | `fans-refreshed`（去掉 uid / extensionId 三格） |

- 来源级问题不走 `engine-error`，改走 `ctx.reportProblem`。出卡失败这类流水线错误仍走 `engine-error`，`source` 改成中立的模块名（名字施工时定）。
- 施工时补一张「现有 22 个事件 → 1.0 去向」的全量表（含 `subscription-reported` 这类宿主内部事件），写进 events.md。
- 直播互动（弹幕、SC、会员、进场）走能力回调还是走总线施工时定；弹幕是高频流，要在 events.md 写清。
- 被否的备选：另开一条 B 站私有总线（违反「MessageBus 是唯一事件通道」）。

## wire 契约

- `apps/contract` 是唯一来源：每个请求体、响应体、WS 帧有且只有一份；服务端的 zod 用契约类型钉住。
- WS 有一张事件表，载荷一律是具名对象（不发裸元组），类型从总线事件表推导。
- 错误体只有一种：非 2xx 是 `{ code, message }`，业务失败是 `{ ok: false, code, message }`。操作结果的 `ok` 保留（布尔前缀规矩的例外）；失败原因只用 `code` + `message`；上游平台的错误码放 `upstreamCode`，不占 `code`。
  - 防撞 B 站那种 `{ code, message, data }`：`code` 只装 BN 自己的错误码（字符串、snake_case，如 `not_found`、`upstream_failed`），永远不装平台的数字；平台的数字码只放 `upstreamCode`（现 `routes/subs.ts` 两处把 B 站的码塞在 `code` 里，契约骨架时改）；平台的原始响应不直接转给面板，一律在来源那层翻成 BN 的形状。主人 09-27 看过嵌套的 `{ error: { code, message } }`，选回平铺。
- 路由按新名：`/api/subscriptions`、`/api/followers`、`/api/library`、`/api/sources`（来源的 descriptor 与登录状态）、`/api/sources/:sourceKey/creators?q=`（搜人）、`/api/history?feature=`、`/api/targets/:id/test`（原 `/api/push/test`）、`/api/connections/:id/probe`（原 `/test`）。
- 设置拆进 `config/settings.json` 的三类段以后，系统页的字段路径与 `PATCH /api/globals` 跟着改（原 `app.*` 搬进 `core.*` / `bilibili.*`）。
- 删掉死字段 `SubscriptionDTO.state`；订阅卡上永远不亮的「播」角标改用真实的在播数据。
- `/api/health` 补进契约，moduleVersions 删掉 api / dynamic / live，`dynamicCron` 删掉。面板把 contract 移进 `dependencies`。
- 密钥下发只用 `MaskedSecret`，见 [data-model.md](./data-model.md)「凭据字段标 secret: true」。

## 守卫

每条规矩配一道会变红的门。扫源码的守卫共用一套仓库级工具（遍历、剥注释、抠 import、白名单与逐行放行标记），收编现有的 walk.ts、stripComments、importSpecifiersIn。写法仿拓展边界守卫：判据是纯函数、配样例、真扫目录。

| # | 守卫 |
| --- | --- |
| 1 | 核心目录不许 import 服务端 `bilibili/`，例外只有 `compose.ts`；和现有两条拓展边界合成一张「谁不许 import 谁」的边界表 |
| 2 | 测试进程对外请求一律失败（只放行本机地址）——施工第一片（第 0 期，见 [construction-plan.md](./construction-plan.md)）。已落：`scripts/network-guard.mjs`，挂在根配置的 `test.setupFiles`；拦在 `net.Socket#connect`（fetch、http、ws、WebSocket 都经过它），每条测试收尾查账，被测代码吞掉了报错也判失败。管不到：测试起的子进程（Chrome、脚本）、直接调 `dns.lookup`、在包目录里跑 `vp test`、本机代理转发 |
| 3 | 服务端除了持久化底层，不许直接写文件（writeFile、rename、appendFile）。底层要接住原子写 JSON、追加 JSONL、原子写二进制、整目录替换；白名单只有 config/persist.ts 那份保留注释的 YAML |
| 4 | 同一个导出名全仓只定义一次；另有「名字 → 唯一的家」点名表（`isPlainObject`、`formatCount`、`formatDuration`、`formatAgo`、`subscriptionIdentityOf`、`displayNameOf`、`createSerialQueue`、`atomicWriteJson`、`createAssetStore`、`createSkinStore` 等），家以外出现同名定义就红，含不导出的局部函数。不扫 extensions/ 与测试夹具，TS 重载不算多次定义。改了名的抄本拦不住，靠审查。 |
| 5 | 面板里 `"/api/"` 字面量只许出现在 `services/` |
| 6 | 注释里写的仓内路径必须指向真实存在的文件 |
| 7 | 测试只放 `__tests__/`；文件名一律 kebab-case（biome `useFilenamingConvention`）。前半已落：`scripts/__tests__/test-file-layout.test.mjs`，全仓无例外（`scripts/` 也搬进了 `__tests__/`） |
| 8 | 服务关停返回以后，数据目录不再变化（端到端） |
| 9 | 存储层拒收同一身份的第二条订阅，所有写入路径各一条测试 |
| 10 | B 站动态出图的字节快照长期保留 |
| 11 | 核心里不许出现 B 站专有词：范围 `packages/` 全部 + 服务端 `bilibili/` 以外；contract、面板、测试、夹具不扫；词表 `DYNAMIC_TYPE_`、`bvid`、`hdslb`、`bilibili.com`、`b23.tv`、`live_status`、`WATCHED_CHANGE` 等，不收 `uid`；先剥注释。确实要留的进白名单、附理由。现查中立包里约 68 处、服务端约 50 处。以棘轮开启（3a 开头记下命中数当上限，只许少不许多，3b 结束清到 0），这就是中立化的验收线 |
| 12 | 核心代码不许读设置的 `bilibili` 段 |
| 13 | 迁移清单完整：以 FeatureKey / CardKind / ExtraKey 做键的记录全部钉进迁移清单；对数据根的 `join(dataDir, …)` 前缀都必须在目录表里 |
| 14 | devtools 换桩表写死两项目录（`src/devtools`、`src/bilibili/devtools`，⛔ 不用通配），隔离测试认两个引用点。构建后自检不动。 |
| 15 | 桥协议的帧形状与通用 webhook 的 JSON 各一条快照守卫 |
| 16 | 改名收尾：每批改完旧名 grep 为零（桥协议、webhook、`bilibili/` 里 B 站原字段、卡片皮肤包清单的 `author`（指皮肤作者）进白名单） |
| 17 | 来源不读写文件：`bilibili/` 里出现 `fs`、`node:fs`、`fs/promises` 的 import 就红 |
| 18 | `bilibili` 是保留 id：`ExtensionIdSchema` 拒收，同拒绝原型名的写法 |
| 19 | 主人目标必须是私聊目标：`master.targetId` 指向群目标时 schema 校验不过；面板选主人的下拉只列私聊目标 |
| 20 | 拓展清单的 `supportedFeatures` 超出 1.0 开放范围（`post` / `liveStart` / `liveStreaming` / `liveEnd`），或声明 `liveStreaming` 却没实现 `fetchLiveStatus`，装载时拒收并说明原因 |
| 21 | 中立性对拍（09-27 加）：用仓库里的假源拓展把 B 站用到的每一种中立能力走一遍端到端（带图标的链接片段、直播、资料、问题上报等）；只有 B 站走得通、拓展走不通的就是后门。词表与 import 守卫抓不到语义上的后门（例：照搬 B 站的 `video \| lottery` 图标枚举，一个 B 站词都没有），靠它抓。3a 检查点的验收之一 |

守卫 4 上线前要先清掉现有重名：`BootstrapConfigSchema` 两份（服务端 `config/schema.ts` 那份 `cookieEncryptionKey` 可选、至少 1 位；internal 那份必填且至少 16 位）合一并**按可选**（否则没设密钥的用户开不了机）；`CommentaryClient` / `SubscriptionsView` / `ConversationRole` 各两份合并；`createDevtools` 的 stub 和零 import 文件里的 `isPlainObject` 进白名单并写明理由；`runtime/video-card.ts` 的 `formatDuration(seconds)` 改叫 `formatClock`。

## 明确不改的

- 产品名 bilibili-notify 与包作用域 `@bilibili-notify/*`。
- `bilibili/` 里贴着 B 站接口的原始字段名，以及 B 站内部的 `uid` / `roomId`。
- `bilibili/` 内部名实相符的名字（如 `biliLiveCardInput`）。原先还列了 `BiliSubscription`、`isBiliSubscription`、`BiliStatsSourceOptions`，已被 09-27 的身份摊平与改名取代：订阅不再分 B 站支，`isBiliSubscription` 删掉、按 `sourceKey` 判，统计适配器合成 `bindStatsRecorder`。
- **日志行格式**（`msg`、`ts` 等）：logs 跨代共享、冻住的桌面壳写死了目录。
- **通用 webhook 发出的 JSON**（`forward`、`ts` 等）：读它的是用户自己的接收端，永远不改。
- **桥协议的线上帧**（`forward`、`desc`、`picUrl`、能力名 `forward`、`miniapp-card` 等）：已发布的插件在读，握手只比主版本。内部改名只改到桥的 adapter；真要改走两步（先发一版插件同时认新旧字段，等大家升上去 BN 再切）。这些冻结的线上名字 1.0.0 之前全部改成内部新名（09-27 拍板）：`forward` → 合并转发 `mergeForward`、`desc` → `description`、`picUrl` → `imageUrl`、能力名 `forward` 同改、能力名 `miniapp-card` → 原生分享；alpha 不动，alpha 之后、1.0.0 之前按两步走一次改完，之后出口里的新旧映射整个删掉，见 [construction-plan.md](./construction-plan.md)。
- 拓展契约里的毫秒时刻、签名清单的 `issuedAt`（秒）：已发出的格式，进门换 ISO。
- 已经拍板不动的：import 后缀两套并存；`FRAMES.live` 与 `FRAMES.wordcloud` 不合并；`skin.json` 与 `default.json` 双文件；锐评分数由模型打；`apps/contract` 放在 `apps/` 下。
- 全仓包版本统一 `0.0.0-dev` 是施工项、不是「不动」：现在只有 ui 与 `apps/*` 是 `0.0.0-dev`，其余包排在第 5 期统一（见 [construction-plan.md](./construction-plan.md)）。
- ⛔ 不做：extension 包版本对齐契约档位 + 守卫（兼容看清单 apiVersion 与 EXTENSION_API_RANGE，不看包版本）。
- alpha 不做、1.0.0 之前做（09-27 改，原定「1.0 之后」）：devtools 换 devframe、新手引导换 driver.js，各自先做小试验再定，见 [construction-plan.md](./construction-plan.md)。devframe 要先查清许可证和维护者，并重新验证 devtools 不会进生产产物；driver.js 要先验证引导锁（聚光灯外不能操作，⛔ 不许放开）、跨页面的步骤与晚挂上的锚点、能不能跟随界面皮肤。真正拦住拓展读写文件也不做（要等沙箱）。
