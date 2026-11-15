# 第6期计划：拓展配套与1.0 alpha

总范围见[施工总计划](construction-plan.md)。先补第三方拓展开发配套，再接抖音来源，最后收alpha数据与发行。2026-11-10主人批准[SDK和创建器走npm](../adr/0040-extension-sdk-npm.md)、[仓库输入映射固定Release索引](../adr/0041-extension-repository-source.md)。

## 状态

- 第5期已正式出期，本期从`38dc17687`开始。
- 迁移修订号53、备份版本23；当前宿主和公开 SDK `0.1.0-alpha.1` 的契约为 `apiVersion: 1`、`apiRevision: 2`。历史“v3”不是当前发行号。展示账号与稳定身份分离见[ADR-0050](../adr/0050-creator-display-id.md)。
- 大改UI限制保留；市场输入在现有弹窗上局部调整。
- 2026-11-12，SDK 与创建器已在 npm 上发布首个 `alpha`，版本均为 `0.1.0-alpha.0`。[SDK](https://www.npmjs.com/package/@bilibili-notify/extension/v/0.1.0-alpha.0) · [创建器](https://www.npmjs.com/package/create-bn-ext/v/0.1.0-alpha.0)
- 2026-11-13，创建器 `0.1.0-alpha.1` 经 npm 可信发布上架。向导只问目录、ID 和显示名。市场资料放在 `bn-extension/marketplace.json`，发布时从 Actions 或 Git 远端读取仓库地址。模板把动态导入打进 ZIP 入口。[ADR-0048](../adr/0048-extension-marketplace-config.md) · [创建器发行作业](https://github.com/Akokk0/bilibili-notify/actions/runs/43350549879/job/131651210554)
- 2026-11-13，`create-bn-ext@0.1.0-alpha.2` 已通过 npm 可信发布上架。创建器与发布工具统一使用 `.bn-extension/marketplace.json`，纯配置提交也会检查文件格式。抖音拓展工程已用该公共版本从零生成，默认 SDK 为 `0.1.0-alpha.0`，冻结安装、构建打包及发布预演通过。[ADR-0049](../adr/0049-hidden-extension-marketplace-config.md) · [创建器发行作业](https://github.com/Akokk0/bilibili-notify/actions/runs/43376339379/job/131728317126)
- 2026-11-13，`create-bn-ext@0.1.0-alpha.3` 已上架；交互向导退格时保留字段提示，跨字段粘贴后在原光标位置继续输入。公共 `alpha` 入口已用真实终端验证。[发行作业](https://github.com/Akokk0/bilibili-notify/actions/runs/43386044891)
- 2026-11-12，抖音首版确认与 B 站对齐常用订阅操作、群聊贴作品出卡和系统账号页扫码登录。群聊入口与登录分片落实。[首版定案](../adr/0047-douyin-source-parity.md)
- 2026-11-14，抖音最终版收归 `extensions/douyin/` 作为官方维护入口，ID 为 `douyin`；仓外 `akokko.douyin` 工程保留为脚手架验证样本。官方源码、四语文案、workspace SDK、构建与主仓拓展发布流程已接齐，使用说明见[拓展 README](../../extensions/douyin/README.md)。本次收归代码不调整既有来源身份与本机数据，市场上架另走发行流程。
- 2026-11-15，第6期已完成获批发行及渠道验收：本体／BN `1.0.0-alpha.1`、桥与 SDK `0.1.0-alpha.1`、创建器 `0.1.0-alpha.4`、抖音 `0.1.0-alpha.0`，全部走 alpha。本体四条发行流水线、开发工具与官方拓展均已发布，实物核对见下方正式发行记录。抖音未自然触发的真实新增作品、短信二次验证及开／下播，按主人此前决定继续作为观察项。
- 2026-11-11最新定案见[ADR-0046](../adr/0046-bundled-npm-distribution.md)：npm包自带两种宿主、随主程序tag发行；`@bilibili-notify/bn web/dev`运行宿主成品；拓展继续由BN手动挂载源码。

## 切片

按依赖暂排，复杂工作继续拆原子片；没有实际使用者的能力保持原边界。

| 片 | 范围与完成条件 | 状态 |
| --- | --- | --- |
| 6-01 | 两项获批ADR、仓库指引与片表、测试入口记录 | ✅ 定案已落 |
| 6-02 | 仓外SDK：本地npm包无私有internal依赖，根入口与`/build`可运行，公开类型可编译，最小拓展可构建并通过现有装包校验；能力不加宽 | ✅ 已落；26文件441项相关测试通过 |
| 6-03 | 仓库简写/URL归一到固定Release索引，保留HTTPS输入与信任边界；确定固定标签和作者配置格式 | ✅ 已落；片级201项、四包类型及内置浏览器通过 |
| 6-04 | npm创建器：生成完整vp工程，配齐锁文件、lint/format/type/test/build/pack入口、pre-commit及commitlint、市场配置和Actions；按下方工程基建清单验收 | ✅ 本地创建器/工程基建与检查Actions已落；自动发布接6-05 |
| 6-05 | 第三方Actions：PR/分支门禁、提交信息复验、tag版本核对、自动构建/ZIP/校验值/Release/固定索引更新及dry-run；复用原格式与校验，检查失败时不发布 | ✅ 本机协议夹具及生成命令已验；真实远端发布未执行 |
| 6-05a | 开发版拓展页手动挂载多个仓外源码工程、独立监听/重载/解除，普通构建不含入口；沿ADR-0044验收 | ✅ 手动挂载、生命周期及仓外工程联调已验，随本体 `1.0.0-alpha.1` 发布。 |
| 6-05b | BN直接加载src/index.ts和依赖，拓展仅在生产打包；开发场景共用源码挂载服务 | ✅ 源码装载、预检失败保留与局部重载已验，随本体 `1.0.0-alpha.1` 发布。 |
| 6-05c | 拓展页复用Hero与横条Tab；开发挂载可浏览宿主目录，选择回填且保留草稿；目录读口沿原鉴权和生产隔离 | ✅ 片级232项、内置浏览器与全量20399项通过，随本体 `1.0.0-alpha.1` 发布。 |
| 6-05d | npm启动器运行正式/开发成品；核对与缓存产物、独立数据、离线与退出；开发产物支持源码挂载，正式隔离不变；同步作者资料 | ✅ `@bilibili-notify/bn@1.0.0-alpha.1` 已发布；真实 registry 安装后，web／dev 离线启动、独立数据与退出检查通过。 |
| 6-05e | npm作为正式渠道：完整tgz自带双宿主、首次不访问GitHub，与主程序tag同版本；独立门禁、dry-run、可信发布、重跑与渠道保护 | ✅ 首包经 Actions 暂存、主人网页批准后上架；可信发布推进 alpha，原始归档与公开包摘要一致，临时首发开关已删除。 |
| 6-05f | SDK与创建器独立手动Actions发行，默认预检、首发凭据与可信发布、精确归档/依赖顺序/重跑与渠道保护 | ✅ 首发与后续可信发布均已完成。本轮 SDK `0.1.0-alpha.1`、创建器 `0.1.0-alpha.4` 已上架；公开包、默认 SDK、仓外冻结安装与完整工程检查通过。 |
| 6-06 | 重查抖音身份、链接、作品、直播、凭据及请求限制；按需求重议Q76，确定初版和测试入口 | ✅ 调研及范围定案完成。已核对 kkk、Amagi、一次匿名真实响应及宿主现有入口。[调研与验收](douyin-source-research.md) |
| 6-07 | 给拓展开放群聊作品链接解析，接 SDK、宿主与声明范围，沿原逐群规则、回复和冷却；验证与 B 站共存 | ✅ 已实现；声明范围、停用撤销与群聊回复已验。 |
| 6-07a | 给订阅源拓展开放系统账号入口，接抖音扫码与二次验证；验证会话隔离、重扫、退出、恢复与失效 | ✅ 已验收。账号页、纯 HTTP 真机扫码、加密凭据重新装载及生命周期回归通过；2026-11-14 主人接受将未触发的真实二次验证保留为后续观察项。 |
| 6-08 | 抖音主页、账号与昵称搜人；资料、视频与图文经 ctx 进入中立链路，复用作品详情供群聊解析；验证开机基线、置顶、重复与风控恢复 | ✅ 已验收。65 项来源回归通过；昵称、主页、主页短链、作者 ID、精确抖音号、视频／图文及作品短链已真机核对，真实配图生成群聊卡片。十分钟频率两轮真实取数成功且未重复旧作；主人接受将未自然触发的新增保留观察。未知过滤分类及恢复探测已修复。 |
| 6-09 | 抖音开播/直播/下播，生命周期、重复/失联与停用收尾，沿现有场次链路 | ✅ 已验收。状态变化回归、真实在播与离线核对通过；主人接受将未自然触发的真实开／下播保留为后续观察项。 |
| 6-10 | 第二来源的资料、卡片、推送、历史、统计贯通验收；区分夹具和真实上游证据 | ✅ 已验收。正式 ZIP 的本机端到端核对历史及统计；最终构建经真实群消息入口回复视频、图文、短链三张卡片，出口仅为本机接收端。仓外正式载荷安装及冷重启通过，开发入口关闭。完整门禁 20,550 项通过，原有 3 项跳过；真实证据、合成回归及保留观察项见[抖音验收记录](douyin-source-acceptance.md)。 |
| 6-11 | 定alpha盘上格式演进、失败自愈和回退规则，按决定实现后冻结迁移基线 | ✅ 主人确认保留 alpha 数据，规则见 [ADR-0051](../adr/0051-alpha-data-evolution.md)。修复回退后再升级误选旧格式代；选代、失败恢复、通知和冻结迁移基线 6 文件 114 项通过。格式 1／修订 53／备份 23 不变，下一次实际格式变化随变更交付真实迁移。 |
| 6-12 | 首个带译文拓展上架的市场索引可选译文，打包/发布/面板与回落验收 | ✅ 已随桥和抖音上架；公开市场索引签名、四语元数据、ZIP 摘要与契约小号均已核对。隔离页面完成四语、缺译文回落与 390px 验收，console 无新增错误或警告，页面、数据和服务已收尾。 |
| 6-13 | 桥预发布版本及SDK/创建器版本拍板、兼容核对与发行准备 | ✅ 本轮版号已确认；实际 SDK、创建器与双宿主 npm 包、桥和抖音 ZIP 已生成。SDK／创建器仓外消费、BN 正式／开发宿主启动退出与本地发行预演通过；当前契约 1/2。正式更新说明已定稿，公开发行接 6-14。 |
| 6-14 | 全量门禁、自包含载荷、拓展包、迁移与流水线dry-run、CHANGELOG；版本/产物就绪后执行获批发行 | ✅ 已完成。新增首发流程回归后全量 20,619 项通过、原有 3 项跳过；正式发行的四条本体流水线、开发工具与两份官方拓展均成功，公开渠道、签名及真实安装验收通过，见下方正式发行记录。 |

## 6-04/6-05工程基建验收

2026-11-11短入口修订：主人要求create式短命令，创建器候选包改为`create-bn-ext`，对应`pnpm create bn-ext`；SDK包名保持原样。脚手架实际源码目录仍为`tools/create-extension`。缺参数的终端进入逐字段向导，原参数方式保留；非终端缺参数直接退出，输入中断前不写目录。alpha期间入口带`@alpha`，真实发行仍待审阅确认。

2026-11-10主人要求细化，定案见[ADR-0042](../adr/0042-extension-scaffold-infrastructure.md)。原稿的GitHub Actions发布模板继续保留，完整工程基建成为默认交付。

- 在仓外从实际创建器生成工程，安装后可用vp执行lint、format检查/修复、类型检查、测试、构建和打包；依赖版本、锁文件、配置和所需脚本齐全。模板有可运行的行为示例测试。
- 生成工程的Git hooks可实际执行：暂存文件不合规范、提交信息不合Conventional Commits时拒绝提交；修复后通过。首次安装的hook配置流程写进README。
- PR/分支CI用冻结锁文件安装，复验lint/format/type/test/build和提交信息；与本地共用工具配置。
- 版本tag须与根清单匹配；门禁绿后自动生成拓展ZIP及sha256/大小，先上传版本Release的包，再更新固定Release索引。失败和dry-run均不进入真实发布步骤。
- 在独立第三方仓库可运行：Actions引用的工具/脚本都随工程提供或来自已分发开发工具。README给出首次安装、开发、检查、tag、dry-run和GitHub权限配置。
- 2026-11-11补充agent资料：SDK随包AGENT_GUIDE.md和bn-extension-development skill；工程生成AGENTS.md、CLAUDE.md及Codex/Claude入口，正文共用SDK版本，指引和skill引用可在仓外读取。沿既有SDK/CLI入口验证，无新增测试入口。
- 2026-11-10主人已批准下述创建器及发布测试入口；本地生成与流程验证、真实GitHub运行/发布分开记录。

## 6-03交付与后续测试入口（2026-11-10）

仓库输入统一保存为`bn-marketplace` Release上的完整HTTPS索引地址，大小写等价的仓库来源不重复添加。设置校验与弹窗共用零依赖规则，四语校验提示已同步；完整HTTPS地址、第三方信任边界和后续安装校验沿用原流程。`.bn/marketplace.json`的版本1格式及公开仓库边界见ADR-0041。无迁移或宿主契约变更。

先验红仓库输入、固定索引大小写及不完整HTTPS地址，再逐项验绿；设置读写、市场、字典与包边界7文件201项通过，internal/contract/web/server类型4/4通过。内置浏览器在独立临时数据上验证保存、重复提示和HTTP拒绝；前后图在本地`.bn-design/s6-6-03-evidence/`，console无新增error/warning，后端无新增错误，注入为空、服务及页面已收尾。官方源在本机网络下不可达属于基线，未安装拓展。

主人已批准：实际create CLI在仓外生成工程，验证安装、vp全部门禁、Git hooks拒绝/放行及可安装拓展产物；生成工程的发布命令与Actions配置通过本机GitHub接口夹具验证tag/版本、dry-run、失败阻止发布、ZIP先上传再更新索引及重跑行为。市场沿既有设置、市场和页面入口。真实GitHub/npm发布另行确认。

## 6-02已批准的测试入口

2026-11-10主人同意“实际npm包在仓外使用”：将本地tgz装入临时工程，验证根入口、`/build`、公开类型和最小拓展构建，再由既有装包器校验发行目录；确认不依赖私有internal。

使用本地产物，不发布npm，不将本地结论扩大为账号权限或真实发布已验。按TDD逐条先红后绿；既有拓展边界、构建辅助和装包测试继续保持。

## 6-02交付（2026-11-10）

SDK源码仍从internal转出唯一契约，workspace保留实际依赖及private标记；构建内联私有实现和声明，并在`lib/`生成独立公开npm清单、说明和许可证。公开清单不带internal、开发依赖或源码脚本，zod作为公开依赖由原catalog给版本。`publishConfig.directory`让真实tgz采用该目录；公开能力和宿主API版本不变，实际npm发行版本留6-13。

原包离线安装先因私有`internal@0.0.0-dev`验红；改后仓外安装/运行与严格类型检查、构建辅助、最小来源装包校验两项通过，包含宿主设置类型不公开的检查。SDK/桥/假源类型3/3、两个消费者构建2/2、Biome4文件、SDK Knip及26文件441项相关回归通过；`vp run build:update-payload`装配与无devtools检查通过。完整命令与红绿日志见本地`.bn-design/s6-6-02-evidence/`。迁移53/备份23不变，未发布npm或推送/tag。

## 6-04交付（2026-11-10）

`@bilibili-notify/create-extension`作为第二个公开开发工具准备npm归档；两个CLI入口为`create-extension`与`bn-extension`。创建器在新目录生成独立工程、实际安装以生成锁文件，统一经vp进行lint/format/type/test/build/pack，启用自身Git hooks。`--no-git`的安装保护会跳过父仓库；无文件覆盖或自动提交。`.bn/marketplace.json`沿ADR-0041，打包复用唯一ZIP实现。SDK和工具版本仍为待发行占位，实际npm发布尚未执行。

PR/分支检查模板冻结安装后跑完整工程门禁，并复验整个提交区间（新分支含首条）；内容权限只读。版本tag发布接6-05。本地npm归档在仓外生成工程后，完整门禁与ZIP宿主接收、hooks消息/lint/format拒绝及修复后放行、父仓库隔离、生成Actions命令的提交区间检查共5项通过；连同SDK归档、ZIP与契约边界回归4文件41项通过。四包类型、创建器Knip与改动文件Biome通过。红绿与完整命令在本地`.bn-design/s6-6-04-evidence/`。

## 6-05交付（2026-11-10）

公开工具新增`release`与`check-commits`，生成tag发布/默认dry-run的Actions。PR、分支和发布复用提交规则；发布在匹配清单/本地/远端tag、干净工作区、完整vp门禁之后，先将ZIP和SHA256上传到版本草稿并公开，再切换固定索引。复用同字节资产，拒绝同版本覆盖；索引保留其他条目、渠道、API档位和撤回，不因旧tag重跑降级。候选/旧索引备份改名支持失败恢复，首次索引草稿公开失败也能重跑完成。普通验证只读，写权限只给依赖验证成功的发布作业；构建/检查子进程不带发布令牌。

SDK内附当前1/0契约作者指南，涵盖创建、生命周期、设置、上报、翻译、检查和发行；生成工程README说明`.bn/`、权限与恢复。滚动Release需保持可变，工具不调整GitHub安全设置；GitHub资产改名非原子，进程在两次改名之间中断时可能短暂不可用，需重跑完成或恢复，Actions已串行。

实际npm归档在仓外安装后，以真实CLI和生成Actions中的命令对本机GitHub协议夹具验收12项；同SDK、完整工程/Git hooks、装包、选版与边界共6文件77项通过。SDK/工具类型2/2、Knip及文件级Biome通过；源函数拆出后原索引24项保持全绿。红绿与完整命令见本地`.bn-design/s6-6-05-evidence/`。本机npm鉴权查询返回401，SDK公开版本查询为404；候选版本和真实npm发行另行确认。尚未声称真实GitHub Actions、npm权限或远端发布已验，迁移53/备份23、宿主API1/0不变。

## 开发配套全量验收（2026-11-11）

6-02至6-05的本地交付已完成。独立作者CLI位于`tools/create-extension`，workspace和Knip配置已对齐；它不进入宿主运行图，服务进程出网守卫的范围与白名单保持原样。默认并发验收中，仓外工程夹具清理曾超过默认10秒，现只给这两处集成测试的收尾留60秒，不调整行为断言或全局测试时限。

冻结离线安装、全量Biome、构建、类型、默认并发测试、CI指定的阿拉伯语格式测试和自包含更新载荷均通过。默认并发为1257文件、20380项通过，另有原有1文件/3项跳过；阿拉伯语定向5项通过。Biome仍有既有3条非空断言警告、4条提示，均在本轮未改文件；构建保留既有Web大chunk提示。命令和日志在本地`.bn-design/s6-tooling-final-gate/`。

SDK和创建器的`1.0.0-alpha.1`仅为待主人确认的候选版本，真实tgz与校验清单在本地`.bn-design/s6-tooling-release-candidate/`。候选归档已检查公开入口、两CLI、模板/hooks、作者指南及私有依赖隔离。npm鉴权仍返回401，两个包的官方公开查询均为404；这不证明包名可用或账号具备命名空间权限。发行批准、登录与真实npm消费验收尚未完成，6-13/6-14及第6期整体不记作完成。

## 本期边界

- 抖音首版的常用操作与扫码登录见 [ADR-0047](../adr/0047-douyin-source-parity.md)，礼物、粉丝团等直播互动留待后续。
- 年度总结、桥WS帧改名、devframe和driver.js试验按总计划留在alpha之后。
- 每片跑相关lint/format/type/test；出期前按CI全量验收，并补相关载荷、桌面和拓展验证。
- 进度和证据进本片表及本地交付；未决项不作为已批准方案。


## 6-05a/6-05b源码拓展开发（2026-11-11）

沿[ADR-0044](../adr/0044-extension-source-development.md)，在已启动的BN源码开发版拓展页手动挂载已安装依赖的工程。BN直接读取src/index.ts及导入依赖，沿唯一装载根和装载队列运行、监听与局部重载；拓展没有独立dev/start进程，生产才打包。多工程独立启停，预检失败保留旧实例，停用项保存不自动启用，解除和退出关闭模块环境与受管理链接。

dev-apps不启动拓展pack watcher；生产构建与Actions保留。作者、agent和共享skill说明同一流程。沿已批准的挂载HTTP、拓展页、真实装载器及SDK/拓展创建器仓外入口先红后绿；内置浏览器以无dist工程验过双挂载、启用、只改A保留B、详情更新和390px弹窗。宿主startedAt未变，console无新增错误，临时数据、挂载、页面与服务已清理。

本地红绿和原始验收证据见`.bn-design/s6-source-dev-evidence/`；当前代码的全量结论见本期最新验收记录。两份SDK/拓展创建器候选版本继续单独保留，真实npm/GitHub发布、推送、tag及本期整体发行尚未完成；迁移53、备份23、宿主API1/0不变。

## 6-05c拓展页局部统一与路径选择（2026-11-11）

按主人要求复用HeroStrip和TabBar，保留原安装/挂载动作与分类计数。目录选择放在挂载弹窗的独立步骤，浏览BN宿主的文件夹，支持上级、工作区、目录软链和清单提示；确认只回填，取消保留草稿。只读接口沿源码开发门及会话鉴权，生产不装配。四语文案及UI图标清单同步。

已批准新HTTP测试入口；目录初始404、软链漏列及选择按钮缺失均先复现再转绿。片级8文件232项、web/server/ui类型与16文件Biome通过。内置浏览器完成1280×720和390×844的分类切换、目录进入/上级/工作区、失败反馈、取消/回填，console基线与新增警告/错误均为空；没有提交挂载、注入或遗留服务。完整命令和前后图见本地`.bn-design/s6-extension-page-polish-evidence/`。

全量Biome、build、typecheck、默认并发1259文件20399项（184.76秒）、CI阿拉伯语5项、Knip和自包含载荷通过；既有1文件/3项跳过、Biome3警告/4提示与web大chunk提示不变。迁移53、备份23、宿主API1/0不变，两处npm候选版本继续单独保留；第6期未整体完成。

6-05c后续修复：目录选择与挂载表单持续复用同一个ModalShell，磨砂遮罩作为独立静止层，入场只移动卡片。沿既有拓展页与ModalShell渲染入口先红后绿，验证弹窗/遮罩身份连续、独立背景层、导航/取消/回填及Escape；39文件377项相关回归、web/UI类型、前端构建和片级Biome通过。桌面与390px内置浏览器连续导航、返回、确认及其他弹窗复验，console无新增警告或错误；本地证据在`.bn-design/s6-directory-blur-fix-evidence/`。

## 6-05d成品宿主启动器（2026-11-11）

沿ADR-0045提供`@bilibili-notify/bn`的web/dev成品入口。正式宿主沿原自包含布局；显式开发宿主保留原源码加载、目录选择和多工程局部重载，加载器作为启动器的公开npm依赖提供，私有核心不外置。运行期环境变量不能打开正式产物的开发能力；开发成品不走普通应用更新。

启动器核对固定版本/用途、大小和SHA256，原子缓存、复验缓存、支持离线；配置和持久数据独立于缓存，正式/开发默认目录分开，不自动迁入既有工作区。web沿boot选版，dev显式调用宿主入口、沿原生命周期处理信号和收尾。SDK作者/agent资料、共享skill与创建器模板已同步，宿主API1/0、迁移53、备份23不变。

新增实际npm包入口已获主人批准，下载使用本机HTTP夹具；原载荷、开发门、生产隔离与更新入口沿用。逐项验红后转绿；冻结离线安装、全量Biome/build/type、默认并发1259文件20407项（183.22秒）、阿拉伯语5项、Knip、两种真实宿主归档与最终精确包5项通过。原有1文件/3项跳过、Biome3警告/4提示与Web大chunk提示保留。

真实tgz在仓外启动web/dev，开发接口分别404/200，目录选择从调用目录起步，配置落入独立数据目录。内置浏览器1280×720和390×844验证挂载、目录回填、启用、双工程独立重载和解除；语法错误保留旧实例，修复后恢复，宿主startedAt未变。两页console无新增error/warning，后端无新增level>=50；官方市场索引不可达记为本机基线。注入、挂载、页面、临时数据及服务已清理。

红绿日志、前后图和本地启动器/宿主归档在`.bn-design/s6-bn-cli-evidence/`；SDK和create-bn-ext精确候选、SHA和审阅稿已刷新。新CLI与宿主仍是0.0.0-dev本地验收版，实际发行版本与动作留6-13/6-14确认；未发布、推送、tag或合dev。两份原有候选版本差异继续单独保留，主人查看用的两个demo及数据不动。第6期尚未整体完成。

## 6-05e包内载荷与npm发行（2026-11-11）

按ADR-0046，npm包自带web/dev两份宿主及面板，首次启动从包内解包；删除远端下载、runtime-file及offline参数，保留原子缓存、摘要复验、用途/版本校验与持久数据隔离。`build:bn-package`独立完成双宿主装配和完整tgz，普通workspace build只编译CLI，发布守卫拒绝无载荷或版本不一致的壳。

沿已批准的实际npm包入口先红后绿，6项包行为回归通过；13.9MB真实tgz在仓外安装、禁用fetch及空缓存条件下启动web/dev，开发目录接口404/200，SIGINT退出0，临时数据和服务已清理。全量Biome/build/type、1259文件20408项默认并发测试（171.17秒）、阿拉伯语5项及Knip通过；原有1文件3项跳过、Biome3警告4提示不变。

主人随后已批准新增registry夹具入口。发行命令与Actions已先红后绿接线：主程序同步版本包含npm宿主，SDK和创建器仍独立；沿门禁生成完整tgz，只有tag push的发布作业取得OIDC权限，手动dev dry-run不写registry。包先于渠道发布，同版本核对摘要、冲突拒绝覆盖，旧版本不倒退alpha/latest；HTTP失败和已提交但响应失败均不自动重传，重跑先复验再补缺失步骤。npm客户端经别名固定11.21.0，包管理仍由vp调用pnpm。

片级4文件70项通过；全量冻结离线安装、Biome/build/type、1260文件20422项默认并发测试（184.25秒）、阿拉伯语5项及Knip全绿，原有1文件3项跳过与Biome3警告4提示保持。临时源码副本复用历史说明版本完成共享版本同步、完整包构建、发行dry-run、仓外离线安装和断网启动，宿主版本一致、开发接口404/200、退出0；历史版本仅用于本机验收，未创建tag。

真实npm账号/可信发布、首发版本和实际上传仍在发行片确认；本地包0.0.0-dev仅供验收，没有发布、推送、tag或合dev。

## 开发工具首次发行准备（2026-11-12）

主人批准先独立发行`@bilibili-notify/extension@0.1.0-alpha.0`与`create-bn-ext@0.1.0-alpha.0`，使用npm的`alpha`标签。旧的`1.0.0-alpha.1`只曾是未获批候选，不再用于首发。创建器归档中的SDK与工具默认版本均已对齐为`0.1.0-alpha.0`。

两份实际tgz已检查公开清单、入口、依赖与SHA512，官方npm客户端发布dry-run通过。全量Biome、build、typecheck、1260文件20422项测试（185.09秒）、CI阿拉伯语5项及Knip通过；既有1文件3项跳过保持。版本清单已提交为`cc8225623`。

真实npm登录和组织owner权限已核对。SDK发布在npm要求的网页安全验证阶段收到验证回调404，进程已退出；重新查询未发现该包。创建器尚未上传，两包均未记作发行完成。精确归档、命令及结果在本地`.bn-design/s6-first-npm-release-2026-11-12/`。

主人随后明确改为 GitHub Actions 手动发行 SDK 与创建器。独立的 `tooling-release.yml` 采用与 base 镜像相同的手动触发方式，默认只预检，先发 SDK 再发创建器。本体 `npm-release.yml` 随本体 tag。工具首发作业使用仓库的 `NPM_TOKEN` Secret，后续使用两包各自的可信发布绑定。共用的不可变 npm 发布逻辑已在 `67b8dfd10` 抽出，原 14 项发行回归保持。

新工具发行入口验证默认只预检、单包选择、全部候选先核对、公开入口与依赖、版本/摘要、SDK依赖顺序、同号冲突、结果不明和部分成功重跑、独立版本与渠道保护。测试执行实际 Actions 步骤，核对首发凭据仅在发布步骤使用且退出清理。

本轮冻结离线安装、Biome、build、typecheck、1261文件20445项默认并发测试（180.22秒）、CI阿拉伯语5项及Knip通过，原有1文件3项跳过保持。新入口23项按9轮红绿推进，既有SDK/创建器实际仓外消费与本体发行回归保持；完整日志与精确候选在`.bn-design/s6-tooling-actions-evidence/`，早期红绿日志在`.bn-design/s6-first-npm-release-2026-11-12/`。

2026-11-12，开发历史已同步到公开 `dev`，`main` 已登记两份 npm 工作流。修复 CI 的时区用例、冷缓存和边界扫描超时后，`f394d41ef` 通过完整远端预检。本地同提交全量测试 20,458 项通过，3 项跳过。两份 Actions 发布归档与预检和本地候选逐字节相同。[远端预检](https://github.com/Akokk0/bilibili-notify/actions/runs/43171151478)

首次直接上传与更新首发凭据后的重跑均在创建 SDK 时收到 npm 的 HTTP 404。随后按主人决定改用 Actions 暂存，两份归档均通过 npm 检查。[直接上传记录](https://github.com/Akokk0/bilibili-notify/actions/runs/43173415973/job/131042334122)

主人在 npm 网页批准两包后，重跑同一发布作业，核对 SHA512 并设置各自的 `alpha` 标签。公开下载的两个 `0.1.0-alpha.0` 包与获批归档逐字节一致。[渠道更新作业](https://github.com/Akokk0/bilibili-notify/actions/runs/43183955815/job/131075720578)

仓外空目录使用 `vp dlx create-bn-ext@alpha` 创建拓展，生成工程从公共 npm 装入两个首发版本。`vp install --frozen-lockfile` 和 `vp run verify` 全部通过，产出拓展 ZIP，清单与 SHA256 校验通过。

本体 `@bilibili-notify/bn`、Docker 和 Desktop 随主程序版本发行。本体的 npm 工作流见 [npm-release.yml](../../.github/workflows/npm-release.yml)，首次本体 npm 发行仍需建立实际包并绑定可信发布。

## 6-11至6-14本轮准备（2026-11-15）

主人确认 alpha 期间保留新增数据，首次 alpha 冻结格式 1／迁移修订 53／备份 23；下一次实际格式变化才随变更交付迁移。回退与再次升级各用匹配格式的完整数据代，不自动合并。选代修复及冻结基线见 [ADR-0051](../adr/0051-alpha-data-evolution.md)。

市场索引的可选 `locales` 只覆盖名称、简介和更新说明。官方与第三方发行从已经入包的四语译文提取；宿主按当前语言、简中、英文及默认文字逐字段回落，缓存不固定展示语言。抖音实际 ZIP 的四语已核对，隔离页面验过四语切换、缺项回落与 390px 布局；关于页已核对本轮 CHANGELOG 和迁移提示。两次验收的 console 无新增错误或警告，临时页面、数据和服务均已收尾。

本轮版本由主人确认：本体／BN `1.0.0-alpha.1`、桥和 SDK `0.1.0-alpha.1`、创建器 `0.1.0-alpha.4`、抖音 `0.1.0-alpha.0`。实际 SDK／创建器 tgz 和桥／抖音 ZIP 已生成，开发工具通过真实仓外消费及发布回归。BN 在隔离源码副本临时同步版本后构建完整 13.9MB tgz；仓外离线安装、空缓存且禁用网络请求时，web／dev 均返回该版本，面板可用，开发目录接口分别为 404／200，SIGINT 退出 0 且端口释放。本体源码版本仍为 `0.0.0-dev`。

版本和更新说明定稿后的全量命令：`vp install --offline --frozen-lockfile`、`vp exec biome ci .`、`vp run build`、`vp run typecheck`、包测试缓存准备、`vp run test` 及 CI 阿拉伯语格式测试，全部通过。默认并发 1,268 文件、20,617 项通过、原有 3 项跳过，用时 187.82 秒；阿拉伯语定向 5 项通过。既有 Biome 3 条警告、4 条提示和 Web 大 chunk 提示保留。实际 BN 与开发工具归档的本地发行 dry-run 通过。

本地门禁、精确归档、校验值及发行清单位于 `.bn-design/s6-release-candidate-2026-11-15/`，市场与页面证据位于 `.bn-design/s6-alpha-marketplace-evidence/`。这是正式发行前的准备记录；随后完成的公开同步、远端预检与实际发行见下方记录。

## 6-14远端预检与修复（2026-11-15）

主人批准同步公开 dev 的 77 个提交、206 个文件改动，并运行发行 dry-run。预检发现的问题另拆成 6 个原子提交修复；最终代码提交为 `94160eaee`。全绿记录如下，已通过且内容未受后续修复影响的作业保留原结果：

| 预检 | 结果 |
| --- | --- |
| 本体版号 `1.0.0-alpha.1` | [通过，仅检查 tag](https://github.com/Akokk0/bilibili-notify/actions/runs/43690526860) |
| Docker amd64／arm64、完整／slim | [最终构建通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43694240367) |
| macOS ARM64／Windows x64 安装包 | [最终构建通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43694243187) |
| 本体完整 npm 包 | [通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43690534643) |
| 应用内更新载荷 | [构建、打包和签名通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43690537439) |
| SDK／创建器 | [两包构建与实际归档校验通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43690540174) |
| 桥拓展 `0.1.0-alpha.1` | [构建、打包和索引签名通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43692384521) |
| 抖音拓展 `0.1.0-alpha.0` | [构建、打包和四语索引签名通过](https://github.com/Akokk0/bilibili-notify/actions/runs/43692386739) |

最终代码的[全量 CI](https://github.com/Akokk0/bilibili-notify/actions/runs/43694134599)与[两端 Rust 检查](https://github.com/Akokk0/bilibili-notify/actions/runs/43694134693)均通过。CI 保留全部测试与独立迁移性能检查；四分片的测试耗时为 134／260／193／219 秒，最慢分片含安装和构建的任务耗时 311 秒。

修复均沿既有真实构建或测试入口复现并验证：Docker 上下文保留 SDK 必需说明和 skill、递归保留多语言指引；官方拓展从零构建时包含 workspace 依赖；桌面发行及 Rust 检查使用仍受支持的 macOS 15；Dock 重开日志只在 macOS 编译；进程内对拍把资料 cron 安排到运行窗口外，保留 P37 的原断言和完整驱动计数。本机 Rust 格式／clippy／20 项测试／编译检查，以及对拍 71 项、服务端类型检查通过。

Actions 的 SDK／创建器归档与本地候选逐字节相同。完整 BN npm 包为 15,555,738 字节，已在仓外离线安装并以空缓存、禁用网络请求启动 web／dev，开发接口分别 404／200，退出 0 且端口释放。它与本地包的两种程序载荷完全一致，仅构建时获取的赞助名单不同。下载的 macOS 与 Windows 便携包均核对宿主 `1.0.0-alpha.1`、布局与禁止目录；原生启动器分别为 ARM64 Mach-O 和 x64 PE，安装包大小与 SHA256 已记录。

截至本节预检结束，全部远端作业均为 `dry_run=true`：正式上传、市场及更新渠道写入已跳过，本轮三个发行 tag 均未创建。临时数据、构建副本和验收服务已收尾，精确结果与归档位于上述本地发行目录。其后的账号配置、发行授权及实际发布见下一节。

## 6-14正式发行与渠道验收（2026-11-15）

主人已授权按既定版本发布；BN 首包采用 Actions 暂存、网页批准，并允许公开 `0.0.0-stage` 占位版。SDK 与 BN 的可信发布绑定均由主人完成。本体 tag `v1.0.0-alpha.1` 指向 `0ecad18b6`，桥和抖音 tag 指向 `b7705e86b`；未重写任何发行 tag 或同号归档。

| 正式发行 | 公开结果与作业 |
| --- | --- |
| Docker `1.0.0-alpha.1` | [发行成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43701251500)。Docker Hub／GHCR 的完整与 slim 镜像均含 amd64／arm64；alpha、版本与提交标签分别指向同一对应清单。公开匿名读取及镜像配置核对通过，Docker Hub 两种 amd64 镜像真实拉取、健康版本与面板 smoke 通过。 |
| Desktop `1.0.0-alpha.1` | [发行成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43701251485)。macOS ARM64 与 Windows x64 便携包、安装包均已公开；下载后摘要、布局、宿主版本和 Windows GUI subsystem 已核对。公开 macOS 包附带的 Node 在独立数据目录离线启动、健康检查、面板与正常退出通过。 |
| BN npm `1.0.0-alpha.1` | [发行成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43701251504)。先核对暂存归档，再由主人批准；重跑原 publish 作业沿可信发布推进 alpha，`awaitingApproval: false`。公开 15,555,863 字节 tgz 与原候选摘要一致，web／dev 真实安装验收通过。临时 Actions 变量 `BN_NPM_BOOTSTRAP_TAG` 已删除。 |
| 应用内更新 `1.0.0-alpha.1` | [发行成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43701251517)。公开 alpha 清单及版本清单的内置公钥验签、载荷大小与摘要通过；清单概述、载荷内迁移提示及 GitHub 发行正文与本版 CHANGELOG 一致。 |
| SDK `0.1.0-alpha.1`／创建器 `0.1.0-alpha.4` | [可信发布成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43699141927)。两个 alpha 指针正确，公开归档与已验候选摘要一致；用公开创建器生成仓外工程，默认 SDK 正确，冻结安装及 `vp run verify` 通过。 |
| 桥 `0.1.0-alpha.1` | [发行成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43697948757)。实际 ZIP 与本地候选逐字节相同，官方市场签名及四语条目核对通过。 |
| 抖音 `0.1.0-alpha.0` | [发行成功](https://github.com/Akokk0/bilibili-notify/actions/runs/43697948878)。实际 ZIP 与本地候选逐字节相同，官方市场签名、契约 1/2 及四语条目核对通过。 |

首发支持新增两项回归，沿原 BN npm 发行入口及实际 Actions 命令先红后绿；发行共享逻辑抽出后，BN／开发工具发布及脚本布局共 72 项通过，最终源码的[全量 CI](https://github.com/Akokk0/bilibili-notify/actions/runs/43699972554)和新增流程预检均成功。各条正式发行仍分别通过共享 gate：`vp exec biome ci .`、`vp run build`、`vp run typecheck`、`vp run test --shard=<1..4>/4`，未跳过门禁。

Docker 首次门禁遇到已有历史留存测试的临时目录清理竞态：该用例启动后台清理后没有等 tracked 任务结束就删除目录，产生 `ENOTEMPTY`。同一发行提交重跑通过；产品与测试断言未修改，后续应单独修正该测试收尾。本机 vp／pnpm 对刚上架的 `@alpha` 一度仍选择旧创建器；精确版本 `vp create bn-ext@0.1.0-alpha.4` 的生成、安装和检查已验，仅为核对而在单次进程中取消发布等待期后，`@alpha` 也选到新版，未修改全局设置。

实际发布与消费证据位于 `.bn-design/s6-release-execution-2026-11-15/`。所有验收均使用隔离目录，临时进程与数据已清理；主人现用的仓外抖音挂载和日常数据未改动。第6期范围已完成，保留的真实上游观察项不冒充已触发验收。
