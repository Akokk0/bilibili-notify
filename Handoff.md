# Handoff · Windows Desktop 回归与独立端发版接力

## 当前状态

- 当前分支: `dev`。
- 本地 `dev` 相对 `origin/dev` 领先 7 个 commit,尚未 push。
- 工作树在重写本文件前是干净的;本次交回后 `Handoff.md` 本身会成为未提交改动。
- `v0.1.0-alpha.7` GitHub Release / tag 已在此前清理,该版本号仍可继续用于下一次正式发布。
- 抛开发布执行不谈,Handoff 原始工程项已完成:Windows Desktop 启动、sidecar 控制台窗口、Windows artifact smoke、Docker Hub / GHCR digest 分离、tag-driven standalone 版本同步均已落地。

## 已提交 commit

本地 `dev` 当前比 `origin/dev` 多以下 7 个 commit:

```text
f247551 style(web): use card radius token in logs panel
baf730c fix(desktop): redesign Windows tray icon
72039ff fix(desktop): stabilize Tauri build script
3b529fb fix(web): include desktop token in log downloads
ca46eb5 fix(desktop): simplify Windows menu and tray icon
b59ff2e fix(desktop): strip Windows verbatim sidecar paths
c9ff756 chore(release): derive standalone version from tag
```

## 已完成内容

### 1. 独立端版本模型改为 tag-driven

源码内独立端版本保持 `0.0.0-dev`,正式版本由 `v<VERSION>` tag 驱动。CI 在 Docker / Desktop 构建前临时同步版本元数据。

涉及要点:

