/**
 * CSS 框旁那颗「请 AI 帮忙写」什么时候按得动(ADR-0015 决策 10 与它的 🔗)。
 *
 * 判据与服务端建 AI 实例那一条对齐:**当前实例的 key 与地址都填了**。「智能女仆」总开关
 * 不管这颗钮。默认皮肤一律按不动 —— 它的草稿存不下来。按不动时必须说得出为什么。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { cardSkinAiReadiness } from "../card-skin-ai";

function globals(profile: { apiKey?: string; baseUrl?: string }, enabled = true): GlobalConfig {
	return {
		defaults: {
			ai: {
				enabled,
				activeProfile: "p1",
				providers: {
					p1: { provider: "custom", apiKey: "", baseUrl: "", model: "m", ...profile },
				},
			},
		},
	} as unknown as GlobalConfig;
}

describe("cardSkinAiReadiness", () => {
	it("key 与地址都填了 → 按得动(总开关关着也一样)", () => {
		const full = { apiKey: "••••", baseUrl: "https://api.test/v1" };
		expect(cardSkinAiReadiness({ globals: globals(full), readOnly: false })).toEqual({
			ready: true,
		});
		expect(cardSkinAiReadiness({ globals: globals(full, false), readOnly: false })).toEqual({
			ready: true,
		});
	});

	it("少一样 → 按不动,并指路「智能女仆」", () => {
		for (const profile of [{ baseUrl: "https://api.test/v1" }, { apiKey: "••••" }]) {
			const r = cardSkinAiReadiness({ globals: globals(profile), readOnly: false });
			expect(r.ready).toBe(false);
			expect(r.ready === false && r.reason).toMatch(/智能女仆/);
		}
	});

	it("指针指向不存在的实例、或配置里压根没 ai 那一段 → 按不动,不炸", () => {
		const dangling = globals({ apiKey: "k", baseUrl: "u" });
		(dangling.defaults.ai as { activeProfile: string }).activeProfile = "gone";
		expect(cardSkinAiReadiness({ globals: dangling, readOnly: false }).ready).toBe(false);
		expect(cardSkinAiReadiness({ globals: {} as GlobalConfig, readOnly: false }).ready).toBe(false);
	});

	it("配置还没读到 → 按不动,说在读", () => {
		const r = cardSkinAiReadiness({ globals: undefined, readOnly: false });
		expect(r).toMatchObject({ ready: false });
		expect(r.ready === false && r.reason).toMatch(/读取/);
	});

	it("默认皮肤 → 按不动,说先复制一份(模型配没配都一样)", () => {
		const r = cardSkinAiReadiness({
			globals: globals({ apiKey: "k", baseUrl: "u" }),
			readOnly: true,
		});
		expect(r.ready).toBe(false);
		expect(r.ready === false && r.reason).toMatch(/复制一份/);
	});
});
