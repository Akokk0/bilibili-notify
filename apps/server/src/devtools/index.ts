import { getHeapStatistics } from "node:v8";
import type {
	ChatIdentity,
	Connection,
	ConnectionCapabilities,
	InboundHandlers,
	MessageBus,
	PushTarget,
} from "@bilibili-notify/internal";
import type { ExtensionContext } from "@bilibili-notify/internal/extension";
import type { Hono } from "hono";
import { entryIdentity, type LoadedExtensions } from "../extensions/loader.js";
import type { Marketplace } from "../extensions/marketplace.js";
import type { HistoryStore } from "../history/store.js";
import type { LiveSessionEngine } from "../live/live-sessions.js";
import { routeConnection } from "../push/dispatch.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";
import type { SendInterceptHandler } from "../push/target-dispatcher.js";
import type { MuteState } from "../runtime/mute-state.js";
import type { ProfileRefreshHandle } from "../runtime/profile-refresh.js";
import type { MemoryUsageSample } from "../runtime/resource-monitor.js";
import type { UpdateService } from "../update/service.js";
import { isDevBuild } from "../update/version-order.js";
import { createCapabilityInjector } from "./capability-injection.js";
import { createCaptureGate } from "./capture.js";
import { createDevClock } from "./clock.js";
import { createDevEntryAttacher } from "./dev-entry.js";
import { heapInjector, injectedMemoryUsage } from "./heap-injection.js";
import { injectableMarketplace } from "./marketplace-injection.js";
import { createDevtoolsProviderRegistry, type DevtoolsProviderRegistry } from "./providers.js";
import { createDevRegistry, type DevRegistry } from "./registry.js";
import { createDevRoute, type DevCapturesApi } from "./route.js";
import { busEventScenarios } from "./scenarios/bus-events.js";
import { capabilityScenario } from "./scenarios/capability.js";
import { pushCaptureScenario } from "./scenarios/capture.js";
import { extensionScenarios } from "./scenarios/extensions.js";
import { heapPressureScenario } from "./scenarios/heap.js";
import { inboundScenarios } from "./scenarios/inbound.js";
import { marketplaceUpdateScenario } from "./scenarios/marketplace.js";
import { timerScenarios } from "./scenarios/timers.js";
import { updateStateScenario } from "./scenarios/update.js";
import { injectableUpdateService } from "./update-injection.js";

/**
 * devtools 的组装点 + 那道门。
 *
 * **门 = 载荷版本号是不是开发版**(`0.0.0-dev` / `dev`),不是环境变量:环境变量能在生产
 * 镜像里被设上,版本号不能;alpha 也不给 —— 那是发出去给人用的构建。`index.ts` 拿到 null
 * 就什么都不挂,`/api/dev` 404,面板那半(`import.meta.env.DEV` 挡着)也就当它不存在。
 *
 * 注入的高度:**既有边界上套装饰器,来源与服务本体一行不动**。这里把真服务 / 真 adapter
 * 各包一层交回去,`index.ts` 把包好的那份往下传 —— 面板看到的、出网的都从装饰器过,本体照常跑。
 */
