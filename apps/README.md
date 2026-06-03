# Bilibili-Notify Dashboard

独立端形态:Hono HTTP / WS 服务端 + React 控制台。Docker 部署,自带可视化面板(扫码登录、订阅、推送目标、历史、日志)。

## 部署(Docker)

推荐用 compose,模板见 [`docker-compose.example.yaml`](./docker-compose.example.yaml)。复制后一条命令启动,不要手动创建 `config/bn.config.yaml`。镜像默认走 Docker Hub,也可改用 GHCR:`ghcr.io/akokk0/bilibili-notify:alpha`。

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
  akokk0/bilibili-notify:alpha
```

GHCR 镜像同 tag 发布:

```bash
docker pull ghcr.io/akokk0/bilibili-notify:alpha
```

## 配置

镜像默认 `BN_CONFIG=/config/bn.config.yaml`,走 **B 模型**:

- **首次启动**:`BN_*` 环境变量 + 默认值 seed 出 `bn.config.yaml`。
- **之后**:yaml 是唯一真相,环境变量被忽略。改配置 = 编辑 `./config/bn.config.yaml` + `docker compose restart`。
- **重置**:删 `./config/bn.config.yaml` + 重新启动。
- **不要手写配置文件**:只挂载 `./config:/config`,让容器生成完整 yaml;如必须手写,保留 `webDistDir: /app/web-dist`。

完整字段见 `server/src/config/schema.ts`,样例见 `server/bn.config.example.yaml`。开发模式(不设 `BN_CONFIG`)走 12-factor:`bn.config.{yaml,json}` < 环境变量 < CLI 三层合并,不 seed 文件。

### 镜像内置 ENV

| 变量 | 默认 | 用途 |
|---|---|---|
| `BN_CONFIG` | `/config/bn.config.yaml` | bootstrap 配置文件路径 |
| `BN_HOST` / `BN_PORT` | `0.0.0.0` / `8787` | 监听地址 / 端口 |
| `BN_DATA_DIR` | `/data` | 运行时状态目录 |
| `BN_CHROME_PATH` | `/usr/bin/chromium` | puppeteer-core 浏览器 |
| `BN_WEB_DIST` | `/app/web-dist` | 控制台静态资源 |
| `TZ` | `Asia/Shanghai` | 容器时区(影响日志 / 历史按日切文件) |
| `BN_LOG_LEVEL` | `info` | 日志级别;引擎启动后被 dashboard 配置接管 |
| `BN_DASHBOARD_USER` / `BN_DASHBOARD_PASS` | 未设 | dashboard 登录凭据(首启动 seed 源) |
| `BN_COOKIE_KEY` | 未设 | secrets 加密密钥(首启动 seed 源) |

`BN_CONFIG` / `BN_HOST` / `BN_PORT` / `BN_DATA_DIR` / `BN_CHROME_PATH` / `BN_WEB_DIST` 由镜像固定注入,compose 里不要重写。

### 故障排查

- `curl localhost:8787` 返回 404:检查 `./config/bn.config.yaml` 是否缺少 `webDistDir: /app/web-dist`;正常启动日志会出现 `serving dashboard static assets from /app/web-dist`。如果配置和 `BN_WEB_DIST` 都缺失,服务会再检查镜像默认 `/app/web-dist/index.html`;仍没有时日志会说明 Dashboard 静态资源已禁用。
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
