# 开发者工具(devtools)

很多功能的触发条件很苛刻(UP 得真开播、动态得真发、更新得真发版),没法坐等。devtools
把这些**造出来**:一半是造状态(换掉面板看到的那份),一半是造事件(整条链路真跑)。

## 门

- **服务端 —— 结构上就不在构建产物里**:`apps/server/vite.config.ts` 的 `stubDevtools` 插件
  在**任何**构建(lib 与 bundle 都算)里把从 `src/devtools/` 目录外指进去的 import 解析到
  `devtools/stub.ts`(`createDevtools` 恒回 null),整棵树随之从产物里消失。前提是整套
  devtools 只有 `src/index.ts` 一个引用点(`/api/dev` 路由也住在 `devtools/route.ts`,
  app.ts 只收一个建好的 Hono),`apps/server/src/__tests__/devtools-isolation.test.ts` 钉着它。
  构建后 `scripts/check-no-devtools.mjs` 再对着产物 grep 一遍只有 devtools 才用的字符串
  (server 的 `build` / `build:bundle` 与 web 的 `build` 都接了),隔离哪天被绕过构建当场红。
  所以 devtools **只在 tsx 直跑源码时存在**;alpha、正式版、`:test` 镜像、lib 裸跑都没有。
- **运行期的门(源码上跑时才走到)**:`devtools/index.ts` 的 `createDevtools` 两道都成立才组装:
  ① 载荷版本号是开发版(`0.0.0-dev` / `dev`,`update/version-order.ts` 的 `isDevBuild`);
  ② 跑的是 TypeScript 源码(`import.meta.url` 以 `.ts` 收尾)。第一道**失败即敞开**(`0.0.0-dev`
  是仓库常驻值,版本号读不出来时兜底也是 `"dev"`),历史上公开推的 `:test` 镜像就是这么把
  `/api/dev` 带出去的 —— 现在构建层已经连代码都不带了,这两道只是源码上跑时的兜底。更新服务
  共用 `isDevBuild`,但那边敞开的后果是「关掉更新」,是安全的一侧 —— 同一个判据,两种后果,别合并。
- **面板**:`App.tsx` 里 `import.meta.env.DEV ? lazy(() => import("./devtools/dock")) : null`,
  生产 bundle 连这个 chunk 都没有;`apps/web/src/__tests__/devtools-isolation.test.ts` 钉着
  「`src/devtools/` 只有 App.tsx 那一处提」——认的是模块说明符,`import "…"`(纯副作用)与
  裸 `import("…")`(不在 DEV 死枝里、会真产出 chunk)都拦得住,只钉 `from` 是拦不住的。面板探 `GET /api/dev`,404 就整个不出现(面板跑 dev、
  后端连着正式镜像时就是这样)。
- **不用环境变量**:环境变量能在生产镜像里被设上。

## 形态

左下角玻璃药丸(`DockPill`,与右下 AI 胶囊同基线)+ 底边升起的整宽面板(`DockPanel`,
拖顶边改高、记在 localStorage、ESC 收)。两件都在 `packages/ui`,走 `z-bn-dock`(45)。
左栏五组:事件 / 状态 / 定时 / 截流 / 前端;顶部「当前生效」条一键收摊。药丸上的快捷位只给
最常按的五个(更新 / 截流 / 开播 / 下播 / 发动态),按默认值跑。

## 注册表:两半合一份

声明类型在 `apps/contract/src/devtools.ts`(`DevScenario`:id / group / title / desc /
params / quick / icon)。参数 **schema 驱动**,六种字段:`sub` / `target` / `adapter`(面板画
选择器,值是 id,留空 = 服务端默认)、`number` / `enum` / `text`(自带默认值)。

- 服务端那半:`apps/server/src/devtools/scenarios/*.ts`,经 `createDevRegistry` 汇总,
  `/api/dev` 列举 / 跑 / 收摊(`routes/dev.ts`)。注册表补默认值、拦越界、汇总各场景的
  `active()`;场景做什么归各自的 `run`。
- 前端那半:`apps/web/src/devtools/web-scenarios.ts`,同形状,`run` 在浏览器里跑(涌 toast、
  不可达壳、灵动岛、新手指引步)。面板把两张表并成一张(`mergeScenarios`),撞 id 直接炸。

加一个场景 = 写一个 `DevScenarioDef` 塞进 `createDevtools` 那张表,面板一行不改。

## 注入高度:既有边界上套装饰器,引擎一行不动

