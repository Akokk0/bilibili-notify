import {
	aiWritingNeeded,
	type EffectiveSubscription,
	type GlobalConfig,
	resolve,
	resolveTemplates,
	type Subscription,
} from "@bilibili-notify/internal";
import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
import { builtinPersonasOf, resolveAiOverride } from "../runtime/ai-config.js";
import type { PostSettings } from "./deliver-post.js";

/**
 * 一条订阅(B 站或拓展)→ 作品装配吃的设置(ADR-0019 决策 65 / 66):订阅覆盖与全局折成一层。B 站与拓展作品
 * 都从这里拿,别抄第二份 —— 两份的话主人给某个抖音号换的文案模板 / 版式 / 皮肤,迟早有一格只有 B 站那头认。
 * 每条作品现折一次({@link makePostSettingsReader}),没有快照问题。
 *
 * 刻意只在**真有 per-UP 覆盖**时才生成的两格:`aiOverride`(没配就 undefined,生成器走全局配置)与
 * `cardSkinKnobs`(订阅自己那层原样给、不折全局,渲染器出图时与全局那份逐枚合并)。
 *
 * `aiWriting`:作品的 AI 正文有没有人用得上(`aiWritingNeeded` 对现存目标算好的布尔,由读口递进来 ——
 * 这里不碰目标表,仍是纯函数);`aiEnabled` 是它与 AI 总开关的与。
 * `eff` 给了就不再折一遍。
 */
export function postSettingsOf(
	sub: Subscription,
	globals: GlobalConfig,
	aiWriting: boolean,
	eff: EffectiveSubscription = resolve(sub, globals.defaults),
): PostSettings {
	const d = globals.defaults;
	// 文字模板设置里只存主人改过的:缺的此刻按当前语言取出厂,不写盘(换语言立即生效)。
	const templates = resolveTemplates(sub, d, templateDefaultsFor(textSettingsOf(globals).locale));
	return {
		filter: eff.filters,
		// per-UP 解析后的消息版式动态切片,恒有值(默认 = 复刻现状:卡片+文本+链接合并一条)。
		messageLayout: eff.messageLayout.post,
		cardEnabled: d.cards.enabled,
		// per-UP 解析后的卡片皮肤 id(eff = per-UP 指了就是它,否则全局)。
		cardSkin: eff.cardSkin,
		cardSkinKnobs: sub.overrides.cardSkinKnobs,
		aiEnabled: globals.ai.enabled && aiWriting,
		aiWebSearch: globals.ai.search.scenes.post,
		aiOverride: resolveAiOverride(sub, globals.ai, builtinPersonasOf(globals)),
		template: templates.post,
		videoTemplate: templates.postVideo,
		imageGroup: { enabled: eff.imageGroup.enabled, mergeForward: eff.imageGroup.mergeForward },
	};
}

/**
 * 核心装配用的「这条订阅此刻的作品设置」读口(`DeliverPostDeps.settings`):不该推就回 `undefined` ——
 * 订阅不在、停用、作品开关关着、来源没在跑。**每次现折**:入口问一次、装配开头问一次、回问再问一次。
 * 导出它是为了让这一跳有自己的测试。
 */
export function makePostSettingsReader(deps: {
	subscription: (id: string) => Subscription | undefined;
	globals: () => GlobalConfig;
	/** 这条订阅的来源还在跑吗(问来源登记表:内置来源登着就在;拓展看它自己在不在跑)。 */
	sourceRunning: (sub: Subscription) => boolean;
	/** 现存目标的 id:AI 正文的例外只数还在的目标,指向已删目标的例外不算开着。 */
	targetIds: () => Iterable<string>;
}): (subscriptionId: string) => PostSettings | undefined {
	return (subscriptionId) => {
		const sub = deps.subscription(subscriptionId);
		if (sub === undefined || !sub.enabled) return undefined;
		const g = deps.globals();
		const eff = resolve(sub, g.defaults);
		if (!eff.features.post) return undefined;
		if (!deps.sourceRunning(sub)) return undefined;
		return postSettingsOf(sub, g, aiWritingNeeded(g.ai.writing.post, deps.targetIds()), eff);
	};
}
