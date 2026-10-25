import type { MessageBus, SourceAuth } from "@bilibili-notify/internal";
import { type OverridableApi, overridableApi } from "../../devtools/api-overrides.js";
import type { DevtoolsProvider } from "../../devtools/providers.js";
import type { Api } from "../api/index.js";
import { observeLiveConnections } from "../live/protocol/client.js";
import type { BiliSourceDeps } from "../source.js";
import { type DynamicPollerLike, dynamicScenarios } from "./dynamic.js";
import { liveScenarios, type SubPick } from "./live.js";
import { liveEventScenarios } from "./live-events.js";
import { createLiveRooms } from "./live-rooms.js";
import { loginScenarios } from "./login.js";
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
 * 🚧 过渡接线:场景今天仍直接用引擎、用套了 Proxy 的 `Api` / 登录口(两层壳在这里建,经 `devShells` 递给 B 站来源
 * 当它的 `api` 与 `Source.auth`,场景按下时才现取)。登录场景要来源的 `login()` 把手、造动态的场景经壳上盖方法再调
 * `detectNow()` 走的是真引擎,各等各的那一片再删。
 */
export interface BiliDevtoolsDeps {
	/** 假登录状态从这条总线发(`subscription-auth-changed`)。 */
	bus: MessageBus;
	/** 场景挑订阅用:每次现读,订阅表会变。 */
	subs: () => SubPick[];
	/** 下面几样都是引擎建好之后才有的,现取(动态引擎的句柄来自 `compose.ts` 造的 B 站来源)。 */
	dynamic: () => DynamicPollerLike | undefined;
	/** 来源自己的房号缓存;直播场景挑房间时现取。 */
	liveRooms: () => { roomIdOf(externalId: string): string | undefined } | undefined;
	/** 来源自己的资料状态;假动态借作者头像时现取。 */
	profileAvatars: () => { avatarUrlOf(externalId: string): string | undefined } | undefined;
	/** 来源的登录把手(`BiliSource.login()`),现取;心跳、失效与重新确认三个场景用它。 */
	login: () =>
		| {
				healthCheckNow(): Promise<boolean>;
				handleAuthLost(): Promise<void>;
				reportAccountInfo(): Promise<void>;
		  }
		| undefined;
	/** 来源自己的登录口(`Source.auth`),现取;真登录场景按它判断当前状态。 */
	auth: () => Pick<Required<SourceAuth>, "state"> | undefined;
}

/**
 * `provider` 是场景那一包;`devShells` 是交给 B 站来源的两层开发壳(`BiliSourceDeps.devShells`):来源造好登录系统之后
 * 把真的 `Api` / 登录口递进来,换回套了 Proxy 的那一份当自己用的(来源、`Source.auth` 与场景盖的是同一个对象)。
 */
export function createBiliDevtools(deps: BiliDevtoolsDeps): {
	provider: DevtoolsProvider;
	devShells: NonNullable<BiliSourceDeps["devShells"]>;
} {
	// 来源造好之前没有壳,场景现取(取不到回「来源还没起来」);来源重造(登记失败后重来)就换成新的。
	let apiShell: OverridableApi<Api> | undefined;
	let authShell: OverridableApi<Required<SourceAuth>> | undefined;
	// 直播间连接登记:blive 每建一条连接就报到这里。全进程只有 devtools 这一个观察者。
	const rooms = createLiveRooms();
	observeLiveConnections(rooms.observe);
	const apiOf = () => apiShell;
	const authOf = () => authShell;
	return {
		provider: {
			scenarios: [
				...liveScenarios({ subs: deps.subs, rooms, api: apiOf, liveRooms: deps.liveRooms }),
				...liveEventScenarios({ subs: deps.subs, rooms, liveRooms: deps.liveRooms }),
				...dynamicScenarios({
					subs: deps.subs,
					api: apiOf,
					dynamic: deps.dynamic,
					profileAvatars: deps.profileAvatars,
				}),
				loginStateScenario({ auth: authOf, bus: deps.bus }),
				...loginScenarios({ auth: deps.auth, login: deps.login }),
				...biliTimerScenarios({
					subs: deps.subs,
					dynamic: deps.dynamic,
					healthCheck: deps.login,
				}),
			],
		},
		devShells: {
			api(real) {
				apiShell = overridableApi(real);
				return apiShell.api;
			},
			auth(real) {
				authShell = overridableApi(real);
				return authShell.api;
			},
		},
	};
}
