import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import type {
	CardSkinFallback,
	RestartAbility,
	StartupHealthDetailsResponse,
} from "@bilibili-notify/contract";
import { type CardKind, fail, type Logger, type Result } from "@bilibili-notify/internal";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ZodType } from "zod";
import { promptNounsOf } from "./ai/prompt-nouns.js";
import { createDashboardAuth } from "./auth/dashboard-auth.js";
import { createDesktopTokenAuth } from "./auth/desktop-token.js";
import { createIpRateLimiter } from "./auth/ip-rate-limit.js";
import type { SessionCodec } from "./auth/session.js";
import type { WsTicketStore } from "./auth/ws-ticket.js";
import type { BackupService } from "./backup/service.js";
import { CARD_SKINS_DIR, CardSkinStore } from "./card-skins/store.js";
import type { ChromeSource } from "./config/persist.js";
import type { ActionOutcome } from "./extensions/context.js";
import type { ExtensionEntry } from "./extensions/loader.js";
import type { Marketplace } from "./extensions/marketplace.js";
import { EXTENSION_MOUNT_PREFIX, type ExtensionMounts } from "./extensions/mount.js";
import type { ReportDiscrepancyTable } from "./extensions/report-discrepancies.js";
import type { IntegrationStore } from "./integration-store/store.js";
import { createMaidSkillReader } from "./maid-skills/reader.js";
import { MaidSkillStore } from "./maid-skills/store.js";
import { createSecretCellsReader } from "./push/connection-settings.js";
import { createAccountsRoute } from "./routes/accounts.js";
import { createAdaptersRoute } from "./routes/adapters.js";
import { createAiRoute } from "./routes/ai.js";
import { createAiSkillsRoute } from "./routes/ai-skills.js";
import { createCardsRoute } from "./routes/cards.js";
import { createCardsSkinsRoute } from "./routes/cards-skins.js";
import { createCommandsRoute } from "./routes/commands.js";
import { createConnectionsRoute } from "./routes/connections.js";
import { createDashboardSkinsRoute } from "./routes/dashboard-skins.js";
import { createExtensionsRoute } from "./routes/extensions.js";
import { createHealthRoute, healthResponse } from "./routes/health.js";
import { createHistoryRoute } from "./routes/history.js";
import { createImagesRoute } from "./routes/images.js";
import { createLibraryRoute } from "./routes/library.js";
import { createLiveRoute } from "./routes/live.js";
import { createProblemsRoute } from "./routes/problems.js";
import {
	ROUTE_NOT_FOUND_MESSAGE,
	requestErrorHandler,
	respondFailure,
} from "./routes/respond-failure.js";
import { createSessionRoute } from "./routes/session.js";
import { createSettingsRoute } from "./routes/settings.js";
import { createSourcesRoute } from "./routes/sources.js";
import { createStatsRoute, type StatsOverviewReader } from "./routes/stats.js";
import { createStatsFollowersRoute } from "./routes/stats-followers.js";
import { createSubscriptionsRoute } from "./routes/subscriptions.js";
import { type CreateSystemRouteInput, createSystemRoute } from "./routes/system.js";
import { createSystemBackupRoute } from "./routes/system-backup.js";
import { createSystemLogsRoute } from "./routes/system-logs.js";
import { createSystemUpdateRoute } from "./routes/system-update.js";
import { createTargetsRoute } from "./routes/targets.js";
import type { RouteDeps } from "./routes/types.js";
import { createWsRoute } from "./routes/ws.js";
import type { AppRuntime } from "./runtime/bootstrap.js";
import type { PuppeteerAdapter } from "./runtime/puppeteer.js";
import type { RoastRunOutcome } from "./runtime/roast-scheduler.js";
import { dataPath } from "./runtime/roots.js";
import { DASHBOARD_SKINS_DIR, SkinStore } from "./skins/store.js";
import { createMembershipTierReader } from "./subscriptions/membership-tiers.js";
import type { UpdateService } from "./update/service.js";

interface BasicAuthCredentials {
	username: string;
	password: string;
}

