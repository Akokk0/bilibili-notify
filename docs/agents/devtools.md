# 开发者工具(devtools)

很多功能的触发条件很苛刻(UP 得真开播、动态得真发、更新得真发版),没法坐等。devtools
把这些**造出来**:一半是造状态(换掉面板看到的那份),一半是造事件(整条链路真跑)。

## 仓外拓展联调

沿[ADR-0045](../adr/0045-bn-runtime-cli.md)，`@bilibili-notify/bn dev`运行专用开发成品，不再创建源码宿主工作区；默认数据在`~/.bilibili-notify/dev-data`，也可显式指定。`create-bn-ext`生成独立拓展，只需安装依赖，由BN加载源码，生产才构建。

开发版拓展页的“挂载开发拓展”接`/api/dev/extensions`：GET列当前挂载，POST指定BN机器上的源码工程绝对目录与监听选项，DELETE解除指定ID。接口沿宿主鉴权，只在源码开发或显式开发构建内装配。解析根清单、核对ID和兼容性，预读src/index.ts及设置规则后，通过现有装载队列在唯一数据代装载根建立工程链接；已有安装或挂载占位时拒绝覆盖。

目录可手填，也可点“浏览目录”：`GET /api/dev/directories?path=<绝对目录>`只列宿主的文件夹及当前目录是否含extension.json，无path时源码开发从仓库起步，开发成品从启动目录起步。支持上级导航与返回工作区，目录软链进入后显示真实路径；选择仅回填，取消保留路径和监听草稿。读取失败返回标准错误体，不执行挂载或读取文件正文；沿同一鉴权与生产剔除边界。

每个工程独立使用Vite+模块环境加载与监听源码和导入依赖，不输出dist、不加载作者打包配置、不另开HTTP服务。预检失败保留旧实例，修正后继续更新；自动重载不启用停用项，界面跟随完成次数刷新拓展表和视图。主进程的tsx不接收这些源码导入，局部更新不重启BN。源码devtools入口为src/devtools/index.ts，继续要求清单声明。解除和退出清理拥有的链接、运行上下文、监听和模块环境，不删源工程。

前端仍只有App的编译期开发入口引用devtools，通过组件插槽把挂载UI放到原拓展页；生产构建的页面与接口均不存在。面板与390px弹窗验收记录在`.bn-design/s6-manual-dev-evidence/`。

## 门

- **正式构建**：`apps/server/vite.config.ts`的stubDevtools把核心与B站devtools入口换为空桩。普通lib、Docker、桌面和`bn web`都不携带开发代码；原build/build:bundle继续运行check-no-devtools。仅`BN_RUNTIME_PROFILE=dev`的显式开发构建保留模块，并给入口固定编译常量。
- **源码直跑**：仍同时检查`0.0.0-dev`/`dev`版本与.ts入口。显式开发成品由编译常量开放，alpha版本也可用于拓展联调。正式成品无法由运行期环境变量打开开发接口。
- **面板**：App.tsx是devtools的唯一引用点，`import.meta.env.DEV || import.meta.env.BN_DEVELOPMENT_RUNTIME`在编译期折叠；普通生产构建不含dock分块。现有源码隔离守卫和产物检查保持。开发面板连接普通后端时仍因`GET /api/dev`返回404而不出现。
- **更新**：显式开发宿主不下载普通更新载荷，升级开发宿主由启动器选择对应成品；版本占位与没有公钥的既有禁用行为保持。

## 形态

左下角玻璃药丸(`DockPill`,与右下 AI 胶囊同基线)+ 底边升起的整宽面板(`DockPanel`,
拖顶边改高、记在 localStorage、ESC 收)。两件都在 `packages/ui`,走 `z-bn-dock`(45)。
左栏六组:事件 / 状态 / 定时 / 截流 / 前端 / 拓展;顶部「当前生效」条一键收摊。药丸上的快捷位只给
最常按的五个(更新 / 截流 / 开播 / 下播 / 发动态),按默认值跑。

