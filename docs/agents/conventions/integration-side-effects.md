# 集成副作用只经 ctx

**集成的副作用一律经宿主递进来的 ctx。** 集成指 `bilibili/`、每个拓展、每个内置平台适配器（[ADR-0025](../../adr/0025-integrations.md) 决策 1）。存状态、存凭据、读设置、发请求、取图、写日志、起定时器、挂端点、收尾，宿主都给了口子，集成不自己去碰文件、不裸开定时器、不裸挂端点。这是活规范，可以直接改，但加条、改条要主人拍板。为什么这样定见 [ADR-0012](../../adr/0012-extensions.md) 决策 11、14 与 [ADR-0021](../../adr/0021-neutral-core.md) 决策 39、41。

## 规矩

1. **不读写文件。** 集成里不 import `fs`、`node:fs`、`fs/promises`。要落盘的东西都有对应的 ctx 成员：

   | 要做的事 | 用这个 |
   | --- | --- |
   | 存游标、分页令牌、小索引 | `ctx.state` |
   | 存 cookie、token | `ctx.secrets` |
   | 读主人填的设置 | `ctx.settings(schema)` |
   | 发请求、开 websocket | `ctx.http` |
   | 取远端的图 / 存手上已有字节的图 | `ctx.fetchImage` / `ctx.storeImage` |
   | 写日志 | `ctx.logger` |
   | 还没存进 `secrets` 的临时凭据 | 先 `ctx.redact(value)` 登记，日志落盘前按值遮掉 |

   - 对：`await ctx.state.set("cursor", cursor)`，再看返回的结果。
   - 错：`import { writeFile } from "node:fs/promises"`，自己把游标写进一个文件。

2. **`state` 与 `secrets` 的写、删与 `batch` 返回结果，不抛错，要看。** 超上限或写了保留前缀（`http.` 开头的键归宿主）回 `invalid`，磁盘写失败回 `unavailable`（ADR-0025 决策 10，码见 [ADR-0026](../../adr/0026-failure-results.md)）。`get` 是同步的，宿主在 `start` / `activate` 之前读进内存。限额：`state` 单键 64KB、每个集成 1MB；`secrets` 每个集成 256KB。要同时改几个键、不想落成只改了一半，用 `batch`：整批一起成或一起不成。

3. **凭据只进 `secrets`，别放 `state`。** `state` 明文、不进备份、不脱敏；`secrets` 用主密钥加密、只进完整备份、值按原文脱敏。cookie 由 `ctx.http` 自动存进 `secrets`，不用自己存（ADR-0025 决策 6、9）。

4. **请求走 `ctx.http`，图走 `fetchImage` / `storeImage`。** 不自己 `fetch` 一个带自己身份的客户端来替代它。拦内网、8MB、格式嗅探、超时只在 `fetchImage` 上，`ctx.http` 本身不拦内网（ADR-0025 决策 8）。上报里只交 `ImageRef`，不交字节。重试、退避、限流归集成自己（ADR-0025 决策 6）。

5. **不裸开定时器、不裸挂端点、不裸开长连接。** 拓展用 ctx 给的可回收定时器（`ctx.setTimeout`、`ctx.setInterval`，返回 `Disposable`）、`ctx.mount`（路由走 `/ext/:id/*`，挂载前缀由宿主分配）、`ctx.onUpgrade`；websocket 用 `ctx.http.websocket`，集成停下时自动关。一次性的超时也不例外：拓展里的 `setTimeout` 一律走 `ctx.setTimeout`，结算或资源关闭时 `dispose`。手里有必须自己管的资源（例如 `onUpgrade` 里拓展自带 `ws` 建的 socket），在 `ctx.onDispose` 里关掉。

   - 对：`ctx.setInterval(poll, 60_000)`。
   - 错：模块顶层或 `activate` 里直接 `setInterval(poll, 60_000)`，停用后它还在跑。
   - 错：请求的超时用裸 `setTimeout`，靠一串手写的清理保证停用时清掉。

6. **收尾经 `signal` 与 `onDispose`。** 手上的请求、轮询接着 `ctx.signal` 停；不归 ctx 管的收尾挂 `ctx.onDispose(fn)`，后注册的先跑。宿主的收尾顺序是：先调来源或适配器自己的 `stop()`，再中止 `ctx.signal`、跑 `onDispose`，替它收掉经 ctx 拿到的东西（websocket、定时器）。`stop` 后不许再上报（ADR-0025 决策 5）。

7. **日志只走 `ctx.logger`。** 集成 id 由宿主写进日志行的 `name` 字段，不要自己拼进正文（B 站另有 `dynamic`、`live` 两个标签，等级同一格）；日志等级也按集成键给：一个集成的全部日志跟设置里它自己那一格，没写就跟总等级，集成不自己设等级；日志落盘前宿主按全部密钥的实际值脱敏（ADR-0021 决策 49）。