export interface CreateAppOptions {
	/** Optional backup/restore service; when present /api/system/backup/* is mounted. */
	backupService?: BackupService;
	/**
	 * 卡片皮肤库(ADR-0014)。**必填,而且必须与出图那头是同一家店** —— 面板、出图
	 * (pipeline 的 ImageRenderer)、卡片预览三处问的都是它。
	 *
	 * ⚠️ **从前它是可选的,缺省时自建一家读同一个目录的店** —— 那正是这段话说绝不能
	 * 发生的拓扑:面板装得进、列得出,而出图那头拿的仍是宿主传给推送链路的那一家,于是
	 * 「装了新皮肤、推送不变」,**且症状完全静默**。生产侧一直传了,所以没出过真事故;
	 * 2026-09-20 主人拍板改成必填,把那个口子焊死。没有店可传的宿主用
	 * {@link createCardSkinStore} 按 `<dataRoot>` 约定开一家。
	 */
	cardSkins: {
		store: CardSkinStore;
		/** 出图回落的账本;列表接口带上它(决策 19 的「回落必须可见」)。 */
		fallbacks?: () => CardSkinFallback[];
		/** 面板上那句「知道了」把账本翻篇。 */
		clearFallbacks?: () => void;
	};
	/**
	 * 开机装载起来的拓展。在 `index.ts` 组装(那里才知道 `<dataRoot>`)。
	 *
	 * `mounts` 是那条动态挂载点的总入口,`loaded` 是拓展页要列的那份名单。不给就当这台
	 * 机器一个拓展都没装:`/ext/*` 一律 404,拓展页空着。
	 */
	extensions?: {
		mounts: ExtensionMounts;
		loaded: () => readonly ExtensionEntry[];
		/**
		 * 某个拓展交上来的面板数据(`ctx.publishView` 核过的那份)。
		 * 没交过 / 没跑就是 undefined。
		 */
		status: (id: string) => unknown;
		/** 跑某个拓展的一个动作。拓展没在跑就是 undefined。没接 → 那一口永远 404。 */
		runAction?: (id: string, name: string) => Promise<ActionOutcome | undefined>;
		/**
		 * 某个拓展经 `ctx.settings(schema)` 交过的 zod(装载器的 `settingsSchemas()`)—— 写它的设置时
		 * 再过一道(ADR-0019 决策 35)。没在跑是 undefined。没接 → 只有清单那一道。
		 */
		settingsSchemas?: (id: string) => readonly ZodType[] | undefined;
		/** 订阅源拓展的「上报出入」记录(ADR-0019 决策 60)。没接 → 列表里哪一行都不带这一格。 */
		reportDiscrepancies?: Pick<ReportDiscrepancyTable, "list" | "clear">;
		/**
		 * 只重载这个拓展(装载器的 `swap()`,ADR-0012 决策 47)。没标着「新版等着换上」时抛,
		 * 路由把那句话原样交出去。没接 → 那一口永远 404。
		 */
		swap?: (id: string) => Promise<void>;
		/** 把还没落地的开关落实掉,再回答「现在什么状态」。见 routes/extensions.ts。 */
		settle?: () => Promise<void>;
		/**
		 * 面板上传装拓展那条路要的:装载根、在装载器那条队里改盘(写完紧跟着重扫)、以及
		 * 「这台机器重启回不回得来」。
		 */
		install?: {
			root: string;
			integrationStore: Pick<IntegrationStore, "remove">;
			changeDisk: <T>(write: () => Promise<T>) => Promise<T>;
			restartAbility: () => RestartAbility;
		};
		/** 拓展市场(ADR-0013)。没接 → 那两口 404。 */
		marketplace?: Marketplace;
	};
	/**
	 * Configured dashboard credentials. When provided, every request under
	 * `/api/*` (including `/api/health`, excluding `/api/session/*`) requires a
	 * valid `bn_session` cookie; the SPA obtains one via `POST
	 * /api/session/login`. When omitted, the dashboard is exposed without auth
	 * and the bootstrap layer logs a warning so the operator notices.
	 *
	 * Cookie-only (Q4): `Authorization: Basic` is NOT accepted — external API
	 * automation is explicitly unsupported when auth is enabled.
	 */
	basicAuthCredentials?: BasicAuthCredentials;
	/**
	 * `/api/stats/overview` 与手动锐评用的取数函数(`createStatsOverview` 的产物)。
	 *
	 * `index.ts` 建好一个、同时交给定时锐评的调度器:三处吃同一份 30 秒缓存。不传就由统计路由自建一个
	 * (路由测试);生产里不传的话缓存就不共用了,所以 `index.ts` 必须传。
	 */
	statsOverview?: StatsOverviewReader;
	/**
	 * 立刻跑一轮 —— 面板上的「试一次」。带订阅 id 跑那条订阅的单人锐评(两支都行),不带跑榜单。
	 * 由 `index.ts` 交给调度器;不传就是「还没就绪」,端点回 503。
	 */
	runRoastNow?: (subscriptionId?: string) => Promise<RoastRunOutcome>;
	/**
	 * Session codec used to sign/verify the `bn_session` cookie. Must be
	 * provided exactly when `basicAuthCredentials` is — `index.ts` builds it
	 * from the runtime key provider (HKDF) + the same credentials.
	 */
	sessionCodec?: SessionCodec;
	/**
	 * 面板改账号密码的写口(`PUT /api/session/credentials`):把新凭据写回配置文件,写不了回失败。
	 * 不给 = 这个部署改不了(桌面版、没开登录的)。
	 */
	changeCredentials?: (creds: BasicAuthCredentials) => Promise<Result>;
	/**
	 * Optional puppeteer-core adapter for /api/cards/preview. When null (no
	 * BN_CHROME_PATH configured) the cards route still mounts but reports 503
	 * with an actionable hint.
	 */
	puppeteer?: PuppeteerAdapter | null;
	/**
	 * Persist the runtime-selected browser source (chromePath / chromeEndpoint)
	 * back to the bootstrap yaml so card rendering stays enabled across
	 * restarts. Wired by index.ts (bound to the config path); omitted in
	 * deployments without a writable config file.
	 */
	persistChromeSource?: (source: ChromeSource) => Promise<void>;
	/**
	 * Notified after POST /api/cards/renderer hot-enables rendering, so
	 * index.ts can update its global puppeteer reference for graceful dispose.
	 */
	onPuppeteerEnabled?: (puppeteer: PuppeteerAdapter) => void;
	/**
	 * Idle auto-close budget (ms) for adapters built by the hot-enable path,
	 * mirroring bootstrap.chromeIdleSeconds. Unset = adapter default.
	 */
	chromeIdleTimeoutMs?: number;
	/**
	 * Browser source that was actually used to build `puppeteer` at boot
	 * (endpoint wins over path). Feeds GET /api/cards/renderer.
	 */
	chromeSource?: ChromeSource;
	/**
	 * Optional directory containing the built React dashboard (`web/dist`). When
	 * set, non-`/api/*` paths fall through to a static file server backed by
	 * this directory, with `index.html` as the SPA fallback for unknown routes.
	 * When omitted, the server is API-only (matches dev mode where vite serves
	 * the dashboard separately).
	 */
	staticDir?: string;
	/**
	 * WS ticket store. Mounted on `POST /api/ws/ticket` so the dashboard can
	 * exchange basic-auth for a one-shot ticket before opening the WebSocket.
	 * Pass null when basicAuthCredentials is omitted (no ticket needed).
	 */
	wsTicketStore?: WsTicketStore | null;
	/**
	 * Origin allow-list (same `auth.allowedOrigins` the WS upgrade gate uses).
	 * When non-empty, the unguarded `POST /api/session/{login,logout}` routes
	 * additionally require a whitelisted `Origin` (defence-in-depth vs.
	 * cross-site abuse). Empty/unset → no Origin enforcement.
	 */
	allowedOrigins?: readonly string[];
	/** Desktop launcher local token gate. When set, /api/* requires x-bn-desktop-token. */
	desktopToken?: string;
	/**
	 * 私聊指令注册表。settings PATCH 用它查别名冲突,`GET /api/commands` 用它
	 * 把「你可以在私聊里敲这些」列给面板 —— 注册表是可序列化的声明,这两件事都是
	 * 白拿的,不必再手写一份指令清单(手写的那份必然与实现脱节)。
	 */
	commands?: RouteDeps["commands"];
	/**
	 * 连接 `settings` 下发打码的查表(适配器的 schema 标记 + 拓展声明的密钥键),与备份脱敏同一份。
	 * 省略 → 只问登记表里的适配器、拓展声明的键一个都问不出来。
	 */
	connectionSecrets?: RouteDeps["connectionSecrets"];
	/**
	 * 自主升级。由 index.ts 构建(它才知道版本目录在哪、怎么优雅地关掉自己)并注入,
	 * 省略 → 整条 `/api/system/update` 不挂载,面板拿到 404 就当功能不存在。
	 */
	update?: {
		service: UpdateService;
		/** 优雅停机 + 退出,让进程管理器把新版本拉起来。 */
		startedAt: string;
		applyUpdate: () => Promise<void>;
	};
	/**
	 * 系统级动作(现在只有「重启一下」)。同样由 index.ts 构建 —— 只有它知道怎么优雅地
	 * 关掉自己,以及这台机器上退了之后有没有人拉。省略 → `/api/system` 不挂载。
	 */
	system?: CreateSystemRouteInput;
	/**
	 * devtools(造状态 / 造事件)的 `/api/dev` 子应用,由 `devtools/index.ts` 建好交过来。
	 * 这里**只收一个 Hono**、不 import 任何 devtools 模块:整套 devtools 只从 `src/index.ts`
	 * 那一处引,构建时把那个入口换成空桩,整棵树就从产物里消失(构建后自检会 grep 一遍)。
	 * 省略 → 不挂载、404 —— 发出去的构建里不该向外承认有这么个口。
	 */
	devtools?: Hono;
}