## 注册表:两半合一份

声明类型是 `DevScenarioDescriptor`(id / group / title / desc / params / quick / icon),这一族的本体住
`packages/internal/src/devtools.ts`;`@bilibili-notify/extension` 转出给拓展,`apps/contract/src/devtools.ts`
只经 `export type` 借给面板。`run` 返回结果形状 `{ ok: true, summary? } | { ok: false, code, message }`,
参数不合法回 `invalid`,场景找不到回 `not_found`;`DevParamError` / `DevScenarioNotFound` 已删。参数 **schema 驱动**,
七种字段:`sub` / `target` / `connection`(面板画选择器,值是订阅 / 目标 / 连接的 id;**只给核心的场景**)、
`creator`(交场景那个来源名单里的人,值是 externalId;名单是来源 `ctx.subscriptions()` 那一份,宿主照它核,不在名单里回
`invalid`;面板按描述符的 `provider` 只列那个来源启用的订阅、按人去重)——这四种留空 = 服务端默认;
`number` / `enum` / `text`(自带默认值)。种类按提供方收:核心以外(B 站与拓展一样)只收 `text` / `number` / `enum` /
`creator`,用了别的认领时整包拒(ADR-0031 决策 2)。

场景 id 一律是 `<提供方>.<短名>`:场景里写短名,前缀由登记表加 —— 核心自己的场景建表时就以 `core` 认领
(`core.update.state`、`core.ext.install`;`core` 是保留的拓展 id,别家认领不到),B 站是 `bilibili.`,拓展是
`<拓展 id>.`。描述符的 `provider` 一格同样由登记表填。面板那半的 `web.*` 不经登记表。

- 服务端那半:核心的场景在 `apps/server/src/devtools/scenarios/*.ts`;各集成自带的场景经 `DevtoolsProvider` 登进
  `devtoolsProviders`,登记与撤销可以发生在启动之后,场景表随 provider 增减(B 站的在 `apps/server/src/bilibili/devtools/`,
  由 `compose.ts` 的 `provideDevtools` 认领;
  B 站 devtools 自己建 `Api` 与登录口那两层开发壳,不再由入口建 `devApi` / `devAuth`;`compose.ts` 只递 B 站来源一个把手
  (`BiliDevtoolsDeps.source`),场景按下时才从它身上现取名单(`subscriptions()`,就是来源 `ctx.subscriptions()` 那一份)、
  动态轮询、直播房号与登录把手 —— 核心的总线、订阅表、订阅运行时状态一样不拿。动态轮询句柄不交回入口,来源登记之前取不到时场景说还没起来),
  汇总时宿主给 id 加来源前缀(`bilibili.live.start`)。
  两边一起经 `createDevRegistry` 汇总,provider 那半在列举、运行、查生效与收摊时现读,
  `/api/dev` 列举 / 跑 / 收摊(`apps/server/src/devtools/route.ts`)。注册表补默认值、拦越界、汇总各场景的
  `active()`;场景做什么归各自的 `run`。
- 前端那半:`apps/web/src/devtools/web-scenarios.ts`,同形状,`run` 在浏览器里跑(涌 toast、
  不可达壳、灵动岛、新手指引步、拓展卡片的两段动画)。面板把两张表并成一张(`mergeScenarios`),撞 id 直接炸。
  **「播放安装动画 / 播放更新动画」**(`ext-motion.ts`)不装东西:往 `card-motion` 那一格放一段,
  与真装 / 真更新成功之后放进去的同形状,拓展页照着演。卡从**页面上**找(`EXT_CARD_ANCHOR`,与动画
  找落点同一个属性),页上没卡(不在拓展页)或没这个 id 就只回一句话、那一格不碰 —— 放一段落不了地
  的进去,演的那头会干等到超时。安装的起点是视口底部正中一个卡那么大的框;更新从卡里那颗「更新」钮
  起飞,没那颗钮(没有新版)就不给起点、球从卡片上方落下 —— 想看从钮上起飞,先跑一次「拓展有更新」。
  换装会一直「蓄」到装完(真更新时那是下载),所以更新那一条带两个参数:蓄几秒、结果(装成了 = 光收到卡心
  画圈打勾,没装成 = 光环淡出)。

