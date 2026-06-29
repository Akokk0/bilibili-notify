/**
 * 单元测试 —— koishi adaptPush 把 PushKind 翻成 broadcastToFeature 的 opts。
 *
 * 回归契约(用户报告的「重复艾特全体」):图集附图(kind="dynamic-images")必须以
 * `{ allowAtAll: false }` 调 broadcastToFeature,否则会跟主卡片各 @ 一次全体。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { adaptPush } from "../push-adapter.js";

function makeSpyPush() {
	const calls: Array<{ uid: string; feature: string; opts: unknown }> = [];
	const broadcastToFeature = vi.fn(
		async (uid: string, feature: string, _payload: unknown, opts?: unknown) => {
			calls.push({ uid, feature, opts });
			return [];
		},
	);
	return { push: { broadcastToFeature } as never, calls };
}

describe("adaptPush — kind → allowAtAll", () => {
	it("主卡片(dynamic)→ broadcastToFeature 不带抑制 opts", async () => {
		const { push, calls } = makeSpyPush();
		await adaptPush(push).broadcastDynamic("123", [{ type: "text", text: "hi" }], "dynamic");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ uid: "123", feature: "dynamic" });
		expect(calls[0].opts).toBeUndefined();
	});

	it("图集附图(dynamic-images)→ broadcastToFeature 带 { allowAtAll: false }", async () => {
		const { push, calls } = makeSpyPush();
		await adaptPush(push).broadcastDynamic(
			"123",
			[{ type: "image-group", forward: false, images: [{ url: "https://i/1.jpg" }] }],
			"dynamic-images",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ uid: "123", feature: "dynamic" });
		expect(calls[0].opts).toEqual({ allowAtAll: false });
	});
});
