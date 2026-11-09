/**
 * CSS 框旁那颗「请女仆帮忙写」什么时候按得动(ADR-0015 决策 10 与它的 🔗)。
 *
 * 判据与服务端建 AI 实例那一条对齐:**当前实例的 key 与地址都填了**。「智能女仆」总开关
 * 不管这颗钮。默认皮肤一律按不动 —— 它的草稿存不下来。按不动时必须说得出为什么。
 */

import type { GlobalSettingsView } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { cardSkinAiReadiness } from "../card-skin-ai";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

function globals(
	profile: { apiKey?: unknown; baseUrl?: string },
	enabled = true,
): GlobalSettingsView {
	return {
		ai: {
			enabled,
			activeProfile: "p1",
			providers: {
				p1: { provider: "custom", apiKey: "", baseUrl: "", model: "m", ...profile },
			},
		},
	} as unknown as GlobalSettingsView;
}

describe("cardSkinAiReadiness", () => {
	it.each([
		[
			"en",
			"The built-in default skin is read-only. Copy it in the library before asking the maid to edit it.",
			"Loading model settings…",
			"Configure the current provider’s API key and endpoint in AI maid first.",
		],
		[
			"ja",
			"内蔵の既定スキンは読み取り専用です。ライブラリーで複製してから、メイドに編集を依頼してください。",
			"モデル設定を読み込み中…",
			"先に「AIメイド」で、使用中のプロバイダーのAPIキーと接続先URLを設定してください。",
		],
		[
			"zh-TW",
			"內建預設外觀為唯讀。請先在資源庫複製一份，再請女僕編輯。",
			"正在讀取模型設定…",
			"請先到「智慧女僕」設定目前供應商的 API 金鑰與端點網址。",
		],
	] as const)(
		"%s explains unavailable actions without changing readiness rules",
		(locale, readOnly, pending, missing) => {
			i18n.set({ locale, voice: "plain" });
			expect(cardSkinAiReadiness({ globals: undefined, readOnly: true })).toEqual({
				ready: false,
				reason: readOnly,
			});
			expect(cardSkinAiReadiness({ globals: undefined, readOnly: false })).toEqual({
				ready: false,
				reason: pending,
			});
			expect(cardSkinAiReadiness({ globals: globals({}), readOnly: false })).toEqual({
				ready: false,
				reason: missing,
			});
			expect(
				cardSkinAiReadiness({
					globals: globals({ apiKey: { masked: "••••" }, baseUrl: "https://api.test/v1" }, false),
					readOnly: false,
				}),
			).toEqual({ ready: true });
		},
	);
	it("key 与地址都填了 → 按得动(总开关关着也一样)", () => {
		const full = { apiKey: { masked: "••••••••" }, baseUrl: "https://api.test/v1" };
		expect(cardSkinAiReadiness({ globals: globals(full), readOnly: false })).toEqual({
			ready: true,
		});
		expect(cardSkinAiReadiness({ globals: globals(full, false), readOnly: false })).toEqual({
			ready: true,
		});
	});

	it("少一样 → 按不动,并指路「智能女仆」", () => {
		for (const profile of [
			{ baseUrl: "https://api.test/v1" },
			{ apiKey: { masked: "••••••••" } },
		]) {
			const r = cardSkinAiReadiness({ globals: globals(profile), readOnly: false });
			expect(r.ready).toBe(false);
			expect(r.ready === false && r.reason).toMatch(/智能女仆/);
		}
	});

	it("指针指向不存在的实例、或配置里压根没 ai 那一段 → 按不动,不炸", () => {
		const dangling = globals({ apiKey: "k", baseUrl: "u" });
		(dangling.ai as { activeProfile: string }).activeProfile = "gone";
		expect(cardSkinAiReadiness({ globals: dangling, readOnly: false }).ready).toBe(false);
		expect(cardSkinAiReadiness({ globals: {} as GlobalSettingsView, readOnly: false }).ready).toBe(
			false,
		);
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
