/**
 * 平台注册表与它的两份**投影**。
 *
 * `WEBHOOK_PLATFORMS` 本该直接从注册表算出来,写成手打的元组只有一个原因:`z.enum` 要求
 * 可枚举的字面量元组,`.filter()` 出来的数组给不出那个类型。
 *
 * 代价就是它会漂 —— 注册表里加一档走 webhook 的新平台、忘了往元组里补一格,
 * 连接照样存得下、面板照样画得出,只有「它算不算 webhook 那一族」在两处说得不一样。
 * 这条用例把两边钉在一起:任何一边单独动都会红。
 *
 * (`atAll` / `inbound` 两列已经从注册表搬走,改由适配器回答,见服务端的 adapter-capabilities 测试。)
 */

import { describe, expect, it } from "vite-plus/test";
import { CONNECTION_PLATFORMS, PLATFORM_REGISTRY, WEBHOOK_PLATFORMS } from "../constants";
import { PlatformSnapshotSchema } from "../schema/targets";

const platformsWhere = (pick: (p: (typeof CONNECTION_PLATFORMS)[number]) => boolean) =>
	CONNECTION_PLATFORMS.filter(pick).sort();

describe("注册表的投影", () => {
	it("WEBHOOK_PLATFORMS 就是注册表里默认走 webhook 连的那些", () => {
		expect([...WEBHOOK_PLATFORMS].sort()).toEqual(
			platformsWhere((p) => PLATFORM_REGISTRY[p].adapterKey === "webhook"),
		);
	});
});

describe("注册表自身", () => {
	it("每个平台都有适配器键,且只有三个内置键", () => {
		// `adapterKey` 是「谁来处理这个平台的连接」的答案;空串或拼错都会让连接落不到任何适配器。
		for (const p of CONNECTION_PLATFORMS) {
			expect(["onebot", "qq-official", "webhook"]).toContain(PLATFORM_REGISTRY[p].adapterKey);
		}
	});

	it("每一行去掉 adapterKey 之后就是一份合法的平台快照", () => {
		for (const p of CONNECTION_PLATFORMS) {
			const { adapterKey: _adapterKey, ...snapshot } = PLATFORM_REGISTRY[p];
			expect(PlatformSnapshotSchema.safeParse(snapshot).success, p).toBe(true);
		}
	});

	it("会话目标的平台要给得出会话种类,单向终点的只有一档", () => {
		for (const p of CONNECTION_PLATFORMS) {
			const { targetKind, scopes } = PLATFORM_REGISTRY[p];
			expect(scopes.length).toBeGreaterThan(0);
			if (targetKind === "endpoint") expect(scopes.length).toBe(1);
		}
	});
});
