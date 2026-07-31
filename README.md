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
  <a href="./koishi/README.md">Koishi 插件文档</a>
  &nbsp;|&nbsp;
  <a href="./apps/README.md">独立 Dashboard 部署文档</a>
</p>

---

## 功能

- **动态推送**:转发 / 文章 / 关键词黑白名单 / 正则过滤、@全体成员(仅开播触发)、免扰时段、定时复推
- **直播**:开播 / 下播、Superchat、上舰、弹幕词云、AI 直播总结、特别关注用户进房 / 弹幕
- **AI**:OpenAI 兼容接口,动态锐评 + 直播总结,人格库可 per-UP 指定;主模型不支持看图也能配一个视觉子模型代读。独立端另带聊天界面(连续对话、贴图、Markdown 排版)
- **数据统计**(独立端):涨粉 / 投稿 / 动态 / 直播活动留档,对比表、热力图、雷达图、单 UP 钻取;可让 AI 据此写周报或单人锐评并推成卡片
- **卡片渲染**:Vue + UnoCSS + Puppeteer SSR 出图,配色 / 背景图 / 字体可自定义(独立端还能直接上传字体文件),实时预览
- **多推送目标**:OneBot v11(NapCat 等,支持 HTTP / 正向 WS / 反向 WS)/ Webhook / Web 通知中心
- **per-UP 定制**:特性开关 / 路由 / 过滤 / 模板 / AI / 卡片样式全部 inherit-or-override
- **其它**:推送历史(按日 jsonl)、扫码登录、Cookie 自动续期

## 选哪种形态

| | Koishi 插件 | 独立 Web Dashboard |
|---|---|---|
| 适合 | 已经在用 Koishi 机器人 | 不想装 Koishi、想要可视化面板 |
| 形态 | npm 包 `koishi-plugin-bilibili-notify` | Docker 镜像,或 macOS / Windows 桌面应用 |
| 配置 | Koishi 控制台 | 自带 React 控制台 |

两端消费同一套 `@bilibili-notify/*` 业务核心,功能等价。

## 快速开始

### Koishi 插件

在 Koishi 控制台「插件市场」搜索 **bilibili-notify** 启用,单包即含全部功能。详见上方 Koishi 插件文档。

### 独立 Dashboard(Docker)

```bash
docker run -d --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" -v "$(pwd)/config:/config" \
  akokk0/bilibili-notify:latest
```

浏览器打开 `http://<host>:8787`。首次启动自动生成 dashboard 登录凭据,见容器日志或 `./config/bn.config.yaml`。完整部署 / 配置见 **[apps/README.md](./apps/README.md)**。

镜像 tag:`latest` = 最新正式版(**推荐**);`vX.Y.Z` = 固定版本;`<short-sha>` = 按 commit 精确 pin。另有 `alpha` 预览渠道,**只在发布预览版时才更新** —— 没有在途预览版时它会一直停在上一个预览版,别拿它当「最新」。免 chromium 的 slim 变体见 [apps/README.md](./apps/README.md)。

### 独立 Dashboard(桌面应用)

不想碰 Docker 的话,[Releases](https://github.com/Akokk0/bilibili-notify/releases) 里有打包好的桌面应用:macOS(Apple Silicon,`.dmg`)与 Windows x64(`.exe` 安装包 / 免安装 zip)。装完直接开,面板与功能同 Docker 版;卡片渲染用你本机装的 Chrome / Edge。

## 仓库结构

```
packages/   平台中立业务核心(@bilibili-notify/*)
koishi/     Koishi 薄壳插件(koishi-plugin-bilibili-notify)
apps/       Hono 服务端 + React Dashboard(Docker / 桌面应用)
astrbot/    AstrBot 平台插件(发布到独立仓库)
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

分支:`dev` 为活跃开发主干,PR 提到这里;`main` 是发布快照,不触发任何发版。

发版三端各走各的,互不牵动:Koishi 端由 `koishi/package.json` 的 `version` 变动 + push `dev` 触发 npm 发布;独立端由 `v<VERSION>` git tag 触发,同时产出 Docker 镜像(Docker Hub `akokk0/bilibili-notify` 与 GHCR)和 macOS / Windows 桌面安装包。机制详见 [`docs/agents/build-release.md`](./docs/agents/build-release.md)。

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
