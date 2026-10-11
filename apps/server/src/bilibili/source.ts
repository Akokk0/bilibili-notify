import {
	BILIBILI_GUARD_PROGRAM,
	type Disposable,
	type MessageBus,
	type ServiceContext,
	type Source,
	type SourceContext,
	type SourceDescriptor,
} from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { Api } from "./api/index.js";
import { DynamicEngine, type PushLike } from "./dynamic/index.js";
import type { ImagesDeps } from "./images.js";
import { settingsOf, watchSettings } from "./settings.js";

export interface BiliSourceDeps {
	api: Api;
	/** 引擎自己还在听 auth-restored / auth-lost、发 engine-error;3a-29 / 3a-30 清。 */
	bus: MessageBus;
	/** 只剩给主人发私信(风控 / 故障告警);3a-30 删。 */
	push: PushLike;
	imageFetcher: ImagesDeps["images"];
	/** B 站自己的设置从它读(`settingsOf` / `watchSettings`);`ctx.settings(schema)` 随 3a-39。 */
	configStore: Pick<ConfigStore, "getIntegrationSettings" | "onChange">;
	/** 可回收的定时器(退避重启用);公共上下文里没有定时器。 */
	setTimeout: ServiceContext["setTimeout"];
}

export interface BiliSource extends Source {
	/** 动态引擎;没 start 或已 stop 是 undefined。开发场景的「现在就跑」与 status 指令的「上次抓取」读它。 */
	dynamic(): DynamicEngine | undefined;
}

export function createBiliSource(deps: BiliSourceDeps): BiliSource {
	let engine: DynamicEngine | undefined;
	let handles: Disposable[] = [];

	const descriptor: SourceDescriptor = {
		postNoun: "动态",
		membershipPrograms: [BILIBILI_GUARD_PROGRAM],
	};

	return {
		descriptor,
		dynamic: () => engine,
		async start(ctx: SourceContext) {
			if (engine) throw new Error("bilibili source is already started");
			const started = new DynamicEngine({
				logger: ctx.logger,
				setTimeout: deps.setTimeout,
				bus: deps.bus,
				api: deps.api,
				push: deps.push,
				imageFetcher: deps.imageFetcher,
				reportPost: (externalId, report) => ctx.reportPost(externalId, report),
				subscriptions: () => ctx.subscriptions(),
				config: {
					dynamicCron: settingsOf(deps.configStore).dynamicCron,
					dynamicVideoUrlToBV: false,
				},
			});
			const mine: Disposable[] = [];
			try {
				started.start();
				mine.push(ctx.onSubscriptionsChanged(() => started.syncSubscriptions()));
				mine.push(
					watchSettings(deps.configStore, (prev, next) => {
						if (prev.dynamicCron === next.dynamicCron) return;
						started.updateConfig({
							dynamicCron: next.dynamicCron,
							dynamicVideoUrlToBV: false,
						});
					}),
				);
			} catch (err) {
				// 登记表那头只会放键、收上下文,不会替来源停 cron:自己收拾干净再抛。
				for (const handle of mine) handle.dispose();
				started.stop();
				throw err;
			}
			engine = started;
			handles = mine;
		},
		// 🔴 没有 await:登记表撤登记时调 stop 是不等它的,而引擎的 dispose 是同步函数、紧接着就关作品入口,
		// 「来源先停、入口后关」只在 stop 的同步段里已经停干净时成立。
		stop() {
			for (const handle of handles) handle.dispose();
			handles = [];
			engine?.stop();
			engine = undefined;
			return Promise.resolve();
		},
	};
}
