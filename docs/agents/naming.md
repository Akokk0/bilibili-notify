# 类型名的后缀

**一个概念只用一个词。** 起新类型名、改名之前先对这张表；表里没有的概念，先加一行再用，不许随手造新后缀。这是活规范，可以直接改，但加行、改行要主人拍板；为什么定这套见 [ADR-0023](../adr/0023-neutral-naming.md) 决策 15。

选词时先数代码里各候选的现有用法（`git grep -h -o -P "\b[A-Z][A-Za-z]*<后缀>\b"`），看它实际装的是什么，别凭一两个新名定。

## 后缀表

| 概念 | 用这个 | 不再用 |
| --- | --- | --- |
| 交给登记表、带行为的一整包 | `Def` | `Spec`、`Definition` |
| 注册或启动后拿回的把手 | `Handle` | — |
| 回调函数的类型 / 一包回调 | `Handler` / `…Handlers` | `Sink` |
| 登记表 | `Registry` | 当登记表用的 `Table` |
| 宿主或运行时递进来的环境（带生命周期、日志、signal） | `Context` | `Ctx`；跟着一次调用走的一包字段也不叫它 |
| 注入的协作者包（构造或函数的依赖；不混配置值） | `Deps` | — |
| 可插拔、可枚举的东西的静态自我介绍；`Def` 去掉行为后过线的那份纯声明 | `Descriptor` | 这层意思的 `Meta` |
| 附在一条数据旁边的元数据 | `Meta` | — |
| 纯数据的规格 / zod 校验 schema | `Spec` / `Schema` | — |
| 按参数规格解析出来的一组值（用户填进来、解析好的） | `Values` | 当它用的 `Options` |
| 操作的结果 | `Result` | `Outcome`、`Verdict`，当结果用的 `Check`、`Read`、`Parse`、`Acceptance` |
| 别人交上来的（上报） | `Report` | 报表类的东西（按装的内容取后缀：设置叫 `Settings`，结果叫 `Result`，算出来的叫 `View`） |
| 由真源算出来、给某个读者用的只读形状（面板、模板、引擎） | `View` | `DTO` |
| 模板吃的输入 / React 组件的属性 | `Input` / `Props` | 当参数包用的 `Input` |
| 一个接口或外部协议的整个请求体 / 回应体 | `Request` / `Response` | — |
| 函数或构造的参数包 | `Options` | `Opts`、`Params`、`Args`，当参数包用的 `Config` |
| 设置的值，包括设置的切片与生效值 | `Settings` | 当设置值用的 `Config`（`Config` 只指存储：`config/`、`ConfigStore`、`bn.config.yaml` 对应的 `BootstrapConfig`） |
| 状态对象 / 状态的取值 | `State` / `Status` | 用反了的 |
| 存下来、以后拿来比对或重放的副本 | `Snapshot` | 当「当前状态」用的（那是 `View` 或 `State`） |
| 一条消息、事件或令牌里装的内容 / 包在它外面、带路由或元数据的那一层 | `Payload` / `Envelope` | — |
| 发生了一件事 / 某样东西的状态变了 | `Event` / `Change` | — |
| 列表、日志、账本里的一条 | `Entry` | `Record`、`Row` |
| 时序里的一个采样点 | `Sample` | — |
| 负责存盘的仓库 | `Store` | 不存盘的（按职责改名，如 `…Cache`） |
| 内存里按键查的表（不存盘、不是登记表） | `Table` | — |
| 登记表或映射的键 | `Key` | — |
| 供人挑选、还没成为实体的候选 | `Candidate` | — |
| 种类的取值；说「是哪一种」的判别键叫 `kind`，说「处在什么状态」的判别键叫 `status`（状态对象里装取值的那一格） | `Kind` | `Type`（只留给外部协议里的原名） |
| 发出去的改动 / schema 的全可选版 / 按订阅覆盖的那一层 / 一步操作 | `Patch` / `Partial` / `Overrides` / `Op` | — |
| 为了解耦写的第三方窄接口 | `…Like` | 自己领域里的 `…Like` |
| 装配根交出来的一组运行中部件 | `Runtime` | 别的意思 |
| 长期运行的部件 | 按职责起名（`Engine`、`Poller`、`Runner`、`Dispatcher`、`Flow`、`Queue`、`Cache`，以及各种 `-er` / `-or` 角色名）；说不出具体职责的叫 `Service` | `Manager`、`Info`、`Data`（太虚） |

## 表外的几条规矩

- **领域实体用本名**：`Post`、`Creator`、`Subscription`、`Problem`、`Connection`。从实体现算出来给某个读者看的投影加 `View`（`SourceSubscriptionView`）。
- **核心接口用角色名，交进登记表的那一整包叫 `…Def`**：`PlatformAdapter` 对 `PlatformAdapterDef`，`SubscriptionSource` 对 `SubscriptionSourceDef`。
- **核心里的 `Source` 只指订阅来源**：读数据的口子叫 `…Reader` 或 `…Lookups`。「市场源」是主人在界面上看得到的叫法，算例外。
- **`Summary` 只用于「一个东西的缩略版」**，并且要和 AI 的直播总结（`liveSummary`）错开。
- **缩写写成 `Ai`、`Api`**（ADR-0023 决策 4）。

## 不管的

- 第三方库与外部协议里的原名：`ZodDef`、`OneBotResponse`，以及住在 `bilibili/` 里、照 B 站接口起名的类型（`VideoInfo` 等）。
- 面板 zustand 的 `useXxxStore`，这是 React 的惯用写法。
