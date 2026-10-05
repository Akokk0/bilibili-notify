/**
 * **按 UP 的过滤覆盖怎么折进作品设置**(㉑e,ADR-0021 决策 43)。
 *
 * 过滤直接吃折好的 `ContentFilters`,中间不再有 `dynamicFilterOf` 那层翻译。`dynamicWorkSettings(...).filter`
 * 只在这位 UP 真有过滤覆盖时才有值(B 站动态引擎的视图是快照,折进全局值就冻住了:全局再改这位 UP 就改不动),
 * 有的话是**折好的整份**(覆盖盖全局、没覆盖的键沿用全局)。
 *
 * 验红:把 `engines.ts` 里 `filter: sub.overrides.filters ? eff.filters : undefined` 换成总给 `eff.filters`,
 * 第一条红;换成只给覆盖本身(不折全局),第二条红。
 */

import {
	DEFAULT_CONTENT_FILTERS,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { dynamicWorkSettings } from "../engines.js";

const biliSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({
		id: "11111111-1111-4111-8111-111111111111",
		identity: { sourceKey: "bilibili", externalId: "12345" },
	}),
	enabled: true,
	overrides,
});

describe("dynamicWorkSettings().filter", () => {
	it("这位 UP 没有过滤覆盖 → 没有这一格(全局那份由引擎的 config 热更),B 站与拓展订阅一样", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.filters.blockVideos = true;
		expect(dynamicWorkSettings(biliSub(), g).filter).toBeUndefined();
		expect(dynamicWorkSettings(makeExtensionSubscription(), g).filter).toBeUndefined();
	});

	it("有过滤覆盖 → 折好的整份 ContentFilters:覆盖的键盖全局,没覆盖的键沿用全局", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.filters.blockKeywords = ["全局禁词"];
		g.defaults.filters.blockVideos = true;
		const sub = biliSub({ filters: { blockVideos: false, blockImages: true } });
		expect(dynamicWorkSettings(sub, g).filter).toEqual({
			...DEFAULT_CONTENT_FILTERS,
			...g.defaults.filters,
			blockKeywords: ["全局禁词"],
			blockVideos: false,
			blockImages: true,
		});
	});

	it("键名就是配置里的键:四个类型开关与关键词 / 正则 / 白名单原样可读(不再有 forward / draw / av 这些引擎自己的名字)", () => {
		const g = makeDefaultGlobalConfig();
		const sub = makeExtensionSubscription({
			overrides: {
				filters: {
					blockReposts: true,
					blockArticles: true,
					blockImages: true,
					blockVideos: true,
					blockKeywords: ["a"],
					blockRegex: ["b"],
					allowKeywords: ["c"],
					allowRegex: ["d"],
				},
			},
		});
		const filter = dynamicWorkSettings(sub, g).filter;
		expect(filter).toMatchObject({
			blockReposts: true,
			blockArticles: true,
			blockImages: true,
			blockVideos: true,
			blockKeywords: ["a"],
			blockRegex: ["b"],
			allowKeywords: ["c"],
			allowRegex: ["d"],
		});
		for (const old of ["enable", "forward", "article", "draw", "av", "whitelistEnable"]) {
			expect(filter).not.toHaveProperty(old);
		}
	});
});
