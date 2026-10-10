/**
 * **一条订阅的作品设置怎么折**(`postSettingsOf`)与**核心读它的口子**(`makePostSettingsReader`)。
 *
 * 核心装配(`posts/deliver-post.ts`)只吃折好的定值 `PostSettings`:订阅覆盖与全局已经折成一层,每条作品现折一次 ——
 * 全局或订阅设置改了立即对下一条生效,不再经引擎快照与热更门。折法住 `engines.ts`(`resolveAiOverride` 直播那头也在用,
 * 搬进核心会把直播的东西一起拖走),这里钉它。
 *
 * 验红:`postSettingsOf` 里每一格改成别的来源(比如 `template` 取 `defaults` 而不看覆盖、`imageGroup` 不看覆盖、`filter` 总给
 * 覆盖本身不折全局)各自红;`makePostSettingsReader` 里四个「回 undefined」的条件逐个删掉,对应的用例红。
 */

import {
	DEFAULT_CONTENT_FILTERS,
	type GlobalConfig,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { makePostSettingsReader, postSettingsOf } from "../engines.js";

const biliSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({
		id: "11111111-1111-4111-8111-111111111111",
		identity: { sourceKey: "bilibili", externalId: "12345" },
	}),
	enabled: true,
	overrides,
});

describe("postSettingsOf — 订阅覆盖与全局折成一层", () => {
	it("没有任何覆盖 → 每一格都取全局;B 站与拓展订阅一样", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.filters.blockVideos = true;
		g.defaults.templates.post = "全局动态 {name}";
		g.defaults.templates.postVideo = "全局视频 {name}";
		g.defaults.imageGroup = { enabled: true, mergeForward: true };
		g.defaults.cards.enabled = false;
		g.defaults.ai.enabled = false;
		g.defaults.ai.search.engines.dynamic = true;
		for (const sub of [biliSub(), makeExtensionSubscription()]) {
			const s = postSettingsOf(sub, g);
			expect(s.filter).toEqual({ ...DEFAULT_CONTENT_FILTERS, ...g.defaults.filters });
			expect(s.filter.blockVideos).toBe(true);
			expect(s.template).toBe("全局动态 {name}");
			expect(s.videoTemplate).toBe("全局视频 {name}");
			expect(s.imageGroup).toEqual({ enabled: true, mergeForward: true });
			expect(s.cardEnabled).toBe(false);
			expect(s.aiEnabled).toBe(false);
			expect(s.aiWebSearch).toBe(true);
			expect(s.cardSkin).toBe(g.defaults.cardSkin);
			expect(s.messageLayout).toEqual(g.defaults.messageLayout.post);
			expect(s.aiOverride).toBeUndefined();
			expect(s.cardSkinKnobs).toBeUndefined();
		}
	});

	it("订阅的覆盖盖过全局:模板、图集、皮肤;过滤是折好的整份(覆盖的键盖全局,没覆盖的键沿用全局)", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.templates.post = "全局动态 {name}";
		g.defaults.templates.postVideo = "全局视频 {name}";
		g.defaults.imageGroup = { enabled: false, mergeForward: false };
		g.defaults.filters.blockKeywords = ["全局禁词"];
		g.defaults.filters.blockVideos = true;
		const sub = biliSub({
			templates: { post: "这位 {name}", postVideo: "这位视频 {name}" },
			imageGroup: { enabled: true, mergeForward: true },
			cardSkin: "skin-x",
			filters: { blockVideos: false, blockImages: true },
		});
		const s = postSettingsOf(sub, g);
		expect(s.template).toBe("这位 {name}");
		expect(s.videoTemplate).toBe("这位视频 {name}");
		expect(s.imageGroup).toEqual({ enabled: true, mergeForward: true });
		expect(s.cardSkin).toBe("skin-x");
		expect(s.filter).toEqual({
			...DEFAULT_CONTENT_FILTERS,
			...g.defaults.filters,
			blockKeywords: ["全局禁词"],
			blockVideos: false,
			blockImages: true,
		});
	});

	it("只覆盖图集的一个键(开关):另一个键(合并转发)沿用全局", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.imageGroup = { enabled: false, mergeForward: true };
		const s = postSettingsOf(biliSub({ imageGroup: { enabled: true } }), g);
		expect(s.imageGroup).toEqual({ enabled: true, mergeForward: true });
	});

	it("每次现折:全局改了,下一次折出来就是新的(不是攥着旧的)", () => {
		const g = makeDefaultGlobalConfig();
		const sub = biliSub();
		const before = postSettingsOf(sub, g);
		g.defaults.templates.post = "改过的 {name}";
		g.defaults.cards.enabled = !g.defaults.cards.enabled;
		const after = postSettingsOf(sub, g);
		expect(after.template).toBe("改过的 {name}");
		expect(after.template).not.toBe(before.template);
		expect(after.cardEnabled).toBe(!before.cardEnabled);
	});

	it("aiOverride 只在这位 UP 真有 AI 覆盖时才有(留 undefined 才跟着全局人格热更,折进来就冻住了)", () => {
		const g = makeDefaultGlobalConfig();
		expect(postSettingsOf(biliSub(), g).aiOverride).toBeUndefined();
		expect(postSettingsOf(biliSub({ ai: { preset: "inherit" } }), g).aiOverride).toBeDefined();
	});

	it("订阅的旋钮覆盖原样给、不折全局(渲染器出图时与全局那份逐枚合并)", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.cardSkinKnobs = { default: { "gradient-end": "#222222" } };
		const knobs = { default: { "gradient-start": "#aaaaaa" } };
		expect(postSettingsOf(biliSub({ cardSkinKnobs: knobs }), g).cardSkinKnobs).toEqual(knobs);
		expect(postSettingsOf(biliSub(), g).cardSkinKnobs).toBeUndefined();
	});

	it("订阅设了直播封面 → 作品设置不读它:没有任何卡片样式覆盖这一格", () => {
		const s = postSettingsOf(
			biliSub({ cards: { liveCoverImageIds: ["up-cover.png"] } }),
			makeDefaultGlobalConfig(),
		);
		expect(s).not.toHaveProperty("customCardStyle");
		expect(JSON.stringify(s)).not.toContain("up-cover.png");
	});

	it("过滤的键名就是配置里的键:四个类型开关与关键词 / 正则 / 白名单原样可读", () => {
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
		const { filter } = postSettingsOf(sub, makeDefaultGlobalConfig());
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

describe("makePostSettingsReader — 不该推就回 undefined", () => {
	/** 一条订阅 + 一份全局 + 来源在不在跑,做成可以被测试随时改的读口。 */
	function setup(initial: { sub?: Subscription; g?: GlobalConfig; running?: boolean } = {}) {
		const state = {
			sub: "sub" in initial ? initial.sub : biliSub(),
			g: initial.g ?? makeDefaultGlobalConfig(),
			running: initial.running ?? true,
		};
		const subscription = vi.fn((id: string) => (id === state.sub?.id ? state.sub : undefined));
		const sourceRunning = vi.fn((_sub: Subscription) => state.running);
		const read = makePostSettingsReader({
			subscription,
			globals: () => state.g,
			sourceRunning,
		});
		return { state, read, subscription, sourceRunning };
	}
	const ID = biliSub().id;

	it("订阅在、启用着、作品开关开着、来源在跑 → 折好的设置(与 postSettingsOf 同一份)", () => {
		const t = setup();
		expect(t.read(ID)).toEqual(postSettingsOf(t.state.sub as Subscription, t.state.g));
		expect(t.subscription).toHaveBeenCalledWith(ID);
		expect(t.sourceRunning).toHaveBeenCalledWith(t.state.sub);
	});

	it("订阅不在(刚删)→ undefined;对照:在就有", () => {
		expect(setup({ sub: undefined }).read(ID)).toBeUndefined();
		expect(setup().read(ID)).toBeDefined();
		expect(setup().read("别的订阅")).toBeUndefined();
	});

	it("订阅停用 → undefined;对照:启用着就有", () => {
		const disabled = { ...biliSub(), enabled: false };
		expect(setup({ sub: disabled }).read(ID)).toBeUndefined();
		expect(setup({ sub: { ...disabled, enabled: true } }).read(ID)).toBeDefined();
	});

	it("作品开关关着 → undefined:全局关着且没单独开,或这位 UP 单独关掉;这位 UP 单独开压过全局关", () => {
		const globalOff = makeDefaultGlobalConfig();
		globalOff.defaults.features.post = false;
		expect(setup({ g: globalOff }).read(ID)).toBeUndefined();
		// 对照:全局关着、这位 UP 单独开 → 有。
		expect(
			setup({ g: globalOff, sub: biliSub({ features: { post: true } }) }).read(ID),
		).toBeDefined();
		// 全局开着、这位 UP 单独关 → 没有。
		expect(setup({ sub: biliSub({ features: { post: false } }) }).read(ID)).toBeUndefined();
	});

	it("来源没在跑 → undefined(拓展停了,等着的作品不补);对照:在跑就有;订阅给到那个判断函数", () => {
		const stopped = setup({ running: false });
		expect(stopped.read(ID)).toBeUndefined();
		expect(stopped.sourceRunning).toHaveBeenCalledWith(stopped.state.sub);
		expect(setup({ running: true }).read(ID)).toBeDefined();
	});

	it("每次现读:订阅与全局之后变了,下一次读到的就是新的;停用之后下一次就没有了", () => {
		const t = setup();
		const first = t.read(ID);
		// 换一份新对象(配置仓每次写入后给的是新快照),不是就地改旧的 —— 攥着旧对象的读口就读不到。
		const next = structuredClone(t.state.g);
		next.defaults.templates.post = "改过的 {name}";
		t.state.g = next;
		expect(t.read(ID)?.template).toBe("改过的 {name}");
		expect(first?.template).not.toBe("改过的 {name}");
		t.state.sub = { ...(t.state.sub as Subscription), enabled: false };
		expect(t.read(ID)).toBeUndefined();
	});
});
