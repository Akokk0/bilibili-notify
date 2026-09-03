# 应用内自主升级

独立端(Docker + Desktop)可以在应用内换版本,不必重拉镜像或重下安装包。
koishi / AstrBot **不在范围内** —— 那两端由各自宿主管更新。

## 一句话机制

发版时打一个**自包含载荷 zip**、签一份清单挂到 GitHub Release;客户端验签、下载、
解进 `<dataDir>/versions/<版本>/`,**重启时由 `boot.mjs` 选中它**。安装包 / 镜像
自带的那份永远不动,所以随时能退回去。

```
镜像 /app/                        用户数据 <dataDir>/versions/
├── boot.mjs   ← CMD 跑的是它      ├── boot-state.json   选版记账 + 回退钉子
├── index.mjs                     └── 0.9.0/
├── package.json                      ├── index.mjs      ← 被选中就加载它
└── web-dist/                         ├── package.json
                                      └── web-dist/
```

`boot.mjs` 是**单独一个 bundle 入口**,只牵 node 内建 + 选版那一小块。塞进
`index.mjs` 顶上不行:ESM 的 import 是提升的,那样会先把镜像那份服务端的整张模块图
加载完,再加载一遍载荷那份,内存直接翻倍。

选中之后是**同进程 `import()`**,不是 spawn:少一个常驻进程、不用转发信号,而且
载荷里的 `import.meta.url` 指向它自己的目录 —— dashboard 资源与版本号因此自动跟着走。

## 密钥(**发版前必须先做这一步**)

签名是代理站能被放进链路的**唯一**理由:没签名,它可以换掉任意一段将要被执行的代码。
但光有签名还不够 —— 签名只证明「这串字节我们签过」,不证明它是**当前**那一份,代理站
可以永远回放一份签过的旧清单(比如后来被撤回的那版)。所以清单带 `issuedAt`(发版脚本
自动盖),客户端把每个渠道见过的最大值记在 `<versionsRoot>/manifest-freshness.json`,
比它旧的一律不收(候选循环里换下一个站;直连给的都旧才报 `stale-manifest`)。两条一起,
代理站才真的只剩「拒绝服务」这一种本事。

**两把**,且必须**从第一个发出去的版本起就都在信任列表里**:

| | 用途 | 放哪 |
|---|---|---|
| A 主用 | 每次发版签清单 | CI secret `BN_UPDATE_SIGNING_KEY` + 离线备份 |
| B 备用 | A 泄露时的唯一退路 | **只在离线备份里,永远不进 CI** |

信任列表是**冻在已经发出去的那些安装里**的。A 泄露那天,唯一的办法是用 B 签一版、
把 A 踢出列表 —— 而事后再加公钥救不了任何存量用户,他们的客户端只认出厂时带的那几把。
所以 B 只有在第一版就在场才有意义。

### 生成

```bash
# 建议生成到**仓库外面** —— .gitignore 没有 *.pem 规则,私钥躺在工作树里,
# 一次 `git add -A` 就会被提交上去。
node scripts/gen-update-keys.mjs --out ~/secrets/bn-update
```

它产出 `bn-update-A.pem` / `bn-update-B.pem`(mode 0600,已存在则**拒绝覆盖** ——
覆盖私钥不可逆),并直接打印该往哪儿贴的三步。

> **别用 `openssl genpkey -algorithm ed25519`。** macOS 自带的 `openssl` 其实是
> LibreSSL(实测 3.3.6),它**不认 ed25519**,只回一句 `Algorithm ed25519 not found`
> 就完事 —— 而且**退出码是 0**,于是 `-out` 指定的文件根本没被创建,下一条命令才报
> 「文件不存在」,把人指向完全错误的方向。真装了 OpenSSL 3.x 的话那两条命令没问题,
> 但上面这个脚本和签名工具用的是同一套 Node crypto,格式一定对得上。

把打印出来的两串公钥填进 `apps/server/src/update/trusted-keys.ts` 的
`TRUSTED_UPDATE_KEYS`。**空列表 = 功能关着**(客户端会明说「本构建未启用」,不会报成
验签失败),fork 出去自己构建的人默认就落在这一档。