- `.github/scripts/read-standalone-version.sh` 从 `VERSION` env 或 `GITHUB_REF_NAME=v<VERSION>` 读取版本。
- 新增 `.github/scripts/sync-standalone-version.sh`,同步以下文件版本:
  - `apps/server/package.json`
  - `apps/web/package.json`
  - `apps/desktop/package.json`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/desktop/src-tauri/Cargo.lock`
- `.github/workflows/version-tag.yml` 改为手动 tag helper。
- `.github/workflows/image-release.yml` / `.github/workflows/desktop-release.yml` 在构建前运行版本同步。
- `apps/CHANGELOG.md`、`docs/agents/build-release.md`、`apps/server/src/routes/health.ts` 已更新对应说明。

注意: `CLAUDE.md` 仍含旧的独立端发布说明。此前尝试修改被权限策略拦截,因为它是 agent 行为配置文件。若需要更新,必须由用户明确要求修改 `CLAUDE.md`。

### 2. Windows Desktop 启动与 sidecar 修复

`apps/desktop/src-tauri/src/main.rs` 已完成:

- release Windows 主程序启用 GUI subsystem:
  - `windows_subsystem = "windows"`
- Windows 下启动 Node sidecar 使用 `CREATE_NO_WINDOW`,避免 sidecar 弹控制台窗口。
- 对传给 Node sidecar 的 Windows verbatim path 做转换:
  - `\\?\C:\...` → `C:\...`
  - `\\?\UNC\server\share\...` → `\\server\share\...`
- 解决了 Node sidecar 报错:
  - `EISDIR: illegal operation on a directory, lstat 'C:'`
  - `EISDIR: illegal operation on a directory, lstat 'D:'`

验证过的结果:

- `cargo:check` 通过,仅剩既有 dead_code warning。
- `cargo test ... windows_verbatim_path` 通过。
- release exe smoke 显示 `sidecar ready`。
- launcher log 后续记录的 `web_dist` 已不再带 `\\?\` 前缀。
- 退出应用后未发现残留 sidecar 进程。

### 3. Windows 顶部菜单与托盘图标

用户确认 Windows app 顶部有不需要的菜单栏,且托盘图标混乱。已处理:

- Windows 下不再设置顶部 app menu。
- 保留 tray menu 行为。
- `apps/desktop/src-tauri/icons/tray-logo-windows.svg` 与 `.png` 已重做为:
  - 蓝底圆角背景
  - 中间白色简化铃铛
  - 32x32,适配 Windows tray 小尺寸显示

相关 commit:

```text
ca46eb5 fix(desktop): simplify Windows menu and tray icon
baf730c fix(desktop): redesign Windows tray icon
```

### 4. Desktop 日志 JSONL 下载 token 修复

用户反馈 Windows 日志页点击下载 `.jsonl` 报:

```json
{"error":"desktop_token_required","message":"desktop token required"}
```

根因: `<a href="/api/logs/raw?...">` 不能附加 `x-bn-desktop-token` header。

已在 `apps/web/src/pages/Logs.tsx` 改为:

- 使用 `fetch('/api/logs/raw?...', { headers: withDesktopTokenHeader(), credentials: 'include' })`。
- 成功后转 blob + `URL.createObjectURL` 触发下载。
- 不把 desktop token 放 URL,避免泄漏。

验证:

```text
vp run -F @bilibili-notify/web typecheck
vpx vitest run --root ../.. apps/web/src/pages/__tests__/Logs.render.test.tsx apps/web/src/services/__tests__/desktop-token.test.ts
```

结果:2 个测试文件、4 个测试均通过。

### 5. `vpr build:desktop` / Tauri build 脚本稳定性

用户运行 `vpr build:desktop` 曾报:

```text
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @bilibili-notify/desktop@0.0.0-dev tauri:build: `vp run prepare-resources && tauri build`
[WARN] Local package.json exists, but node_modules missing, did you mean to install?
```

根因:desktop 包脚本里嵌套 `vp run prepare-resources`,在 hoisted workspace 布局下本地 `apps/desktop/node_modules` 不存在,会触发包级 node_modules 检查。

已修复:

- `apps/desktop/package.json`
  - `prepare-resources` 仍为 `node scripts/prepare-resources.mjs`
  - `dev` 改为 `node scripts/prepare-resources.mjs && vpx tauri dev`
  - `tauri:build` 改为 `node scripts/prepare-resources.mjs && node scripts/tauri-build.mjs`
- 新增 `apps/desktop/scripts/tauri-build.mjs`
  - 使用 `vpx tauri build`
  - 默认加 `--ci`
  - Windows 默认加 `--bundles nsis`
  - 支持透传参数,如 `-- --no-bundle` / `-- --help`

验证:

```text
vp run -F @bilibili-notify/desktop tauri:build -- --no-bundle
vp run -F @bilibili-notify/desktop tauri:build
```

结果:

- no-bundle release build 通过。
- 完整 NSIS build 通过。
- 产物:

```text
apps/desktop/src-tauri/target/release/bundle/nsis/Bilibili Notify_0.0.0-dev_x64-setup.exe
```

注意:根级完整 `vpr build:desktop` 在修复后未再次长时间全量跑一遍;但失败的 desktop 子步骤已单独验证通过。

### 6. Windows CI artifact 校验

`.github/scripts/assert-windows-desktop-artifact.ps1` 已实现:

- 解压 `desktop-artifacts/bilibili-notify-windows-x64.zip`。
- 检查 `bilibili-notify-desktop.exe` 是 Windows GUI subsystem (`Subsystem=2`)。
- 检查 portable artifact 必要文件:
  - `bilibili-notify-desktop.exe`
  - `resources/node/bin/node.exe`
  - `resources/app/apps/server/lib/index.mjs`
  - `resources/BUILD_INFO.json`
- 直接运行打包内 Node:
  - `resources/node/bin/node.exe`
  - `resources/app/apps/server/lib/index.mjs`
- 设置 smoke env:
  - `BN_CONFIG_DISABLED=1`
  - `BN_ALLOW_NO_AUTH=1`
  - `BN_DESKTOP_TOKEN=desktop-smoke-token`
  - `BN_DESKTOP_ALLOWED_ORIGIN=http://127.0.0.1:<port>`
  - `NODE_ENV=production`
- 轮询 `/api/health`,要求 `status=ok`。
- 检查 `GET /` 返回 `text/html` 且包含 dashboard root。
- sidecar 提前退出时打印 stderr。
- 检查 artifact 内不含敏感/运行时禁止文件。

本地 Windows PowerShell 5.1 不支持脚本中的 `ProcessStartInfo.ArgumentList`,CI runner 预期使用 PowerShell 7 (`pwsh`)。此前本地用 PS5 兼容 smoke 脚本验证过同等启动路径。

### 7. Docker image workflow digest 分离

`.github/workflows/image-release.yml` 已按 registry 分开 build/push-by-digest:

- Docker Hub:
  - `Build + push Docker Hub digest`
  - digest 写入 `/tmp/digests/dockerhub/<arch>`
- GHCR:
  - `Build + push GHCR digest`
  - digest 写入 `/tmp/digests/ghcr/<arch>`

`.github/scripts/export-image-digest.sh` 已支持 `DIGESTS_DIR`。

