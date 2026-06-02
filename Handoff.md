# Handoff · Windows Desktop 回归测试

## 当前状态

- `v0.1.0-alpha.7` GitHub Release 已撤回,同名远程 tag 已清理。
- `image-release` 正式 run `26763331463` 未发布 Docker Hub / GHCR manifest tag:
  - amd64 / arm64 的 push-by-digest 阶段跑过;
  - amd64 smoke 因 workflow 把 GHCR digest 当成 Docker Hub digest 拉取而失败;
  - merge job 被跳过,所以 `:alpha` / `:v0.1.0-alpha.7` 没有发布成功。
- `0.1.0-alpha.7` 还没有完成正式发布;后续可继续使用这个版本号发布,不需要 bump 到 `0.1.0-alpha.8`。

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

- Docker 与 Desktop 已改为共同依赖 `version-tag` workflow 生成的同名 git tag,彼此不再互相阻塞。
- `0.1.0-alpha.7` 尚未正式发布完成,可继续使用当前 `apps/server/package.json#version`。
- Windows 本地确认通过后,建议:
  1. 手动触发 `version-tag` 做 dry-run,确认会创建 `v0.1.0-alpha.7`;
  2. 将包含 `apps/server/package.json#version` 变更的提交 push 到 `dev`,由 `version-tag` 创建 tag;
  3. tag push 会分别触发 Docker 与 Desktop;二者互不依赖,哪个 workflow 失败就只重跑对应 run。
