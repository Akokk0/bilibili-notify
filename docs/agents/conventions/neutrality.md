# 中立性

**这条管核心里能不能出现「B 站」这个概念。** 核心指一等的中立核心：`packages/`、服务端里 `bilibili/` 与 `platforms/` 以外的部分、`apps/contract`、面板；集成指 `bilibili/`、每个拓展、每个内置平台适配器（见 [README.md](README.md)）。这是活规范，可以直接改，但加条、改条要主人拍板；为什么这样定见 [ADR-0021](../../adr/0021-neutral-core.md)「判据」。

判据只有一条：**核心里出现「B 站」这个概念，就算越界。** B 站的东西要么搬回 `bilibili/`，要么变成核心的中立概念、由 B 站去实现。B 站与拓展一样，只经中立接口进核心，没有后门；两边的区别只在谁写、住在哪、开放多宽。

## 规矩

**1. 核心里不按平台分叉。**
- 不写 `isBili`，也不换个写法写回来：`sourceKey === "bilibili"`、`"@bilibili"` 哨兵、`BILIBILI_*` 常量、`Bili*` 类型。
- 不写死平台叫法（「UP 主」「B 站」「舰长」「UID」）。该怎么叫见 [nouns.md](nouns.md)。

```ts
// 错：按来源分叉
if (sub.identity.sourceKey === "bilibili") showGuardTab();
// 对：问描述符
if (descriptor.membershipPrograms?.length) showMembershipTab();
```

**2. 身份只有 `{ sourceKey, externalId }`。** 中立层不出现 `uid`，包括事件载荷的键。B 站的 uid 在 `bilibili/` 里就当 `externalId` 交出来。

```ts
// 错
emit({ uid, post });
// 对
emit({ identity: { sourceKey, externalId }, post });
```

**3. B 站只经登记表进核心。**
- 只有 `compose.ts` 能 import `bilibili/` 与 `platforms/`；`bilibili/` 的东西在那里只能作登记的参数。
- 核心拿不到平台客户端。给路由临时调 B 站用的句柄（旧的 `engines.api`）不许再有。
- 核心不 import 拓展，拓展只从 `@bilibili-notify/extension` 进（拓展那条另有守卫，见项目根 CLAUDE.md）。

**4. 只有 `TargetDispatcher` 能发送。** 发出去的每一条都经它：广播、主人通知、目标测试、卡片发送、人工重推。链接预览与指令的回复走它的 `sendToAddress`：不进路由、不过闸、不落历史，但要查 `isAvailable`、结果带 code、由截流统一记，不重试。不许现造临时目标去直调适配器的 `send`。

**5. 核心读 `.platform` 只许三件事：构造身份、显示、记日志。** 要按平台做决定，就问适配器的能力（`atAll`、`inbound`）。换个名字的谓词也算按平台名做决定。

```ts
// 错
if (platformSupportsAtAll(conn.platform)) addAtAll(msg);
// 对
if (adapter.capabilities.atAll) addAtAll(msg);
```

**6. 核心不读设置的 `bilibili` 段。** 解构（`const { bilibili } = settings`）与下标（`settings["bilibili"]`）都不行。

**7. 不给中立形状加平台专属的枚举。** 需要通用能力就加通用能力（如卡片行 `{ text, icon?: ImageRef }`），不照搬 B 站的 `video | lottery` 图标枚举。

## 边界与例外

- `bilibili/`、内置平台适配器（`platforms/`）、拓展自己的目录里可以出现 B 站与平台的词，它们是集成。
- 迁移模块要读老数据，可以出现 `uid`、`bilibili` 这些老形状；它在几道扫描里都进白名单。
- `compose.ts`、保留 id 表、设置 schema 的组合处，是 B 站合法露面的地方，白名单里逐个列着。
- 「投稿」「动态」这两个叫法在面板与 CSV 里保留（ADR-0021 决策 50），不算越界。
- 外部协议定死的字段名，出现在 `bilibili/` 与 `platforms/` 里不受限；进了核心的类型就得换成中立的名字。
- 面板也算核心，只是它归「B 站替身」与「中文叫法棘轮」管，守卫 11 不扫面板；contract 由守卫 11 与「B 站替身」一起扫。
- 「只装了 B 站时混用处也用 B 站的叫法」是叫法规矩，不是分叉的许可：核心还是不判断「是不是 B 站」，只读描述符。
- 用户自己写的文案、提示词里的 B 站词，不归这条管，迁移与内置预设的处理见 [nouns.md](nouns.md)。

