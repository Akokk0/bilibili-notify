# BN 部署与配置

BN 自带 Web 控制台，可通过 Docker、macOS / Windows 桌面应用或 npm 运行。

Docker 和桌面应用默认使用最新正式版。各版本的功能与配置请查阅对应发行标签下的文档。

## Docker

将 Compose 示例复制到部署目录，按需调整端口和挂载路径。示例使用 Docker Hub 的 `latest` 正式版镜像，也可换成 `ghcr.io/akokk0/bilibili-notify:latest`。容器首次启动会自动生成 `config/bn.config.yaml`。[`docker-compose.example.yaml`](./docker-compose.example.yaml)

```bash
cp docker-compose.example.yaml docker-compose.yaml
docker compose up -d
```

宿主目录布局:

```
./
├── data/                  # 运行时状态(订阅 / 历史 / 日志 / 凭据)
├── config/
│   └── bn.config.yaml     # 首次启动自动生成
└── docker-compose.yaml
```

首次启动后，用 `docker compose logs bilibili-notify` 查看账号 `admin` 和随机密码。打开 `http://<host>:8787` 登录面板，再到「系统 → 账号」管理各来源的登录。

也可以直接运行容器。

```bash
docker run -d --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" -v "$(pwd)/config:/config" \
  akokk0/bilibili-notify:latest
```

GHCR 使用相同的镜像标签。

```bash
docker pull ghcr.io/akokk0/bilibili-notify:latest
```

### 镜像变体与更新

| 变体 | 正式版标签 | 内容 |
|---|---|---|
| full | `latest` | 内置 Chromium 与 CJK 字体 |
| slim | `slim` | 体积较小，可外接 Chromium |

更新到新正式版时，执行 `docker compose pull && docker compose up -d`。

使用 slim 出图时，在系统页配置远程浏览器，新部署也可在首次启动前设置 `BN_CHROME_ENDPOINT`。`ws://…` 可连接 browserless 等 DevTools WebSocket，`http://…` 可连接 Chromium 调试端口。缺少可用浏览器时发送文本。Compose 示例提供了 browserless 伴随容器的配置。

另有两个省内存开关(两种变体都适用):

- 渲染空闲 `chromeIdleSeconds`(默认 300)秒后自动关闭 / 断开浏览器,下次渲染懒重启;`0` = 常驻。
- Node 堆上限默认 `NODE_OPTIONS=--max-old-space-size=512`,在 compose `environment` 设同名变量可覆盖。

浏览器来源(本地路径 / 远程端点)也可在 **dashboard 系统页**查看与热切换:先探测新浏览器
连通,通了才替换并写回配置,无需重启;坏候选不会顶掉在用的配置。

## 桌面应用

