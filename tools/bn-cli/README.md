# @bilibili-notify/bn

BN正式发行渠道，包内自带正式和开发宿主及面板；首次启动无需访问GitHub。包尚未发布；下面是发行后的入口，alpha期间使用`@alpha`，发布到latest后可省略。需要Node 24.15.0或更高版本，不需要克隆或构建BN。

```sh
npx @bilibili-notify/bn@alpha web
# 拓展开发专用宿主；拓展工程继续使用vp
vp dlx @bilibili-notify/bn@alpha dev
```

`web`运行正式宿主，保留既有应用内更新；`dev`运行带源码挂载与热重载的专用开发成品。先用`create-bn-ext`创建并安装拓展工程，再从BN拓展页浏览并挂载工程目录、启用拓展。BN拥有运行与监听，多个工程可同时调试；拓展不需要dist或自己的dev进程。开发BN本体仍在主仓使用vp。

默认仅监听127.0.0.1:8787，终端显示面板地址。两个宿主同时运行时用`--port`指定不同端口。配置和凭据保存在数据目录的`bn.config.yaml`；设置、迁移和备份沿现有宿主流程。

| 选项 | 行为 |
| --- | --- |
| `--data-dir <目录>` | 指定持久数据；也读取显式BN_DATA_DIR。默认web为`~/.bilibili-notify/data`，dev为`~/.bilibili-notify/dev-data` |
| `--port <端口>` | 覆盖默认端口，也读取BN_PORT |
| `--cache-dir <目录>` | 覆盖`~/.bilibili-notify/cache/runtimes`；数据必须在缓存外 |

npm包版本与主程序版本一致，包内固定两种宿主的版本、用途、大小和SHA256。首次从包内解包，复用缓存时仍核对内容；校验或解包失败不替换完整缓存。删除缓存后可直接从包内重建，持久数据不会删除。其他实例的数据需要用`--data-dir`明确指定。`web`保留原应用内更新机制；`dev`升级时安装新版本npm包。

npm包不含Node或浏览器；公开依赖随npm正常安装，浏览器使用宿主既有配置。npm registry使用环境自己的配置，启动器无需另设GitHub下载镜像。

## 本仓构建与发行准备

全部操作经vp，真实发布另行确认：

- `vp run build:bn-package`构建CLI、两种宿主并生成`dist/bn-npm/bilibili-notify-bn-<版本>.tgz`和校验清单。两种宿主沿原装配与载荷格式，保持用途隔离。完整tgz可直接在仓外安装，不需要额外载荷参数。
- 普通workspace build只生成CLI编译壳，避免每次开发构建重复打宿主；它不能当成完整发行包。发布守卫拒绝占位版本、载荷缺失、版本不一致及大小/摘要错误。
- 主程序tag由发行流程确认后同步四种渠道；npm预发布走`alpha`、正式版走`latest`。源文件保持`0.0.0-dev`，CI临时同步版本。`npm-release.yml`复用门禁，只给tag发布作业可信发布权限；dev上的手动dry-run只生成候选。
- `vp run release:bn-package --directory <候选目录> --tag v<VERSION> --dry-run`核对完整tgz且不写registry；同版本重跑先核对内容，旧tag不回退渠道。实际上传、首发及npm组织的可信发布配置见主仓`docs/agents/build-release.md`。

业务核心仍为私有workspace包，不成为启动器的npm依赖。源码加载器作为公开依赖安装，保留自己的原生组件与运行资源；正式宿主仍自包含。具体定案见主仓ADR-0045、ADR-0046。