`.github/scripts/create-manifest-list.sh` 已支持 `DIGESTS_DIR`,merge 阶段分别执行:

- Docker Hub manifest:
  - `DIGESTS_DIR=/tmp/digests/dockerhub`
- GHCR manifest:
  - `DIGESTS_DIR=/tmp/digests/ghcr`

这样避免再把 GHCR digest 当成 Docker Hub digest 做 smoke / manifest merge。

## 已做验证汇总

已通过的关键验证:

```text
vp install
vp run build:apps                    # 早期曾通过;后续一次异常耗时被用户中断
vp run -F @bilibili-notify/desktop prepare-resources
vpx tauri build --bundles nsis       # 早期通过
vp run -F @bilibili-notify/desktop cargo:check
cargo test --manifest-path src-tauri/Cargo.toml --locked windows_verbatim_path -- --nocapture
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo build --manifest-path src-tauri/Cargo.toml --release --locked
vp run -F @bilibili-notify/web typecheck
vpx vitest run --root ../.. apps/web/src/pages/__tests__/Logs.render.test.tsx apps/web/src/services/__tests__/desktop-token.test.ts
vp run -F @bilibili-notify/desktop tauri:build -- --no-bundle
vp run -F @bilibili-notify/desktop tauri:build
```

注意:

- `vp run build:apps` 后续曾出现异常耗时,用户中断。之后主要改用更窄的验证命令。
- 若重新跑完整 `vpr build:desktop`,请先确认没有正在运行的 `bilibili-notify-desktop.exe` 和对应 Node sidecar,否则 release exe 可能被 Windows 锁住。

## Windows 本地复测建议

在 Windows 上从当前 `dev` 执行:

```powershell
vp install
vpr build:desktop
```

如果只想快速确认 desktop 子步骤:

```powershell
vp run -F @bilibili-notify/desktop tauri:build
```

安装 / 启动检查:

1. 安装 NSIS:

```text
apps/desktop/src-tauri/target/release/bundle/nsis/Bilibili Notify_0.0.0-dev_x64-setup.exe
```

2. 从开始菜单 / 桌面快捷方式启动。
3. 预期:
   - 不出现常驻命令行窗口。
   - Windows 顶部无多余菜单栏。
   - 托盘图标为蓝底圆角 + 白色铃铛。
   - 应用窗口正常打开。
   - Dashboard 自动打开或可访问 `127.0.0.1:<随机端口>`。
   - 日志页面 `.jsonl` 下载不再报 `desktop_token_required`。
   - 退出后任务管理器无残留 `node.exe` sidecar。

## 如果 Windows 仍失败

收集以下日志:

```powershell
$logDir = Join-Path $env:LOCALAPPDATA "bilibili-notify\launcher-logs"
Get-Content (Join-Path $logDir "launcher.log") -Tail 120
Get-Content (Join-Path $logDir "sidecar.stdout.log") -Tail 120
Get-Content (Join-Path $logDir "sidecar.stderr.log") -Tail 160
```

重点看:

- `launcher.log` 是否出现 `sidecar ready url=http://127.0.0.1:<port>`。
- `web_dist` 是否仍带 `\\?\` 前缀;如果带,说明 path normalization 没生效。
- `sidecar.stderr.log` 是否还有 Node 入口路径 / lstat / EISDIR 错误。
- 退出后是否残留 `node.exe`。

## 发布注意,仅供后续

目前尚未执行发布。若用户确认要发布:

1. push 本地 7 个 commit 到 `origin/dev`。
2. 手动触发 `version-tag` dry-run:
   - `version=0.1.0-alpha.7`
   - `dry_run=true`
3. dry-run 通过后触发正式 tag:
   - `dry_run=false`
   - 或本地创建/推送 `v0.1.0-alpha.7`
4. tag push 会分别触发:
   - `image-release`
   - `desktop-release`
5. Docker 与 Desktop workflow 已解耦,任一失败只需重跑对应 workflow。

不要在未得到用户明确要求时 push、创建 tag 或发布 release。

## 当前交回结论

抛开发布不谈,Handoff 原始待测 / 待修内容已经完成。当前主要剩余事项是:

- 用户本地最终安装体验确认。
- 如需发布,先 push 当前 7 个 commit,再按 tag-driven 流程发布 `v0.1.0-alpha.7`。
- 如需让项目说明完全一致,用户需明确授权后再更新 `CLAUDE.md` 中旧的发布模型描述。
