# bilibili-notify for AstrBot

AstrBot 插件版本，使用本机 Node 24 启动 sidecar。

## 目录

- `main.py`：AstrBot 插件入口
- `sidecar/app/`：打包后的 Node sidecar 产物
- `sidecar/state/`：运行时状态与日志

## 本地开发

1. 在 monorepo 根目录构建 sidecar：
   ```bash
   vp run build:astrbot-sidecar
   ```
2. 把 `astrbot/core` 软链接到本机 AstrBot 的 `data/plugins/astrbot_plugin_bilibili_notify`
3. 启动 AstrBot
4. 在 AstrBot 里执行 `bilibili-notify` 查看 sidecar 状态

## Python 门禁

- `vp run check:astrbot-python`：运行 Ruff lint、Ruff format 检查和 pytest
- `vp run lint:astrbot-python`：只跑 Ruff lint
- `vp run format:astrbot-python`：自动格式化 Python 代码
- `vp run test:astrbot-python`：只跑 AstrBot Python 测试

这些命令会在 `astrbot/core` 目录内调用 `uv`，按需拉起 Ruff、pytest、httpx 和 pytest-asyncio。

## 环境变量

- `BN_NODE_BIN`：Node 可执行文件路径，默认 `node`
- `BN_SIDECAR_HOST`：sidecar 监听地址，默认 `127.0.0.1`
- `BN_SIDECAR_PORT`：监听端口，默认随机端口 `0`
- `BN_SIDECAR_READY_FILE`：ready 文件路径
- `BN_SIDECAR_LOG_FILE`：sidecar 日志路径
- `BN_SIDECAR_STARTUP_TIMEOUT_SECONDS`：启动超时
- `BN_SIDECAR_SHUTDOWN_TIMEOUT_SECONDS`：关闭超时
- `BN_SIDECAR_AI_BACKEND`：`astrbot` / `own` / `disabled`
- `BN_SIDECAR_AI_PROVIDER_ID`：AstrBot provider id
- 以上路径若填写相对路径，会按插件根目录解析
