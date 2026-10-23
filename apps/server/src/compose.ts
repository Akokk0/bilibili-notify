/**
 * 组装根:整个核心里只有这个文件登记内置集成。只放登记与开发场景的过渡接线,不长别的逻辑。
 *
 * 今天它做三件事:认领 B 站那组开发场景(`provideDevtools`);造 B 站来源并登记(`registerSources`,
 * 登记即启动);造三个内置平台适配器(OneBot / QQ 官方机器人 / webhook)并登记(`registerAdapters`,
 * 登记即启动)。`status` 指令的「上次抓取」不从这里取:它读登记表里各来源自己说的那一行(`Source.health()`)。
 * 来源的上下文仍由登录那套建好递进来(`integration`),这里不另开存储;适配器各有各的存储与上下文,
 * 由 `registerBuiltinAdapters` 按适配器键开。
 *
 * 核心里只有这个文件能 import `platforms/`(`scripts/__tests__/import-boundaries.test.mjs` 钉着);
 * 入口与推送链路只认 `PlatformAdapter` 接口。
 *
 * 「挑订阅」那一段是随开发场景的过渡接线一起留着的。
 *
 * 带 `devtools/` 的模块说明符在这里只许 B 站 devtools 的入口一个
 * (`devtools-isolation` 钉着,注释里也别加引号写它):构建时它被换成恒空的桩。
 */