export interface CreateDevtoolsInput {
	payloadVersion: string;
	/**
	 * 跑的是不是 TypeScript 源码(`import.meta.url` 以 `.ts` 收尾)。构建产物一律是 `.mjs`,
	 * 这一条没有任何环境变量、任何过期的 package.json 能翻过来。
	 */
	sourceRun: boolean;
	updateService: UpdateService;
	/** 推送出口的注册表。交回去的是包过能力注入的那份**派生表**。 */
	adapters: PlatformAdapterRegistry;
	/**
	 * 拓展那三条场景要的两个目录 + 装载器本体(**现取**,拓展比 devtools 后起来)。
	 *
	 * 装载器只认 `<数据根>/extensions/` 一个根,所以「开发时怎么让仓里那份跑起来」
	 * 从宿主的一条特例变成了这里的一个动作 —— 见 `scenarios/extensions.ts`。
	 *
	 * 要的两个把手:`rescan()` 让装 / 卸当场生效,`reload()` 换掉已经跑着那份的代码。
	 */
	extensions: {
		/** 仓里那个 `extensions/`。 */
		repoDir: string;
		/** `<数据根>/extensions/`。 */
		installRoot: string;
		/** 「拓展有更新」还要它的名单:装着哪一版,假新版就比它高一格。 */
		loaded: () => Pick<LoadedExtensions, "reload" | "rescan" | "list"> | undefined;
	};
	/** 拓展市场。交回去的是装饰过的那份(「拓展有更新」:列表里那一条改成 updatable、装的那下假装成功)。 */
	marketplace: Marketplace;
	/** 「清掉截流期间历史行」要它。 */
	historyStore: Pick<HistoryStore, "deleteRange">;
	/**
	 * 各家集成登记自己的场景(B 站是第一个)。**过了门才调**,调的时候登记表是空的、注册表还没建:
	 * 门没开,各家的工厂一次都不会被调用。场景 id 的来源前缀与撞名检查在登记那一处做完。
	 */
	provide: (providers: DevtoolsProviderRegistry) => void;
	/** 入站口(私聊指令 / 群链接)。接线层后接,现取。 */
	inbound: () => InboundHandlers | undefined;
	commands: () => { prefix: string; master?: ChatIdentity };
	connectionConfigs: () => Connection[];
	/**
	 * BN 自己的 `host:port` —— 拓展的开发入口拿它拼出自己挂载点的完整地址(`mountUrl()`)。
	 * **现取**:端口是 `serve()` 之后才知道的,而 devtools 比它先建。
	 */
	address: () => string | undefined;
	targets: () => PushTarget[];
	/** 推送链路错误 / 登录失效 / 登录恢复都从这条总线发。 */
	bus: MessageBus;
	/** 定时组要碰的几个口,都是后建的,现取。 */
	puppeteer: () => { closeIdleNow(): Promise<boolean> } | null | undefined;
	mute: () => Pick<MuteState, "muteFor" | "mutedUntil" | "isMuted"> | undefined;
	/** 资料刷新在核心启动更晚,场景跑时现取。 */
	profileRefresh: () => Pick<ProfileRefreshHandle, "pollNow"> | undefined;
	subscriptions?: () => readonly { id: string; enabled: boolean; name: string }[];
	session?: () => Pick<LiveSessionEngine, "tickNow"> | undefined;
}

export interface Devtools {
	registry: DevRegistry;
	/**
	 * `/api/dev` 那棵子应用,建好交给 app.ts 挂。路由在这里建而不是在 app.ts 里 import:
	 * 整套 devtools 只从 `src/index.ts` 这一处引,构建时把这个入口换成空桩就能把整棵树
	 * 连根摇掉 —— 多一个引用点就多一条漏进构建产物的路。
	 */
	route: Hono;
	captures: DevCapturesApi;
	/** 交给 `/api/system/update` 路由的那份 —— 装饰过的。 */
	updateService: UpdateService;
	/** 交给 `/api/ext/marketplace*` 的那份 —— 装饰过的。 */
	marketplace: Marketplace;
	/** 交给推送链路、再递给派发器的能力注入读口 —— 盖在宿主的能力记忆之上,收摊即回真。 */
	injectedCapabilities: (connectionId: string) => ConnectionCapabilities | undefined;
	/** 交给推送链路、再递给派发器的截流闸口 —— 三条发送路(含链接回卡、指令回复)共用。 */
	interceptSend: SendInterceptHandler;
	/**
	 * 交给采样器的堆读数口 —— 真 `process.memoryUsage()` 外面包了一层注入。
	 *
	 * 交出来的是**包好的读数**而不是注入口:`index.ts` 只许从 `./devtools/index.js` 这
	 * 一处引 devtools(构建期整棵树靠它换空桩),多开一个 import 就多一条漏进产物的路。
	 */
	memoryUsage: () => MemoryUsageSample;
	/** 交给推送链路的免扰时钟(单点覆盖)。 */
	quietHoursNow: () => Date;
	/** 装载器在拓展跑起来之后调:只给开了 `contributes.devtools` 的那几家挂开发场景。 */
	attachExtension: (started: { id: string; dir: string; ctx: ExtensionContext }) => Promise<void>;
}

