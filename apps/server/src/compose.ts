/**
 * 组装根:整个核心里只有这个文件登记内置集成。只放登记与开发场景的过渡接线,不长别的逻辑。
 *
 * 今天它做三件事:认领 B 站那组开发场景(`provideDevtools`);开 B 站的上下文、造 B 站来源并登记(`registerSources`,
 * 登记即启动;登录那一套由来源自己造、起、停);造三个内置平台适配器(OneBot / QQ 官方机器人 / webhook)并登记
 * (`registerAdapters`,登记即启动)。`status` 指令的「上次抓取」不从这里取:它读登记表里各来源自己说的那一行
 * (`Source.health()`)。B 站的上下文只开一次、寿命与来源一致,收尾钩子在构造时就登记在关停的 `stop` 段(早于推送链路
 * 登记,于是晚于推送链路跑:来源先停完、登录先停,再最后一次存盘、再关存储把手);适配器各有各的存储与上下文,
 * 由 `registerBuiltinAdapters` 按适配器键开。
 *
 * 核心里只有这个文件能 import `platforms/`(`scripts/__tests__/import-boundaries.test.mjs` 钉着);
 * 入口与推送链路只认 `PlatformAdapter` 接口。
 *
 * B 站那组开发场景只拿 B 站来源一个把手(名单、轮询、直播连接、登录都从它身上现取),核心的句柄一样不给(ADR-0031 决策 2)。
 *
 * 带 `devtools/` 的模块说明符在这里只许 B 站 devtools 的入口一个
 * (`devtools-isolation` 钉着,注释里也别加引号写它):构建时它被换成恒空的桩。
 */

import {
	BILIBILI_SOURCE_KEY,
	type Connection,
	type Disposable,
	type InboundHandlers,
	type Logger,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { type BiliContextHandle, createBiliContext } from "./bilibili/context.js";
import { createBiliDevtools, type DevtoolsProviderRegistry } from "./bilibili/devtools/index.js";
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
import type { PipelineRuntime } from "./runtime/pipeline.js";
import type { NodeServiceContext } from "./runtime/service-context.js";

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
	/** 当前语言的读口(入口造一份):内置集成的问题句在语言变了时按新语言重报,递给 B 站来源。 */
	locale: LocaleReader;
	setTimeout: ServiceContext["setTimeout"];
	/** 账号头像往图库存图的口(`AppRuntime.accountImages`):B 站来源的登录系统抓头像用。 */
	accountImages: ImageWriter;
	/**
	 * 三个内置平台适配器要的东西。运行时(`createAppRuntime`)开机就建好了,所以和上面一样构造时给齐:
	 * 适配器在 `composeBuiltinIntegrations` 里就造出来(工厂只往 `serviceCtx` 挂一个关停兜底,不连网、不开监听),
	 * 关停钩子的登记时刻因此与从前入口里造它们那一刻一致;登记即启动的那一步仍在 `registerAdapters`。
	 */
	serviceCtx: ServiceContext & Pick<NodeServiceContext, "forSubsystem">;
	/** 图库「集成在途」那一家的写口(`AppRuntime.transitImages`):内置适配器与假来源的 `ctx.fetchImage` / `ctx.storeImage` 经它。 */
	transitImages: Pick<ImageWriter, "put">;
	/**
	 * 入站两路出口(下一层)。指令处理器要等推送链路与调度器建好才有,所以是入口先留好的可后填引用,现转。
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
	/**
	 * 推送链路建好之后调一次:开 B 站的上下文、造 B 站来源并登记(登记即 start,登录在它的 start 里起)。调第二次就抛;
	 * 造来源或登记任一步抛了,先收上下文再原样抛。
	 */
	registerSources(pipeline: Pick<PipelineRuntime, "registerSource">): Promise<void>;
	/**
	 * `createPipelineRuntime` 之前调一次:依次登记 OneBot、QQ 官方机器人、webhook 三个内置适配器(登记即 `start`),
	 * 交回的 `dispose` 由调用方挂到关停钩子上(逐个撤登记再关存储;幂等)。登记途中任一个抛了,已登记的先收回,
	 * 错原样抛出去。一次性:调第二次就抛,登记途中抛了也不复位(不给重来)。
	 */
	registerAdapters(): Promise<BuiltinAdapters>;
}

export function composeBuiltinIntegrations(deps: BuiltinIntegrationsDeps): BuiltinIntegrations {
	// B 站的代码(登录系统、上报器、来源、上下文)日志行都跟 B 站那一格(`logging.levels.bilibili`),不跟核心。
	const biliServiceCtx = deps.serviceCtx.forSubsystem(BILIBILI_SOURCE_KEY, BILIBILI_SOURCE_KEY);
	let source: BiliSource | undefined;
	// 开着的 B 站上下文(`registerSources` 里开);收尾钩子在这里就登记:关停的 `stop` 段里后登记的先跑,
	// 登记在 `createPipelineRuntime` 之前,所以推送链路先停来源(登录随之停、续期作废),这里再做最后一次存盘、关存储把手。
	let biliContext: BiliContextHandle | undefined;
	// 开发壳(`provideDevtools` 记下,开发版才有):来源造好登录系统之后拿它换成套过壳的 `Api` / 登录口。
	let devShells: ReturnType<typeof createBiliDevtools>["devShells"] | undefined;
	deps.serviceCtx.onDispose(async () => {
		const closing = biliContext;
		biliContext = undefined;
		await closing?.dispose();
	}, "stop");
	// 登记过(含登记途中)就不许再来一次;造来源或登记任一步抛了都会复位。
	let registering = false;
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
			const made = createBiliDevtools({ source: () => source });
			devShells = made.devShells;
			providers.claim(BILIBILI_SOURCE_KEY, made.provider);
		},
		async registerSources(pipeline) {
			if (registering) throw new Error("builtin sources are already registered");
			registering = true;
			let opened: BiliContextHandle | undefined;
			try {
				opened = await createBiliContext({
					stores: deps.integrationStore,
					serviceCtx: biliServiceCtx,
					problems: deps.problems,
					transitImages: deps.transitImages,
					settingsOf: deps.settingsOf,
				});
				biliContext = opened;
				const made = createBiliSource({
					context: opened.ctx,
					serviceCtx: biliServiceCtx,
					accountImages: deps.accountImages,
					...(devShells ? { devShells } : {}),
					setTimeout: deps.setTimeout,
					locale: deps.locale,
					liveContext: deps.serviceCtx.forSubsystem("live", BILIBILI_SOURCE_KEY),
				});
				source = made;
				await pipeline.registerSource({
					sourceKey: BILIBILI_SOURCE_KEY,
					source: made,
					integration: opened.ctx,
					// 来源上下文的 `ctx.logger`:标签 `dynamic`、等级跟来源键那一格(B 站的整体)。
					logger: deps.serviceCtx.forSubsystem("dynamic", BILIBILI_SOURCE_KEY).logger,
				});
			} catch (err) {
				// 开机失败(与从前造动态引擎抛了的后果一样):不留半个来源,上下文先收再抛。
				source = undefined;
				registering = false;
				biliContext = undefined;
				await opened?.dispose();
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
