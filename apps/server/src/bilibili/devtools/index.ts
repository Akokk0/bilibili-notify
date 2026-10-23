import type { MessageBus, SourceAuth } from "@bilibili-notify/internal";
import type { OverridableApi } from "../../devtools/api-overrides.js";
import type { DevtoolsProvider } from "../../devtools/providers.js";
import type { Api } from "../api/index.js";
import { observeLiveConnections } from "../live/protocol/client.js";
import { type DynamicPollerLike, dynamicScenarios } from "./dynamic.js";
import { liveScenarios, type SubPick } from "./live.js";
import { liveEventScenarios } from "./live-events.js";
import { createLiveRooms } from "./live-rooms.js";
import { loginStateScenario } from "./login-state.js";
import { biliTimerScenarios } from "./timers.js";

/** `compose.ts` 的 `provideDevtools` 形参要它;`compose.ts` 自己不许写 `"./devtools/…"` 的说明符。 */
export type { DevtoolsProviderRegistry } from "../../devtools/providers.js";

/**
 * B 站交给 devtools 的那一包场景(`DevtoolsProvider`)—— 只在开发版登记。
 *
 * 构建时 `apps/server/vite.config.ts` 把这个入口换成 `./stub.ts`(恒交出空的一包),
 * 整个 `bilibili/devtools/` 随之从产物里消失。场景里写**不带前缀**的 id,`bilibili.` 前缀由
 * 宿主汇总时统一加(`devtools/providers.ts`)。
 *
 * 🚧 过渡接线:场景今天仍直接用引擎、用套了 Proxy 的 `Api` / `AuthSystem`(两个 Proxy 由
 * `src/index.ts` 建好、经 `src/compose.ts` 传进来)。登录场景要
 * `healthCheck`、造动态的场景经壳上盖方法再调 `detectNow()` 走的是真引擎,各等各的那一片再删。
 */
export interface BiliDevtoolsDeps {
	/** 传给引擎的 `Api` 外面的那层 Proxy —— 引擎拿的就是它的 `.api`。 */
	api: OverridableApi<Api>;
	/** 来源的登录口外面的那层 Proxy(`state()` / `account()` 可注入);来源挂的是它的 `.api`。 */
	auth: OverridableApi<Required<SourceAuth>>;
	/** 假登录状态从这条总线发(`subscription-auth-changed`)。 */
	bus: MessageBus;
	/** 场景挑订阅用:每次现读,订阅表会变。 */
	subs: () => SubPick[];
	/** 下面几样都是引擎建好之后才有的,现取(动态引擎的句柄来自 `compose.ts` 造的 B 站来源)。 */
	dynamic: () => DynamicPollerLike | undefined;
	/** 来源自己的房号缓存;直播场景挑房间时现取。 */
	liveRooms: () => { roomIdOf(externalId: string): string | undefined } | undefined;
	/** 登录心跳「现在就跑」的把手(`AuthSystem.healthCheckNow`),现取。 */
	healthCheck: () => { healthCheckNow(): Promise<boolean> } | undefined;
}

export function createBiliDevtools(deps: BiliDevtoolsDeps): DevtoolsProvider {
	// 直播间连接登记:blive 每建一条连接就报到这里。全进程只有 devtools 这一个观察者。
	const rooms = createLiveRooms();
	observeLiveConnections(rooms.observe);
	return {
		scenarios: [
			...liveScenarios({ subs: deps.subs, rooms, api: deps.api, liveRooms: deps.liveRooms }),
			...liveEventScenarios({ subs: deps.subs, rooms, liveRooms: deps.liveRooms }),
			...dynamicScenarios({ subs: deps.subs, api: deps.api, dynamic: deps.dynamic }),
			loginStateScenario({ auth: deps.auth, bus: deps.bus }),
			...biliTimerScenarios({
				subs: deps.subs,
				dynamic: deps.dynamic,
				healthCheck: deps.healthCheck,
			}),
		],
	};
}
