/**
 * 锐评里「这位是谁」的名字链(`roastSubjectName`):B 站与拓展两条链,按订阅的身份分流。
 *
 *   - B 站:资料里的名字 → `UID <uid>`(主人起的别名**不**参与,改之前锐评就是这条链);
 *   - 拓展:资料里的名字 → 主人起的别名 → 外部 id。
 */

import { makeEmptySubscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { type RoastSubjectDeps, roastPlatformLabel, roastSubjectName } from "../roast-subject.js";

/** 订阅 id → 资料里的名字。 */
function depsWith(profiles: Record<string, string> = {}): RoastSubjectDeps {
	return {
		runtime: {
			subRuntimeStore: {
				get: (id: string) => ({
					cachedProfile: profiles[id] === undefined ? undefined : { name: profiles[id] },
				}),
			},
		},
	} as unknown as RoastSubjectDeps;
}

describe("roastSubjectName", () => {
	it("B 站:有资料名用资料名(去掉首尾空白),没有写 UID", () => {
		const sub = makeEmptySubscription({
			id: "b1",
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		expect(roastSubjectName(depsWith({ b1: "  资料名 " }), sub)).toBe("资料名");
		expect(roastSubjectName(depsWith({ b1: "   " }), sub)).toBe("UID 12345");
		expect(roastSubjectName(depsWith(), sub)).toBe("UID 12345");
	});

	it("拓展:资料名 → 外部 id(别名已退役,ADR-0021 决策 16)", () => {
		const sub = makeExtensionSubscription({ id: "e1", externalId: "sec-1" });
		expect(roastSubjectName(depsWith({ e1: "抖音乙" }), sub)).toBe("抖音乙");
		expect(roastSubjectName(depsWith(), sub)).toBe("sec-1");
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
			engines: { extensionPlatformLabel: (id: string) => extensionLabels[id] },
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
