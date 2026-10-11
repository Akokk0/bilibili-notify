/**
 * 组装根:整个核心里只有这个文件登记内置集成。只放登记与开发场景的过渡接线,不长别的逻辑。
 *
 * 今天它做两件事:认领 B 站那组开发场景(`provideDevtools`);造 B 站来源并登记(`registerSources`,
 * 登记即启动)。`bilibili.dynamic` 是 B 站来源上给入口读的那一面,只为 `status` 指令的「上次抓取」。
 * 来源的上下文仍由登录那套建好递进来(`integration`),这里不另开存储。
 *
 * 「挑订阅」那一段是随开发场景的过渡接线一起留着的;入口咽喉守卫(3a-40)开张前,
 * 「这个文件只放登记」没有守卫钉着,靠审查。
 *
 * 带 `devtools/` 的模块说明符在这里只许 B 站 devtools 的入口一个
 * (`devtools-isolation` 钉着,注释里也别加引号写它):构建时它被换成恒空的桩。
 */

import {
	BILIBILI_SOURCE_KEY,
	type IntegrationContext,
	type Logger,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import {
	type BiliDevtoolsDeps,
	createBiliDevtools,
	type DevtoolsProviderRegistry,
} from "./bilibili/devtools/index.js";
import type { ImagesDeps } from "./bilibili/images.js";
import { type BiliSource, createBiliSource } from "./bilibili/source.js";
import type { ConfigStore } from "./config/store.js";
import { type EnginesRuntime, masterTellers } from "./runtime/engines.js";
import type { SubRuntimeStore } from "./runtime/sub-runtime-store.js";

export interface BuiltinIntegrationsDeps {
	/** 套了壳的 `Api` 与登录系统(壳在入口建)。来源拿 `api.api`,场景拿壳本身:只进这一次,两头不可能接成两个对象。 */
	api: BiliDevtoolsDeps["api"];
	auth: BiliDevtoolsDeps["auth"];
	/** B 站集成的上下文(`AuthSystem.integration`)。 */
	integration: IntegrationContext;
	bus: BiliDevtoolsDeps["bus"];
	configStore: Pick<ConfigStore, "getIntegrationSettings" | "onChange">;
	/** 开发场景挑订阅用,现读。 */
	subscriptions: Pick<SubscriptionStore, "list">;
	subscriptionRuntime: Pick<SubRuntimeStore, "get">;
	imageFetcher: ImagesDeps["images"];
	setTimeout: Parameters<typeof createBiliSource>[0]["setTimeout"];
	logger: Logger;
	/** 下面三样建得比这里晚,现取,原样转给开发场景。 */
	live: BiliDevtoolsDeps["live"];
	fans: BiliDevtoolsDeps["fans"];
	loginFlow: BiliDevtoolsDeps["loginFlow"];
}

export interface BuiltinIntegrations {
	/** `createDevtools` 的 `provide` 回调里调:过了开发版那两道门才会走到,把 B 站那组场景按来源键认领进去。 */
	provideDevtools(providers: Pick<DevtoolsProviderRegistry, "claim">): void;
	/** 引擎建好之后调一次:造 B 站来源并登记(登记即 start)。调第二次就抛。 */
	registerSources(engines: Pick<EnginesRuntime, "registerSource" | "push">): Promise<void>;
	/** B 站来源上给入口读的那一面:只为 `status` 指令的「上次抓取」。登记之前 `dynamic()` 是 undefined。 */
	readonly bilibili: Pick<BiliSource, "dynamic">;
}

export function composeBuiltinIntegrations(deps: BuiltinIntegrationsDeps): BuiltinIntegrations {
	let source: BiliSource | undefined;
	// 登记过(含登记途中)就不许再来一次;造来源或登记任一步抛了都会复位。
	let registering = false;
	const dynamic = () => source?.dynamic();

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
					dynamic,
					live: deps.live,
					fans: deps.fans,
					loginFlow: deps.loginFlow,
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
					push: { sendPrivateMsg: masterTellers(engines.push, deps.logger).sendPrivateMsg },
					imageFetcher: deps.imageFetcher,
					configStore: deps.configStore,
					setTimeout: deps.setTimeout,
				});
				source = made;
				await engines.registerSource({
					sourceKey: BILIBILI_SOURCE_KEY,
					source: made,
					integration: deps.integration,
				});
			} catch (err) {
				// 开机失败(与从前造动态引擎抛了的后果一样):不留半个来源。
				source = undefined;
				registering = false;
				throw err;
			}
		},
		bilibili: { dynamic },
	};
}