/**
 * 按约定开一家卡片皮肤店:`<dataRoot>/card-skins`。**这个目录名只声明在这一处** ——
 * 宿主与测试共用它,两边各抄一份字面量迟早会漂。
 *
 * 目录叫 `card-skins` 而不是 `skins`:与隔壁 dashboard 皮肤分开 —— 两种包长得像
 * (都是 zip + 一份 JSON),混在一个目录里 init 会互相报「格式不对」。
 *
 * ⚠️ 开一家**不等于**可以随手开:全进程只该有一家(见 `CreateAppOptions.cardSkins`)。
 * 这个函数是给「还没有店的那个宿主」用的,不是给已经有店的调用方再开一家。
 */
export function createCardSkinStore(dataRoot: string): CardSkinStore {
	return new CardSkinStore({ dir: dataPath(dataRoot, ...CARD_SKINS_DIR) });
}

/**
 * Build the top-level Hono app. 路径按资源排(ADR-0036):顶层是资源,只属于某个资源的东西才下沉。
 *   /api/health           — liveness (short,四格)
 *   /api/health/details   — 健康卡的数据(各模块开没开、核心包版本、配置分区)
 *   /api/settings         — GET / PATCH
 *   /api/subscriptions    — GET / POST / PATCH /:id / DELETE /:id(+ tags)
 *   /api/targets          — GET / POST / PATCH /:id / DELETE /:id / POST /:id/test
 *   /api/ai/skills        — 女仆技能(离开 AI 聊天没有意义,下沉在 /api/ai 底下)
 *   /api/cards/skins      — 卡片皮肤库(与出卡同一个前缀;截图口 /:id/screenshot 在 cards 路由里)
 *   /api/dashboard/skins  — 面板皮肤库
 *   /api/stats/followers  — 粉丝样本(只喂统计)
 *   /api/images/:ref      — 图库的同源读口(只读;历史、订阅、AI 共用的顶层资源)
 *   /api/system/*         — 日志(一直挂)、更新 / 备份 / 重启与开新代(宿主传了才挂)
 *   /api/sources          — 来源表(GET,每个来源的描述符与能力)
 *   /api/sources/:sourceKey/auth — 来源的登录口(GET 读 / POST 发起扫码 / DELETE 退出)
 *   /api/sources/:sourceKey/creators — 新建订阅时在这个来源里搜人(GET ?q=)
 *   /api/problems         — 问题表(各集成报上来的「主人该知道的事」,GET 一次给全)
 *   /api/ws/ticket        — 面板 WS 的一次性票(无条件挂)
 */