私钥 A 进 repo secret(PEM 换行在 secret 里容易丢,所以脚本也收 base64 包过一层的):

```bash
base64 < ~/secrets/bn-update-A.pem | gh secret set BN_UPDATE_SIGNING_KEY
```

两把私钥离线各存一份(密码管理器 / 冷存储)。**丢了 A 还能用 B 顶上;两把都丢,
存量用户就再也收不到能验过签的更新了。**

## 渠道入口

清单挂在一个**滚动的** `update-channel` release 上:

- `https://github.com/Akokk0/bilibili-notify/releases/download/update-channel/stable.json`
- `…/update-channel/alpha.json`

不用 `releases/latest/download/` 是因为它按定义指向最新的**正式**发布,预发布渠道就
永远拿不到自己那份。也**不碰 `api.github.com`** —— 代理站不代理 API,而且 API 的回答
上没有我们的签名。清单和载荷同域同前缀,用户填**一条**加速前缀就同时管住两者。

正式版发布同时刷 `stable.json` 与 `alpha.json`(预发布渠道的用户也该拿到更新的正式版,
否则会卡在某个旧 alpha 上);预发布只刷 `alpha.json`。

## 发版流程

`v<VERSION>` tag 触发 `update-payload.yml`,与 Docker / Desktop 两条路**互不阻塞**。
它做四件事:

1. `vp run build:update-payload` —— 构建 web + server 自包含 bundle + 装配资产
2. `node scripts/build-update-payload.mjs` —— 打 zip,交出 sha256 / size
3. `node scripts/sign-update-manifest.mjs` —— 生成并签署清单信封
4. 上传到 `v<VERSION>` release(不存在就**自己建** —— 与 desktop-release 共用同一个幂等脚本
   `create-standalone-github-release.sh`,谁先到谁建,**不等对方**),再覆盖 `update-channel`
   上对应渠道的清单

没配 `BN_UPDATE_SIGNING_KEY` 时**整条跳过并打 warning**,不让发版红着 —— 但那次发版
的用户也就没有应用内更新。

## 面板上怎么提示

**打开面板就查一次,不定时、不轮询。** `useUpdateCheckOnOpen` 挂在登录门之后(和其他
channel hook 一起),每次页面加载 `POST /api/update/check` 一次。查到比现在新的一版:

- 右下角出一张**通知卡**(借推送 toast 那条队列,同壳同栈;区别是带「去更新」按钮、
  **不自动消失**)
- 概览的「系统状态」卡在核心 / 面板版本号旁边追一句(文案与系统页那节同源
  `phaseLabel`),头部出「去更新」
- 两处按钮都落到 `/system#update`,系统页那一节看见这个 hash 就把自己滚进视口

没新版就什么都不说。两种情况**不自动查**:功能关着(没内置公钥);以及**盘上钉着回退的钉子**
(`pinnedVersion`,不只是内存态的 `rolled-back` —— 回退靠重启生效,重启之后 phase 已是 `idle`,
钉子却还在盘上;只认内存态的守卫守的正是最不需要守的那个窗口)。自动检查在开着自动下载时会
装新版、顺手拔钉子,等于用户开一次面板就把自己按的回退撤销了。用户手动按「检查更新」不受这条
限制,那是明确要往前走(既有测试 `退回去之后又装了新版 → 钉子必须拔掉` 就是这个决定);系统页
在钉着时会说明这一句。

服务端配合两条:同一份包(版本 + sha256)这个进程装过了就不再下、也不把 `ready` 打回
`available`;并发的 check / download 共用一趟。没有这两条,「打开就查」会让每次开面板都
重下一遍 7MB,或者两趟各解一次压。

「有没有新版」「这一阶段怎么说」只在 `apps/web/src/components/update/status.ts` 判一处 ——
概览说「有新版」而系统页说「已是最新」就是两处各判一遍的下场。

