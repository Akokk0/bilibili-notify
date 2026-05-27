# Changelog · 独立端

`@bilibili-notify/server` + `@bilibili-notify/web` 独立端版本历史。Docker 镜像
`akokk0/bilibili-notify` 跟随这套版本号(由 `apps/server/package.json#version`
驱动,bump 后 push 到 `dev` 自动触发 `image-release` workflow 构建)。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);本仓库 koishi
端 `koishi-plugin-bilibili-notify*` npm 包版本独立维护,见各包 `CHANGELOG.md`。

---

## [0.1.0-alpha.4] — 2026-05-27

### Added

- 灵动岛草稿机制:Rules / Cards / Ai / System 四页修改字段时,屏幕底部漂浮 chip
  统一显示「页名 + 未保存字段数 + 保存」按钮,hover / click 展开后按 section 分组
  的字段级 diff list(旧值 → 新值),点单行跳转高亮目标 Field,左下「丢弃全部更改」
  一键回滚。chip 5 态:idle 不显示、dirty(待保存)、saving(保存中 spinner)、
  saved(✓ 1.2s 自动消失)、error(摇晃 + 红边 pulse 需手动 dismiss)。dirty 态
  chip 外圈 2px 粉色单弧流光环绕岛旋转 2.4s/圈。AiBar dismissed / expanded 时灵
  动岛垂直避让(4fcd59f..af13f66)

### Fixed

- 独立端 dashboard 修改全局 ai persona / cardStyle 后 dynamic 推送不跟随 hot-reload,
  仍用 add 订阅时的旧值(直播端因 refreshOps 不受影响);`buildDynamicSubsView` /
  `buildLiveSubViewSingle` 改为仅在 `sub.overrides.cardStyle` / `.ai` / `.filters`
  真存在时生成对应字段,推送路径回退到 `imageRenderer.config` / `commentary.config`
  全局兜底 (5bdedcc)
- 保存 AI 配置时,即便只改 persona / 温度 / 提示词也会触发连通性探活,导致按钮卡
  10s;后端 `shouldRunAiEnableCheck` 加值对比,patch 含连接字段但值跟 current 相同
  时不触发 (0395404)

---

## [0.1.0-alpha.3] — 2026-05-26

### Added

- @全体提醒拆为独立消息(@全体 → 卡片 → 文字三条),Koishi 主插件、advanced-subscription
  per-UP 覆盖、独立端 globals.@全体规则同步暴露 (f427278)
- 动态过滤新增「图文」「视频」两个屏蔽开关 (f427278)

### Fixed

- SC 卡片右侧文字贴边塌陷 (f427278)
- 上舰卡片长用户名挤掉舰长 / 提督 / 总督 logo (f427278)
- 直播卡片简介里 `<p>` / `<br>` 等富文本残片改为去标签纯文本(独立端镜像 image
  渲染路径同步生效)

### Build

- image-release workflow 5 个 inline shell step 提到 `.github/scripts/*.sh` (28b1e4e)
- 修复 codex audit 抓出的 7 类 CI 安全 / 一致性问题(包括 RELEASE_PAT 注入路径 /
  tag commit 鉴权 / merge job 串行化等)(22dce62)
- pnpm 11.1.3 → 11.3.0,docker / setup actions 升到最新版 (22854f5)
- arm64 镜像 build cache mode=max → mode=min,绕开 GHA cache export hang (7da55c6)
- tag push 鉴权改 basic auth,兼容 fine-grained PAT(`github_pat_*` 上不支持 bearer)
  (81a274e)

---

## [0.1.0-alpha.2] — 2026-05-24

### Added

- MasterNotifier 同步消费 `auth-lost` 与 `engine-error`,主人通知文案对齐独立端 (e600703)
- image-release workflow 自动创建 GitHub Release 挂在 `v<version>` tag 下 (87a1232)

### Fixed

- onebot 合并转发 node 用 bot 真身的 uin / nickname,而非订阅 master 假名 (f47810e)
- onebot forward send 先校验 target,latency 计入 `get_login_info` (db8ef70)