桌面应用与 Docker 同版本发布，可在最新正式版的发行页下载。[下载正式版桌面应用](https://github.com/Akokk0/bilibili-notify/releases/latest)

| 平台 | 产物 |
|---|---|
| macOS(Apple Silicon) | `bilibili-notify-macos-arm64.dmg` / `.app.zip` |
| Windows x64 | `bilibili-notify-windows-x64-setup.exe` / `.zip`(免安装) |

装完直接开,面板与功能同 Docker 版 —— 它内嵌的就是同一套服务端与控制台。两点差异:

- **卡片渲染用你本机的浏览器**,按平台自动探测 Chrome / Edge / Chromium 的默认安装位置;都没有则降级为纯文字推送,也可在系统页手填路径或指向远程浏览器。
- **字体来自你的操作系统**,不是镜像里那套 —— 所以卡片设置里「手填字体名」在桌面版填苹方 / 微软雅黑这类系统自带字体就作数(容器里则只有思源黑 / 思源宋)。

## npm

npm 正式版发布前，通过 `@alpha` 安装 BN。需要 Node.js 24.15.0 或更高版本。npm 包会从包内解出服务端和面板，卡片渲染使用本机或远程 Chromium。

```bash
npx @bilibili-notify/bn@alpha web
vp dlx @bilibili-notify/bn@alpha dev  # 拓展开发
```

默认监听 `127.0.0.1:8787`。npm 的 `latest` 目前指向发行占位包。

| 模式 | 数据目录 | 用途 |
| --- | --- | --- |
| `web` | `~/.bilibili-notify/data` | 日常使用，支持应用内更新 |
| `dev` | `~/.bilibili-notify/dev-data` | 拓展源码挂载与热重载，随 npm 包升级 |

两个宿主可用 `--data-dir` 分别指定数据目录。用 `--port` 为新实例设置初始端口。开发 BN 本体使用主仓的 `vp run dev:apps`。[启动参数与数据目录](../tools/bn-cli/README.md)

Docker 和桌面应用可在「系统 → 维护」的「正式版」渠道检查应用内更新。Docker 通过容器重启策略启动新版。用终端直接启动的 npm `web` 在更新就绪后会提示手动重启。[应用内更新机制](../docs/agents/self-update.md)

## 配置

镜像默认 `BN_CONFIG=/config/bn.config.yaml`,走 **B 模型**:

- **首次启动**:`BN_*` 环境变量 + 默认值 seed 出 `bn.config.yaml`。
- **之后**:yaml 是唯一真相,环境变量被忽略。改配置 = 编辑 `./config/bn.config.yaml` + `docker compose restart`。
- **重置**:删 `./config/bn.config.yaml` + 重新启动。
- **不要手写配置文件**:只挂载 `./config:/config`,让容器生成完整 yaml。

完整字段见 `server/src/config/schema.ts`,样例见 `server/bn.config.example.yaml`。开发模式(不设 `BN_CONFIG`)走 12-factor:`bn.config.{yaml,json}` < 环境变量 < CLI 三层合并,不 seed 文件。

### 镜像内置 ENV

| 变量 | 默认 | 用途 |
|---|---|---|
| `BN_CONFIG` | `/config/bn.config.yaml` | bootstrap 配置文件路径 |
| `BN_HOST` / `BN_PORT` | `0.0.0.0` / `8787` | 监听地址 / 端口 |
| `BN_DATA_DIR` | `/data` | 运行时状态目录 |
| `BN_CHROME_PATH` | `/usr/bin/chromium`(slim 变体未设) | puppeteer-core 浏览器 |
| `BN_CHROME_ENDPOINT` | 未设 | 远程浏览器端点(`ws://…` / `http://…`),优先于 `BN_CHROME_PATH`;slim 变体的卡片渲染靠它 |
| `BN_CHROME_IDLE_SECONDS` | 未设(=300) | 渲染空闲多久后关闭 / 断开浏览器省内存;`0` = 常驻 |
| `NODE_OPTIONS` | `--max-old-space-size=512` | V8 堆上限,压住 RSS 浮高;compose 可覆盖 |
| `TZ` | `Asia/Shanghai` | 容器时区：影响定时任务（cron）的钟点与免扰时段；卡片上的时间看设置里的全局时区 |
| `BN_LOG_LEVEL` | `info` | 日志级别;引擎启动后被 dashboard 配置接管 |
| `BN_DASHBOARD_USER` / `BN_DASHBOARD_PASS` | 未设 | dashboard 登录凭据(首启动 seed 源) |
| `BN_COOKIE_KEY` | 未设 | secrets 加密密钥(首启动 seed 源) |

`BN_CONFIG` / `BN_HOST` / `BN_PORT` / `BN_DATA_DIR` / `BN_CHROME_PATH` 由镜像固定注入,compose 里不要重写。

### 内存与反向代理

出图那一下是整个服务的内存峰值 —— full 镜像内置 chromium,**建议宿主可用内存 ≥ 1GB**。
只有 512MB 的机器请改用 `:slim` + 远程浏览器,否则渲染时容易被系统 OOM 杀掉;因为
compose 模板是 `restart: unless-stopped`,被杀后会自动拉起,所以现象不是「服务挂了」
而是**隔几分钟断一次线**(OneBot 连接 `ECONNRESET`、面板转圈)。

卡片渲染是**串行**的(并发截图会在浏览器冷启动窗口触发 CDP 竞态,把一张卡平铺成
2×2),所以一次要出几张图时,单个请求跑十几秒很正常。经反向代理访问的话,把读超时
调到 **120s 以上**(nginx 的 `proxy_read_timeout`),否则请求会被代理掐断,而服务端
那边其实渲染成功了 —— 日志一路「渲染完成」,页面上却是「连接中断」。

```bash
# 是不是被 OOM 杀过 / 反复重启
docker inspect bilibili-notify --format '重启={{.RestartCount}} OOM={{.State.OOMKilled}}'
# 容器日志里找重启横幅与堆溢出
docker logs bilibili-notify --tail 300 2>&1 | grep -iE "out of memory|heap limit|listening"
```

撞堆上限和被系统 OOM 杀掉是**两回事**,现象像但修法相反:

| 日志现象 | `docker inspect` | 含义 |
|---|---|---|
| `FATAL ERROR: Reached heap limit` + 一段 V8 栈 | `OOMKilled=false` | 撞的是上面那个 Node 堆上限,跟宿主机还剩多少内存无关 |
| 没有这段日志,进程凭空消失 | `OOMKilled=true` | 宿主机 / cgroup 内存不够,被系统杀 |

撞堆上限时,先在 compose 里抬一档撑住:

```yaml
environment:
  NODE_OPTIONS: --max-old-space-size=1024
```

但抬上限只是止痛 —— 堆要是**慢慢涨**上去的,抬完只是把崩溃推迟。想分清是哪一种，
查看内存采样日志中的诊断参数（开启后每 10 分钟一条，业务规模另列在 `probes`）：

```json
{"heapUsedMB":210,"heapLimitMB":512,"heapRatioPercent":41,"heapCommittedMB":250,"rssMB":340,"externalMB":12}
```

`heapUsedMB` / `heapLimitMB` 是已用堆与上限，`heapCommittedMB` 是 V8 已提交的堆空间，
`rssMB` 是进程驻留内存。已用堆平稳、提交量上涨可能与堆空间管理有关，仅凭这一项不能判定泄漏。**`externalMB` 不受堆上限管**(jieba 词典等都在里面),
所以别照堆上限去设 `mem_limit`,否则会从撞 V8 上限变成被系统 OOM 杀。

启动后即接近上限时，先核对容量和配置；相近负载下长时间持续上涨时，
请带上连续采样与使用情况开 issue，便于判断状态积累或内存泄漏。

这行日志**默认不写**，需要时在系统页开启「内存自检打印」；
概览页的「系统资源」卡不靠它,随时都能看实时值。堆用量超过上限 85% 时无论开关如何
都会有一条 `warn` 并附上处理办法。

面板与运行日志支持简体中文、台湾繁体中文、英文、日文。日志说明跟随全局语言，诊断字段、上游错误码和用户内容保留原值；排查时结合事件标识、参数和时间，不依赖某一句英文日志。

### 故障排查

- `curl localhost:8787` 返回 404：控制台静态资源默认取当前载荷入口旁的 `web-dist`，初始镜像中为 `/app/web-dist`。检查日志事件 `host.web_serving` 的 `dir`；`host.web_missing` 表示没有找到托管资源，需检查镜像或载荷是否完整；`host.web_pinned` 表示配置固定了静态目录，移除 YAML 中的 `webDistDir` 或首次启动时设置的 `BN_WEB_DIST` 可恢复跟随载荷。说明文字会随日志语言变化。
- 卡片预览显示「**连接中断**」:请求没拿到响应,不是渲染失败。多半是上面那两条 —— 反代读超时太短,或服务端被 OOM 杀掉重启了。先按上面两条命令查。
- 手写过 `bn.config.yaml`:建议备份后删除该文件,让容器重新生成;不要删除 `./data`。

### Volume

`/data`(状态)与 `/config`(bootstrap yaml)是两个独立挂载点,都要 bind-mount 到宿主,否则随容器丢失。

```
/data
├── generations/<序号>/   数据代,一代一个目录(升级时迁出新的一代,旧代原样留着可回退)
│   ├── config/          设置 settings/、订阅、连接、目标
│   ├── secrets/         各来源与拓展凭据、AI 密钥
│   ├── history/         推送历史(按日 jsonl)
│   ├── stats/           作品、直播、粉丝与按需播放量时序
│   ├── images/          图库与已缓存图片
│   ├── library/         图片、字体等资源索引与文件
│   ├── ai/             AI 对话数据
│   ├── maid-skills/     女仆技能
│   ├── skins/           界面与卡片皮肤
│   └── extensions/      已安装拓展
├── versions/            应用内更新载荷
└── logs/                日志归档(按日 jsonl,跨代连续)
```

## 登录与安全

- Docker 首次启动会生成 `admin` 和随机密码，写入 `./config/bn.config.yaml`，并在启动日志显示一次。需要自定凭据时，可在首次启动前设置 `BN_DASHBOARD_USER` 和 `BN_DASHBOARD_PASS`。如果仍在使用旧版示例的固定密码，请修改密码。
- **拒启保护**:监听非 loopback 又无凭据时服务拒绝启动;`BN_ALLOW_NO_AUTH=1` 可强制放行(自担风险)。
- **`auth.allowedOrigins`**:非 localhost 部署务必设置 —— 它门禁 WebSocket upgrade 并兜底防 CSRF,填 dashboard 自己的 origin。
- **会话**:登录态是签名 cookie,滑动过期(空闲 ≤ 7 天),无服务端吊销;轮换 dashboard 密码可使所有已签发 cookie 立即失效。
- **限流**:每 IP 登录限流以直连对端为 key,不信任 `X-Forwarded-For`。反代后所有客户端共用一个桶 —— 必须在代理层另做鉴权 / IP 白名单。

## secrets 静态加密

各来源 Cookie、拓展凭据和 AI 密钥保存在当前数据代的 `secrets/`，即 `<dataDir>/generations/<序号>/secrets/`，使用 AES-256-GCM 加密。密钥来自 `cookieEncryptionKey`（首启动可由 `BN_COOKIE_KEY` 提供）：

- **设置**:密钥由口令经 scrypt 派生、不落盘。生成:`openssl rand -base64 32`。
- **不设**:回退到与密文同目录的随机密钥文件 —— 仅混淆,启动打告警。

## 来源账号与订阅

先配置推送连接和目标，再点击「添加订阅」选择来源，按输入框提示搜索创作者。需要账号的来源可在「系统 → 账号」登录。各来源独立管理账号，系统页账号列表的第一位用于顶栏和 AI 对话头像。

| 来源 | 支持的内容 | 使用条件 |
| --- | --- | --- |
| B 站（内置） | 动态、开播 / 直播中 / 下播和直播互动 | 建议在系统页扫码登录 |
| [抖音](../extensions/douyin/README.md) | 视频、图文、开播 / 直播中 / 下播和群聊作品链接解析 | 安装并启用后扫码登录 |
| [虎牙](../extensions/huya/README.md) | 公开房间的开播 / 直播中 / 下播 | 安装并启用后可直接订阅 |
| [微博](../extensions/weibo/README.md) | 关注流中的新微博，支持长文、转发和带超话的作品 | 安装并启用后扫码登录，并用该账号在微博关注博主 |

订阅项根据所选来源提供的能力显示。各来源的首次检查与轮询规则见对应说明。

头像或配图在路由器的 FakeIP 环境里一直加载失败时，可在「系统 → 运行 → 图片下载网络」查看和配置所用的代理网段。[图片下载的地址范围](../docs/agents/image-network.md)

## 资源库

「资源库」统一管理图片、字体、女仆技能、女仆性格、界面皮肤和卡片皮肤，支持导入导出。资源的选用或启用仍在对应的卡片、AI 和系统设置中完成；导入资源不会自动替换当前配置。

## 接入 OneBot(NapCat)

控制台 **推送目标** → 新建连接,platform 选 `onebot`,连接方式三选一:

- **HTTP** —— 填 bot 的 HTTP API `baseUrl`,如 `http://napcat:3000`。
- **正向 WS** —— 填 bot 的 WS 地址,如 `ws://napcat:3001`。
- **反向 WS** —— 填一个监听端口,bot 主动连入;该端口需在 compose `ports:` 额外映射。
  面板会把 bot 那头该填的完整地址印出来(形如 `ws://<BN 主机>:<端口>/onebot`)—— **末尾的路径随便填**,
  不填也行,从 koishi 转过来的人照抄 `/onebot` 即可。

`docker-compose.example.yaml` 含注释掉的 NapCat 边车段落。

## 验证推送

在「推送目标」页先测试连接。机器人卡片显示各项能力，在具体目标的「测试」弹窗可选择该会话可测试的能力，发送测试会向所选会话实际投递消息。

支持群内状态查询的目标可查看机器人身份。QQ 官方群的「今日艾特全体」显示 BN 当日发送记录，平台额度以腾讯实际返回为准。

## 拓展

安装后，到「拓展」页打开对应卡片的启用开关。首次启用会立即生效。

控制台 **拓展**,右上「装拓展」,两条来路:

- **拓展市场**提供官方拓展安装。请选择与当前 BN 版本兼容的拓展，兼容情况可在市场卡片上查看。
- **传一个包上来** —— 把 `.zip` 拖进「装拓展」弹窗。**只装信得过的**:拓展在 BN 进程里跑,装的时候不验签。

还有第三条不走面板的路：把解开的目录放进**拓展目录**，目录名就是拓展 ID。安装包必需 `extension.json` 和自包含入口 `index.mjs`，另可带 `README.md`、`CHANGELOG.md` 与支持语言的 `locales/<语言码>.json`。**这条要重启一次**才认得到。拓展目录位于当前数据代的 `<数据目录>/generations/<序号>/extensions/`；「装拓展」弹窗显示完整路径。

| 形态 | 数据目录 |
| --- | --- |
| Docker | `/data`,在 volume 里 |
| 桌面 macOS | `~/Library/Application Support/bilibili-notify/data` |
| 桌面 Windows | `%LOCALAPPDATA%\bilibili-notify\data` |
| npm `web` | `~/.bilibili-notify/data` |
| npm `dev` | `~/.bilibili-notify/dev-data` |

覆盖安装后，若面板显示新版本待生效，可重启 BN。已启用的拓展也可点「只重载这个拓展」。用终端直接运行且面板无法重启时，请从终端重启。

开发宿主提供「挂载开发拓展」。选择含 `extension.json` 的源码工程根目录并启用，可监听保存并自动重载。重启时，BN 会用同一数据目录恢复仍指向原工程的挂载和监听设置，沿用启用状态。[拓展开发指南](../packages/extension/DEVELOPMENT.md)

### 机器人框架桥接

可以把 Koishi 或 AstrBot 里已配置的机器人接入 BN，用于 Telegram、Discord、KOOK 等平台。下面以 Koishi 为例。两个框架的插件入口、能力和常见问题见桥接说明。[机器人框架桥接](../extensions/bridge/README.md)

1. 控制台 **拓展** → 装上「机器人框架桥接」→ 在它那张卡上**把开关拨开**。
2. 卡片右下「管理 ›」→「桥接入」→ **新建接入**:桥的种类选 `koishi`,起个名字,弹窗会当场生成一条 token。
   ⚠️ **token 全文只在这一刻看得到**,存下之后面板只显示头尾。忘了就重新生成一条 —— 旧的立刻作废,对面当场掉线。
3. 弹窗底下那个盒子里,**BN 地址**与 **token** 成对摆着,各带一颗复制钮。这两样就是要填进插件的全部。
4. koishi 那侧装 [`koishi-plugin-bilibili-notify-bridge`](https://www.npmjs.com/package/koishi-plugin-bilibili-notify-bridge),把 `url` 与 `token` 填进去保存。**桥主动连 BN,BN 从不反过来连 koishi** —— koishi 跑在内网 / NAS / 家宽后面都不用开端口。
5. 连上之后那张接入卡变绿,并列出这台 koishi 借出来的 bot。
6. **还没完**:回到控制台 **推送目标** → 新建连接 → 平台挑「机器人框架桥接」→ 从借来的 bot 里挑一个 → 保存。**一条连接就是一个 bot**,要用几个 bot 就建几条;之后才谈得上给它挂群和私聊。

⚠️ **「BN 地址」是按你打开面板时浏览器地址栏算出来的。** 在 BN 那台机器上用 `http://localhost:8787` 开面板,复制出来的就是 `ws://localhost:8787/ext/bridge` —— 填进另一台机器(或另一个容器)里的 koishi 必然连不上,而且报出来只是一句「连不上」,最难查。要填**桥那台机器访问得到的地址**,如 `ws://192.168.1.5:8787/ext/bridge`;BN 挂在 https 反代后面则用 `wss://`。

连不上时,那张接入卡会印出两句判据:**填错 token 的话插件收到 401;地址不通则是连不上** —— 两种都不会在 BN 这侧留下记录。

## 开发

```bash
vp install
vp run dev:apps                          # apps/server + apps/web 并行
curl -s http://localhost:8787/api/health
```

`vp run build` 产出构建物。