给核心加一个场景 = 写一个 `DevScenarioDef`(短名)塞进 `createDevtools` 那张表,面板一行不改;它在面板上叫 `core.<短名>`。

## 拓展的开发入口

拓展清单写 `"contributes": { "devtools": {} }` 只表示「开发版可以来找入口」,不带路径,也不算 `provides`
或「至少开一口」。挂载源码时，BN 读取 `src/devtools/index.ts`。从本地构建目录装载时，BN 查找 `devtools.mjs`，发行 ZIP 会排除该文件。入口同步导出
`devtools(ctx: ExtensionDevtoolsContext): DevtoolsProvider`,模块顶层不存状态。开发上下文就是拓展 `activate`
拿到的 `ExtensionContext`,另多一个 `mountUrl()`:它现取自己那条总入口在本机回环上的完整地址,HTTP 还没起来时回
`undefined`。

宿主只在开发版、且拓展已经 `activate` 成功后挂开发入口;入口交回的场景 id 写不带前缀的短名,宿主按拓展 id
认领、加 `<拓展 id>.`。核心的场景前缀是 `core.`,`core` 又是保留的拓展 id,撞不上。停用、卸载、重载或关机都会经 `ctx.signal`
撤掉 provider;入口自己占着的连接等资源也要听这个信号收尾。开发入口挂不上只记 warn,不改主拓展的运行状态。

拓展场景收 `text` / `number` / `enum` / `creator` 四种参数(来源型拓展挑自己名单里的人用 `creator`);`sub` / `target` /
`connection` 只留给核心,出现别的种类认领时整包拒,开发入口记一行警告。`run` 与核心场景一样回结果,不抛参数异常。

主仓运行 `vp run dev:apps` 启动 BN 服务端和面板。在拓展页点「挂载开发拓展」，选择 `extensions/bridge` 或 `extensions/fake-source` 的源码目录，挂载后在卡片上启用。「源码变化时自动重载」默认勾选，保存源码或其导入的依赖后，BN 只重载对应工程。预检失败时旧实例继续运行，卡片显示失败原因。

开发面板的「拓展」组与拓展页共用挂载服务。BN 能在主仓的 `extensions/` 下找到工程时，面板提供四个场景（`scenarios/extensions.ts`）。

- 「挂载仓里的拓展源码」（`core.ext.install`）按目录名选择工程，挂载时开启源码监听。
- 「解除源码挂载」（`core.ext.uninstall`）停止实例和监听，移除宿主创建的链接，保留工程目录。
- 「重新加载源码」（`core.ext.reload`）立即预检并刷新选中的工程，停用的拓展仍保持停用。
- 「源码自动更新」（`core.ext.watch`）为已挂载的工程开启监听。此场景开启的监听列在「当前生效」条，显示重载次数或失败原因，一键收摊会关闭监听。工程保持挂载，仍可手动重载。

同组的 **「拓展有更新」**(`core.ext.updatable`)不做真事,造的是**假状态**:已装卡片上造出「有新版 vX · 更新」,
按下去先假装下载几秒(参数,默认 2 秒 —— 一按就成的话,那段一直蓄到装完的换装根本看不见蓄力),再假装装成(见下表)。它进「当前生效」条、归一键收摊,按「更新」装成之后自己撤掉 —— 现实里
更新完那张卡就不再提示了。参数是**装着的**拓展 id(没装的拒:那颗钮只长在已装卡片上),所以它不跟
那几条一起「仓里没拓展就整组不出现」。

## 注入高度:既有边界上套装饰器,来源一行不动

