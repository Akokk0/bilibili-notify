---
name: verify-ui
description: 改了 apps/web(面板)或 apps/desktop(桌面启动页)的界面、报完成之前用:起 dev,在内置浏览器里点到改动涉及的页面,前后截图,确认 console 零新报错,验完才报完成。不适用于纯后端、纯类型 / 测试 / 文档改动(没有看得见的界面变化)。
---

# 界面验证

目标:改动在真浏览器里**看得见、点得通、console 干净**。有一步没过就修了**从头再跑**,不交半验证的结果。

## 合格线(全部满足才算验过)

- 改动涉及的每个页面都打开过,并且做了改动对应的操作(点、填、切 tab、开弹窗),不只看首屏。
- 每处改动有前后两张截图,同一视口尺寸(见 Gotchas)。能在改代码前先截就先截;改完才验的,「前」取操作 / 注入之前的样子,回报里说清两张各是什么。
- console:打开页面时记基线,操作完 `read_console_messages`(`onlyErrors`)**零新增 error**;新冒的 warning 要么解释、要么修。
- 后端日志(自己起的才有)没有因为这次操作新冒出的 `"level":50` 以上的行。
- devtools 造过的状态全部收摊(面板顶部显示「没有注入生效」,或 `GET /api/dev/active` 为 `{"active":[]}`);自己起的进程全停,端口空,`git status --short` 不多东西。

## 起服务

下文 `dev.sh` 指本 skill 的 `scripts/dev.sh`(在仓库根跑:`.claude/skills/verify-ui/scripts/dev.sh`)。`.claude/launch.json` 三套:`dev-apps`(后端 8787 + 面板 5173 + 拓展 watch,改面板用它)、`web`(只起面板:后端已在跑,或要看后端断线态)、`desktop-launcher`(启动页 1421)。

- 先跑 `dev.sh status`。端口原本就被本仓进程占着(主人自己的 dev)→ 直接复用,收尾**不停它**;被别的程序占着 → 停下来说,别抢。
- 优先 `preview_start` 按 name 起;读不到 launch.json(见 Gotchas)就用 Bash `run_in_background` 跑 `vp run dev:apps`(日志写 scratchpad),`dev.sh wait` 等就绪,再 `preview_start` 传 `url: http://localhost:5173`。
- dev 配置默认不开鉴权(`dev.sh wait` 打出的 session 是 `authRequired:false`),不用登录。真弹了登录框,凭据从本机 `apps/server/bn.config.yaml` 的 `auth.basicAuth` 或它引用的环境变量取;不问主人,不写进回报。
- 改了 `packages/*`(`packages/ui` 除外,它直接吃源码)或 `apps/contract`:`dev:apps` 不重建这些包的 `lib/`,先构建再验。

## 造状态

等不来的状态(有新版、开播、登录失效、连接能力……)用 devtools 注入,**不改源码**:左下角 `devtools` 药丸 → 底部面板左栏分组 → 场景「跑一下」。每个场景造什么、注入在哪,见 `docs/agents/devtools.md` 的「注入高度」表和「真机验过 / 没验过」。

- devtools 默认**真发**:造事件(开播、动态、私聊指令……)前先开「截流」。页面上会真发消息或真下载的按钮(推送目标的「测试」、更新的「下载这一版」)不按。
- 验完按面板顶部「全部收摊」,确认回到「没有注入生效」。

## 桌面端

- `desktop-launcher` 在浏览器里没有 Tauri,只显示 degraded 态(「Tauri API 不可用」),能验的只有布局和这一态。靠 `invoke` 的状态(starting / ready / failed)在这里看不到,交给 `apps/desktop/src/__tests__`,回报里写明没在真壳里看。
- 真壳(`vp run dev:desktop`)要先打更新载荷、再编 Rust,本 skill 没覆盖;桌面壳里的面板就是 apps/web,按面板那套验。

## 收尾与回报

`resize_window` 用 `preset: desktop` 复位视口;按 name 起的用 `preview_stop`(参数是 `preview_list` 里的进程 serverId,不是 previewId),按 url 开的用 `tabs_close` 关掉自己开的 tab。服务是自己起的,再 `dev.sh stop`(它停本仓、非 worktree 的全部 dev 进程,所以复用主人的 dev 时别跑),最后 `dev.sh status` 三个端口都是 free;复用的就只确认自己的 tab 关了。

回报每个页面:做了什么操作、前后截图各是什么、console error 基线 → 操作后各几条、造过哪些状态且已收摊。没验到的写清哪项、为什么。

## Gotchas(实跑踩到的)

- **`preview_start` 按 name 只读会话根目录的 `.claude/launch.json`**:会话开在别的目录(scratch workspace 之类)时报「No .claude/launch.json found」,而且命令也会在那个目录里跑。这时走 Bash 后台起 + `preview_start` 传 url。
- **Vite 只监听 `[::1]`**:`127.0.0.1:5173` / `127.0.0.1:1421` 连不上(curl 回 000),一律写 `localhost`;后端反过来只听 `127.0.0.1:8787`。
- **别硬杀 Bash 起的 `dev:apps`**:`scripts/dev-apps.mjs` 把 server、vite、每个拓展的 `pack -w` 各放进自己的 detached 进程组,后台 shell 的进程组里只有 `vp` 和 runner 自己;硬杀它们,子进程组照占端口。对 runner 发 SIGINT(`dev.sh stop` 就这么做),实测不到一秒端口就空,server 日志走完「收到 SIGINT,已在收尾」。
- **视口跟着窗格走**:窗格开着时视口偏窄,实跑时顶栏 tab 折成两行、推送目标页是顶部一排连接胶囊;窗格被隐藏时 `innerWidth×innerHeight` 缩到 304×266,截图没法看;1280 宽时同一页变成左栏连接列表。截图前先 `resize_window` 定成 1280×800(前后同尺寸),验完复位。
- **console 列表跨整页刷新累积**:`navigate` 之后上一页的日志还在(两遍 `[vite] connecting...`);dev 停着时没关的面板 tab 一直重连,攒了 50 多条 `ERR_CONNECTION_REFUSED` / `ws://localhost:5173/ws failed`,重起服务再刷新也不清。所以基线按「本轮页面加载完时的 error 条数」记,比条数不比内容;收尾关掉自己开的 tab。
- **动作后立刻截图会截偏**:药丸要等 `GET /api/dev` 探完才懒加载出来,`navigate` 完马上截常常没有它(用 `find "devtools"` 拿 ref 再点);收面板、切路由有动画,截到过 URL 已是 `/system`、画面还是上一页加半截面板。动作后 `wait` 1 秒再截。
- **「有新版」通知卡收摊后不会消失**:「更新状态」注入后弹出的卡在前端,收摊只撤服务端状态;截「收摊后」那张图前先手动关卡或刷新。
- **告警多半是本机数据现状**:dev 后端用的是 `apps/server/data` 里的真数据,实跑时开机就报 B 站登录失效、有一条连接连不上,顶栏和系统页都标红,开机约半分钟后端日志还有一条 `"level":50` 的「账号未登录,动态检测已停止」;首次开机还可能做一次数据代迁移(日志「从第 N 代迁出第 M 代」)。对照改动前的截图和开机日志再判断是不是回归。
