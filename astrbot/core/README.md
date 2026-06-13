# bilibili-notify for AstrBot

AstrBot 插件形态的 bilibili-notify。插件用本机 Node 启动本地 sidecar，并在 AstrBot Plugin Page 中提供 Dashboard 配置页。

这不是独立端；独立端请使用 `apps/` 对应的服务与 Dashboard。

> 源码托管于 monorepo [Akokk0/bilibili-notify](https://github.com/Akokk0/bilibili-notify)，本插件即其中的 `astrbot/core/`，经发布同步为独立插件仓。

## 使用

### 1. 准备 Node

本机需要 Node `>=24`。

默认使用 `PATH` 中的 `node`。如果 AstrBot 的运行环境找不到正确版本，在插件原生配置里填写 `nodePath` 绝对路径。

### 2. 启动插件

在 AstrBot 插件目录启用 `astrbot_plugin_bilibili_notify`。插件启动后会自动启动 sidecar。

插件原生配置只包含启动级字段：

- `nodePath`：Node 可执行文件路径；留空使用 `PATH` 中的 `node`
- `fixedPort`：固定 sidecar 端口；`0` 表示随机本地端口，仅用于调试
- `logLevel`：sidecar 日志级别，支持 `debug` / `info` / `warn` / `error`
- `startupTimeoutSeconds`：sidecar 启动超时
- `shutdownTimeoutSeconds`：sidecar 关闭超时
- `aiProviderId`：AstrBot AI Provider；留空使用 AstrBot 默认 Provider
- `aiPersonaId`：AI 总结使用的 AstrBot 人格；留空使用 AstrBot 当前默认人格

业务配置不在 AstrBot 原生配置里编辑，请使用 Dashboard。AI 总结的人格由 AstrBot 人格系统提供，可在 Dashboard 高级规则里为单个 UP 主单独指定人格。

### 3. 打开 Dashboard

在 AstrBot WebUI 的插件页面打开 bilibili-notify 的 Plugin Page：`dashboard`。

Dashboard 包含：

- 设置：B 站登录、全局默认配置、过滤、通知内容、AI、卡片、危险操作
- 订阅：UID 查询、昵称搜索、订阅启停、分组筛选、默认路由
- 推送目标：生成配对码、目标列表、重命名、启停、删除、纯文本测试推送
- 高级规则：按 UP 编辑继承或自定义覆盖

`dataDir` 自动使用 AstrBot 插件持久化数据目录，Dashboard 只读展示，不可配置。

### 4. 绑定推送目标

1. 打开 Dashboard 的「推送目标」Tab。
2. 点击生成配对码。
3. 在要接收通知的群聊或私聊里发送：

```text
/bilibili-notify bind <配对码>
```

也可以使用别名：

```text
/bn bind <配对码>
```

绑定命令需要 AstrBot 管理员、主人或白名单用户权限。

### 5. 测试推送

Dashboard「推送目标」Tab 可以发送纯文本测试推送。

已绑定当前会话后，也可以在聊天里发送：

```text
/bilibili-notify test
```

或指定文本：

```text
/bilibili-notify test 测试推送
```

### 6. 登录兜底命令

Dashboard 不可用时可以使用聊天命令：

```text
/bilibili-notify status
/bilibili-notify login
/bilibili-notify login-status
```

## 开发与同步

在 monorepo 根目录使用 `vp`：

```bash
vp run build:astrbot
vp run build:astrbot-sidecar
vp run build:astrbot-page
vp run check:astrbot-python
```

同步到外部插件仓库：

```bash
vp run sync:astrbot-core -- --target /path/to/astrbot_plugin_bilibili_notify
```

安装到本机 AstrBot：

```bash
vp run link:astrbot-core -- --astrbot-root /path/to/AstrBot --force
```

该命令默认复制插件文件，确保 AstrBot Plugin Page 能识别 `pages/dashboard/`。

如只需要调试 Python 代码热更新，可改用符号链接模式：

```bash
vp run link:astrbot-core -- --astrbot-root /path/to/AstrBot --force --symlink
```

符号链接模式下，AstrBot 可能无法发现 Plugin Page；验证 Dashboard 时使用默认复制模式。

同步会包含已构建的 `sidecar/app/` 和 `pages/dashboard/`，并排除运行态目录、日志、缓存与虚拟环境。

## 注意点

- sidecar 只监听 `127.0.0.1`
- sidecar token 只在插件内部使用，不会暴露给 Dashboard
- Dashboard 不保存 Node AI provider key；AI 调用走 AstrBot Provider
- Dashboard 测试推送只验证纯文本，不验证富消息
- 富消息发送失败时会尽量降级为文本或图片
- 首版投递队列是内存队列，插件重启后不会保留未投递 job

## 排障

### Node 版本过低

确认 AstrBot 运行环境里的 Node 版本：

```bash
node --version
```

如果不是 Node `>=24`，在插件原生配置里设置 `nodePath`。

### sidecar 启动失败

检查：

- `nodePath` 是否存在并可执行
- `fixedPort` 是否被占用
- `logLevel` 是否需要临时调成 `debug`
- sidecar 日志文件中的脱敏错误摘要

### Dashboard 无法加载

先确认插件已启动，且 `pages/dashboard/index.html` 已随插件一起同步或构建。

本地开发时重新构建：

```bash
vp run build:astrbot-page
```

### `resource_tracker: There appear to be 8 leaked semaphore objects`

这是 AstrBot/Loguru `enqueue=True` sink 在退出时未清理导致的上游 warning，不是 bilibili-notify 的 sidecar 泄漏。

如果只在 AstrBot 退出时出现，且 sidecar 已正常关闭，可以忽略。

## 问题反馈

遇到使用问题或 bug，欢迎通过以下方式反馈：

- 提交 [GitHub Issue](https://github.com/Akokk0/astrbot_plugin_bilibili_notify/issues)
- 加入 QQ 交流群 `801338523` 反馈
