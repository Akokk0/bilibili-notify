import type { BilibiliAPI } from "@bilibili-notify/api";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { Context } from "koishi";
import { BilibiliNotifyAI } from "../ai/service";
import type { BilibiliNotifyConfig } from "../config";
import { BilibiliNotifyDynamic } from "../dynamic/service";
import { BilibiliNotifyLive } from "../live/service";
import type { TargetRegistry } from "../push/target-registry";
import BilibiliNotifyImage from "../render/service";

/**
 * render/ai/dynamic/live 从各自独立的 koishi Service 收编成普通类之后的统一构造/析构
 * 点(切片9)。四者与 api/push/store/registry 同生命周期 —— 每轮 bringUp() 全新构造,
 * 每轮 tearDown() 全部析构,`bn restart` 因此天然重建这四个引擎(修掉了重构前遗留的
 * "restart 不刷新 dynamic/live 内部引用"的潜伏 bug)。
 *
 * 构造顺序:render → ai → dynamic → live —— dynamic/live 需要直接持有 render/ai 的
 * engine 引用,必须晚于两者构造完成;不再需要 ctx.inject 的后置晚注入。
 */
export interface Engines {
	render: BilibiliNotifyImage | null;
	ai: BilibiliNotifyAI | null;
	dynamic: BilibiliNotifyDynamic;
	live: BilibiliNotifyLive;
}

export interface EnginesCoreDeps {
	api: BilibiliAPI;
	push: BilibiliPush;
	store: SubscriptionStore;
	registry: TargetRegistry;
}

export function buildEngines(
	ctx: Context,
	config: BilibiliNotifyConfig,
	core: EnginesCoreDeps,
): Engines {
	const render = config.render.enabled ? new BilibiliNotifyImage(ctx, config.render) : null;
	render?.start();

	const ai = config.ai.enabled
		? new BilibiliNotifyAI(ctx, config.ai, {
				api: core.api,
				store: core.store,
				registry: core.registry,
			})
		: null;
	ai?.start();

	const dynamic = new BilibiliNotifyDynamic(ctx, config.dynamic);
	dynamic.start({
		api: core.api,
		push: core.push,
		store: core.store,
		image: render?.engine,
		ai: ai?.engine,
		// 联网搜索的 per-engine 开关住在 AI 子配置里(key / 后端也在那边)。
		// AI 没启用时恒关 —— 没有生成器,搜了也没人用。
		aiWebSearch: config.ai.enabled ? (config.ai.webSearchDynamic ?? false) : false,
	});

	const live = new BilibiliNotifyLive(ctx, config.live);
	live.start({
		api: core.api,
		push: core.push,
		store: core.store,
		image: render?.engine,
		ai: ai?.engine,
		aiWebSearch: config.ai.enabled ? (config.ai.webSearchLive ?? false) : false,
	});

	return { render, ai, dynamic, live };
}

export function disposeEngines(engines: Engines): void {
	engines.live.stop();
	engines.dynamic.stop();
	engines.ai?.stop();
	engines.render?.stop();
}
