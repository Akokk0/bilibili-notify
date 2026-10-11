# 设置校验

设置什么时候校验、坏了怎么办：保存时挡在门口，读取时只隔离坏的那一处，不让 BN 起不来。这是活规范，可以直接改，但加条、改条要主人拍板；为什么这样定见 [ADR-0025](../../adr/0025-integrations.md) 决策 4。

先说三个词。**信封**是整份设置文件；**段**是里面的 `core`、`bilibili`、`extensions.<id>`；**外壳**是一条连接的 `id` / `name` / `adapterKey` / `platform` 这四格。

## 规矩

**保存时校验**

1. 连接的 `settings` 按适配器的 `settingsSchema` 校验，不过回 400 并带原因。适配器不在场时先存下，不拒。
2. 拓展设置只校验这次动到的那几格，存量里别的不合规的不连坐（否则清单一收紧，连删一条坏项都被拒）。拓展跑着时，写入再过它自己交的 zod。

**读取时，坏一条只隔离那一条**

3. `bilibili` 段或某个拓展段校验不过：只停那一个集成，运行状态记 `settings-invalid`。面板显示原值与原因并进问题框，改对了当场起。
4. `core` 段逐格校验，每个顶层键一格，`defaults` 与 `ai` 再细一层。坏的那格在内存里退回默认值，盘上原文不动，问题表记一条 `settings_invalid`，主人在面板上重存那一格就清掉（重存 = 存进去的值与内存里跑着的值不同；面板的补丁值没变也照发，所以不按补丁里有没有这个键判。想要的值恰好是默认值时要存两次：先改成别的，再改回来）。
5. 一条连接的 `settings` 过不了适配器的 `settingsSchema`：只隔离这一条，不交给适配器、不投递；面板显示「设置不合法」与原因并进问题框，盘上原文不动。
6. 一条目标指向的连接不在了：只隔离这一条。
7. 撤下的旧连接形状写成明确的名单，不靠猜。

**只有三种情况挡开机**

8. 核心那一份设置文件的信封坏了（整份解析不了，或顶层不是对象）。`bilibili` 段、拓展段的文件解析不了不挡开机，只停读它的那几样。
9. 一条连接的外壳坏了。

还有第三种，它不是设置、是数据，所以不编号（上面的号被别处引用，不挪）：**订阅文件读坏**（形状不是 `{ tags, subscriptions }`、标签表不合规矩、任何一行过不了 schema）也挡开机，因为跳过坏行的话，下次写回那几行就永久丢了。推送目标文件同理（`store.ts` 的 `loadConnectionsAndTargets`）：文件不是数组、任何一行过不了 `PushTargetSchema` 都整个拒、报出第几行，不跳过那一行；连接文件不见了而目标还在也拒。订阅坏行隔离的事记在 [construction-plan.md](../../1.0/construction-plan.md)「以后再说」，排在第 3a 期之后（主人 10-11 定）。

**运行中与启动期**

10. 运行中的 `get()` 不抛。
11. 内置来源读设置不抛，拿到的是结果（`get()` 回 `Result`）：自己那一格读不懂，就让读它的那一样停着、问题表里说清，来源握着把手，改好了自己起。拓展照旧：只有 `activate` 期间读设置失败可以抛错中止启动，读不懂的拓展不会跑着，宿主接住转成 `settings-invalid`。

```ts
// 对：拿到的是结果，读不懂就停自己那一样、报一条问题，握着把手等改好
const reader = ctx.settings(schema);
const apply = () => {
  const read = reader.get();
  if (!read.ok) return ctx.reportProblem({ code: "xxx_settings_invalid", message: "…" });
  run(read.settings);
  ctx.resolveProblem({ code: "xxx_settings_invalid" });
};
apply();
reader.onChange(apply);

// 错：读不懂就自己抛，把一处坏设置放大成整台 BN 的问题
if (!read.ok) throw new Error("settings broken");
```

**为什么不能挡开机**：BN 起不来时，桌面壳连续失败几次就把这一版判死、自愈退回旧版，而且进不去面板改设置；Docker 则反复重启。隔离是显式的，面板与问题框都看得见。面板登录凭据在 `bn.config.yaml`，不在这些段里，某格退回默认值不会把门打开。

## 边界与例外

