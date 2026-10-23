import { makeEmptySubscription, type Subscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { platformLabelOf, sourceNounsFor, subscriptionIdentityLabelOf } from "../platform-label.js";

const NEUTRAL = { creatorNoun: "创作者", postNoun: "作品", sources: "各平台" };

/** 来源登记表里各键的描述符 `label`;拓展装载器说的平台名另给。 */
function depsWith(labels: Record<string, string>, extensionLabels: Record<string, string> = {}) {
	return {
		sources: {
			get: (key: string) =>
				labels[key] === undefined ? undefined : { descriptor: { label: labels[key] as string } },
		},
		extensionPlatformLabel: (id: string) => extensionLabels[id],
	};
}

/** 带外部 id 叫法的来源登记表；拓展装载器另给。 */
function nounDepsWith(
	descriptors: Record<string, { label: string; externalIdNoun?: string }>,
	extensionLabels: Record<string, string> = {},
) {
	return {
		sources: {
			get: (key: string) =>
				descriptors[key] === undefined
					? undefined
					: { descriptor: descriptors[key] as { label: string; externalIdNoun?: string } },
		},
		extensionPlatformLabel: (id: string) => extensionLabels[id],
	};
}

describe("platformLabelOf —— 订阅所属平台的叫法", () => {
	// 验红:把函数改成只问拓展装载器,第一条(登记表里的假来源)读到键名,红。
	it("在来源登记表里的来源:读描述符的 label,先于拓展装载器", () => {
		const deps = depsWith(
			{ bilibili: "B 站", "acme.inprocess": "对拍源" },
			{ "acme.inprocess": "装载器说的" },
		);
		expect(platformLabelOf("bilibili", deps)).toBe("B 站");
		expect(platformLabelOf("acme.inprocess", deps)).toBe("对拍源");
	});

	it("不在登记表里的(拓展):装载器说的平台名;取不到(拓展卸了、装载器没起来)写键名", () => {
		expect(platformLabelOf("douyin", depsWith({}, { douyin: "抖音" }))).toBe("抖音");
		expect(platformLabelOf("douyin", depsWith({}))).toBe("douyin");
		expect(platformLabelOf("douyin", { sources: depsWith({}).sources })).toBe("douyin");
	});
});

describe("subscriptionIdentityLabelOf —— 按来源拼身份标签", () => {
	it("登记表里的来源声明了外部 id 的叫法时，用它写标签", () => {
		const deps = nounDepsWith({ bilibili: { label: "B 站", externalIdNoun: "UID" } });
		expect(subscriptionIdentityLabelOf({ sourceKey: "bilibili", externalId: "123" }, deps)).toBe(
			"UID 123",
		);
	});

	it("登记表里的来源没声明叫法时，写描述符的平台名与外部 id", () => {
		const deps = nounDepsWith(
			{ "acme.inprocess": { label: "对拍源" } },
			{ "acme.inprocess": "装载器说的" },
		);
		expect(
			subscriptionIdentityLabelOf({ sourceKey: "acme.inprocess", externalId: "x" }, deps),
		).toBe("对拍源 · x");
	});

	it("不在登记表里的拓展用清单平台名；拓展卸了就退到来源键", () => {
		expect(
			subscriptionIdentityLabelOf(
				{ sourceKey: "douyin", externalId: "s" },
				nounDepsWith({}, { douyin: "抖音" }),
			),
		).toBe("抖音 · s");
		expect(
			subscriptionIdentityLabelOf({ sourceKey: "douyin", externalId: "s" }, nounDepsWith({})),
		).toBe("douyin · s");
	});
});

describe("sourceNounsFor —— 按这次涉及的来源取提示词叫法", () => {
	function subscription(sourceKey: string, enabled: boolean): Subscription {
		const sub = makeEmptySubscription({
			id: `sub-${sourceKey}`,
			identity: { sourceKey, externalId: "fixture" },
		});
		sub.enabled = enabled;
		return sub;
	}

	function nounDeps(
		descriptors: Record<string, { label: string; creatorNoun?: string; postNoun?: string }> = {},
		over: {
			extensionLabels?: Record<string, string>;
			extensionPostNouns?: Record<string, string>;
			subscriptions?: readonly (readonly [sourceKey: string, enabled: boolean])[];
			registered?: readonly string[];
		} = {},
	) {
		return {
			sources: {
				get: (key: string) =>
					descriptors[key] === undefined ? undefined : { descriptor: descriptors[key] },
				list: () =>
					(over.registered ?? Object.keys(descriptors)).map((sourceKey) => ({ sourceKey })),
			},
			extensionPlatformLabel: (id: string) => over.extensionLabels?.[id],
			extensionPostNoun: (id: string) => over.extensionPostNouns?.[id],
			subscriptions: () =>
				(over.subscriptions ?? []).map(([sourceKey, enabled]) => subscription(sourceKey, enabled)),
		};
	}

	it("一个登记来源用它自己的叫法", () => {
		const deps = nounDeps({
			bilibili: { label: "B 站", creatorNoun: "UP主", postNoun: "动态" },
		});
		expect(sourceNounsFor(["bilibili"], deps, NEUTRAL)).toEqual({
			creatorNoun: "UP主",
			postNoun: "动态",
			sources: "B 站",
		});
	});

	it("两个来源混着用中性叫法,平台名去重后列出来", () => {
		const deps = nounDeps({
			a: { label: "甲站", creatorNoun: "甲主", postNoun: "甲作" },
			b: { label: "乙站", creatorNoun: "乙主", postNoun: "乙作" },
		});
		expect(sourceNounsFor(["a", "b", "a"], deps, NEUTRAL)).toEqual({
			creatorNoun: "创作者",
			postNoun: "作品",
			sources: "甲站、乙站",
		});
	});

	it("不在登记表里的拓展取清单的平台名与作品叫法", () => {
		const deps = nounDeps(
			{},
			{
				extensionLabels: { douyin: "抖音" },
				extensionPostNouns: { douyin: "视频" },
			},
		);
		expect(sourceNounsFor(["douyin"], deps, NEUTRAL)).toEqual({
			creatorNoun: "创作者",
			postNoun: "视频",
			sources: "抖音",
		});
	});

	it("不给键:取全部启用订阅的来源,重复的来源只算一个", () => {
		const deps = nounDeps(
			{
				bilibili: { label: "B 站", creatorNoun: "UP主", postNoun: "动态" },
				douyin: { label: "抖音", creatorNoun: "博主", postNoun: "视频" },
			},
			{
				subscriptions: [
					["bilibili", true],
					["douyin", false],
					["bilibili", true],
				],
			},
		);
		expect(sourceNounsFor(undefined, deps, NEUTRAL)).toEqual({
			creatorNoun: "UP主",
			postNoun: "动态",
			sources: "B 站",
		});
	});

	it("不给键且没有启用订阅:取登记表里在册的来源", () => {
		const deps = nounDeps(
			{ bilibili: { label: "B 站", creatorNoun: "UP主", postNoun: "动态" } },
			{ registered: ["bilibili"] },
		);
		expect(sourceNounsFor(undefined, deps, NEUTRAL)).toEqual({
			creatorNoun: "UP主",
			postNoun: "动态",
			sources: "B 站",
		});
	});
});
