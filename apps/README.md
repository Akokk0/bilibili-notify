# Bilibili-Notify Dashboard

Hono HTTP 服务端 + React 控制台。

## 目录结构

```
apps/
  server/                    # Hono + Node 24 后端(@bilibili-notify/server)
  web/                       # React + Vite 控制台(@bilibili-notify/web)
  Dockerfile
  docker-compose.example.yaml
```

业务核心通过 pnpm `workspace:*` 协议被服务端消费。

## 快速开始(开发)

工具链:**vp (vite-plus)**。

```bash
vp install
vp run typecheck
vp run dev:apps              # apps/server + apps/web 并行
curl -s http://localhost:8787/api/health
```

`vp run build` 产出构建物;`vp run start:server` 跑产物。

## 配置

bootstrap 配置加载顺序:

1. CLI 参数
2. 环境变量(`BN_*`)
3. `./bn.config.{yaml,json}`(或 `BN_CONFIG=path/to/file`)
4. 默认值

必填项:`server.{host,port}`、`dataDir`。完整 Zod schema 见 `server/src/config/schema.ts`。改动对照 `server/bn.config.example.yaml`;复制成 `bn.config.yaml`(已 gitignore)按本机情况修改。

### 静态加密(`cookieEncryptionKey` / `BN_COOKIE_KEY`)

B 站登录 cookie 与 AI apiKey 存放在 `<dataDir>/secrets/` 下,用 AES-256-GCM 加密。密钥来自 `cookieEncryptionKey`(环境变量回退 `BN_COOKIE_KEY`):

- **设置它**:密钥由 passphrase 经 scrypt 派生,不落盘。生成:

  ```bash
  openssl rand -base64 32
  ```

- **不设置**:服务端仍能启动,但回退到与密文同目录的随机密钥文件 —— 仅混淆,非真正保护。启动时打告警。

> GCM 之前的旧 cookie 无法解密 —— 重新扫码一次即可。

## 安全

dashboard 凭证(`BN_DASHBOARD_USER` / `BN_DASHBOARD_PASS`,或 yaml 里的 `auth.basicAuth`)是 `/api/*` 与 WS 的唯一门禁。

- **用强随机、唯一的密码。** 服务端只校验非空,没有复杂度策略。生成:`openssl rand -base64 24`。

- **反代后也要在代理层做鉴权。** 每 IP 登录限流以*直连对端*为 key;`X-Forwarded-For` 不信任。反代后所有客户端共用一个桶:攻击者失败 5 次就能**把所有人锁死** 60 s。内置限流不能替代代理层鉴权 / IP 白名单 / mTLS。

- **非 localhost 部署都设 `auth.allowedOrigins`。** 它门禁 WebSocket upgrade,并在 SameSite=Strict 之上为 `POST /api/session/{login,logout}` 兜底防 CSRF。填 dashboard 自己的 origin,如 `["https://bn.example.com"]`。

- **会话无服务端吊销。** 登出只清除*该*浏览器 cookie;被复制的 cookie 在过期前(滑动,空闲 ≤ 7 天)仍有效。逃生口:轮换 `BN_DASHBOARD_PASS`,所有已签发 cookie 立即失效。

- **Loopback 裸跑模式。** 未配置凭证时,非 loopback 绑定会拒启,除非 `BN_ALLOW_NO_AUTH=1`。

## Docker 部署

镜像把 React 控制台打包在 `/app/web-dist`,Hono 对非 `/api/*` 路径直接服务它。

```bash
# 仓库根构建:
docker build -f apps/Dockerfile -t bilibili-notify:dev .

# 或拉取预构建:
docker pull akokk0/bilibili-notify:latest

docker run -d \
  --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/bn.config.yaml:/app/apps/server/bn.config.yaml:ro" \
  -e BN_DASHBOARD_USER=admin \
  -e BN_DASHBOARD_PASS='change-me' \
  bilibili-notify:dev
```

`docker-compose.example.yaml` 提供模板,含注释掉的 NapCat 边车。

### 镜像内置默认值

| 环境变量 | 镜像内默认 | 用途 |
|---|---|---|
| `BN_HOST` | `0.0.0.0` | 绑定地址 |
| `BN_PORT` | `8787` | http 端口 |
| `BN_DATA_DIR` | `/data` | 运行时状态(volume) |
| `BN_CHROME_PATH` | `/usr/bin/chromium` | puppeteer-core 用 |
| `BN_WEB_DIST` | `/app/web-dist` | 控制台静态目录 |
| `BN_LOG_LEVEL` | (未设 → `info`) | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent`。仅管早期启动窗口,引擎起来后被 dashboard 的 `globals.app.logLevel` 覆盖。 |
| `BN_DASHBOARD_USER` / `BN_DASHBOARD_PASS` | (未设 → 无认证,告警) | dashboard 登录凭证 |
| `BN_COOKIE_KEY` | (未设 → `/data/secrets` 下自动生成) | B 站 cookie 加密密钥 |
| `BN_CONFIG` | (未设) | bootstrap yaml/json 路径 |

### Volume 布局

```
/data
├── secrets/
│   └── master.key                # 自动生成的 AES 密钥
├── state/
│   ├── globals.json
│   ├── subscriptions.json
│   └── targets.json
└── history/
    ├── 2026-05-09.jsonl
    └── img/
```

`/data` 是 volume,bind-mount 到宿主目录,否则状态随容器丢失。

### 接入 OneBot(NapCat)

1. 起 napcat 边车(取消 `docker-compose.example.yaml` 里那段注释),在 WebUI `http://<host>:6099` 配置 QQ 账号。
2. 控制台**推送目标** → **新建** → platform `onebot`,baseUrl `http://napcat:3000`(docker 内主机名),如设了 accessToken 则填上,选 `scope=group` + 目标群号。
3. 点**测试**确认有响应,再保存。

## Koishi 端

`../koishi/core` 及并列子插件包。

## 分支与发布

`packages/` `koishi/` `apps/` 三类改动都落在 `refactor`;Koishi 端 npm 发版来自 `main`,独立端推 Docker Hub `akokk0/bilibili-notify`。详见仓库根 `README.md`。