## 怎么钉住

三层（ADR-0021 决策 59；判据与范围以 [architecture.md](../../1.0/architecture.md)「守卫」为准，期次以 [construction-plan.md](../../1.0/construction-plan.md)「中立性守卫的归期」为准）。棘轮的规矩：开的那一刻记下命中数当上限，只许少不许多，到清零期必须是 0。

| 层 | 守卫 | 扫什么 | 期 |
| --- | --- | --- | --- |
| 咽喉 | 入口咽喉 | `compose.ts` 里 `bilibili/` 的东西只能作登记的参数（按 AST 判），核心的依赖包里没有平台客户端。落在 `scripts/__tests__/entry-throat.test.mjs`，四条判据：① `compose.ts` 导出的声明里类型位置上不许出现集成的名字（本地的类型别名、接口、函数的形参与返回类型、类、导出的命名空间转一手也算），历史欠账按名字记上限；② 集成的值在 `compose.ts` 里只能被调用、直接作调用的实参或作导出常量数组的元素，指向集成目录的转出一律不许；③ 交回入口的 `BuiltinIntegrations.bilibili` 那一格的成员只许少，要等于名单；④ 核心里名字正好是 `api` 的槽位按文件记数只降不涨。它抓不到什么，见守卫文件头 | 3a |
| 咽喉 | 出口咽喉 | 适配器登记表对外只给不含 `send` 的视图；源码扫描白名单只有 `TargetDispatcher` | 3a |
| 咽喉 | 咽喉 e2e | 逐条驱动全部发送路径，每条恰好一条截流记录、零外连 | 3a |
| 咽喉 | 出图器零联网 | 渲染页拦截请求（闸在浏览器适配层，每一页都开，只放行 `data:`）；交给渲染页的 HTML 里扫不出网络地址；`packages/image/src` 里不许出现 `fetch(`、`node:http(s)`、`undici` | 3a |
| 静态扫描 | 守卫 1 与推送守卫① | 核心不许 import `bilibili/`、`platforms/`，例外只有 `compose.ts` | 3a |
| 静态扫描 | 守卫 12 | 核心不读 B 站的设置。只有组装处 `compose.ts` 能引 `bilibili/settings.ts`（白名单只有它一个文件）；棘轮表是空的（B 站接线早已不引它）。解构与下标的写法由 B 站替身棘轮兜底。 | 1⑥ 棘轮开，3a 清零 |
| 静态扫描 | B 站替身 | 核心、面板、contract 里正好是 `"bilibili"` / `"@bilibili"` 的字面量，以及按驼峰段与下划线段切开后有一段是 `bili` / `bilibili` 的标识符（`isBiliSubscription`、`BILI_ONLY_EXTRAS`、`fromBilibili` 都算） | 1⑥ 棘轮开，4 末清零 |
| 静态扫描 | 守卫 11 与推送守卫② | B 站专有词、推送平台专有词，先剥注释。🔗 3a-41 已开：`scripts/__tests__/bilibili-vocabulary.test.mjs`（`platforms/` 与迁移模块以外，词表是手写词加 `bilibili/` 里 snake_case 的类型键，标识符整名或按段匹配、字符串按词边界、正则字面量与字符串 / 模板写的正则里的词也认（还原标点转义），`SESSDATA`、`bili_jct` 等核心里真在用的凭据字段名已手补；自动词表只认写成类型声明的字段，没写成类型声明的原始字段不在里面，核心里今天真在读的 `live_room` / `roomid` 已手补，「现生成 = 快照」那条只证明两边一致、不证明没漏）与 `scripts/__tests__/platform-vocabulary.test.mjs`（词按连续几段拼起来匹配；`compose.ts` 整文件白名单；`webhook` 不在词表）；实现走语法树，注释天生不是节点 | 3a 棘轮开，3b 末清零 |
| 静态扫描 | uid 棘轮 | `bilibili/` 与迁移模块以外出现 `uid`。🔗 3a-41 已开：`scripts/__tests__/uid-ratchet.test.mjs`，标识符有一段是 `uid` / `uids`、字符串整个正好是 `uid` / `uids` 才算，不扫面板 | 3a 棘轮开，3b 末清零 |
| 静态扫描 | 中文叫法棘轮 | 见 [nouns.md](nouns.md) | 4 棘轮开，5 末清零 |
| 静态扫描 | `.platform` 决定棘轮 | 核心读 `.platform` 做决定。🔗 3a-41 已开：`scripts/__tests__/platform-decisions.test.mjs`，平台值流到比字面量、`switch`、查表、喂函数、在平台值上调任何方法这几种会分叉的位置才算，`platform ?? x` / `platform || x` 这类带兜底的也看穿，两个平台值比相等（平台对平台，两边都得是从对象上读出来的）与问有没有不算；面板另记一张表；已知会漏过去与会误中的写法列在守卫文件头，判据不再逐个改 | 3a 棘轮开，3b 末清零 |
| 静态扫描 | 事件载荷 | 总线载荷类型递归检查：不许有 `uid` 键、`Bili*` 类型，平台原始值不许以裸 `string` 进载荷 | 1④ |
| 对拍 | 守卫 21b | 测试 compose 里登记一个假来源与 `AiToolProvider`，断言内容。🔗 3a-42 已落（10-12）：`apps/server/src/__tests__/in-process-source-parity-e2e.test.ts`，夹具 `apps/server/src/__tests__/support/in-process-source.ts`（假来源键 `acme.inprocess`，经真入口与真 `compose.ts`，与真 B 站来源并排在册）。接口上今天没有的成员列在同一个文件的「这版不开」名单里（`PARITY_ROWS` 里 `checked: false` 的行，每行必须写等哪一期与理由）；`AiToolProvider` 的登记与撤销已转成 P42。当前 `PARITY_ROWS` 共 50 行（P01–P42 对拍，另 8 行不开）。**给 `Source` / `SourceContext` / `SourceDescriptor` / `SourceAuth` 加一个成员，那个文件类型检查就过不去，必须来补一行（指向管着它的对拍行）**。夹具不许 import `bilibili/`、不许写 B 站的键常量与字面量，有一条用例钉着 | 3a 检查点验收 |
| 对拍 | 守卫 21a、推送守卫③ | 假源拓展经契约 v3、假适配器逐成员走一遍。🔗 3b-46 已落（10-25）：两道同住 `apps/server/src/__tests__/extension-contract-parity-e2e.test.ts`，装仓里 `extensions/fake-source/` 的构建产物（假适配器是它的推送口 `src/adapter.ts`），开机后才拨开、经公开口驱动、零外连。六张行表共 47 行（`Source`、清单订阅段、拓展来源上下文、`PlatformAdapter`、清单推送段、适配器上下文），每行写走通 / 另一份 e2e 管着 / 不开（带理由与证据）/ 宿主填。**给这六样里任何一样加一个成员，那个文件类型检查就过不去，必须来补一行**；开放的来源成员要与 `extensions/extension-source.ts` 的 `SOURCE_DEF_MEMBERS` 对得上 | 3b |