### 按下「立即重启并应用」之后

服务端回一句 `restarting: true` 就关自己了,从那一刻起页面**收不到任何消息**:没有事件,
WS 重连的 hydrate 也只补 globals / subs / targets。所以「重启完了吗、换成了吗」由页面自己
去问(`components/update/restart.ts`):按下之前先读一次 `/api/health` 记下 `startedAt`,
之后每秒探一次,**只认 `startedAt` 变了的回答** —— 光「能连上」不算,旧进程优雅停机时
还能连上好几秒(最多 10 秒)。三种结局各有各的说法,一个不落:

- 新进程的版本正是目标 → **整页刷新**。web-dist 是跟着载荷一起换的,不刷新就是旧面板在和
  新 API 说话。刷新之前在 sessionStorage 留个记号,刷新后打开面板那次检查据它弹一句
  「已更新到 X」/「已退回 X」(对得上现在跑的版本才说,记号取一次就没了)。
- 新进程起来了,版本却不是目标 → 载荷起不来、`boot.mjs` 回落了。这一节明说「跑起来的是
  X,不是 Y」,并把状态重新拉一次,别再显示「已就绪」。
- 等满 90 秒还没回来 → 多半是容器没开 `restart:` 策略。说明原因,给一个「再等等」。

桌面版不靠这条:外壳看到 sidecar 退 0 会自己拉起,就绪后把窗口导航到新地址(新端口、
新 token),等于整页刷新;这条流程在那之前只负责显示「正在重启」。

## 加速站怎么选

照 OpenClash 的骨架砍到够用:系统页那节里一张表,**直连打头、内置六个候选、末尾一行自定义**,
列是 地址 | 延迟 | 通过它拿到的清单版本 | 选用。「测一遍」打 `POST /api/update/mirrors/probe`,
服务端对每个前缀并行拉一次当前渠道的清单 + 验签(浏览器直接打代理站会被 CORS 挡,而且真正
下载的是服务端那台机器);结果按老规矩归因:无法访问 / **签名验不过** / 清单不成形。

**默认直连、只能选一个。** 选中的前缀是 `update.mirrors` 里唯一那项,直连永远垫底 —— 设置
结构没改,「不硬编码第三方当默认」那条决定也没动:内置名单只决定面板上给谁看,
不决定默认和谁说话。名单在 `apps/contract/src/update.ts` 的 `BUILTIN_UPDATE_MIRRORS`
(2026-09-02 凭经验列的,没逐个实测;死站在面板里一测就露馅)。

## 撤回一个坏版本

三道闸,各管一批人:

- **服务端撤回**:重签一份渠道清单,`version` 写用户**该在**的版本(修复版,或退回上一个
  好版本 —— 可以比坏版本号小),`revoked` 列上坏版本号。客户端对 `revoked` 的处理:
  还没升的人不会去装它;**已经装好等重启**的人,那份目录会被删掉、`ready` 撤掉;
  **正在跑着坏版本**的人,清单那版哪怕更旧也当更新目标装上,坏版本被记进
  `boot-state.json` 的 **`revoked`**,重启后开机选版不再选它。
- **客户端自愈**:起不来的那批靠 `boot.mjs` —— 连续起不来到上限就把那一版判死(记进
  `failed`),自动退回上一版。这条路**压过用户手动钉的版本**,否则退到一个也起不来的
  版本就是死局(进不去面板 = 拔不掉钉子)。

  > 撤回记 `revoked`、自愈记 `failed`,**两份名单刻意分开**:自愈那份的语义是「这一版
  > 起不来」,所以 `markBootSucceeded` 会在它起来之后把它放出来;而「厂商召回」不会因为
  > 它能启动就不成立。共用一份的下场是撤回镜像自带那版之后,重启一次召回就被自己撤销了。
- **新鲜度**:重签会让 `issuedAt` 变新,客户端从此不再收更旧的那份 —— 代理站缓存或
  回放旧清单都推不回去。

### 怎么撤

跑 **`revoke-update` workflow**(手动触发,默认 dry-run):