export function createDevtools(input: CreateDevtoolsInput): Devtools | null {
	// 两道门都得成立。版本号那道是**失败即敞开**的:`0.0.0-dev` 是仓库常驻值,读不出版本号时
	// 兜底也是 `"dev"` —— 任何没走发版流程的构建(公开推的 `:test` 镜像就是一例)都会自认
	// 开发版。所以再要一道构建产物身上不可能成立的:跑在源码上。
	// (更新服务共用 `isDevBuild`,但那边的后果是「关掉更新」,敞开反而是安全的一侧。)
	if (!isDevBuild(input.payloadVersion) || !input.sourceRun) return null;
	const update = injectableUpdateService(input.updateService);
	// 装着哪一版**现取**(装载器比 devtools 后起来,名单也会变),读法与市场自己那份同一把尺子。
	const market = injectableMarketplace(
		input.marketplace,
		() =>
			input.extensions
				.loaded()
				?.list()
				.map((entry) => {
					const who = entryIdentity(entry);
					return { id: entry.id, name: who?.name, version: who?.version };
				}) ?? [],
	);
	const gate = createCaptureGate();
	const caps = createCapabilityInjector();
	const clock = createDevClock();
	// 堆读数注入:交回去给采样器包在真 `process.memoryUsage()` 外面。
	const heap = heapInjector();
	const captures: DevCapturesApi = {
		status: () => ({ enabled: gate.enabled(), entries: gate.entries() }),
		clear: () => gate.clear(),
		// 每一段截流窗各删一遍;开着的那段截到现在。删完把窗归零 —— 再清一次不该把同一段又删一遍。
		async purgeHistory() {
			const now = Date.now();
			let deleted = 0;
			for (const { from, to } of gate.windows()) {
				deleted += await input.historyStore.deleteRange({ fromMs: from, toMs: to ?? now });
			}
			gate.resetWindows();
			return deleted;
		},
	};
	const coreDefs = [
		updateStateScenario(update),
		pushCaptureScenario(gate),
		...inboundScenarios({
			inbound: input.inbound,
			commands: input.commands,
			connections: input.connectionConfigs,
			// 眼下有效的能力:真适配器的回答;注入过就用注入的(与派发器看到的那份同源)。
			capabilities: (connection) => {
				const route = routeConnection(input.adapters.list(), connection);
				const real = route.ok ? route.adapter.capabilities?.(route.connection) : undefined;
				return caps.get(connection.id) ?? real;
			},
			targets: input.targets,
		}),
		...busEventScenarios({ bus: input.bus }),
		heapPressureScenario({ heap }),
		// 方言给的是登记表视图本身:「哪些平台有能力这回事」是方言自己的事实,不经过注入那一层。
		capabilityScenario({
			injector: caps,
			connections: input.connectionConfigs,
			dialects: () => input.adapters.list(),
		}),
		...extensionScenarios({
			repoDir: input.extensions.repoDir,
			installRoot: input.extensions.installRoot,
			extensions: input.extensions.loaded,
		}),
		// 不跟上面那几条一起:仓里一个拓展都没有时它们整组不出现,而这一条认的是**装着的**。
		marketplaceUpdateScenario(market),
		...timerScenarios({
			clock,
			mute: input.mute,
			puppeteer: input.puppeteer,
			profileRefresh: input.profileRefresh,
			subscriptions: input.subscriptions ?? (() => []),
			session: input.session ?? (() => undefined),
		}),
	];
	const providers = createDevtoolsProviderRegistry(coreDefs.map((def) => def.id));
	input.provide(providers);
	const registry = createDevRegistry(coreDefs, providers);
	const attachExtension = createDevEntryAttacher({ providers, address: input.address });
	return {
		registry,
		route: createDevRoute({ registry, captures }),
		updateService: update.service,
		marketplace: market.marketplace,
		// 能力和截流一样接在派发器上,不包适配器:推送链路拿的就是真登记表(拓展后注册照样看得见,
		// ADR-0012 决策 29),注入读口只在派发器问能力时盖一层、收摊即回真。
		injectedCapabilities: caps.get,
		interceptSend: gate.intercept,
		quietHoursNow: () => clock.now(),
		memoryUsage: injectedMemoryUsage(
			() => process.memoryUsage(),
			heap,
			() => getHeapStatistics().heap_size_limit,
		),
		captures,
		attachExtension,
	};
}
