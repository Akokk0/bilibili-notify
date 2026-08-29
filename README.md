<h1 align="center">
  <img src="./docs/images/logo-squircle.png" width="200" />
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
  <a href="https://github.com/Akokk0/bilibili-notify/releases/latest"><img src="https://img.shields.io/github/v/release/Akokk0/bilibili-notify?label=standalone" alt="独立端最新版本" /></a>
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

## 界面预览

以下为独立 Web Dashboard,Koishi 端的配置界面在 Koishi 控制台内。

<table>
  <tr>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-1.png" alt="概览" /><br />
      <sub><b>概览</b> —— 开播状态、粉丝涨跌、本周推送趋势、最近推送时间轴,以及各模块健康度一览</sub>
    </td>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-2.png" alt="数据统计" /><br />
      <sub><b>数据统计</b> —— 多 UP 横向对比、活跃热力图、粉丝净增趋势与内容构成,可让 AI 据此写周报锐评</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-3.png" alt="订阅 UP 主" /><br />
      <sub><b>订阅 UP 主</b> —— 每个 UP 单独开关动态 / 开播 / 词云 / 直播总结等,还能按推送目标再覆盖一层</sub>
    </td>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-4.png" alt="卡片渲染 · 样式" /><br />
      <sub><b>卡片渲染 · 样式</b> —— 配色、字体、背景图随改随看,四种卡片由 Puppeteer 真实渲染实时预览</sub>
    </td>
  </tr>
</table>

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

compose 与 `docker run` 都可以,**推荐 compose** —— 配置留在文件里,以后升级或改参数不用重敲一长串命令。新建 `docker-compose.yaml`:

```yaml
services:
  bilibili-notify:
    image: akokk0/bilibili-notify:latest
    container_name: bilibili-notify
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      # 首启动后请改掉默认密码;删掉这两行则自动生成随机密码(见容器日志)
      BN_DASHBOARD_USER: admin
      BN_DASHBOARD_PASS: change-me-on-first-boot
    volumes:
      - ./data:/data       # 运行时状态(订阅 / 历史 / 日志 / 凭据)
      - ./config:/config   # 只挂目录,bn.config.yaml 由容器自动生成
```

然后在同目录启动:

```bash
docker compose up -d
```

浏览器打开 `http://<host>:8787` 登录面板。屏幕左缘的**「指引」导览**会带你走完剩下的配置(登录 B 站 → 接上 QQ / webhook 推送 → 订阅 UP),每步做完自动进入下一步;手把手图文教程(含 QQ 机器人两条接入路线的选型与踩坑)在面板内 **关于 · 新手指引**。**不要手动创建 `config/bn.config.yaml`** —— 容器首次启动会自己生成完整配置。

更新镜像用 `docker compose pull && docker compose up -d`(`restart` 不换镜像)。带 browserless / NapCat 边车的完整模板见 [`apps/docker-compose.example.yaml`](./apps/docker-compose.example.yaml),完整部署 / 配置见 **[apps/README.md](./apps/README.md)**。

不想写 compose 文件也可以直接 `docker run`。下面这条与上面的 compose 等效,只是没设登录凭据 —— 密码会随机生成,到容器日志或 `./config/bn.config.yaml` 里取:

```bash
docker run -d --name bilibili-notify \
  --restart unless-stopped \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" -v "$(pwd)/config:/config" \
  akokk0/bilibili-notify:latest
```

镜像 tag:`latest` = 最新正式版(**推荐**);`vX.Y.Z` = 固定版本;`<short-sha>` = 按 commit 精确 pin。另有 `alpha` 预览渠道,**只在发布预览版时才更新** —— 没有在途预览版时它会一直停在上一个预览版,别拿它当「最新」。

full 镜像内置 chromium,出图峰值不低,建议宿主可用内存 ≥ 1GB;只有 512MB 的小鸡请改用免 chromium 的 slim 变体 + 远程浏览器,见 [apps/README.md](./apps/README.md)。

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
