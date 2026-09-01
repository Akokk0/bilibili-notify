# Bilibili-Notify Dashboard

独立端形态:Hono HTTP / WS 服务端 + React 控制台,自带可视化面板(扫码登录、订阅、推送目标、历史、日志)。两种部署方式:**Docker**(下方)或 **macOS / Windows 桌面应用**(见「部署(桌面应用)」)。

## 部署(Docker)

推荐用 compose,模板见 [`docker-compose.example.yaml`](./docker-compose.example.yaml)。复制后一条命令启动,不要手动创建 `config/bn.config.yaml`。镜像默认走 Docker Hub,也可改用 GHCR:`ghcr.io/akokk0/bilibili-notify:latest`。

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

打开 `http://<host>:8787`,登录后扫码绑定 B 站账号。

最小 `docker run`:

```bash
docker run -d --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" -v "$(pwd)/config:/config" \
  akokk0/bilibili-notify:latest
```

GHCR 镜像同 tag 发布:

```bash
docker pull ghcr.io/akokk0/bilibili-notify:latest
```

### 镜像变体:full 与 -slim

| 变体 | tag | 内容 |
|---|---|---|
| full(默认) | `:latest` / `:vX.Y.Z` / `:<short-sha>` | 内置 chromium + CJK 字体,开箱即用 |
| slim | `:slim` / `:vX.Y.Z-slim` / `:<short-sha>-slim` | 无 chromium,体积与内存占用小得多 |

预览渠道另有 `:alpha` / `:alpha-slim`,**只在发布预览版(`vX.Y.Z-alpha.N`)时更新** —— 长期没有预览版时它们会停在上一个预览版、落后于正式渠道,别拿来当「最新」。

slim 变体的卡片图片渲染改由 `BN_CHROME_ENDPOINT` 指向的**远程浏览器**承担
(`ws://…` 直连 browserless 等 DevTools WS;`http://…` 为 chromium
`--remote-debugging-port` 端点)。不配远程浏览器 slim 也能正常运行,只是卡片渲染
退化为文字推送。browserless 伴随容器写法见 `docker-compose.example.yaml` 注释段。

另有两个省内存开关(两种变体都适用):

- 渲染空闲 `chromeIdleSeconds`(默认 300)秒后自动关闭 / 断开浏览器,下次渲染懒重启;`0` = 常驻。
- Node 堆上限默认 `NODE_OPTIONS=--max-old-space-size=512`,在 compose `environment` 设同名变量可覆盖。

浏览器来源(本地路径 / 远程端点)也可在 **dashboard 系统页**查看与热切换:先探测新浏览器
连通,通了才替换并写回配置,无需重启;坏候选不会顶掉在用的配置。

## 部署(桌面应用)

