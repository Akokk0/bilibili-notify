# 发版:AstrBot 插件(独立仓)

版本事实源是 `astrbot/core/metadata.yaml#version`。发布把 `astrbot/core` **工作目录**(含 gitignored 的构建产物 `sidecar/app` + `pages/dashboard` —— 插件运行必需)作为单个 squash 提交 push 到独立仓 `Akokk0/astrbot_plugin_bilibili_notify`。

## CI 路径(推荐)

`.github/workflows/astrbot-release.yml`,**监测 `metadata.yaml#version` 变化**驱动,跨仓 push 用 secret `RELEASE_PAT`。

1. **写 CHANGELOG** — 按 [changelog.md](changelog.md) 写 `astrbot/CHANGELOG.md` 的新版本段。基线 = CHANGELOG 顶部版本(即 `metadata.yaml#version` 的现值)。⚠️ 这一步含**按端归属判断**:`astrbot/sidecar` 经 `workspace:*` 消费九个 `@bilibili-notify/*` 共享包,但改了共享包**不代表 AstrBot 受影响** —— 必须 grep `astrbot/sidecar/src` + `astrbot/core` 验证它是否真的用到了被改的能力,别把别端专属的修复写进来。完成:本批改动都归了端,AstrBot 该得的都在里面。
2. **定版本** — 版本号**由用户拍板**,不要自己决定。完成:用户给了版本号。
3. **dry-run 预演** — Actions → "astrbot release" → Run workflow(ref=dev, dry_run=true)。完成:run 绿,日志含 `build:astrbot` 成功 + `[dry-run] skip push`。
4. **正式发布(不可逆)** — 把版本号写进 `astrbot/core/metadata.yaml#version`(单一来源,Dashboard 也读它),**连同 CHANGELOG 一起**提交并 push 到 **dev** → workflow 比对 HEAD~1 检测到 version 变化、自动发布(没变则跳过)。完成:workflow 绿,独立仓 `main` 收到新提交。

**顺序要紧**:CHANGELOG 先写、版本号后改。`metadata.yaml#version` 是发版扳机 —— 它和 CHANGELOG 得在同一个 commit 里 push 出去,漏了 CHANGELOG 就只能补发一版。(与 koishi 的 `package.json#version` 同一套心智。)

## 本地路径(备选)

`vp run build:astrbot` → `vp run check:astrbot-python` → `vp run release:astrbot-core -- --dry-run`(核对内容)→ `vp run release:astrbot-core`。

## 不可逆点

正式发布(version bump push 或本地真跑)直推**公开**独立仓,出错只能再推修正。CI dry-run 不 push。本地脚本曾因 `vp run … -- --dry-run` 的 `--` 转发把 dry-run **跑成真推送** —— 走本地路径务必确认输出确是 dry-run 再真发;CI 的 dispatch dry_run 更安全。
