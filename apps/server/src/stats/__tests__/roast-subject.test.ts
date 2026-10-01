/**
 * 锐评里「这位是谁」的名字链(`roastSubjectName`):B 站与拓展两条链,按订阅的身份分流。
 *
 *   - B 站:资料里的名字 → `UID <uid>`(主人起的别名**不**参与,改之前锐评就是这条链);
 *   - 拓展:资料里的名字 → 主人起的别名 → 外部 id。
 */

import { makeEmptySubscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { type RoastSubjectDeps, roastSubjectName } from "../roast-subject.js";

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