词表抓不到语义后门（比如照搬 `video | lottery` 图标枚举，一个 B 站词都没有），只有对拍够得着。

审查时逐条看：
- diff 里有没有 `sourceKey ===` 某个具体平台、有没有新的 `uid`。
- 新加的可选参数、回调、句柄，是不是让核心拿到了平台客户端。
- 新的发送是不是经 `TargetDispatcher`。
- 新加的字段与枚举，换一个平台还成不成立；只有 B 站填得出的，放进 `bilibili/` 或做成可选能力。

## 出处

- [ADR-0021](../../adr/0021-neutral-core.md)：「判据」；决策 2（`compose.ts` 是组装根）、10（描述符）、14（身份摊平，中立层不出现 `uid`）、35（叫法由来源给）、50（「投稿」「动态」）、59（守卫三层）。
- [ADR-0024](../../adr/0024-push-platform-adapter.md)：决策 3（`atAll`、`inbound` 改成问能力）、13（只有 `TargetDispatcher` 能发送）。
- [ADR-0028](../../adr/0028-post-text-rendering-and-templates.md)：决策 2 与「明确不做」（不为保字节一致给中立形状加 B 站专属枚举）。
- [architecture.md](../../1.0/architecture.md)：「守卫」三张表与「棘轮」。
- [construction-plan.md](../../1.0/construction-plan.md)：「中立性守卫的归期」。
