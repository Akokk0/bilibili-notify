# ADR-0031：指令与 devtools 场景

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）。**未施工**。
- **记录方式**：拷问当场落的定案。接口的正本在 [docs/1.0/](../1.0/) 的 subscription-sources；本份只写定了什么、为什么、否了什么。
- **影响面**：指令框架与各指令、登录指令、devtools 的登记表与场景、`apps/contract` 的 devtools 契约。
- **依赖**：[ADR-0021](0021-neutral-core.md)、[ADR-0024](0024-push-platform-adapter.md)（`sendToAddress`）、[ADR-0026](0026-failure-results.md)、[ADR-0008](0008-devtools.md)。

## 背景

文档写了 `CommandDef` 与 `DevtoolsScene` 两个名字，都没定义；代码里对应的是 `CommandSpec` 与 `DevScenarioDef`。指令出错时只打日志、不回话，回话发到主人目标那条连接而不是消息进来的那条；全仓只有一条来源自己的指令（B 站的扫码登录）。devtools 的场景 id 全局共用一个命名空间，参数里的 `sub` 是订阅 id，来源拿不到。

## 决策

1. **指令**：
    - 交给登记表的一整包叫 `CommandDef`（代码里的 `CommandSpec` 改名），字段不变。
    - `run(values, ctx: { reply(payload), signal })` 返回结果形状；`reply` 经 `sendToAddress` 回到发指令的那个会话。
        - 🔗 10-09（3a-19）：改名与 `ctx.reply` 已落，`reply` 收文字或消息体、回投递结果；`signal` 还没有使用者，没加；`run` 返回结果与下一条的失败文案留在 3b。
    - 返回失败时框架回「『{指令名}』没办成：{message}」；抛错回「出错了，详情在日志里」，并记错误日志。
        - 🔗 10-13（3b-05）已落：`run(values, ctx: { reply }): Promise<Result>`，`signal` 仍没加（没有使用者）；`{指令名}` 填的是主人这次敲的那个词（别名就是别名），不是内部的本名；抛错记 error 级日志。五条内置指令办不成的地方改成返回 `fail()`，话集中在 `runtime/command-texts.ts`。
    - `login` 改成核心的通用指令 `login [来源]`：只装了一个带登录的来源就直接扫它，装了多个就列出来让主人挑；二维码取自 `AuthState`，经 `reply` 发图。
        - 🔗 10-13（3b-06）已落：「带登录的来源」是登记表里带 `auth` 的来源，每次现读（`listLoginSources`，视图为此多带了 `sourceKey`）。一个都没有回 `not_found`；不带词恰好一个直接扫；不带词不止一个回一条清单（名字加键）并说怎么挑，是正常回答、返回 `ok()`；带词认来源的键、也认给人看的名字，不分大小写、键先于名字，名字撞名回 `invalid` 让改用键，对不上回 `not_found` 并把能挑的列出来。发起之后的逻辑照旧，只是对象换成挑中那个来源的 `auth`，回话里的来源名字取描述符的 `label`。`status` 的「登录」行同时改成每个带登录的来源各一行（「<label>登录：<状态>」；某个来源的 `auth.state()` 抛了，那一行写「状态读不到」、记一行 error，别的行照出），入口不再为这两条指令直读 B 站登录系统；对拍 N17 转进对拍的 P21。文案在 `runtime/command-texts.ts`。
    - 于是 1.0 没有来源自带的指令，`CommandProvider` 登记表先不造（修订 ADR-0021 决策 8）。
2. **devtools 场景**：
    - `DevtoolsProvider { scenarios: DevScenarioDef[] }`；过线给面板的纯声明叫 `DevScenarioDescriptor`。
    - 场景 id 由宿主加前缀（`bilibili.xxx`、`<拓展 id>.xxx`），不会撞名，也冒充不了别家。
    - 参数按提供方收窄：来源用新种类 `creator`（值是自己名单里的 `externalId`）；推送适配器只能挑自己的连接；`sub` / `target` 只给核心。
    - `run` 返回结果形状：参数不合法回 `invalid`，场景找不到回 `not_found`；原来那两个异常类删掉。
    - 场景只用自己集成的 ctx 做事（B 站「造一条新动态」就调 `ctx.reportPost`），核心的句柄不交出去。
    - 🔗 10-10（3a-32）已落前四条里的登记方式与 id 前缀：`DevtoolsProvider`、登记表 `devtoolsProviders`（类型 `DevtoolsProviderRegistry`）、宿主加前缀；B 站的场景搬进 `bilibili/devtools/`，只在开发版的门里登记。「只用自己集成的 ctx 做事」还没做：B 站的场景仍直接用引擎与套了壳的接口句柄，句柄由入口建好交给它，等 3a-28 B 站有了上报口再改。核心自己的场景不加前缀（原文没提）。`run` 返回结果形状、`creator` 参数种类也还没做。

## 取代与修订的旧条款

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0021 决策 8 里的 `CommandProvider` | 修订：1.0 不造 | 1 |
| ADR-0021 决策 54「devtools 走 `DevtoolsProvider`」 | 细化：场景 id 加前缀、参数按提供方收窄 | 2 |
| 拷问中途：指令沿用 `CommandSpec` 这个名字 | 修订：按后缀表叫 `CommandDef`（ADR-0023 决策 15） | 1 |

## 明确不做

- **1.0 就造 `CommandProvider`**：`login` 挪走以后没有实现者；没有实现者的接口先不造。

## 仍未决

- **来源自带指令与指令重名的规矩**：等第一个真要自带指令的拓展。
