import { describe, expect, it } from "vite-plus/test";
import { platformLabelOf, subscriptionIdentityLabelOf } from "../platform-label.js";

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