- **`core` 某格退回默认时行为会变**（过滤、静音、新手引导），所以必须靠问题框亮出来，不能悄悄退。
- **状态值与问题码写法不同。** 运行状态 `settings-invalid` 是状态取值，写 kebab；`core` 段坏格记进问题表的码 `settings_invalid` 是问题码，写 snake，不受标准码表约束（见 [failure-results.md](failure-results.md)）。
- **`bilibili` 设置逐格：哪格坏，停读那一格的那一样**（主人 10-11 定）。动态那格（`dynamicCron`，读的人比读盘多一道「能解析」）读不懂停动态；登录检查那格（`healthCheckMinutes`）读不懂停定时的登录检查，登录本身照常、失效仍由请求撞 `-101` 报上来；整个文件不是合法 JSON 两样都停。**来源照常 `start`、照常在册**（B 站描述符、登录口、会员档位照旧），停着的那一样各有一条问题（`dynamic_settings_invalid`、`login_check_settings_invalid`，只进表、不私聊），改好保存当场起。
- **核心不读 `bilibili` 段**，那是核心与集成的界线，见 docs/1.0 的守卫 12。
- **备份从内存导出，带内存里的值**（主人 10-11 定）：退回默认的那格（核心的坏格、集成段的坏格、读不懂的整个集成设置文件）导出的是默认值，不是盘上原文；这样的备份一定恢复得了，原文还留在本机盘上。导出结果里提示哪几格是按默认值导出的，放第 4 期（要动导出回包与面板，这一片不做，导出时也不记 warn）。读不懂的拓展设置文件不在备份里。被隔离的连接与目标带哪一份，这里仍不预设。
- **「设置读不了」这个旧说法**（ADR-0019 决策 36，只管拓展）已被 ADR-0025 决策 4 延伸到内置集成，以后者为准。

## 怎么钉住

核心设置、集成段设置与拓展设置文件这几份已经有测试（第 3a 期 3a-39，[docs/1.0/phase-3a-plan.md](../../1.0/phase-3a-plan.md)「3a-39 已落」），其余仍靠审查把关。

**有测试或守卫钉着的**：

- 核心设置逐格退默认、盘上原文不动、重存按比值、密钥袋不被洗（真 `SecretStore`、真文件）、写失败时什么都不变：`config/__tests__/store-invalid-settings.test.ts`；解析与放回原文的纯函数：`config/__tests__/core-settings.test.ts`；问题表里只有一条：`config/__tests__/settings-problems.test.ts`，接线（真 `createAppRuntime`）：`__tests__/core-settings-problem-wiring.test.ts`。
- **核心设置文件只有一个落盘口**：`scripts/__tests__/core-settings-single-writer.test.mjs` 按语法树钉死，实参是 `this.path("globals")` 的写盘调用只许出现在 `persistGlobals` 里（放回原文才不会漏口子）。
- 集成段设置逐格、整个文件读不懂、比值、按字节回滚、恢复备份：`__tests__/config-store-integration-settings.test.ts`，纯函数在 `config/__tests__/integration-settings.test.ts`。
- 读设置的把手不抛、变了才叫、一个订阅者抛了不影响别的：`integrations/__tests__/settings-reader.test.ts`；挂在来源上下文上、随上下文收掉：`subscriptions/__tests__/source-context.test.ts`。
- B 站哪格坏停哪样、改好当场起：`bilibili/__tests__/source-settings.test.ts`；从真入口坏着开机、经真的设置路由存对、那一样起来（也钉着全量图里 `bilibili` 键一直在）：`__tests__/builtin-source-settings-boot-e2e.test.ts`。
- 拓展设置文件不是合法 JSON 只停那一个拓展：`__tests__/config-store-extension-settings.test.ts`、`extensions/__tests__/settings-invalid.test.ts`、`__tests__/extension-broken-settings-boot-e2e.test.ts`、`routes/__tests__/extension-settings-route.test.ts`。

**仍靠审查的**，逐条看：

- 新加的设置读取路径，坏值会不会走到抛错、挡开机；除核心信封、连接外壳与订阅文件外，有没有新的「坏了就起不来」（没法静态扫，只有上面那些开机测试按类各摆一种坏法）。
- 连接设置、订阅文件之外的写口：校验不过的，盘上原文有没有被改写或删掉（核心与集成段由上面的测试钉着）。
- 退回默认或被隔离的地方，问题框或面板有没有可见的提示。
- 新的连接设置有没有走适配器的 `settingsSchema`；适配器不在场时是不是先存而不是拒。
- 拓展设置的写入是不是只校验动到的格子。
- 集成自己在运行中读设置会不会抛（宿主造的把手的 `get()` 不抛由测试钉着，集成自己的代码仍靠审查）。

## 出处

- [ADR-0025](../../adr/0025-integrations.md)：决策 4（设置坏了只停那一处，不挡开机；生命周期闸）、决策 5（运行状态取值）。
- [ADR-0024](../../adr/0024-push-platform-adapter.md)：决策 9（连接不在了的目标只隔离那一条）、决策 10（连接设置的校验、外壳坏了才挡开机）。
- [ADR-0019](../../adr/0019-subscription-source-opening.md)：决策 35（拓展设置只校验动到的格子，跑着时再过它自己的 zod）、决策 36（旧的「设置读不了」，已被延伸）。
- [docs/1.0/data-and-migration.md](../../1.0/data-and-migration.md)：「设置坏了怎么办」。
- [docs/1.0/data-model.md](../../1.0/data-model.md)：「问题表」（`core` 段坏了记 `settings_invalid`）、配置里各段的坏法表。
- [docs/1.0/subscription-sources.md](../../1.0/subscription-sources.md)：「设置」（`settings(schema)` 的形状：内置来源拿到的是结果、读不懂不抛）。
- [docs/1.0/extension-contract.md](../../1.0/extension-contract.md)：拓展设置坏了只停这一个拓展。
