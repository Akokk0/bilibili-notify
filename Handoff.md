# Handoff · Windows Desktop 回归测试

## 当前状态

- `v0.1.0-alpha.7` GitHub Release 已撤回,同名远程 tag 已清理。
- `image-release` 正式 run `26763331463` 未发布 Docker Hub / GHCR manifest tag:
  - amd64 / arm64 的 push-by-digest 阶段跑过;
  - amd64 smoke 因 workflow 把 GHCR digest 当成 Docker Hub digest 拉取而失败;
  - merge job 被跳过,所以 `:alpha` / `:v0.1.0-alpha.7` 没有发布成功。
- 先不继续发布。下一次对外发布请先 bump 到新版本(建议 `0.1.0-alpha.8`),不要复用已撤回的 `0.1.0-alpha.7`。

## 本次待测改动

### Windows Desktop

- `apps/desktop/src-tauri/src/main.rs`
  - release Windows 主程序改为 GUI subsystem,避免双击后出现常驻命令行窗口。
  - Windows 下启动 Node sidecar 时设置 `CREATE_NO_WINDOW`,避免 sidecar 自己弹控制台窗口。

### Windows CI 产物校验

- `.github/scripts/assert-windows-desktop-artifact.ps1`
  - 解包 portable zip 后检查 `bilibili-notify-desktop.exe` 必须是 Windows GUI subsystem。
  - 在 Windows runner 上直接运行打包进 portable zip 的 `resources/node/bin/node.exe` + `resources/app/apps/server/lib/index.mjs`。
  - 轮询 `/api/health`,并检查 `GET /` 返回 dashboard HTML。
  - 如果 sidecar 提前退出,CI 会打印 stderr,不再只做文件存在性检查。

### Docker image workflow

- `.github/workflows/image-release.yml`
  - Docker Hub 与 GHCR 不再作为同一个 `docker buildx build` 的两个 output。
  - 原因:buildx 会为两个 registry 生成不同 provenance / manifest-list digest,但 `docker/build-push-action` 只暴露最后一个 digest;这会导致 Docker Hub smoke 拿到 GHCR digest。
  - 现在每个 registry 单独 build/push-by-digest,分别导出 digest。
- `.github/scripts/export-image-digest.sh`
  - 支持 `DIGESTS_DIR`,用于区分 Docker Hub 与 GHCR digest。
- `.github/scripts/create-manifest-list.sh`
  - 支持 `DIGESTS_DIR`,merge 阶段分别用 `/tmp/digests/dockerhub` 和 `/tmp/digests/ghcr` 拼 manifest。

## Windows 本地测试步骤

在 Windows 机器切到本分支最新 `dev` 后执行。JS/TS 命令一律用 `vp` / `vpx`,不要直接用 `pnpm` / `npm` / `yarn`。

```powershell
vp install
vp run build:apps
vp run -F @bilibili-notify/desktop prepare-resources
cd apps/desktop
vpx tauri build --bundles nsis
```

构建完成后测试两种入口:

1. 安装 `src-tauri/target/release/bundle/nsis/*.exe` 后从开始菜单 / 桌面快捷方式启动。
2. 如果有 portable zip,解压后双击 `bilibili-notify-desktop.exe`。

预期:

- 双击后不出现常驻命令行窗口。
- 应用窗口正常打开。
- 后端 sidecar 不再显示 `sidecar exit status: exit code:1`。
- Dashboard 自动打开并能访问 `127.0.0.1:<随机端口>`。
- 退出应用后 Node sidecar 一起退出,任务管理器里不残留 `node.exe`。

## 如果 Windows 仍失败

请收集以下文件内容:

```powershell
$logDir = Join-Path $env:LOCALAPPDATA "bilibili-notify\launcher-logs"
Get-Content (Join-Path $logDir "launcher.log") -Tail 80
Get-Content (Join-Path $logDir "sidecar.stdout.log") -Tail 80
Get-Content (Join-Path $logDir "sidecar.stderr.log") -Tail 120
```

重点看 `sidecar.stderr.log`;如果 Node 进程仍 exit code 1,真正错误栈会在这里。

## 发布注意

- 当前不要再发布 `0.1.0-alpha.7`。
- Windows 本地确认通过后,建议:
  1. bump `apps/server/package.json` 到 `0.1.0-alpha.8`;
  2. 更新 `apps/CHANGELOG.md`;
  3. 先用 `[dry-run]` 提交触发 desktop/image dry-run;
  4. dry-run 全绿后再正式发布。