export function createApp(runtime: AppRuntime, options: CreateAppOptions): Hono {
	const deps: RouteDeps = {
		runtime,
		store: runtime.configStore,
		connectionSecrets:
			options.connectionSecrets ?? createSecretCellsReader(runtime.adapterRegistry),
		puppeteer: options.puppeteer ?? null,
		wsTicketStore: options.wsTicketStore ?? null,
		commands: options.commands,
	};
	// 会员档位读口:每次现读来源登记表。
	const tiers = createMembershipTierReader(runtime.sourceRegistry);

	return createAppShell(runtime.serviceCtx.logger, options, (app) => {
		app.route(
			"/api/health",
			createHealthRoute(deps, {
				extensions: () => options.extensions?.loaded() ?? [],
				settle: options.extensions?.settle,
			}),
		);
		app.route("/api/settings", createSettingsRoute(deps));
		app.route("/api/commands", createCommandsRoute(deps));
		app.route(
			"/api/subscriptions",
			// 新建拓展订阅要核「它是不是装着的订阅源」—— 与拓展页同一份名单,现取。
			createSubscriptionsRoute(deps, { extensions: () => options.extensions?.loaded() ?? [] }),
		);
		app.route("/api/connections", createConnectionsRoute(deps));
		app.route("/api/targets", createTargetsRoute(deps));
		app.route("/api/live", createLiveRoute(deps));
		app.route("/api/history", createHistoryRoute(deps));
		// 图库被历史、订阅、AI 共用,是顶层资源(ADR-0036 决策 5 下 10-03 的 🔗)。
		app.route("/api/images", createImagesRoute(deps));
		app.route("/api/library", createLibraryRoute(deps));
		// `/api/system` 是这一个实例自己的事(ADR-0036):日志一直挂着;更新、备份、重启与开新代
		// 宿主传了才挂(见下面各自的 `if`)—— 各个口原来挂不挂的条件照旧,只是并进了一个前缀。
		app.route("/api/system/logs", createSystemLogsRoute(deps));
		// 皮肤库一份两处用:`/api/dashboard/skins` 是它的主场,聊天路由拿它挂 `create_skin`
		// (「女仆,做套皮肤」)。两处必须是**同一个实例** —— 各 new 一个的话,内存
		// 索引各存各的,聊天里刚做好的皮肤在皮肤页上要等到重启才出现。
		const skinStore = new SkinStore({
			skinsDir: dataPath(runtime.dataRoot, ...DASHBOARD_SKINS_DIR),
		});
		// 技能库同样一份两处用:`/api/ai/skills` 是编辑器那一端,聊天路由拿它挂
		// `load_skill`。盘上目录特意叫 `maid-skills` 而不是 `skills` —— 它跟隔壁的
		// `skins` 只差一个字母,而这是主人要亲手往里放文件的地方。
		const skillStore = new MaidSkillStore({
			dir: dataPath(runtime.dataRoot, "maid-skills"),
			reservedNames: () => runtime.aiToolProviders.skills().map((skill) => skill.name),
		});
		const skillReader = createMaidSkillReader({
			store: skillStore,
			providers: runtime.aiToolProviders,
			logger: runtime.serviceCtx.logger,
			nouns: () => promptNounsOf(deps)(),
		});
		// 女仆技能只给 AI 聊天用、离开它没有意义,所以下沉在 `/api/ai` 底下(ADR-0036 决策 1)。
		app.route(
			"/api/ai/skills",
			createAiSkillsRoute({ skillStore, skillReader, aiToolProviders: runtime.aiToolProviders }),
		);
		// 卡片皮肤库(ADR-0014)。**只用传进来的那一家**,这里不 `new`(理由见
		// `CreateAppOptions.cardSkins`)。读盘推迟到首个请求(createApp 是同步装配),
		// 凭据记在店上,见 `ensureReady`。
		const cardSkinStore = options.cardSkins.store;
		/**
		 * 卡片工坊 `look_card` 的截图口。握着 Chrome 的是 `/api/cards`,而它装配在聊天路由之后 ——
		 * 这里先放一个晚绑定的口子,卡片路由建好时把真的交进来(见 `onSkinShot`)。
		 */
		let shootCardSkin: ((skinId: string, kind: CardKind) => Promise<string | null>) | null = null;
		app.route(
			"/api/ai",
			createAiRoute(deps, {
				skinStore,
				skillReader,
				// 与 `/api/cards/skins` 同一家店:工坊做出来的皮肤,皮肤页当场就看得见。
				cardSkinStore,
				cardSkinShot: (skinId, kind) => shootCardSkin?.(skinId, kind) ?? Promise.resolve(null),
			}),
		);
		// 粉丝样本只喂统计与首页的统计卡,所以是统计的子路由(ADR-0036)。
		app.route("/api/stats/followers", createStatsFollowersRoute(deps));
		app.route(
			"/api/stats",
			createStatsRoute(deps, {
				...(options.statsOverview ? { overview: options.statsOverview } : {}),
				...(options.runRoastNow ? { runRoastNow: options.runRoastNow } : {}),
			}),
		);
		// 适配器表、新建连接的候选与扫码建连接;拓展的适配器照装载器那张表列。
		app.route(
			"/api/adapters",
			createAdaptersRoute(deps, {
				extensions: () => options.extensions?.loaded() ?? [],
				settle: options.extensions?.settle,
			}),
		);
		app.route("/api/accounts", createAccountsRoute(deps, options.extensions?.settle));
		// 来源表与来源的登录口;无条件挂,来源在不在、有没有登录口由路由现问登记表。拓展的来源照装载器那张表列。
		app.route(
			"/api/sources",
			createSourcesRoute(deps, {
				extensions: () => options.extensions?.loaded() ?? [],
				settle: options.extensions?.settle,
				// 热读:pipeline 是后挂的;搜人走推送链路那道共用的来源串行闸。候选头像引用从图库读回。
				searchCreators: async (sourceKey, query) =>
					deps.runtime.pipeline?.searchCreators(sourceKey, query),
				images: deps.runtime.imageStore,
			}),
		);
		// 问题表的读口:各集成报上来的问题,一次给全。
		app.route("/api/problems", createProblemsRoute(deps));
		// 面板那一侧的拓展口。URL 面用短词 `ext`(ADR-0012 决策 38),代码面照旧全称。
		app.route(
			"/api/ext",
			createExtensionsRoute({
				store: deps.store,
				extensions: () => options.extensions?.loaded() ?? [],
				status: (id) => options.extensions?.status(id),
				runAction: async (id, name) => options.extensions?.runAction?.(id, name),
				settingsSchemas: (id) => options.extensions?.settingsSchemas?.(id),
				reportDiscrepancies: options.extensions?.reportDiscrepancies,
				// 设置写进去了 → bus → WS `state` 频道一帧 → 面板按 id 失效设置与视图。只带 id:设置里有密钥。
				settingsChanged: (id) =>
					runtime.bus.emit("extension-settings-changed", { extensionId: id }),
				swap: options.extensions?.swap,
				settle: options.extensions?.settle,
				install: options.extensions?.install,
				marketplace: options.extensions?.marketplace,
			}),
		);
		// 面板皮肤库。「谁的」放前面(`/api/cards/skins` 同一个写法),也对上盘上的 `skins/dashboard/`。
		app.route(
			"/api/dashboard/skins",
			createDashboardSkinsRoute({
				skinStore,
				// 热读:pipeline 是后挂的,`/:id/ai` 每次现取,不做快照。
				commentary: () => runtime.pipeline?.commentary ?? null,
			}),
		);
		// `/api/cards` 与 `/api/cards/skins` 共一个前缀、各管各的口:`POST /api/cards/skins/:id/screenshot`
		// 的处理函数在 cards 路由里(握着 Chrome 的是它),其余 `/api/cards/skins/*` 归皮肤库那条。
		// 先挂 cards,截图口就由它直接认领,不绕进皮肤库那条的读盘中间件(与从前它不经过皮肤库路由一致);
		// 皮肤库那头的中间件只读盘再 `next()`,所以顺序反过来也不会错 —— 接线守卫钉着两边都挂着。
		app.route(
			"/api/cards",
			createCardsRoute({
				deps,
				puppeteer: options.puppeteer ?? null,
				persistChromeSource: options.persistChromeSource,
				onPuppeteerEnabled: options.onPuppeteerEnabled,
				chromeIdleTimeoutMs: options.chromeIdleTimeoutMs,
				initialChromeSource: options.chromeSource,
				// 预览自己建一个 ImageRenderer(样式烤进 config),皮肤得问同一家店 ——
				// 否则「预览是这套皮肤、推出去是另一副样子」。
				cardSkins: cardSkinStore,
				onSkinShot: (shoot) => {
					shootCardSkin = shoot;
				},
			}),
		);
		app.route(
			"/api/cards/skins",
			createCardsSkinsRoute({
				store: cardSkinStore,
				config: deps.store,
				logger: runtime.serviceCtx.logger,
				fallbacks: options.cardSkins.fallbacks,
				clearFallbacks: options.cardSkins.clearFallbacks,
				// 同 dashboard 皮肤库:热读,pipeline 是后挂的。
				commentary: () => runtime.pipeline?.commentary ?? null,
				// 会员卡示例用的档:读口每次现读来源登记表,来源后登记也读得到。
				membershipTier: () => tiers.lowest(),
			}),
		);
		// 面板 WS 的一次性票。无条件挂(它只依赖 `deps`)。要登录才给,所以**不能**放进
		// `/api/session` 底下(那里免 cookie 闸,ADR-0036 决策 3)。
		app.route("/api/ws", createWsRoute(deps));

		// Backup/restore. Built in index.ts (needs the cookie store + a live re-login
		// hook from the auth system) and injected, so app.ts stays decoupled from
		// auth internals and the route only mounts when a service is provided.
		if (options.backupService) {
			app.route("/api/system/backup", createSystemBackupRoute({ service: options.backupService }));
		}

		// 自主升级。同 backup:在 index.ts 组装(需要版本目录与停机钩子)后注入,
		// app.ts 不必知道进程怎么关。
		if (options.update) {
			app.route("/api/system/update", createSystemUpdateRoute(options.update));
		}

		if (options.system) {
			app.route("/api/system", createSystemRoute(options.system));
		}

		// devtools。同样在 index.ts 组装(那里才知道载荷版本)后注入;不给就不挂。
		if (options.devtools) {
			app.route("/api/dev", options.devtools);
		}

		// 拓展的动态挂载点。**刻意不在 `/api/*` 底下** —— 上面那道 dashboard 鉴权中间件是按
		// `/api/*` 挂的,而拓展的对家(桥、回调)手里只有一条 URL、没有会话。谁能进来由拓展
		// 自己在 handler 里判。面板要的数据走 `/api/ext/:id/status`,那条才吃得到会话鉴权。
		if (options.extensions) {
			app.route(EXTENSION_MOUNT_PREFIX, options.extensions.mounts.route);
		}
	});
}