### Build

- image-release workflow build 拆 matrix(amd64 / arm64 各原生 runner)+ digest
  merge 替代 emulation,大幅缩短 arm64 镜像构建时间 (5cfbb89)
- docker actions 升到 v4/v7,checkout 升到 v6 (5ed8382)
- builder 阶段插 `vp --version` / `vp env doctor` 诊断输出 (74901a4)
- 显式 `pnpm install --no-frozen-lockfile` + `pnpm -r build` 拆两阶段 + `--stream`
  便于定位 hang (2a4d110, c41de2a)
- tag push + release 创建走 `secrets.RELEASE_PAT`(workflow `GITHUB_TOKEN` 没有
  workflow scope 写权)(8311a67)
- docker pull 命令省 `docker.io/` 前缀 (49a2805)

---

## [0.1.0-alpha.1] — 2026-05-24

### Added

- 独立端 cards 配置补齐 `font` / `hideDesc` / `hideFollower` 三字段(对齐 koishi
  image 子插件 schema)(7022322)
- 动态图集开关独立成 `imageGroup` 子段,支持 per-UP 覆盖 (ca47fe6)

### Changed

- 二维码渲染收进 `LoginFlow` 默认实现,koishi 端 / 独立端不再各自实现一遍 PNG 输出
  (7d32e87)
- koishi 端 config 模型整体收敛,internal 当唯一默认源;packages/internal 同步
  export `DEFAULT_AI` / `DEFAULT_CARD_STYLE` / `DEFAULT_TEMPLATES` 等(独立端通过
  共用 packages/internal 间接受益)(e0083e2)
- 直播卡片 `room_info.description` 富文本(`<p>` / `<br>` / entity-encoded)统一剥
  成 plain text(`html-to-plain.ts`)(77bbc77)
- forward-images sink 走 `payload.forward` 二分:默认普通群消息多 image segment
  (稳),显式合并转发节点(`h("message", { forward: true }, nodes)`)(5c632f7)
- 动态图集推送改用合并转发消息形态 (c3ee457)

### Fixed

- dashboard 未启用鉴权时误弹 LoginDialog 且走不出去 (22cb87e)
- onebot 错误响应加 NapCat 掉线提示文案 (dfb4388)
- onebot 私聊 scope target 报「group: groupId missing」(77b9b37)

### Breaking Changes

- `image` 子插件 `followerDisplay` 字段重命名为 `hideFollower` 并反转语义
  (`followerDisplay: true` → `hideFollower: false`)(106b3db, b9aaba6)
- `GlobalDefaults.imageGroup` 新子段:
  - 新增 `imageGroup: { enable, forward }`(老 `globals.json` 缺字段时按默认值兜底)
  - `Subscription.overrides.dynamic` 重命名为 `Subscription.overrides.imageGroup`
    (旧数据需外部迁移或 dashboard 重写一次)
  - `AppConfig` 删除原顶层两字段
  - `forward-images` payload 加 `forward: boolean` 区分合并转发卡片 vs 普通多图
  - 详见 ca47fe6

### Build

- 镜像 push 成功后自动打 git tag `v<version>` (dfdcb6f)
- `.dockerignore` 排除 `**/*.md` 误杀 changeset 文件 (1be8d4c)

---

## [0.1.0-alpha.0] — 2026-05-22

### Added

- monorepo 拆分后独立端首次镜像。业务核心独立成平台中立的 `@bilibili-notify/*`
  包,独立端通过 `apps/server` 消费这套核心,经 puppeteer + Hono 提供 HTTP API +
  WebSocket,`apps/web` (React 19 + Vite) 内嵌进同一镜像
- 独立端版本由 `apps/server/package.json#version` 驱动(本次起为 `0.1.0-alpha.0`),
  bump 后 push 到 dev 触发 image-release workflow 自动构建 + push Docker Hub +
  打 git tag + 创建 GitHub Release (9b7bb75)
