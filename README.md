<h1 align="center">
  <img src="./docs/images/logo-squircle.png" width="200" />
  <br>
  Bilibili Notify
  <br>
</h1>

<p align="center">
  订阅创作者的<b>作品 / 直播</b>,渲染成卡片图片,推送到 QQ 群等渠道。
  <br>
  自带 Web 控制台，通过 <b>Docker</b>、<b>macOS / Windows 桌面应用</b>或 <b>npm</b> 运行。
</p>

<p align="center">
  <a href="https://github.com/Akokk0/bilibili-notify/releases/latest"><img src="https://img.shields.io/github/v/release/Akokk0/bilibili-notify?label=stable" alt="最新正式版" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524.15.0-339933?logo=nodedotjs&logoColor=white" alt="node" />
</p>

<p align="center">
  <a href="./apps/README.md">部署与配置文档</a>
</p>

---

Docker 和桌面应用的快速开始使用最新正式版。功能介绍跟随仓库实现，已发布版本的功能与配置请查阅对应发行标签下的文档。[最新正式版](https://github.com/Akokk0/bilibili-notify/releases/latest)

## 功能

- 内置 **B 站**，可安装抖音、虎牙和微博拓展。按来源提供的能力配置作品或直播提醒，支持关键词过滤、免扰时段和定时复推
- **直播通知**覆盖开播、直播中与下播。B 站还支持 Superchat、上舰、弹幕词云、AI 直播总结、特别关注用户进入直播间或发弹幕
- **女仆 AI** 使用 OpenAI 兼容接口或 DeepSeek 官方服务生成作品点评、直播总结与统计周报。女仆聊天和推送可按配置联网。图片理解、文件解析和录音转写依赖所选服务，推送里的女仆文字可在支持的目标转成语音
- **数据统计**:粉丝 / 作品 / 直播活动留档,B 站累计视频播放量可按创作者或全部开启,支持小时 / 日走势;对比表、热力图、雷达图、单人分析;可让 AI 据此写周报或单人锐评并推成卡片
- **卡片渲染**:Vue + UnoCSS + Puppeteer SSR 出图,配色 / 背景图 / 字体可自定义(还能直接上传字体文件),实时预览
- **多推送目标**:QQ 官方机器人、OneBot v11(NapCat 等,支持 HTTP / 正向 WS / 反向 WS)、飞书 / 钉钉 / 企业微信群机器人、自定义 HTTP 端点和 Web 通知中心
- **拓展**可从市场或 ZIP 安装，开发版支持挂载源码并自动重载。机器人框架桥接可借用 Koishi / AstrBot 的机器人，将通知发到 Telegram / Discord / KOOK 等平台
- **按订阅定制**:特性开关 / 路由 / 过滤 / 模板 / AI / 卡片样式可继承全局设置或单独覆盖
- **资源库**:统一管理图片、字体、女仆技能、女仆性格、界面皮肤和卡片皮肤，支持导入导出
- **多语言**:面板、使用指引和运行日志支持简体中文、台湾繁体中文、英文、日文
- **其它**:推送历史、来源账号管理、扫码登录、应用内自主升级

## 界面预览

<table>
  <tr>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-1.png" alt="概览" /><br />
      <sub><b>概览</b> —— 开播状态、粉丝涨跌、本周推送趋势、最近推送时间轴,以及各模块健康度一览</sub>
    </td>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-2.png" alt="数据统计" /><br />
      <sub><b>数据统计</b> —— 多创作者横向对比、活跃热力图、粉丝净增趋势与内容构成,可让 AI 据此写周报锐评</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-3.png" alt="订阅" /><br />
      <sub><b>订阅</b> —— 按来源提供的能力配置作品和直播通知，并为每条订阅选择推送目标</sub>
    </td>
    <td width="50%">
      <img src="https://github.com/Akokk0/bilibili-notify/releases/download/assets/dashboard-4.png" alt="卡片渲染 · 样式" /><br />
      <sub><b>卡片渲染 · 样式</b> —— 配色、字体、背景图随改随看,四种卡片由 Puppeteer 真实渲染实时预览</sub>
    </td>
  </tr>
</table>

## 快速开始

### Docker

使用 Compose 管理镜像、端口和数据目录。把下面内容保存为 `docker-compose.yaml`。

```yaml
services:
  bilibili-notify:
    image: akokk0/bilibili-notify:latest
    container_name: bilibili-notify
    restart: unless-stopped
    ports:
      - "8787:8787"
    volumes:
      - ./data:/data       # 订阅、历史、日志和凭据
      - ./config:/config   # 首次启动自动生成 bn.config.yaml
```

在同目录启动。

```bash
docker compose up -d
```

首次启动后，运行 `docker compose logs bilibili-notify` 查看默认账号 `admin` 和随机密码，也可从 `./config/bn.config.yaml` 读取。浏览器打开 `http://<host>:8787` 登录面板。左侧「指引」会带你配置来源账号、推送连接、推送目标和订阅。使用拓展来源前，先安装并启用对应拓展。面板的「关于 → 新手指引」包含 QQ 机器人接入教程。

更新镜像用 `docker compose pull && docker compose up -d`(`restart` 不换镜像)。带 browserless / NapCat 边车的完整模板见 [`apps/docker-compose.example.yaml`](./apps/docker-compose.example.yaml),完整部署 / 配置见 **[apps/README.md](./apps/README.md)**。

也可以直接运行容器。首次启动的密码可用 `docker logs bilibili-notify` 查看。

```bash
docker run -d --name bilibili-notify \
  --restart unless-stopped \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" -v "$(pwd)/config:/config" \
  akokk0/bilibili-notify:latest
```

`latest` 镜像内置 Chromium，建议宿主可用内存至少 1 GB。内存较小的主机可用正式版的 `slim` 镜像并外接浏览器。[部署与配置](./apps/README.md)

### 桌面应用

从最新正式版发行页下载 macOS Apple Silicon 的 `.dmg`，或 Windows x64 的 `.exe` 安装包或免安装 ZIP。卡片渲染使用本机安装的 Chrome / Edge，也可配置远程浏览器。[下载正式版桌面应用](https://github.com/Akokk0/bilibili-notify/releases/latest)

### npm

npm 正式版发布前，通过 `@alpha` 安装 BN。需要 Node.js 24.15.0 或更高版本。

```bash
npx @bilibili-notify/bn@alpha web
```

npm 包自带宿主，首次启动无需从 GitHub 下载 BN 本体。拓展开发、数据目录和本仓构建方式见 [BN 启动器说明](./tools/bn-cli/README.md)。

## 仓库结构

```
packages/     平台中立业务核心(@bilibili-notify/*)
apps/         Hono 服务端 + React Dashboard + Tauri 桌面壳
extensions/   拓展 —— 装进来才有,不编在主程序里
tools/        BN npm 启动器与拓展创建器
```

单 pnpm workspace、单 lockfile;`apps/server` 通过 `workspace:*` 消费业务核心。老的 Koishi 插件与 AstrBot 插件已暂停更新,源码与维护版留在 `koishi-astrbot-maintenance` 分支。桥接现在由**拓展**接手:独立端开一扇 WS 门,koishi 那侧装一个薄插件把 bot 借过来 —— 见上面「功能」里的拓展一档,用法在[部署与配置文档](./apps/README.md)。

## 开发

工具链统一走 **vp (vite-plus)**，由仓库配置锁定 Node 与包管理器版本。

```bash
vp install
vp run dev:apps     # 启动服务端与面板，在拓展页挂载要联调的源码目录
vp run gate         # 全量检查、构建和测试
```

开发在 `dev` 进行，发布快照通过 PR 从 `dev` 同步到 `main`。`koishi-astrbot-maintenance` 保存旧 Koishi / AstrBot 插件的维护代码。

本体使用 `v<VERSION>` 标签发布 Docker、桌面应用、npm 和应用内更新。官方拓展、SDK 与拓展创建器各自编号发行。[构建与发布参考](./docs/agents/build-release.md)

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
