/**
 * 假源 —— **开发用**的订阅源拓展(ADR-0019 决策 34 的「devtools 假源」)。
 *
 * 真平台接进来之前,让主人在真机上把订阅源那条路走一遍:平台选择里多一档「假源」、输入框的提示、
 * 解析门的候选(有头像 / 没头像、有粉丝 / 没粉丝)、空 / 超时 / 出错 / 形状不对四种失败、拓展页上的
 * 视图,以及页上那几颗上报按钮(作品 / 开播 / 下播 / 资料 / 直播状态,外加两颗报坏的)。它走的是
 * **正式的注册口**(`ctx.registerSource`),与以后的抖音拓展同一条路,不在核心里手写第二份。
 */

import type {
	ExtensionContext,
	Identity,
	SourceContext,
	SourceDef,
} from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import { wireReportButtons } from "./buttons.js";
import { fakeSearchCreators } from "./lookup.js";
import { createFakeProfiles, fakeFetchedProfile, pictureStore } from "./reports.js";
import { fakeSourceView } from "./view.js";

/**
 * 合 `externalIdRegex`,但解析门永远不会现编出这个尾巴:`fetchProfile` 拿它演「平台上这个人没了」,
 * 宿主据此把订阅的问题记成 `creator_not_found`。
 */
const MISSING_PROFILE_EXTERNAL_ID = "fake-0000000000000000-z";

export function activate(ctx: ExtensionContext): void {
	/** `start` 拿到的来源上下文;`stop` 之后清掉。按钮、解析门、视图都从这里取名单与上报口。 */
	let running: SourceContext | undefined;
	const profiles = createFakeProfiles();
	const buttons = wireReportButtons(ctx, () => running, profiles);
	// 视图是现取的:订阅名单每次现读,不缓存。
	ctx.publishView(() => fakeSourceView(running?.subscriptions() ?? [], ctx.i18n, buttons.blocks()));

	const def = {
		start(source: SourceContext) {
			running = source;
			// 订阅一动就喊一声,面板当场重取视图 —— 不然加完一条,切回拓展页那个数还是旧的。
			source.onSubscriptionsChanged(() => ctx.statusChanged());
		},
		stop() {
			running = undefined;
			ctx.statusChanged();
		},
		searchCreators(query: string, signal: AbortSignal) {
			const source = running;
			if (!source) {
				return Promise.resolve(fail("unavailable", "来源没在跑(还没起来,或者已经停下了)"));
			}
			return fakeSearchCreators(pictureStore(source, signal), query, signal);
		},
		async fetchProfile(identity: Identity, signal: AbortSignal) {
			if (identity.externalId === MISSING_PROFILE_EXTERNAL_ID) {
				return fail("not_found", "假平台上没有这个人");
			}
			const source = running;
			if (!source) {
				return fail("unavailable", "来源没在跑(还没起来,或者已经停下了)");
			}
			const reported = profiles.reported(identity.externalId);
			if (reported) return ok(reported);
			try {
				signal.throwIfAborted();
				const profile = await fakeFetchedProfile(identity.externalId, pictureStore(source, signal));
				signal.throwIfAborted();
				return ok(profile);
			} catch (err) {
				return fail("unavailable", (err as Error).message);
			}
		},
		fetchLiveStatus: buttons.liveStatusOf,
		// 故意的:auth 与 liveInteractions 这一版不对拓展开放,交上去让守卫证明宿主会摘掉。
		auth: {
			beginLogin: async () => ok(),
			logout: async () => ok(),
			state: () => ({ status: "logged-in" }),
			onChange: () => ({ dispose() {} }),
		},
		liveInteractions: {
			fetchViewerAvatar: async () =>
				fail("unsupported", "fake source does not support live interactions"),
			fetchTierIcon: async () =>
				fail("unsupported", "fake source does not support live interactions"),
		},
		health() {
			const people = new Set(running?.subscriptions().map((one) => one.externalId) ?? []);
			return { summary: ctx.i18n.t("health.summary", { count: people.size }) };
		},
	};
	// 故意的:把不开的成员塞进注册对象,给宿主成员表把它们摘掉。
	ctx.registerSource(def as unknown as SourceDef);
}