| 要造什么 | 装饰在哪 | 文件 |
| --- | --- | --- |
| 更新 9 相 8 归因 | 包 `UpdateService`,只换 `getStatus()` 的 `state`;**真动作不清注入**(面板每次打开都自动 check,清了刷新一下就没了),只在面板收摊 | `update-injection.ts` |
| 推送截流 | 接在 `TargetDispatcher` 调适配器 `send` 的那一处(`interceptSend`,三条发送路共用):开着就不真发、记摘要、回 ok**并标 `isSynthetic`**(dispatcher 的 `onDelivery` 会拿投递结果去写 `target.reachability` 并落盘,一条没出网的成功不能拿来说「这个目标通」——`isReachabilityEvidence` 挡在那儿);历史照记 delivered 不打标,面板列表是对照,`DELETE /api/dev/captures/history` 按截流时间窗删行(`HistoryStore.deleteRange`) | `capture.ts` |
| 开播 / 下播 / 弹幕 / SC / 上舰 / 礼物 / 进场 | blive 的 `observeLiveConnections` 观察钩子拿到房间的 `emit`,与真帧同一条回调;假直播期间 `fetchLiveRoomInfo` 对那个房间打补丁(live_status=1、live_time=现在)。挑人用 `creator`,省略 = 名单里第一个直播间连着的;回执写 UID(名字在核心的资料缓存里,场景拿不到);「进场」的 uid 要自己填一位特别关注(特别关注是订阅的配置,B 站读不到) | `live-rooms.ts`、`scenarios/live*.ts` |
| 四类动态 | 传给动态轮询的 `api` 套 Proxy(`api-overrides.ts`,按方法名盖、`this` 绑回真对象;每个方法一份**稳定**的包装,盖没盖在调用时查 —— 动态轮询构造时存下的方法引用也吃得到覆盖),`fetchAllDynamic` 结果最前并进假动态,`DynamicPoller.detectNow()` 立刻跑一轮,跑完撤 —— B 站解析、`ctx.reportPost`、推送全是真链路(动态轮询句柄是 B 站来源的 `dynamic()`;来源登记之前它是 undefined,场景报「动态轮询还没起来」)。挑人用 `creator`,省略 = 名单里第一个开着作品的,作品开关关着的拒;卡上的作者名经同一个壳现拉 `fetchUserCard`,拉不到写 UID | `scenarios/dynamic.ts` |
| 私聊指令 / 群链接 | 直接调接线层的两个入站口(与 adapter 收到真帧后调的是同一个函数) | `scenarios/inbound.ts` |
| 一条桥接进来 | **不装饰任何东西** —— 拿那条桥接入自己的 token 连一条**真 WS** 回桥自己的端点(`ws://127.0.0.1:<自己的端口>/ext/bridge`),所以 upgrade / 鉴权 / 握手 / `publishView` / 推送 adapter / 回执全是真的,假的只有「后面没有 bot」。回执是结果形状(协议 1.5)。地址经 `ctx.mountUrl()` 现取,连接与取图都走桥自己的 `ctx.http`;帧与协议版本直接用桥的 `contract.ts`,不再在核心手抄第二份。`src/__tests__/devtools-fake-bridge-e2e.test.ts` 仍把真桥装进装载根让两边真说一次话 | `extensions/bridge/src/devtools/` |
| 拓展有更新 | 包交给 `/api/ext/marketplace*` 的那个 `Marketplace`:列表里那个 id 的一条改成 `updatable`,版本 = **装着那版**的下一个补丁号(预发布就加最后一段);索引里没有它(断网 / 不在任何索引里)就现造一条**官方**的 —— 官方一键装,造成第三方的每按一次多弹一个确认框。拓展 id 默认空,按之前要手填**已装**的拓展 id。装那个 id **先等「假装下载」那几秒、再假装成功**:同形状的回话,不下载、不写盘、不重扫,所以卡上印的版本号不变;装成即撤。别的 id 原样过真市场 | `marketplace-injection.ts`、`scenarios/marketplace.ts` |
| 动态拉取报错(`bilibili.dynamic.fail`,宿主按来源键加前缀;场景里的 id 是 `dynamic.fail`) | 同一个 `fetchAllDynamic` 盖板位:让下一轮(参数 `rounds` 连着几轮,1 至 50,默认 1)拉动态的请求不发真请求、回请求层会给的失败结果(经 `failureFromBili` 造:参数 `code` 翻成标准码、原码放 `upstreamCode`,没有 `data`;`code` 非 0 整数,默认 `-352`,`-412` / `-799` / `-509` 同样是风控,`-101` 是未登录;非法值回 `invalid`),用完自己摘。**只装弹、不触发检测**:想立刻看到就再点「动态检测」。**与「四类动态」共用盖板位**:场景里一个函数 `syncOverride()` 汇总,错误码优先,谁还要用就留着、都不用了才摘,收摊两边各清各的。盖的只是拉动态这一个请求、不经请求客户端对 `-101` 的拦截,所以**回 `-101` 不会让登录状态变成失效**,动态轮询停 cron 后等 `watchLoginEdges` 的恢复边;要把它拉起来,先按「登录失效」、再按「重新确认登录」。用来看动态轮询的退避、问题表(风控 `risk_controlled`、拉动态失败 `dynamic_fetch_failed`)与风控私聊、恢复句 | `bilibili/devtools/dynamic.ts` |
| 推送链路错误 | `core.pipeline.error` 仍直接 `bus.emit`(发射不是转发,不碰 MessageBus 铁律),让主人收到私聊、面板右上角出告警 | `scenarios/bus-events.ts` |
| 登录失效 / 重新确认登录(`bilibili.auth.lost` / `bilibili.auth.recheck`) | 经 B 站来源的 `login()` 把手调登录流程的 `handleAuthLost` / `reportAccountInfo`,真改登录状态:动态检测会停、直播监听会拆,会进问题表、主人会收私聊,恢复时补「已恢复」;cookie 罐不动,所以「重新确认登录」能把它拉回来。没登录时「登录失效」不调、只说没有可判失效的会话;来源还没起来时两个都回「B 站来源还没起来」 | `bilibili/devtools/login.ts` |
| 登录状态(`AuthState` 的各取值) | 盖来源登录口(`Source.auth`)的 `state()` 与 `account()`,再替登录口喊一声「变了」(开发壳记着经它订的变更回调,`notifyChanged()` 挨个叫):宿主照常读一遍 `state()`、发 `subscription-auth-changed`,登录问题表也跟着反应(假「失效」进表并私聊,截流开着就拦下)。场景拿不到总线。开发壳由 B 站 devtools 自建,登记表里挂的是壳的 `.api`,所以 `GET /api/sources/:sourceKey/auth` 与 WS 帧都读得到注入值,收摊时摘掉、再喊一声让面板对回去。选项:未登录、等待扫码、正在确认(已扫码等手机确认 / 开机还没向 B 站确认,各一项)、已登录(带账号名)、登录失效、登录失败;假二维码走 `qrcode` 包(与真登录同一条渲染路),扫出来是一句「devtools 的假货」 | `bilibili/devtools/login-state.ts`、`fake-qr.ts` |
| 连接能力三态 | 包 `capabilities` / `probeCapabilities`(只对有能力概念的平台)。注入接在派发器上(`injectedCapabilities` 读口,生产不传)、盖在宿主的能力记忆之上,收摊回真:注入期间读到假值、假值不进记忆,`probeConnectionCapabilities` 也直接交假值、不叫适配器(不出网) | `capability-injection.ts` |
| 免扰 / 静音 | 免扰:`PushRouter.quietHoursNow` 单点时钟(**不是假时钟**);静音:真调 `muteFor`,并**记住自己写进去的到期时刻** —— 只认领 / 只解除这一次,主人自己 `/mute` 出来的不碰(收摊只收 devtools 造的东西) | `clock.ts`、`scenarios/timers.ts` |
| 堆逼近上限 | 包真 `process.memoryUsage()`,按注入的占比 × 堆上限造 `heapUsed`(顺带把 `heapTotal` 抬到不低于它)。注的是**读数**不是显示值 —— 概览页那两个环的染色、近 5 分钟曲线、服务端「已逼近堆上限」那条 warn 全照真的算一遍。包好的读数由 `createDevtools` 交回去(`index.ts` 只许从 `./devtools/index.js` 引 devtools,多一个 import 就多一条漏进产物的路) | `heap-injection.ts`、`scenarios/heap.ts` |
| 「现在就跑」 | 各来源 / 运行时自己暴露的一个口:`closeIdleNow` / `repushNow` / `detectNow` / `pollNow` / `healthCheckNow`;资料刷新在核心定时组走 `ProfileRefreshHandle.pollNow()`,登录心跳经 B 站来源的 `login()` 交出(没登录 / 扫码中跳过) | `scenarios/timers.ts`、`bilibili/devtools/timers.ts` |

