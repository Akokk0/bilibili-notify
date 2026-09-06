import type { BilibiliAPI } from "@bilibili-notify/api";
import { observeLiveConnections } from "@bilibili-notify/blive";
import type { MessageBus, PushAdapter, PushTarget } from "@bilibili-notify/internal";
import type { Hono } from "hono";
import type { AuthSystem } from "../auth/index.js";
import type { HistoryStore } from "../history/store.js";
import type { PlatformAdapter } from "../platforms/types.js";
import type { MuteState } from "../runtime/mute-state.js";
import type { UpdateService } from "../update/service.js";
import { isDevBuild } from "../update/version-order.js";
import { overridableApi } from "./api-overrides.js";
import { createCapabilityInjector } from "./capability-injection.js";
import { createCaptureGate } from "./capture.js";
import { createDevClock } from "./clock.js";
import { createLiveRooms } from "./live-rooms.js";
import { createDevRegistry, type DevRegistry } from "./registry.js";
import { createDevRoute, type DevCapturesApi } from "./route.js";
import { busEventScenarios } from "./scenarios/bus-events.js";
import { capabilityScenario } from "./scenarios/capability.js";
import { pushCaptureScenario } from "./scenarios/capture.js";
import { type DynamicEngineLike, dynamicScenarios } from "./scenarios/dynamic.js";
import { type InboundHandlers, inboundScenarios } from "./scenarios/inbound.js";
import { liveScenarios, type SubPick } from "./scenarios/live.js";
import { liveEventScenarios } from "./scenarios/live-events.js";
import { loginStateScenario } from "./scenarios/login-state.js";
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
 * 注入的高度:**既有边界上套装饰器,引擎与服务本体一行不动**。这里把真服务 / 真 adapter
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
	/** 推送出口。交回去的是包过截流闸的那份。 */
	adapters: readonly PlatformAdapter[];
	/** 「清掉截流期间历史行」要它。 */
	historyStore: Pick<HistoryStore, "deleteRange">;
	/** 传给引擎的 B 站 API。交回去的是套了 Proxy 的那份(假直播期间房间信息说在播)。 */
	api: BilibiliAPI;
	/** 场景挑订阅用:每次现读,订阅表会变。 */
	subs: () => SubPick[];
	/** 动态引擎(「发动态」之后立刻跑一轮)。引擎后建,现取。 */
	dynamic: () => DynamicEngineLike | undefined;
	/** 入站口(私聊指令 / 群链接)。接线层后接,现取。 */
	inbound: () => InboundHandlers | undefined;
	commands: () => { prefix: string; masterUserId?: string };
	adapterConfigs: () => PushAdapter[];
	targets: () => PushTarget[];
	/** 引擎错误 / 登录失效 / 登录状态快照都从这条总线发。 */
	bus: MessageBus;
	/** 登录系统:交回去的是套了 Proxy 的那份(`status()` 可注入),给路由用。 */
	authSystem: AuthSystem;
	/** 定时组要碰的几个口,都是后建的,现取。 */
	puppeteer: () => { closeIdleNow(): Promise<boolean> } | null | undefined;
	live: () => { repushNow(uid: string): Promise<boolean> } | undefined;
	mute: () => Pick<MuteState, "muteFor" | "mutedUntil" | "isMuted"> | undefined;
	fansPoller: () => { pollNow(): Promise<boolean> } | undefined;
	loginFlow: () => { healthCheckNow(): Promise<boolean> } | undefined;
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
	/** 交给 `/api/update` 路由的那份 —— 装饰过的。 */
	updateService: UpdateService;
	/** 交给引擎 / 链接回卡的那份 —— 包过截流闸的。 */
	adapters: PlatformAdapter[];
	/** 交给引擎的那份 —— 套了 Proxy 的。 */
	api: BilibiliAPI;
	/** 交给路由的那份 —— `status()` 可注入。 */
	authSystem: AuthSystem;
	/** 交给推送引擎的免扰时钟(单点覆盖)。 */
	quietHoursNow: () => Date;
}

export function createDevtools(input: CreateDevtoolsInput): Devtools | null {
	// 两道门都得成立。版本号那道是**失败即敞开**的:`0.0.0-dev` 是仓库常驻值,读不出版本号时
	// 兜底也是 `"dev"` —— 任何没走发版流程的构建(公开推的 `:test` 镜像就是一例)都会自认
	// 开发版。所以再要一道构建产物身上不可能成立的:跑在源码上。
	// (更新服务共用 `isDevBuild`,但那边的后果是「关掉更新」,敞开反而是安全的一侧。)
	if (!isDevBuild(input.payloadVersion) || !input.sourceRun) return null;
	const update = injectableUpdateService(input.updateService);
	const gate = createCaptureGate();
	const caps = createCapabilityInjector();
	const api = overridableApi(input.api);
	const auth = overridableApi(input.authSystem);
	const clock = createDevClock();
	// 直播间连接登记:blive 每建一条连接就报到这里。全进程只有 devtools 这一个观察者。
	const rooms = createLiveRooms();
	observeLiveConnections(rooms.observe);
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
	const registry = createDevRegistry([
		updateStateScenario(update),
		pushCaptureScenario(gate),
		...liveScenarios({ subs: input.subs, rooms, api }),
		...liveEventScenarios({ subs: input.subs, rooms }),
		...dynamicScenarios({ subs: input.subs, api, dynamic: input.dynamic }),
		...inboundScenarios({
			inbound: input.inbound,
			commands: input.commands,
			adapters: input.adapterConfigs,
			targets: input.targets,
		}),
		...busEventScenarios({ bus: input.bus }),
		loginStateScenario({ auth, bus: input.bus }),
		capabilityScenario({ injector: caps, adapters: input.adapterConfigs }),
		...timerScenarios({
			clock,
			subs: input.subs,
			mute: input.mute,
			puppeteer: input.puppeteer,
			live: input.live,
			dynamic: input.dynamic,
			fans: input.fansPoller,
			loginFlow: input.loginFlow,
		}),
	]);
	return {
		registry,
		route: createDevRoute({ registry, captures }),
		updateService: update.service,
		// 两层叠着:截流闸在里、能力注入在外 —— 顺序无所谓,两者各管各的方法。
		adapters: input.adapters.map((a) => caps.wrap(gate.wrap(a))),
		api: api.api,
		authSystem: auth.api,
		quietHoursNow: () => clock.now(),
		captures,
	};
}
