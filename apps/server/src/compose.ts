/**
 * 组装根:整个核心里只有这个文件登记内置集成。只放登记与开发场景的过渡接线,不长别的逻辑。
 *
 * 今天它只做一件事:认领 B 站那组开发场景(`provideDevtools`),并把 B 站动态引擎的句柄
 * 原样交回入口(`bilibili`,只为 `status` 指令的「上次抓取」)。3a-28 的下一个提交起,
 * 这里造并登记 B 站来源,`bilibili.dynamic` 改读自己造的那个来源。
 *
 * 「挑订阅」那一段是随开发场景的过渡接线一起留着的;入口咽喉守卫(3a-40)开张前,
 * 「这个文件只放登记」没有守卫钉着,靠审查。
 *
 * 带 `devtools/` 的模块说明符在这里只许 B 站 devtools 的入口一个
 * (`devtools-isolation` 钉着,注释里也别加引号写它):构建时它被换成恒空的桩。
 */

import { BILIBILI_SOURCE_KEY, subscriptionIdentityOf } from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import {
	type BiliDevtoolsDeps,
	createBiliDevtools,
	type DevtoolsProviderRegistry,
} from "./bilibili/devtools/index.js";
import type { DynamicEngine } from "./bilibili/dynamic/index.js";
import type { SubRuntimeStore } from "./runtime/sub-runtime-store.js";

export interface BuiltinIntegrationsDeps {
	/** 套了壳的 `Api` 与登录系统(壳在入口建):场景拿壳本身。 */
	api: BiliDevtoolsDeps["api"];
	auth: BiliDevtoolsDeps["auth"];
	bus: BiliDevtoolsDeps["bus"];
	/** 开发场景挑订阅用,现读。 */
	subscriptions: Pick<SubscriptionStore, "list">;
	subscriptionRuntime: Pick<SubRuntimeStore, "get">;
	/** 下面几样建得比这里晚,现取,原样转给开发场景(`dynamic` 同时是 `bilibili.dynamic()` 的来源)。 */
	dynamic: () => DynamicEngine | undefined;
	live: BiliDevtoolsDeps["live"];
	fans: BiliDevtoolsDeps["fans"];
	loginFlow: BiliDevtoolsDeps["loginFlow"];
}

export interface BuiltinIntegrations {
	/** `createDevtools` 的 `provide` 回调里调:过了开发版那两道门才会走到,把 B 站那组场景按来源键认领进去。 */
	provideDevtools(providers: Pick<DevtoolsProviderRegistry, "claim">): void;
	/** B 站来源上给入口读的那一面:只为 `status` 指令的「上次抓取」。 */
	readonly bilibili: { dynamic(): DynamicEngine | undefined };
}

export function composeBuiltinIntegrations(deps: BuiltinIntegrationsDeps): BuiltinIntegrations {
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
									specialUsers: sub.specialUsers.map((u) => u.uid),
									avatar: runtime?.cachedProfile?.avatarUrl,
								};
							}),
					dynamic: deps.dynamic,
					live: deps.live,
					fans: deps.fans,
					loginFlow: deps.loginFlow,
				}),
			);
		},
		bilibili: { dynamic: deps.dynamic },
	};
}