| 要造什么 | 装饰在哪 | 文件 |
| --- | --- | --- |
| 更新 9 相 8 归因 | 包 `UpdateService`,只换 `getStatus()` 的 `state`;**真动作不清注入**(面板每次打开都自动 check,清了刷新一下就没了),只在面板收摊 | `update-injection.ts` |
| 推送截流 | 包每个 `PlatformAdapter.send`:开着就不真发、记摘要、回 ok**并标 `synthetic`**(sink 的 `onDelivery` 会拿投递结果去写 `target.testStatus` 并落盘,一条没出网的成功不能拿来说「这个目标通」——`isReachabilityEvidence` 挡在那儿);历史照记 delivered 不打标,面板列表是对照,`purge-history` 按截流时间窗删行(`HistoryStore.deleteRange`) | `capture.ts` |
| 开播 / 下播 / 弹幕 / SC / 上舰 / 礼物 / 进场 | blive 的 `observeLiveConnections` 观察钩子拿到房间的 `emit`,与真帧同一条回调;假直播期间 `getLiveRoomInfo` 对那个房间打补丁(live_status=1、live_time=现在) | `live-rooms.ts`、`scenarios/live*.ts` |
| 四类动态 | 传给引擎的 `api` 套 Proxy(`api-overrides.ts`,按方法名盖、`this` 绑回真对象;每个方法一份**稳定**的包装,盖没盖在调用时查 —— 引擎构造时存下的方法引用也吃得到覆盖),`getAllDynamic` 结果最前并进假动态,`DynamicEngine.detectNow()` 立刻跑一轮,跑完撤 | `scenarios/dynamic.ts` |
| 私聊指令 / 群链接 | 直接调接线层的两个入站口(与 adapter 收到真帧后调的是同一个函数) | `scenarios/inbound.ts` |
| 引擎错误 / 登录失效 / 恢复 | 直接 `bus.emit`(发射不是转发,不碰 MessageBus 铁律);auth-lost 会**真的**停引擎,看完记得 restored | `scenarios/bus-events.ts` |
| 扫码登录六态 | 盖 `authSystem.status()` + 总线发同一份 `login-status-report`;假二维码走 `qrcode` 包(与真登录同一条渲染路),扫出来是一句「devtools 的假货」 | `scenarios/login-state.ts`、`fake-qr.ts` |
| 适配器能力三态 | 包 `capabilities` / `probeCapabilities`(只对有能力概念的平台)。两个 adapter 包装器都是 `{ ...inner, … }` 展开叠上去的,靠的是「adapter 方法不吃 `this`」这条写在 `PlatformAdapter` 上的契约 | `capability-injection.ts` |
| 免扰 / 静音 | 免扰:`BilibiliPush.quietHoursNow` 单点时钟(**不是假时钟**);静音:真调 `muteFor`,并**记住自己写进去的到期时刻** —— 只认领 / 只解除这一次,主人自己 `/mute` 出来的不碰(收摊只收 devtools 造的东西) | `clock.ts`、`scenarios/timers.ts` |
| 「现在就跑」 | 各引擎 / 运行时自己暴露的一个口:`closeIdleNow` / `repushNow` / `detectNow` / `pollNow` / `healthCheckNow` | 同上 |

副作用规矩:**默认真发,可截流**。造事件之前先开截流,推送就只进列表不出网。

## 面板那半的三个坑

- react-query 的 `refetchInterval` 窗口失焦就停;人盯着终端 / 聊天软件时面板恰好在后台,
  所以 devtools 的查询都开了 `refetchIntervalInBackground`。轮的是 `GET /api/dev/active`
  (十几字节的生效表),不是带整张场景表的 `GET /api/dev` —— 那份静态、拉一次就够。
- 跑完一个场景把**所有**查询作废(连 `/api/dev` 自己),造出来的状态经各页自己的查询才看得见,
  逐个列 key 的话新场景必漏。
- 靠作废查询看不到的消费点:只在某个**时机**才出手的那种。「有新版」通知卡只在打开面板那次
  自动检查里发(`useUpdateCheckOnOpen`),注入 `available` 之后不刷新页面就没有卡。
  `apps/web/src/devtools/follow-ups.ts` 按场景 id 登记「跑完后面板要补做的事」,`update.state`
  跑完就地**重放**那次检查(同一个函数、同一条路),卡当场弹。补做失败的红字会说明注入已生效。

## 真机验过 / 没验过(2026-09-06)

验过:更新状态(系统页 / 概览卡 / 刷新后「有新版」通知卡)、截流 + 清历史行、假开播 → 开播卡 →
60 条弹幕 → 下播卡 + 词云 + AI 总结、假图文动态 → 卡片 + 点评 + 图集、`/help` 回复、群链接
回卡、假二维码弹窗、engine-error 进主人私聊、能力 supported、四个「现在就跑」、涌 toast、
灵动岛保存中。没验过:免扰时钟(主人配置里 quietHours 为空,单测覆盖)、Chrome 空闲关
(当时浏览器没起)、新手指引步(导览关着)、Windows。
