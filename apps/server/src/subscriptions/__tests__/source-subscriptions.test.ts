import {
	type GlobalSettings,
	makeDefaultGlobalSettings,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { sourceSubscriptionViews } from "../source-subscriptions.js";

const KEY = "bilibili";

const sub = (
	id: string,
	externalId: string,
	patch: Partial<Subscription> = {},
	sourceKey = KEY,
): Subscription => ({
	...makeEmptySubscription({ id, identity: { sourceKey, externalId } }),
	enabled: true,
	...patch,
});

const defaults = (): GlobalSettings["defaults"] => makeDefaultGlobalSettings().defaults;

describe("sourceSubscriptionViews", () => {
	it("只列本来源的、启用中的订阅", () => {
		const views = sourceSubscriptionViews(
			[
				sub("a", "1"),
				sub("b", "2", { enabled: false }),
				sub("c", "3", {}, "other-source"),
				sub("d", "4"),
			],
			KEY,
			defaults(),
		);
		expect(views.map((v) => v.externalId)).toEqual(["1", "4"]);
	});

	it("features 取自折好的开关:订阅覆盖压过全局默认", () => {
		const base = defaults();
		const globalOff: GlobalSettings["defaults"] = {
			...base,
			features: { ...base.features, post: false, liveStart: true },
		};
		const [plain, overridden] = sourceSubscriptionViews(
			[sub("a", "1"), sub("b", "2", { overrides: { features: { post: true, liveStart: false } } })],
			KEY,
			globalOff,
		);
		expect(plain?.features.has("post")).toBe(false);
		expect(plain?.features.has("liveStart")).toBe(true);
		expect(overridden?.features.has("post")).toBe(true);
		expect(overridden?.features.has("liveStart")).toBe(false);
	});

	it("作品开关关着的人仍在名单里,只是 features 里没有 post", () => {
		const base = defaults();
		const views = sourceSubscriptionViews([sub("a", "1")], KEY, {
			...base,
			features: { ...base.features, post: false },
		});
		expect(views).toHaveLength(1);
		expect(views[0]?.features.has("post")).toBe(false);
	});

	it("同一个人的重复订阅合成一条,features 取并集", () => {
		const views = sourceSubscriptionViews(
			[
				sub("a", "1", { overrides: { features: { post: true, liveStart: false } } }),
				sub("b", "1", { overrides: { features: { post: false, liveStart: true } } }),
			],
			KEY,
			defaults(),
		);
		expect(views).toHaveLength(1);
		expect(views[0]?.features.has("post")).toBe(true);
		expect(views[0]?.features.has("liveStart")).toBe(true);
	});

	it("monitorsLive 由整条折好的订阅算,重复订阅取或", () => {
		const views = sourceSubscriptionViews(
			[
				sub("a", "1", { overrides: { features: { liveStart: false } } }),
				sub("b", "1", { overrides: { features: { liveStart: true } } }),
				sub("c", "2", {
					overrides: {
						features: {
							liveStart: false,
							liveStreaming: false,
							liveEnd: false,
							membership: false,
							superchat: false,
							viewerChat: false,
							viewerEnter: false,
						},
					},
				}),
			],
			KEY,
			defaults(),
		);
		expect(views.map((view) => view.monitorsLive)).toEqual([true, false]);
	});

	it("停用的那条重复订阅不参与并集", () => {
		const views = sourceSubscriptionViews(
			[
				sub("a", "1", { overrides: { features: { post: false } } }),
				sub("b", "1", { enabled: false, overrides: { features: { post: true } } }),
			],
			KEY,
			defaults(),
		);
		expect(views).toHaveLength(1);
		expect(views[0]?.features.has("post")).toBe(false);
	});

	it("只有身份、开关与监听判定三格:作品设置(模板 / 皮肤 / 过滤……)不进名单", () => {
		const [view] = sourceSubscriptionViews(
			[
				sub("a", "1", {
					overrides: {
						cardSkin: "skin-x",
						templates: { post: "这位 {name}" },
						filters: { blockVideos: true },
					},
				}),
			],
			KEY,
			defaults(),
		);
		expect(Object.keys(view ?? {}).sort()).toEqual(["externalId", "features", "monitorsLive"]);
	});

	it("全局的作品开关一翻、订阅没单独覆盖:features 里的 post 跟着翻;订阅单独开压过全局关", () => {
		const base = defaults();
		const off: GlobalSettings["defaults"] = {
			...base,
			features: { ...base.features, post: false },
		};
		const subs = [sub("a", "1"), sub("b", "2", { overrides: { features: { post: true } } })];
		const on = sourceSubscriptionViews(subs, KEY, base);
		const flipped = sourceSubscriptionViews(subs, KEY, off);
		expect(on.map((v) => v.features.has("post"))).toEqual([true, true]);
		expect(flipped.map((v) => v.features.has("post"))).toEqual([false, true]);
	});

	it("次序按第一次出现", () => {
		const views = sourceSubscriptionViews(
			[sub("a", "3"), sub("b", "1"), sub("c", "3"), sub("d", "2")],
			KEY,
			defaults(),
		);
		expect(views.map((v) => v.externalId)).toEqual(["3", "1", "2"]);
	});
});
