import { type OverridableApi, overridableApi } from "../../devtools/api-overrides.js";
import type { DevtoolsProvider } from "../../devtools/providers.js";
import type { Api } from "../api/index.js";
import { observeLiveConnections } from "../live/protocol/client.js";
import type { BiliSource, BiliSourceDeps } from "../source.js";
import { dynamicScenarios } from "./dynamic.js";
import { liveScenarios } from "./live.js";
import { liveEventScenarios } from "./live-events.js";
import { createLiveRooms } from "./live-rooms.js";
import { loginScenarios } from "./login.js";
import { type AuthShell, createAuthShell, loginStateScenario } from "./login-state.js";
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
 * 场景只用 B 站自己的东西(ADR-0031 决策 2):名单是来源 `ctx.subscriptions()` 那一份,挑人用 `creator` 参数;
 * 注入点在 B 站自己的边界上 —— 假动态并进拉动态的结果、假直播塞进直播连接、假登录态盖在登录口上再替它喊变更,
 * B 站解析到上报、宿主转发到推送都是真链路。核心的句柄(总线、订阅表、订阅运行时状态)一样不拿。
 * `Api` / 登录口两层开发壳在这里建,经 `devShells` 递给 B 站来源当它的 `api` 与 `Source.auth`,场景按下时才现取。
 */

/** 场景要从 B 站来源身上现取的那几样。 */
export type BiliDevSource = Pick<
	BiliSource,
	"subscriptions" | "dynamic" | "liveRooms" | "profileAvatars" | "login" | "auth"
>;

export interface BiliDevtoolsDeps {
	/** B 站来源,现取:造好之前、登记失败重来之间是 undefined。 */
	source: () => BiliDevSource | undefined;
}

/**
 * `provider` 是场景那一包;`devShells` 是交给 B 站来源的两层开发壳(`BiliSourceDeps.devShells`):来源造好登录系统之后
 * 把真的 `Api` / 登录口递进来,换回套了壳的那一份当自己用的(来源、`Source.auth` 与场景盖的是同一个对象)。
 */
export function createBiliDevtools(deps: BiliDevtoolsDeps): {
	provider: DevtoolsProvider;
	devShells: NonNullable<BiliSourceDeps["devShells"]>;
} {
	// 来源造好之前没有壳,场景现取(取不到回「来源还没起来」);来源重造(登记失败后重来)就换成新的。
	let apiShell: OverridableApi<Api> | undefined;
	let authShell: AuthShell | undefined;
	// 直播间连接登记:blive 每建一条连接就报到这里。全进程只有 devtools 这一个观察者。
	const rooms = createLiveRooms();
	observeLiveConnections(rooms.observe);
	const apiOf = () => apiShell;
	const source = deps.source;
	const roster = () => source()?.subscriptions() ?? [];
	const liveRooms = () => source()?.liveRooms();
	const dynamic = () => source()?.dynamic();
	const login = () => source()?.login();
	return {
		provider: {
			scenarios: [
				...liveScenarios({ roster, rooms, api: apiOf, liveRooms }),
				...liveEventScenarios({ roster, rooms, liveRooms }),
				...dynamicScenarios({
					roster,
					api: apiOf,
					dynamic,
					profileAvatars: () => source()?.profileAvatars(),
				}),
				loginStateScenario({ auth: () => authShell }),
				...loginScenarios({ auth: () => source()?.auth, login }),
				...biliTimerScenarios({ dynamic, healthCheck: login }),
			],
		},
		devShells: {
			api(real) {
				apiShell = overridableApi(real);
				return apiShell.api;
			},
			auth(real) {
				authShell = createAuthShell(real);
				return authShell.api;
			},
		},
	};
}