| 输入 | 填什么 |
|---|---|
| `target` | 用户**该在**的版本,裸 semver(如 `0.9.0`)。可以比坏版本号小。 |
| `revoked` | 坏版本,逗号分隔(如 `0.9.1` 或 `0.9.1,0.9.2`) |
| `channel` | `both` / `stable` / `alpha` |
| `dry_run` | 先留 `true` 看一眼解析结果,再关掉真发 |

它做三件事:按规矩校验参数(目标版本自己不能在撤回名单里、版本号得成形)、**从那一版
已发布的 zip 上现算 sha256 与字节数**、签名并刷渠道清单。规矩在 `scripts/revocation.mjs`,
`scripts/revocation.test.mjs` 钉着。

它**不跑门禁** —— 这里一行代码都不发,只是把清单指回一个已经发布过的载荷;给一件
本该几十秒的急事加十几分钟没有意义,而且门禁红了也不说明这次撤回有问题。

签名用的是 CI 里那把 A。**A 泄露**是另一回事:那要用离线的 B 签、并把 A 踢出信任列表,
只能手跑 —— 而且救不了存量用户(信任列表冻在他们出厂的那份里)。手跑长这样:

```bash
node scripts/sign-update-manifest.mjs --version 0.9.0 --revoked 0.9.1 \
  --payload-url https://github.com/Akokk0/bilibili-notify/releases/download/v0.9.0/bilibili-notify-payload-0.9.0.zip \
  --sha256 <那份 zip 的 sha256> --size <字节数> \
  --release-url https://github.com/Akokk0/bilibili-notify/releases/tag/v0.9.0 --out dist/manifest
CHANNEL=stable FILE=dist/manifest.sig.json GH_TOKEN=… REPO=Akokk0/bilibili-notify \
  bash .github/scripts/publish-update-channel.sh   # 预发布渠道再来一遍 CHANNEL=alpha
```

## 几条不许动的约定

- **`startStandaloneServer` 这个导出是向前兼容契约。** 镜像里的 `boot.mjs` 是冻住的,
  它得能启动任何未来版本的载荷。改名 = 老镜像上的用户更新完打不开。
- **清单以字符串放进信封,信封本身从不被签。** 展开成对象就要求验签时重新序列化,
  而 JSON 的重新序列化不唯一(键序/空白/数字写法/unicode 转义)—— 两边差一点就验不过,
  且完全查不出原因。
- **`webDistDir` / `--web-dist` 一旦写死,前端就不跟着升级走了。** 两端都已经改成
  「相对载荷入口就近解析」,别再加回显式路径。
- **只保留当前 + 上一版**,回退只退一步,不给版本列表。用户想要更老的版本,自己去下
  老镜像 / 老安装包,风险自负。
- **清理只碰长得像版本号的目录,外加我们自己的 `.staging-*` / `.old-*` 残留**。`/data` 是用户挂
  出来的,他真的会往里丢东西;残留是我们的命名空间,断一次电就永远躺着,没人替我们扫。

## 相关文件

| 位置 | 干什么 |
|---|---|
| `apps/server/src/boot.ts` | 选版 + 同进程加载载荷,回落镜像 |
| `apps/server/src/update/` | 验签 / 决策 / 落盘 / 镜像站 / 选版自愈 / 清理 / 编排 |
| `apps/server/src/routes/update.ts` | `GET /api/update` 与 check/download/apply/rollback/mirrors/probe |
| `apps/web/src/components/update/` | 系统页那一节;`status.ts` 是三处消费点共用的判断与查询键 |
| `apps/web/src/hooks/useUpdateCheckOnOpen.ts` | 打开面板查一次 + 发通知卡 |
| `scripts/build-update-payload.mjs` | 打载荷 zip |
| `scripts/gen-update-keys.mjs` | 生成两把 Ed25519 密钥,并打印该往哪儿贴 |
| `scripts/sign-update-manifest.mjs` | 生成 + 签署清单 |
| `.github/workflows/update-payload.yml` | 发版侧 |
