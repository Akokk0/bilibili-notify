import {
	BILIBILI_GUARD_PROGRAM,
	type Disposable,
	type MessageBus,
	type ServiceContext,
	type Source,
	type SourceAuth,
	type SourceContext,
	type SourceDescriptor,
} from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { Api } from "./api/index.js";
import { DynamicEngine, type PushLike } from "./dynamic/index.js";
import type { ImagesDeps } from "./images.js";
import type { ProblemLayers } from "./problem-layers.js";
import { settingsOf, watchSettings } from "./settings.js";

export interface BiliSourceDeps {
	api: Api;
	/** 引擎自己还在听 auth-restored / auth-lost、发 engine-error:私聊主人那一处随 3a-30,其余随 3b。 */
	bus: MessageBus;
	/** 只剩给主人发私信(风控 / 故障告警);3a-30 删。 */
	push: PushLike;
	imageFetcher: ImagesDeps["images"];
	/** B 站自己的设置从它读(`settingsOf` / `watchSettings`);`ctx.settings(schema)` 随 3a-39。 */
	configStore: Pick<ConfigStore, "getIntegrationSettings" | "onChange">;
	/** 可回收的定时器(退避重启用);公共上下文里没有定时器。 */
	setTimeout: ServiceContext["setTimeout"];
	/** 登录口(`AuthSystem.auth`):原样挂到 `Source.auth`,登记表的视图带着它。 */
	auth: SourceAuth;
	/**
	 * 分层上报器(`compose.ts` 造,与给开发场景、给入口的是同一个):`start` 最后一步接上这个来源的上下文,
	 * `stop` 第一步摘下。
	 */
	problems: Pick<ProblemLayers, "attach" | "detach">;
}

export interface BiliSource extends Source {
	/** 动态引擎;没 start 或已 stop 是 undefined。开发场景的「现在就跑」与 status 指令的「上次抓取」读它。 */
	dynamic(): DynamicEngine | undefined;
}

/** 从 B 站设置算动态引擎的配置(启动与热更共用)。 */
const dynamicConfigOf = (settings: { dynamicCron: string }) => ({
	dynamicCron: settings.dynamicCron,
	dynamicVideoUrlToBV: false,
});

export function createBiliSource(deps: BiliSourceDeps): BiliSource {
	let engine: DynamicEngine | undefined;
	let handles: Disposable[] = [];

	const descriptor: SourceDescriptor = {
		postNoun: "动态",
		membershipPrograms: [BILIBILI_GUARD_PROGRAM],
	};

	return {
		descriptor,
		auth: deps.auth,
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
				config: dynamicConfigOf(settingsOf(deps.configStore)),
			});
			const mine: Disposable[] = [];
			try {
				started.start();
				mine.push(ctx.onSubscriptionsChanged(() => started.syncSubscriptions()));
				mine.push(
					watchSettings(deps.configStore, (prev, next) => {
						if (prev.dynamicCron === next.dynamicCron) return;
						started.updateConfig(dynamicConfigOf(next));
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
			// 最后一步:核心那头此刻才有。接上之前记着的问题(登录失效、风控、请求失败)在这一刻整份补报。
			deps.problems.attach(ctx);
		},
		// 🔴 没有 await:登记表撤登记时调 stop 是不等它的,而引擎的 dispose 是同步函数、紧接着就关作品入口,
		// 「来源先停、入口后关」只在 stop 的同步段里已经停干净时成立。
		stop() {
			// 第一步先摘:引擎收尾时的「不再适用」清除不许变成对主人说的一句「已恢复」。
			deps.problems.detach();
			for (const handle of handles) handle.dispose();
			handles = [];
			engine?.stop();
			engine = undefined;
			return Promise.resolve();
		},
	};
}