副作用规矩:**默认真发,可截流**。造事件之前先开截流,推送就只进列表不出网。

## 面板那半的三个坑

- react-query 的 `refetchInterval` 窗口失焦就停;人盯着终端 / 聊天软件时面板恰好在后台,
  所以 devtools 的查询都开了 `refetchIntervalInBackground`。轮的是 `GET /api/dev/active`
  (十几字节的生效表),不是带整张场景表的 `GET /api/dev` —— 那份静态、拉一次就够。
- 跑完一个场景把**所有**查询作废(连 `/api/dev` 自己),造出来的状态经各页自己的查询才看得见,
  逐个列 key 的话新场景必漏。
- 靠作废查询看不到的消费点:只在某个**时机**才出手的那种。「有新版」通知卡只在打开面板那次
  自动检查里发(`useUpdateCheckOnOpen`),注入 `available` 之后不刷新页面就没有卡。
  `apps/web/src/devtools/follow-ups.ts` 按场景 id 登记「跑完后面板要补做的事」,`core.update.state`
  跑完就地**重放**那次检查(同一个函数、同一条路),卡当场弹。补做失败的红字会说明注入已生效。

## 真机验过 / 没验过(2026-09-06)

验过:更新状态(系统页 / 概览卡 / 刷新后「有新版」通知卡)、截流 + 清历史行、假开播 → 开播卡 →
60 条弹幕 → 下播卡 + 词云 + AI 总结、假图文动态 → 卡片 + 点评 + 图集、`/help` 回复、群链接
回卡、假二维码弹窗、pipeline-error 进主人私聊、能力 supported、四个「现在就跑」、涌 toast、
灵动岛保存中。没验过:免扰时钟(主人配置里 quietHours 为空,单测覆盖)、Chrome 空闲关
(当时浏览器没起)、新手指引步(导览关着)、Windows。

3a-30(2026-10-11)新加的 `bilibili.dynamic.fail` 与「登录状态」「推送链路错误」几个场景对问题表的影响**没有真机验过**,清单见 `docs/1.0/phase-3a-plan.md` 的「3a-30 真机待看」:开发场景「登录状态」只盖 `state()` / `account()` 并往总线发 `subscription-auth-changed`、不叫真登录口的 `onChange`,而宿主报的登录问题靠真登录口的 `onChange` 再读 `state()`,所以读代码判断它开不了那条登录问题(没实跑)。

🔗现状（4-55，2026-10-31）：定时场景保留原DevClock/API方法形状；注入只存请求HH:mm，每次active现读核心timezone和今天，用Luxon规范化。显示请求值与实际yyyy-MM-dd HH:mm、IANA、UTC偏移；summary是上次操作结果，不随设置改写。gap/overlap沿库、固定边界由单测/库探针钉住；mute同epoch换当地显示，全部收摊不能清掉后来手动覆盖的静音。本片未新增4-48时区控件或通用下次cron面板。
