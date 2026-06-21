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

## 功能

- **动态推送**:转发 / 文章 / 关键词黑白名单 / 正则过滤、@全体成员(仅开播触发)、免扰时段、定时复推
- **直播**:开播 / 下播、Superchat、上舰、弹幕词云、AI 直播总结、特别关注用户进房 / 弹幕
- **AI**:OpenAI 兼容接口,动态锐评 + 直播总结,人格 / prompt 可 per-UP 定制
- **卡片渲染**:Vue + UnoCSS + Puppeteer SSR 出图,配色可自定义,实时预览
- **多推送目标**:OneBot v11(NapCat 等,支持 HTTP / 正向 WS / 反向 WS)/ Webhook / Web 通知中心
- **per-UP 定制**:特性开关 / 路由 / 过滤 / 模板 / AI / 卡片样式全部 inherit-or-override
- **其它**:推送历史(按日 jsonl)、扫码登录、Cookie 自动续期

## 选哪种形态

| | Koishi 插件 | 独立 Web Dashboard |
|---|---|---|
| 适合 | 已经在用 Koishi 机器人 | 不想装 Koishi、想要可视化面板 |
| 形态 | npm 包 `koishi-plugin-bilibili-notify*` | Docker 镜像 |
| 配置 | Koishi 控制台 | 自带 React 控制台 |

两端消费同一套 `@bilibili-notify/*` 业务核心,功能等价。

## 快速开始

### Koishi 插件

在 Koishi 控制台「插件市场」搜索 **bilibili-notify** 启用。子插件见上方导航。

### 独立 Dashboard(Docker)

```bash
docker run -d --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" -v "$(pwd)/config:/config" \
  akokk0/bilibili-notify:alpha
```

浏览器打开 `http://<host>:8787`。首次启动自动生成 dashboard 登录凭据,见容器日志或 `./config/bn.config.yaml`。完整部署 / 配置见 **[apps/README.md](./apps/README.md)**。

镜像 tag:`alpha` = 持续构建(当前可用);`latest` = 稳定版;`vX.Y.Z` = 固定版本。

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
vp test
vp run dev:apps     # apps/server + apps/web 并行
vp run check        # Biome lint + format(:fix 自动修)
```

### 只开发 Koishi 端(可选)

只想给 Koishi 插件(`packages/` + `koishi/`)贡献、不需要 `apps/` 与 `astrbot/`,可用 sparse-checkout 只检出这两块:

```bash
git clone --filter=blob:none --sparse https://github.com/Akokk0/bilibili-notify.git
cd bilibili-notify
git sparse-checkout set packages koishi
```

已有完整克隆也可直接 `git sparse-checkout set packages koishi` 收起其余目录,`git sparse-checkout disable` 随时全部恢复。仍是同一个仓库,提交照常提 PR 到 `dev`,CI 跑全量门禁。

此状态下不要跑全量 `vp run build` / `vp test`(`apps/`、`astrbot/` 不在工作树),改用 `vp run -F <包名> <script>` 针对单包。

分支:`dev` 为活跃开发主干;`main` 为发布分支,`dev → main` 合并触发 Koishi 端 npm 发版。独立端 Docker 镜像发布到 Docker Hub `akokk0/bilibili-notify`。

## 问题反馈

- [GitHub Issue](https://github.com/Akokk0/bilibili-notify/issues)
- QQ 交流群 `801338523`

## 支持项目

Bilibili Notify 是 MIT 开源、永久免费的项目。如果它帮到了你,欢迎在 [爱发电](https://afdian.com/a/akokko) 请女仆喝杯奶茶 —— 每一份心意,都会化作新功能与更少的 bug。

<p align="center">
  <img src="./docs/images/afdian.jpeg" width="220" alt="爱发电赞助二维码" />
</p>

## License

[MIT](./LICENSE)
