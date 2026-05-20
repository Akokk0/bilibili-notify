<h1 align="center">
  <img src="./docs/images/logo.png" width="160" />
  <br>
  Bilibili Notify
  <br>
</h1>

<p align="center">
  监听 B 站 UP 主<b>动态 / 直播</b>,渲染成卡片图片,推送到 QQ 群等渠道。
  <br>
  一套业务核心,两种形态:<b>Koishi 插件</b> 与 <b>独立 Web Dashboard</b>。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/koishi-plugin-bilibili-notify"><img src="https://img.shields.io/npm/v/koishi-plugin-bilibili-notify?label=koishi-plugin" alt="npm" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-339933?logo=nodedotjs&logoColor=white" alt="node" />
</p>

<p align="center">
  子插件:
  <a href="./koishi/core/README.md">核心</a> ·
  <a href="./koishi/live/README.md">直播</a> ·
  <a href="./koishi/dynamic/README.md">动态</a> ·
  <a href="./koishi/image/README.md">图片渲染</a> ·
  <a href="./koishi/ai/README.md">AI</a> ·
  <a href="./koishi/advanced-subscription/README.md">高级订阅</a>
  &nbsp;|&nbsp;
  <a href="./apps/README.md">独立 Dashboard 部署文档</a>
</p>

---

## 选哪种形态

| | Koishi 插件 | 独立 Web Dashboard |
|---|---|---|
| 适合 | 已经在用 Koishi 机器人 | 不想装 Koishi、想要可视化面板 |
| 形态 | npm 包 `koishi-plugin-bilibili-notify*` | Docker 镜像 |
| 配置 | Koishi 控制台 | 自带 React 控制台(扫码、订阅、推送目标、历史) |
| 状态 | 历史 / 现行发布形态 | 后续主推形态 |

两端消费同一套 `@bilibili-notify/*` 业务核心,功能等价。

## 功能

- **动态推送**:转发 / 文章 / 关键词黑白名单 / 正则过滤、@全体成员(仅开播触发)、免扰时段、定时复推
- **直播**:开播 / 下播、Superchat、上舰(舰长/提督/总督)、弹幕词云、AI 直播总结、特别关注用户进房/弹幕
- **AI**:OpenAI 兼容接口,动态锐评 + 直播总结,人格 / prompt per-UP 可定制
- **卡片渲染**:Vue + UnoCSS + Puppeteer SSR 出图,配色可自定义,实时预览
- **多推送目标**:OneBot v11(NapCat 等)/ Webhook / Web 通知中心,一等公民 `PushTarget`
- **per-UP 定制**:特性开关 / 路由 / 过滤 / 模板 / AI / 卡片样式全部 inherit-or-override
- **其它**:推送历史(按日 jsonl)、扫码登录、Cookie 自动续期

## 快速开始

### Koishi 插件

在 Koishi 控制台「插件市场」搜索 **bilibili-notify** 启用。子插件见上方导航。

### 独立 Dashboard(Docker)

```bash
docker run -d --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" \
  -e BN_DASHBOARD_USER=admin \
  -e BN_DASHBOARD_PASS='换成强随机密码' \
  akokk0/bilibili-notify:latest
```

浏览器打开 `http://<host>:8787`,登录后扫码绑定 B 站账号。完整配置见 **[apps/README.md](./apps/README.md)**。

> 镜像在 Docker Hub:`akokk0/bilibili-notify`。`latest` 从 `main` 构建,版本化镜像由 `image-v*.*.*` tag 触发。

## 仓库结构

```
packages/   平台中立业务核心(@bilibili-notify/*)
koishi/     Koishi 薄壳插件(koishi-plugin-bilibili-notify*)
apps/       Hono 服务端 + React Dashboard
```

单 pnpm workspace、单 lockfile;`apps/server` 通过 `workspace:*` 消费业务核心。

## 开发

工具链统一走 **vp (vite-plus)**(包裹 pnpm,不暴露 `pnpm` 命令)。

```bash
vp install
vp run typecheck
vp run build
vp test run
vp run dev:apps            # apps/server + apps/web 并行
vp run check               # Biome lint + format(:fix 自动修)
```

Git hooks 由 Lefthook 在 `vp install` 时装好。

## 分支与发布

- **`refactor`** — 活跃开发主干。
- **`main`** — 旧版发布快照;`refactor → main` 合并触发 Koishi 端 changesets npm 发版。
- 独立端推送到 Docker Hub `akokk0/bilibili-notify`。

## License

[MIT](./LICENSE)
