<h1 align="center">
  <img src="./docs/images/logo-squircle.png" width="200" />
  <br>
  Bilibili Notify
  <br>
</h1>

<p align="center">
  监听 B 站 UP 主<b>动态 / 直播</b>,渲染成卡片图片,推送到 QQ 群等渠道。
  <br>
  自带 Web 控制台:<b>Docker 镜像</b>,或 <b>macOS / Windows 桌面应用</b>。
</p>

<p align="center">
  <a href="https://github.com/Akokk0/bilibili-notify/releases/latest"><img src="https://img.shields.io/github/v/release/Akokk0/bilibili-notify?label=standalone" alt="独立端最新版本" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-339933?logo=nodedotjs&logoColor=white" alt="node" />
</p>

<p align="center">
  <a href="./apps/README.md">部署与配置文档</a>
</p>

---

## 功能

- **动态推送**:转发 / 文章 / 关键词黑白名单 / 正则过滤、@全体成员(仅开播触发)、免扰时段、定时复推
- **直播**:开播 / 下播、Superchat、上舰、弹幕词云、AI 直播总结、特别关注用户进房 / 弹幕
- **AI**:OpenAI 兼容接口,动态锐评 + 直播总结,人格库可 per-UP 指定;主模型不支持看图也能配一个视觉子模型代读。另带聊天界面(连续对话、贴图、Markdown 排版)
- **数据统计**:涨粉 / 投稿 / 动态 / 直播活动留档,对比表、热力图、雷达图、单 UP 钻取;可让 AI 据此写周报或单人锐评并推成卡片
- **卡片渲染**:Vue + UnoCSS + Puppeteer SSR 出图,配色 / 背景图 / 字体可自定义(还能直接上传字体文件),实时预览
- **多推送目标**:OneBot v11(NapCat 等,支持 HTTP / 正向 WS / 反向 WS)/ Webhook / Web 通知中心
- **per-UP 定制**:特性开关 / 路由 / 过滤 / 模板 / AI / 卡片样式全部 inherit-or-override
- **其它**:推送历史(按日 jsonl)、扫码登录、Cookie 自动续期、应用内自主升级

## 界面预览

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

## 快速开始

### Docker

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

### 桌面应用

不想碰 Docker 的话,[Releases](https://github.com/Akokk0/bilibili-notify/releases) 里有打包好的桌面应用:macOS(Apple Silicon,`.dmg`)与 Windows x64(`.exe` 安装包 / 免安装 zip)。装完直接开,面板与功能同 Docker 版;卡片渲染用你本机装的 Chrome / Edge。

## 仓库结构

```
packages/   平台中立业务核心(@bilibili-notify/*)
apps/       Hono 服务端 + React Dashboard + Tauri 桌面壳(Docker / 桌面应用)
```

单 pnpm workspace、单 lockfile;`apps/server` 通过 `workspace:*` 消费业务核心。Koishi 插件与 AstrBot 插件已暂停更新,源码与维护版发布在 `koishi-astrbot-maintenance` 分支;后续会以薄适配插件的形式把独立端桥接进这两个宿主。

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

分支:`dev` 为活跃开发主干,PR 提到这里;`main` 是发布快照,不触发任何发版;`koishi-astrbot-maintenance` 是两个插件宿主的维护线。

发版由 `v<VERSION>` git tag 触发,同时产出 Docker 镜像(Docker Hub `akokk0/bilibili-notify` 与 GHCR)、macOS / Windows 桌面安装包与应用内更新载荷。机制详见 [`docs/agents/build-release.md`](./docs/agents/build-release.md)。

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