8. **不拿 bus。** `MessageBus` 不在 ctx 里；集成的事件由宿主转进总线（ADR-0012 决策 15）。

## 边界与例外

- **核心不归它管。** 核心的落盘走持久化底层，由守卫 3 管（见下）。这条管的是集成。
- **BN 自己的请求不走集成的客户端。** `ctx.http` 带着集成的身份与 cookie，BN 自己的请求不许冒用（ADR-0025「明确不做」）。
- **读也算。** 契约写的是「不读写文件」；集成要读的东西走 `ctx.settings` 或 `ctx.state`。
- **推送适配器的 websocket** 不算裸连接的例外：走 `ctx.http.websocket`，帧、心跳、重连归适配器（ADR-0025 决策 6）。
- 拓展与 BN 同进程，1.0 拦不住真想越界的代码。这是规矩加静态检查，不是沙箱；真正的强制要等沙箱（SES 的 `lockdown` 加每个拓展一个 `Compartment`，以后先做兼容性小试验再定）。

## 怎么钉住

- **守卫 17**（[docs/1.0/architecture.md](../../1.0/architecture.md)「其余守卫」，3a 期开，[construction-plan.md](../../1.0/construction-plan.md)「中立性守卫的归期」）：`bilibili/` 与 `platforms/` 里出现 `fs`、`node:fs`、`fs/promises` 的 import 就红。写法仿 `extension-import-boundary.test.ts`。拓展不在它的范围里，见下一条。
- **守卫 3**（第 1 期切片 ②）：服务端除了持久化底层，不许直接写文件（`writeFile`、`rename`、`appendFile`）。管的是服务端整体，不专门管集成读文件。
- **拓展**：官方市场发布时做静态检查，打包产物 import 了 `fs`（`fs`、`node:fs`、`fs/promises`）就不收；手动安装的第三方拓展安装时警告。
- **出网点名表**（第 1 期切片 ④ 以棘轮开、3b 末清零，[docs/1.0/architecture.md](../../1.0/architecture.md)「第二层：静态扫描」）：服务端进程里跑的源码（含 `extensions/*/src`，不含测试）出现出站原语（`fetch(`、客户端 `new WebSocket(`、`http(s).request` / `get`、`net` / `tls` 的 connect、`undici`），文件又不在白名单里就红。白名单只有集成的请求客户端（第 2 期起是 `packages/http`）和 BN 自己的几个出口。第三方拓展的打包产物不扫。
  🔗 现状（3b-39，2026-10-19）：棘轮已清零，`RATCHET = {}`；三个内置适配器的 12 处出网都改走了 `ctx.http` 的 `bare: true` 一档。规矩本身不变，白名单仍只有集成的请求客户端与 BN 自己的出口。
- **守卫 22**（3a 期开）：扫 `extensions/*/src`（不含测试），不经 ctx 的 `setTimeout` / `setInterval`、`createServer`、自己监听端口的 `WebSocketServer` 就红。第三方拓展的打包产物不扫，库自己会用定时器。
- **其余靠审查**，审 PR 时逐条看：
  1. 集成目录里有没有 `fs`、`node:fs`、`fs/promises`、`path` 拼数据目录的痕迹。
  2. 状态是不是都经 `ctx.state`，凭据是不是都经 `ctx.secrets`；`set` / `delete` 的返回值有没有被看。
  3. 内置集成（`bilibili/`、`platforms/`）自己开的定时器与连接，`stop` 或 `onDispose` 里有没有收掉；拓展里有没有守卫 22 与出网点名表扫不到的写法（换个名字的 `setTimeout`、把 `fetch` 另存一个名字再调）。
  4. 每个不经 ctx 管的资源，`onDispose` 里有没有对应的关闭。
  5. 日志有没有自己拼集成 id，有没有把凭据原文打进日志。

## 出处

- [ADR-0025](../../adr/0025-integrations.md) 决策 1（集成与 `IntegrationContext`）、5（收尾顺序）、6（`packages/http`）、8（`fetchImage`）、9（`state` 与 `secrets`）、10（调用被拒或失败）与「明确不做」。
- [ADR-0021](../../adr/0021-neutral-core.md) 决策 39（`ctx.state`）、41（来源不读写文件）、49（日志）。
- [ADR-0012](../../adr/0012-extensions.md) 决策 11（两条硬约束，守卫 22）、14（持久状态由宿主落盘）、15（`bus` 不开给拓展）、26（`onUpgrade` 与裸 socket 的代价）。
- [ADR-0026](../../adr/0026-failure-results.md)（失败结果的码）。
- [docs/1.0/extension-contract.md](../../1.0/extension-contract.md)「ctx 能用的全部」「state 与 secrets」「ctx.http」「图」「不许读写文件」。
- [docs/1.0/architecture.md](../../1.0/architecture.md)「其余守卫」（守卫 3、17）。
