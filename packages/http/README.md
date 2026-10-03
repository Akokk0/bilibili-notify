# @bilibili-notify/http

`bilibili-notify` monorepo 内部包，集成的请求底座：请求客户端（含 WebSocket 建连）、cookie 罐、浏览器身份。通用，不带任何平台的默认值（`Origin` / `Referer` / `sec-fetch-*` 这类归调用方，构造客户端时交进来）。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- `HttpClient` — `fetch(url, options)` 回 `Result<HttpResponse>`（结果形状见 `docs/agents/conventions/failure-results.md`）
  - 手动逐跳跟重定向，逐跳把 `Set-Cookie` 摄进罐子；303 与 POST 上的 301/302 降成 GET；`beforeHop` 在每一跳发出之前调，可否决
  - **非 2xx 不抛**，状态码交给调用方判；网络断 `unavailable`、超时 `timeout`、被中止 `indeterminate`、被否决由回调给的失败；抛错只留给 bug
  - `HttpResponse` 只回原始字节，`text()` / `json()` 现转；没有 `ok` 这一格（它是结果的判别键）
  - 超时按跳算，管到 body 读完；`maxRedirects: 0` 就是「只看第一跳的 Location」
  - 头序：客户端默认头、这次请求的头，然后是调用方没写的身份四件（`User-Agent` / `sec-ch-ua*`），最后 `Cookie`；要掌控头序（指纹对齐）就把身份头自己写在想要的位置
  - `cookies: "send-only"` 只外发罐子的 cookie、不摄入响应的 Set-Cookie；罐子在请求在途时被 `load()` / `clear()` 换过，迟到响应的 Set-Cookie 不写进新罐子（`CookieJar.epoch`）
  - `websocket(url, { headers?, signal? })` — 用这个客户端的身份与罐子建一条 WebSocket，同步交出连接（`WebSocketLike`：`binaryType` / `on` / `send` / `close`，不把 `ws` 的类型摆进对外面）；帧、心跳、重连归调用方
  - 握手头是自己的一套、与 fetch 的头装配无关：`Cookie`（罐子里有**这个地址该带的**才带，`wss:` 按 `https:` 查）在前，`User-Agent`（身份的）在后，然后是 `headers`（同名的盖过默认值、留在原位置）；不带 `sec-ch-ua*` / `Origin`，也不带构造客户端时交进来的默认头；`ws` 的其余默认项一个不动
  - `signal` 中止就关掉连接（建连时已中止的，连接一建好就关）；握手期被关会先报一次 `error` 再 `close`，调用方一定要挂 `error`
  - 地址不合法、协议 `ws` 不收（如 `ftp:`）时同步抛错（和 `new WebSocket` 一样；`ws` 把 `http(s):` 当 `ws(s):` 收）
- `CookieJar` — RFC 6265 的子集（公共后缀不做）；IP 主机只认原样；`Domain` 必须匹配请求主机；`load()` / `clear()` 原地整罐换；`onChange()` 订阅内容变了；存盘形状 `Cookie` 与 tough-cookie 的序列化双向兼容
- `generateBrowserIdentity()` / `upgradeBrowserIdentity()` — UA 与 `sec-ch-ua` 一起生成、永远配套；后者在版本区间前挪之后把存着的旧身份换新，只升不降（存在哪里归调用方）
- 全仓只有这个包的 `http-client.ts` 允许调全局 `fetch`、`websocket.ts` 允许 `new WebSocket(`（出网点名表）