/**
 * 开机那一段的 app:listen 之后、数据与推送链路起来之前由它应答(ADR-0022 决策 2)。健康检查(短版)
 * 照答,详情口交开机阶段与进度;别的 `/api/*` 与拓展挂载点一律 503 `unavailable`;面板照常加载、照常能登录。
 * 数据段做完,index.ts 把请求切到 {@link createApp} 建的完整 app。
 */
export function createStartupApp(
	runtime: AppRuntime,
	options: AppShellOptions & { message: () => string; details: () => StartupHealthDetailsResponse },
): Hono {
	return createAppShell(runtime.serviceCtx.logger, options, (app) => {
		app.get("/api/health", (c) => c.json(healthResponse()));
		app.get("/api/health/details", (c) => c.json(options.details()));
		app.all("/api/*", (c) => respondFailure(c, fail("unavailable", options.message())));
		app.all(`${EXTENSION_MOUNT_PREFIX}/*`, (c) =>
			respondFailure(c, fail("unavailable", options.message())),
		);
	});
}

/** 开机两段共用的那几样:鉴权闸、面板静态资源。 */
export type AppShellOptions = Pick<
	CreateAppOptions,
	| "staticDir"
	| "desktopToken"
	| "basicAuthCredentials"
	| "sessionCodec"
	| "changeCredentials"
	| "allowedOrigins"