不想碰 Docker 的话,[Releases](https://github.com/Akokk0/bilibili-notify/releases) 里有打包好的桌面应用,与 Docker 镜像同一个 `v<VERSION>` tag 一起发:

| 平台 | 产物 |
|---|---|
| macOS(Apple Silicon) | `bilibili-notify-macos-arm64.dmg` / `.app.zip` |
| Windows x64 | `bilibili-notify-windows-x64-setup.exe` / `.zip`(免安装) |

装完直接开,面板与功能同 Docker 版 —— 它内嵌的就是同一套服务端与控制台。两点差异:

- **卡片渲染用你本机的浏览器**,按平台自动探测 Chrome / Edge / Chromium 的默认安装位置;都没有则降级为纯文字推送,也可在系统页手填路径或指向远程浏览器。
- **字体来自你的操作系统**,不是镜像里那套 —— 所以卡片设置里「手填字体名」在桌面版填苹方 / 微软雅黑这类系统自带字体就作数(容器里则只有思源黑 / 思源宋)。

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
| `TZ` | `Asia/Shanghai` | 容器时区(影响日志 / 历史按日切文件) |
| `BN_LOG_LEVEL` | `info` | 日志级别;引擎启动后被 dashboard 配置接管 |
| `BN_MEMORY_PROBE_SECONDS` | 未设(=600) | 内存自检日志的采样间隔(秒);`0` = 关闭,下限 30 |
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

但抬上限只是止痛 —— 堆要是**慢慢涨**上去的,抬完只是把崩溃推迟。想分清是哪一种,
翻日志里的 `[mem]` 行(默认 10 分钟一条,一并报出弹幕收集器占的规模):

```
[mem] heap 210/512MB (41%, 已提交 250MB) rss 340MB external 12MB | 弹幕 3 房/12000 词/8000 人
```

`heap 已用/上限`是唯一会导致 FATAL 的那个数;`已提交`是 V8 为此实际占下的量,
用量平而它一路涨说明是碎片化。**`external` 不受堆上限管**(jieba 词典等都在里面),
所以别照堆上限去设 `mem_limit`,否则会从撞 V8 上限变成被系统 OOM 杀。

一开机就接近上限 → 是容量不够,抬上限就对了;几个小时一路爬上去 → 是泄漏,
请带上这几行开 issue。堆用量超过上限 85% 时这条会升成 `warn` 并附上处理办法;
不想要这条日志可设 `BN_MEMORY_PROBE_SECONDS=0` 关掉。

### 故障排查

- `curl localhost:8787` 返回 404:控制台静态资源默认取服务端入口旁边那份(`/app/web-dist`),正常启动日志会出现 `serving dashboard static assets from /app/web-dist`。日志里出现 `dashboard static assets disabled` = 镜像里那份资源没了,重拉镜像;出现 `webDistDir is pinned to …` = 你自己在 yaml 或 `BN_WEB_DIST` 里指了别处,删掉即可恢复默认。
- 卡片预览显示「**连接中断**」:请求没拿到响应,不是渲染失败。多半是上面那两条 —— 反代读超时太短,或服务端被 OOM 杀掉重启了。先按上面两条命令查。
- 手写过 `bn.config.yaml`:建议备份后删除该文件,让容器重新生成;不要删除 `./data`。

### Volume

`/data`(状态)与 `/config`(bootstrap yaml)是两个独立挂载点,都要 bind-mount 到宿主,否则随容器丢失。

```
/data
├── state/      globals.json / subscriptions.json / targets.json / adapters.json
├── secrets/    加密的 B 站 cookie / AI apiKey
├── history/    推送历史(按日 jsonl)
├── logs/       日志归档(按日 jsonl)
└── fans/       粉丝数时序
```

## 登录与安全

- **首次启动凭据**:未显式设凭据时,首启动自动生成 `admin` + 随机密码,写进 `./config/bn.config.yaml` 并打印到容器日志。也可在 compose 里设 `BN_DASHBOARD_USER` / `BN_DASHBOARD_PASS`(仅首启动生效)。**登录后请立即改掉默认密码。**
- **拒启保护**:监听非 loopback 又无凭据时服务拒绝启动;`BN_ALLOW_NO_AUTH=1` 可强制放行(自担风险)。
- **`auth.allowedOrigins`**:非 localhost 部署务必设置 —— 它门禁 WebSocket upgrade 并兜底防 CSRF,填 dashboard 自己的 origin。
- **会话**:登录态是签名 cookie,滑动过期(空闲 ≤ 7 天),无服务端吊销;轮换 dashboard 密码可使所有已签发 cookie 立即失效。
- **限流**:每 IP 登录限流以直连对端为 key,不信任 `X-Forwarded-For`。反代后所有客户端共用一个桶 —— 必须在代理层另做鉴权 / IP 白名单。

## secrets 静态加密

B 站 cookie 与 AI apiKey 存在 `<dataDir>/secrets/`,AES-256-GCM 加密。密钥来自 `cookieEncryptionKey`(环境变量回退 `BN_COOKIE_KEY`):

- **设置**:密钥由口令经 scrypt 派生、不落盘。生成:`openssl rand -base64 32`。
- **不设**:回退到与密文同目录的随机密钥文件 —— 仅混淆,启动打告警。

## 接入 OneBot(NapCat)

控制台 **推送目标** → 新建适配器,platform 选 `onebot`,连接方式三选一:

- **HTTP** —— 填 bot 的 HTTP API `baseUrl`,如 `http://napcat:3000`。
- **正向 WS** —— 填 bot 的 WS 地址,如 `ws://napcat:3001`。
- **反向 WS** —— 填一个监听端口,bot 主动连入;该端口需在 compose `ports:` 额外映射。

`docker-compose.example.yaml` 含注释掉的 NapCat 边车段落。

## 开发

```bash
vp install
vp run dev:apps                          # apps/server + apps/web 并行
curl -s http://localhost:8787/api/health
```

`vp run build` 产出构建物。