import {
	BILIBILI_SOURCE_KEY,
	type Connection,
	type Disposable,
	type InboundHandlers,
	type IntegrationContext,
	type Logger,
	type MessageBus,
	type ServiceContext,
	type SourceAuth,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import {
	type BiliDevtoolsDeps,
	createBiliDevtools,
	type DevtoolsProviderRegistry,
} from "./bilibili/devtools/index.js";
import { createProblemLayers } from "./bilibili/problem-layers.js";
import { settingsSegment } from "./bilibili/settings.js";
import { type BiliSource, createBiliSource } from "./bilibili/source.js";
import type { IntegrationSettingsSegment } from "./config/store.js";
import type { LocaleReader } from "./i18n/locale-reader.js";
import type { ImageWriter } from "./images/image-store.js";
import type { IntegrationStore } from "./integration-store/store.js";
import { createOnebotAdapter, onebotSettingsSegment } from "./platforms/onebot.js";
import { createQQOfficialAdapter, qqOfficialSettingsSegment } from "./platforms/qq-official.js";
import { createWebhookAdapter, webhookSettingsSegment } from "./platforms/webhook.js";
import {
	type BuiltinAdapters,
	type RegisterBuiltinAdaptersOptions,
	registerBuiltinAdapters,
} from "./push/builtin-adapters.js";
import type { PlatformAdapterRegistry } from "./push/registry.js";
import type { EnginesRuntime } from "./runtime/engines.js";
import type { NodeServiceContext } from "./runtime/service-context.js";
import type { SubRuntimeStore } from "./runtime/sub-runtime-store.js";

/**
 * 各内置集成的设置段:建运行时(配置仓)时交进去,段在配置仓构造期定死,所以是模块级常量、不在
 * `composeBuiltinIntegrations` 里。每个拿到集成上下文的内置集成一段:B 站,加三个内置适配器(后三段没有任何格)。
 */
export const BUILTIN_INTEGRATION_SETTINGS: readonly IntegrationSettingsSegment[] = [
	settingsSegment,
	onebotSettingsSegment,
	qqOfficialSettingsSegment,
	webhookSettingsSegment,
];

export interface BuiltinIntegrationsDeps {
	/** 套了壳的 `Api` 与登录系统(壳在入口建)。来源拿 `api.api`,场景拿壳本身:只进这一次,两头不可能接成两个对象。 */
	api: BiliDevtoolsDeps["api"];
	auth: BiliDevtoolsDeps["auth"];
	/** 当前语言的读口(入口造一份):内置集成的问题句在语言变了时按新语言重报,递给分层上报器与 B 站来源。 */
	locale: LocaleReader;
	/** B 站集成的上下文(`AuthSystem.integration`)。 */
	integration: IntegrationContext;
	/** 登录口(`AuthSystem.auth`,真的那一份):挂到 B 站来源的 `auth` 上,登记表与 `/api/sources/:sourceKey/auth` 读它。 */
	sourceAuth: SourceAuth;
	bus: MessageBus;
	/**
	 * 定时的登录检查的开关(`AuthSystem.setHealthCheckMs`,现转:登录系统在入口里是个会清掉的 let)。来源 `start` 里读了
	 * B 站设置、按它挂上或停下;登录系统自己不读设置。
	 */
	setHealthCheckMs: (ms: number) => void;
	/** 开发场景挑订阅用,现读。 */
	subscriptions: Pick<SubscriptionStore, "list">;
	subscriptionRuntime: Pick<SubRuntimeStore, "get" | "patch">;
	setTimeout: ServiceContext["setTimeout"];
	/** 登录心跳建得比这里晚,现取,原样转给 B 站开发场景。 */
	healthCheck: BiliDevtoolsDeps["healthCheck"];
	/**
	 * 三个内置平台适配器要的东西。运行时(`createAppRuntime`)开机就建好了,所以和上面一样构造时给齐:
	 * 适配器在 `composeBuiltinIntegrations` 里就造出来(工厂只往 `serviceCtx` 挂一个关停兜底,不连网、不开监听),
	 * 关停钩子的登记时刻因此与从前入口里造它们那一刻一致;登记即启动的那一步仍在 `registerAdapters`。
	 */
	serviceCtx: ServiceContext & Pick<NodeServiceContext, "forSubsystem">;
	/** 图库「集成在途」那一家的写口(`AppRuntime.transitImages`):内置适配器与假来源的 `ctx.fetchImage` / `ctx.storeImage` 经它。 */
	transitImages: Pick<ImageWriter, "put">;
	/**
	 * 入站两路出口(下一层)。指令处理器要等引擎与调度器建好才有,所以是入口先留好的可后填引用,现转。
	 * 各适配器经自己的 `ctx.inbound` 交来,宿主核过归属、补上平台后才到这里。
	 */
	inbound: Required<InboundHandlers>;
	/** 按 id 取一条连接 —— 入站校验归属的热路径用(全表那口每问一次深拷一遍)。 */
	connection?: (connectionId: string) => Connection | undefined;
	/** 活的适配器登记表(拓展与内置共用的那一张)。 */
	adapterRegistry: PlatformAdapterRegistry;
	/** 各适配器的 state / secrets 存储。 */
	integrationStore: Pick<IntegrationStore, "open">;
	/** 问题表的写口(`AppRuntime.problems`):各适配器集成上下文的 `reportProblem` 记到这里。 */
	problems: RegisterBuiltinAdaptersOptions["problems"];
	/** 按集成键要设置的读法(入口造一次):各适配器的集成上下文读自己那一段。 */
	settingsOf: RegisterBuiltinAdaptersOptions["settingsOf"];
	/** 全部连接,现读。 */
	connections: () => readonly Connection[];
	/** 「连接配置动过了」的订阅(内置适配器与拓展装载器共用)。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
}

export interface BuiltinIntegrations {
	/** `createDevtools` 的 `provide` 回调里调:过了开发版那两道门才会走到,把 B 站那组场景按来源键认领进去。 */
	provideDevtools(providers: Pick<DevtoolsProviderRegistry, "claim">): void;
	/** 引擎建好之后调一次:造 B 站来源并登记(登记即 start)。调第二次就抛。 */
	registerSources(engines: Pick<EnginesRuntime, "registerSource">): Promise<void>;
	/**
	 * `createEngines` 之前调一次:依次登记 OneBot、QQ 官方机器人、webhook 三个内置适配器(登记即 `start`),
	 * 交回的 `dispose` 由调用方挂到关停钩子上(逐个撤登记再关存储;幂等)。登记途中任一个抛了,已登记的先收回,
	 * 错原样抛出去。一次性:调第二次就抛,登记途中抛了也不复位(不给重来)。
	 */
	registerAdapters(): Promise<BuiltinAdapters>;
}

export function composeBuiltinIntegrations(deps: BuiltinIntegrationsDeps): BuiltinIntegrations {
	// B 站的代码(上报器、来源)日志行都跟 B 站那一格(与登录系统拿到的是同一个日志器)。
	const biliLogger = deps.serviceCtx.forSubsystem(BILIBILI_SOURCE_KEY, BILIBILI_SOURCE_KEY).logger;
	// B 站分层上报器:先造、来源登记之后才接上核心(`BiliSource.start` 里接)。给来源与给入口读的是同一个。
	const problems = createProblemLayers({
		auth: deps.sourceAuth,
		logger: biliLogger,
		locale: deps.locale,
	});
	deps.integration.onDispose(() => problems.dispose());
	let source: BiliSource | undefined;
	// 登记过(含登记途中)就不许再来一次;造来源或登记任一步抛了都会复位。
	let registering = false;
	const dynamic = () => source?.dynamic();
	// 每个适配器是一个集成:日志行的标签与等级都跟它自己的适配器键(`logging.levels.<适配器键>`)。
	// 键要等于它登进登记表的 `adapterKey`(工厂要日志器在先、适配器对象在后,只能先写下来;`compose.test.ts` 钉着对得上)。
	const loggerOf = (key: string): Logger => deps.serviceCtx.forSubsystem(key, key).logger;
	// 次序即登记与关停的次序:OneBot、QQ 官方机器人、webhook。
	const adapters = [
		createOnebotAdapter({
			logger: loggerOf("onebot"),
			serviceCtx: deps.serviceCtx,
		}),
		createQQOfficialAdapter({
			logger: loggerOf("qq-official"),
			serviceCtx: deps.serviceCtx,
			locale: deps.locale,
		}),
		createWebhookAdapter({ logger: loggerOf("webhook") }),
	];
	let registeringAdapters = false;

	return {
		provideDevtools(providers) {
			providers.claim(
				BILIBILI_SOURCE_KEY,
				createBiliDevtools({
					api: deps.api,
					auth: deps.auth,
					bus: deps.bus,
					// 场景挑订阅:配置里的订阅 + 运行时解析出的房号(与 room-session 拿的是同一份)。
					// 只挑 B 站订阅:这些场景造的是 B 站的直播 / 动态事件(ADR-0019 决策 12)。
					subs: () =>
						deps.subscriptions
							.list()
							.filter((sub) => subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY)
							.map((sub) => {
								const uid = subscriptionIdentityOf(sub).externalId;
								const runtime = deps.subscriptionRuntime.get(sub.id);
								return {
									id: sub.id,
									uid,
									name: runtime?.cachedProfile?.name ?? uid,
									enabled: sub.enabled,
									roomId: runtime?.roomId,
									specialViewers: sub.specialViewers.map((v) => v.id),
									avatar: runtime?.cachedProfile?.avatarUrl,
								};
							}),
					dynamic,
					healthCheck: deps.healthCheck,
				}),
			);
		},
		async registerSources(engines) {
			if (registering) throw new Error("builtin sources are already registered");
			registering = true;
			try {
				const made = createBiliSource({
					api: deps.api.api,
					bus: deps.bus,
					problems,
					loginCheck: { setHealthCheckMs: (ms) => deps.setHealthCheckMs(ms) },
					setTimeout: deps.setTimeout,
					auth: deps.sourceAuth,
					locale: deps.locale,
					liveContext: deps.serviceCtx.forSubsystem("live", BILIBILI_SOURCE_KEY),
					liveRoomIds: {
						get: (externalId) =>
							deps.subscriptionRuntime.get(
								deps.subscriptions
									.list()
									.find(
										(sub) =>
											subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY &&
											subscriptionIdentityOf(sub).externalId === externalId,
									)?.id ?? "",
							)?.roomId,
						set: (externalId, resolvedLiveCode) => {
							for (const sub of deps.subscriptions.list()) {
								const identity = subscriptionIdentityOf(sub);
								if (
									identity.sourceKey !== BILIBILI_SOURCE_KEY ||
									identity.externalId !== externalId ||
									deps.subscriptionRuntime.get(sub.id)?.roomId === resolvedLiveCode
								) {
									continue;
								}
								deps.serviceCtx.track(
									deps.subscriptionRuntime
										.patch(sub.id, { roomId: resolvedLiveCode })
										.catch((error) => {
											biliLogger.warn(
												`[compose] room id write failed externalId=${externalId}: ${String(error)}`,
											);
										}),
								);
							}
						},
					},
				});
				source = made;
				await engines.registerSource({
					sourceKey: BILIBILI_SOURCE_KEY,
					source: made,
					integration: deps.integration,
					// 来源上下文的 `ctx.logger`:标签 `dynamic`、等级跟来源键那一格(B 站的整体)。
					logger: deps.serviceCtx.forSubsystem("dynamic", BILIBILI_SOURCE_KEY).logger,
				});
			} catch (err) {
				// 开机失败(与从前造动态引擎抛了的后果一样):不留半个来源。
				source = undefined;
				registering = false;
				throw err;
			}
		},
		async registerAdapters() {
			if (registeringAdapters) throw new Error("builtin adapters are already registered");
			// 一次性:失败也不复位。登记途中抛了,已登记的由 `registerBuiltinAdapters` 自己收回,
			// 但三个适配器实例在 `composeBuiltinIntegrations` 里只造一次,收回过的实例不保证能再启动。
			registeringAdapters = true;
			return await registerBuiltinAdapters({
				registry: deps.adapterRegistry,
				adapters,
				loggerOf,
				stores: deps.integrationStore,
				transitImages: deps.transitImages,
				setTimeout: deps.setTimeout,
				problems: deps.problems,
				settingsOf: deps.settingsOf,
				connections: deps.connections,
				...(deps.connection ? { connection: deps.connection } : {}),
				inbound: deps.inbound,
				onConnectionsChanged: deps.onConnectionsChanged,
			});
		},
	};
}