>;

/**
 * 两段开机共用的外壳(ADR-0022 决策 2 下的 🔗):出错处理、SPA 兜底、nosniff、桌面令牌、
 * 会话路由、看板鉴权在前,`mountRoutes` 挂的路由在中间,静态面板在最后。开机那一段的 app 与
 * 完整的 app 都从这里建 —— 鉴权闸各写一份的话,迁移窗口里就会冒出「健康检查不用登录」这种差。
 */
function createAppShell(
	logger: Logger,
	options: AppShellOptions,
	mountRoutes: (app: Hono) => void,
): Hono {
	const app = new Hono();

	// 全局出错处理(ADR-0026 决策 2、6):抛错只留给 bug,这里接住 —— 原始错误进错误日志,
	// 客户端只拿一句固定的话。统计子路由因为会被进程内直接 `request`,自己也挂着同一份。
	app.onError(requestErrorHandler(logger));

	// SPA fallback — when staticDir is configured, any non-`/api/*` GET that
	// reaches notFound is treated as a client-side route and served the
	// dashboard's index.html. The static middleware below picks up real assets
	// (js/css/png/etc.) before this runs. API routes always return JSON 404 so
	// that fetch errors stay machine-readable.
	const indexHtml = options.staticDir ? loadIndexHtml(options.staticDir) : null;
	app.notFound((c) => {
		if (indexHtml && c.req.method === "GET" && !c.req.path.startsWith("/api/")) {
			return c.html(indexHtml);
		}
		return respondFailure(c, fail("not_found", ROUTE_NOT_FOUND_MESSAGE));
	});

	/**
	 * `X-Content-Type-Options: nosniff`,一个口管住整片 API。
	 *
	 * 四条路在发**主人上传的字节**:皮肤包资产(壁纸 + 自带字体)、聊天附件、卡片
	 * 背景图、卡片字体。它们各自都声明了正确的 content-type,但没有这个头时浏览器
	 * 仍保留自行嗅探的余地 —— 而皮肤包是可以从外部导入的 zip,里头的字节不是我们
	 * 写的。真被嗅成 HTML,那就是一个长在 API 同源上的存储型 XSS。
	 *
	 * **挂在中间件而不是各条路由自己写**:五处散着写,第六条上传路由必然会忘。
	 *
	 * **只管 /api/*,不往静态面板扩**:那边是我们自己的构建产物、不是攻击面,而
	 * nosniff 会让浏览器严格照 content-type 办事 —— 万一 Hono 的 mime 表认不出某个
	 * 构建产物,换来的是整块面板不加载。风险收益不对等。
	 *
	 * 注册在鉴权闸**之前**:401/403 那些响应也照样带上。
	 */
	app.use("/api/*", async (c, next) => {
		await next();
		c.res.headers.set("X-Content-Type-Options", "nosniff");
	});

	if (options.desktopToken) {
		app.use("/api/*", createDesktopTokenAuth(options.desktopToken));
	}

	// Session control plane — mounted outside the cookie gate. Login can't require
	// being logged in; `GET /api/session` is the SPA boot probe; logout must
	// work with a stale cookie. The desktop-token gate, when enabled, still
	// wraps these local-launcher routes. The IP token-bucket guards login.
	const loginRateLimiter = createIpRateLimiter({
		onEvent: (event) => {
			if (event.type === "blocked") {
				logger.warn(`session-login ip=${event.ip} blocked retryAfterMs=${event.retryAfterMs}`);
			} else if (event.type === "failure" && event.failures >= 3) {
				logger.warn(`session-login ip=${event.ip} failures=${event.failures}`);
			}
		},
	});
	app.route(
		"/api/session",
		createSessionRoute({
			codec: options.sessionCodec,
			...(options.changeCredentials ? { changeCredentials: options.changeCredentials } : {}),
			rateLimiter: loginRateLimiter,
			allowedOrigins: options.allowedOrigins,
		}),
	);

	// Fail-closed invariant: creds ⟺ codec. Having exactly one set would
	// silently skip the gate below and expose /api/* — refuse to build instead.
	if (!!options.basicAuthCredentials !== !!options.sessionCodec) {
		throw new Error("createApp: basicAuthCredentials and sessionCodec must be provided together");
	}

	// Cookie-session gate over the rest of /api/* (Q4: cookie-only, no Basic,
	// no WWW-Authenticate). Skipped entirely when auth is unconfigured —
	// bootstrap already did the fail-closed / loopback check. The middleware
	// internally exempts /api/session/*.
	if (options.basicAuthCredentials && options.sessionCodec) {
		app.use("/api/*", createDashboardAuth(options.sessionCodec));
	}

	mountRoutes(app);

	// Static dashboard. Mounted last so /api/* always wins routing. The cookie
	// gate (when configured) applies only to /api/*; the dashboard shell stays
	// reachable so the SPA can boot, probe `GET /api/session`, and render its
	// own login dialog. Dashboard assets are non-secret.
	if (options.staticDir) {
		// 缓存策略:serveStatic 默认只发 Last-Modified,浏览器按启发式缓存旧
		// index.html/JS —— 镜像更新后 API 已是新版而面板仍从缓存跑旧 bundle。
		// Vite 的 /assets/* 文件名含内容 hash → immutable 永久缓存;其余入口
		// (index.html / public 文件 / SPA fallback)no-cache 每次回源确认。
		// /api/* 命中路由后早已终结,只有落到 notFound 的才在这里排除。
		app.use("/*", async (c, next) => {
			await next();
			if (c.req.path.startsWith("/api/")) return;
			c.res.headers.set(
				"Cache-Control",
				c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
			);
		});
		app.use("/*", serveStatic({ root: options.staticDir }));
	}

	return app;
}

function loadIndexHtml(staticDir: string): string | null {
	try {
		return readFileSync(joinPath(staticDir, "index.html"), "utf8");
	} catch {
		return null;
	}
}
