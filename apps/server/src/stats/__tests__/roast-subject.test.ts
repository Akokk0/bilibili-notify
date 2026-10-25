/**
 * 锐评里「这位是谁」的名字链(`roastSubjectName`):资料里的名字 → 来源的身份标签。
 * 身份标签由来源描述符与装载器决定,B 站自己不再另走一条链。
 */

import type { UpStatsRow } from "@bilibili-notify/contract";
import type { SourceDescriptor } from "@bilibili-notify/internal";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	type RoastSubjectDeps,
	roastPlatformLabel,
	roastRowName,
	roastSubjectName,
} from "../roast-subject.js";

/** 订阅 id → 资料里的名字;来源登记表与装载器只填名字链真正读到的叫法。 */
function depsWith(
	profiles: Record<string, string> = {},
	descriptors: Record<string, Pick<SourceDescriptor, "label" | "externalIdNoun">> = {},
	extensionLabels: Record<string, string> = {},
): RoastSubjectDeps {
	return {
		runtime: {
			subscriptionStateStore: {
				get: (id: string) => ({
					cachedProfile: profiles[id] === undefined ? undefined : { name: profiles[id] },
				}),
			},
			sourceRegistry: {
				get: (key: string) =>
					descriptors[key] === undefined ? undefined : { descriptor: descriptors[key] },
			},
			pipeline: { extensionPlatformLabel: (id: string) => extensionLabels[id] },
		},
	} as unknown as RoastSubjectDeps;
}

describe("roastSubjectName", () => {
	it("B 站不特殊:描述符没声明叫法时写平台名 · id,声明 UID 时写 UID id", () => {
		const sub = makeEmptySubscription({
			id: "b1",
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		expect(roastSubjectName(depsWith({ b1: "  资料名 " }), sub)).toBe("资料名");
		const bare = depsWith({}, { bilibili: { label: "B 站" } });
		expect(roastSubjectName(bare, sub)).toBe("B 站 · 12345");
		const withNoun = depsWith({}, { bilibili: { label: "B 站", externalIdNoun: "UID" } });
		expect(roastSubjectName(withNoun, sub)).toBe("UID 12345");
	});

	it("拓展没资料名时用身份标签:登记表或装载器给平台名,卸了就退来源键", () => {
		const sub = makeExtensionSubscription({ id: "e1", externalId: "sec-1" });
		expect(roastSubjectName(depsWith({ e1: "抖音乙" }), sub)).toBe("抖音乙");
		const registered = depsWith({}, { douyin: { label: "抖音" } });
		expect(roastSubjectName(registered, sub)).toBe("抖音 · sec-1");
		const unloaded = makeExtensionSubscription({
			id: "gone",
			extensionId: "gone.ext",
			externalId: "sec-2",
		});
		expect(roastSubjectName(depsWith(), unloaded)).toBe("gone.ext · sec-2");
	});

	it("订阅已删:统计行按行上的身份走同一个标签", () => {
		const bare = depsWith({}, { bilibili: { label: "B 站" } });
		const biliRow = {
			identity: { sourceKey: "bilibili", externalId: "12345" },
		} as UpStatsRow;
		expect(roastRowName(bare, biliRow, undefined)).toBe("B 站 · 12345");
		const withNoun = depsWith({}, { bilibili: { label: "B 站", externalIdNoun: "UID" } });
		expect(roastRowName(withNoun, biliRow, undefined)).toBe("UID 12345");
		const goneRow = {
			identity: { sourceKey: "gone.ext", externalId: "sec-2" },
		} as UpStatsRow;
		expect(roastRowName(depsWith(), goneRow, undefined)).toBe("gone.ext · sec-2");
	});
});

/** 来源登记表里各键的 `label`;拓展装载器说的平台名(`extensionPlatformLabel`)另给。 */
function platformDeps(
	labels: Record<string, string>,
	extensionLabels: Record<string, string> = {},
): RoastSubjectDeps {
	return {
		runtime: {
			sourceRegistry: {
				get: (key: string) =>
					labels[key] === undefined ? undefined : { descriptor: { label: labels[key] } },
			},
			pipeline: { extensionPlatformLabel: (id: string) => extensionLabels[id] },
		},
	} as unknown as RoastSubjectDeps;
}

describe("roastPlatformLabel(「平台」那一列)", () => {
	// 验红:把函数改回「按键判 B 站、别的问装载器」,第一条(登记表里的假来源)读到键名,红。
	it("在来源登记表里的来源:读描述符的 label(B 站「B 站」,别的来源它自己的叫法)", () => {
		const deps = platformDeps({ bilibili: "B 站", "acme.inprocess": "对拍源" });
		expect(roastPlatformLabel(deps, { sourceKey: "bilibili", externalId: "1" })).toBe("B 站");
		expect(roastPlatformLabel(deps, { sourceKey: "acme.inprocess", externalId: "x" })).toBe(
			"对拍源",
		);
	});

	it("不在登记表里的(拓展):装载器说的平台名;取不到(拓展卸了)写拓展 id", () => {
		const deps = platformDeps({ bilibili: "B 站" }, { douyin: "抖音" });
		expect(roastPlatformLabel(deps, { sourceKey: "douyin", externalId: "s" })).toBe("抖音");
		expect(roastPlatformLabel(deps, { sourceKey: "gone.ext", externalId: "s" })).toBe("gone.ext");
	});

	it("登记表优先于装载器:同一个键两边都有,取登记表的", () => {
		const deps = platformDeps({ "acme.inprocess": "对拍源" }, { "acme.inprocess": "装载器说的" });
		expect(roastPlatformLabel(deps, { sourceKey: "acme.inprocess", externalId: "x" })).toBe(
			"对拍源",
		);
	});
});
