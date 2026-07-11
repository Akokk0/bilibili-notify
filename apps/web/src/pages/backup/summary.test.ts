import { describe, expect, it } from "vite-plus/test";
import type { ImportResult } from "./summary";
import { summarizeImport } from "./summary";

/**
 * 脱敏备份**不含任何凭据** —— 恢复回来的适配器密钥是空的、AI API Key 是空的。
 * 配置都在、开关也开着,但推不出去。用户不会想到是这个原因,除非导入回执直接讲明。
 *
 * (schema 层的坑同时也修了:appSecret 曾经 `.min(1)`,脱敏档根本存不回去,直接
 * ConfigValidationError。见 packages/internal/src/schema/targets.ts。)
 */

const empty: ImportResult = {
	subscriptions: { upserted: 0, deleted: 0 },
	adapters: { upserted: 0, deleted: 0 },
	targets: { upserted: 0, deleted: 0 },
	globalsApplied: false,
	cookiesRestored: false,
};

describe("summarizeImport", () => {
	it("逐段汇总改动量", () => {
		const s = summarizeImport(
			{
				...empty,
				subscriptions: { upserted: 3, deleted: 1 },
				targets: { upserted: 2, deleted: 0 },
				cookiesRestored: true,
			},
			"full",
		);

		expect(s).toContain("订阅 3 项、删除 1 项");
		expect(s).toContain("推送目标 2 项");
		expect(s).toContain("B 站登录已恢复");
	});

	it("无改动时说清「无改动」,不留空", () => {
		expect(summarizeImport(empty, "full")).toContain("无改动");
	});

	describe("脱敏档:凭据是空的,必须讲出来", () => {
		it("导入了适配器 → 提示重填适配器密钥", () => {
			const s = summarizeImport({ ...empty, adapters: { upserted: 1, deleted: 0 } }, "sanitized");

			expect(s).toContain("不含凭据");
			expect(s).toContain("适配器密钥");
		});

		it("应用了全局设置 → 提示重填 AI API Key", () => {
			const s = summarizeImport({ ...empty, globalsApplied: true }, "sanitized");

			expect(s).toContain("AI API Key");
		});

		// 完整备份带着密钥一起回来,提示只会添乱。
		it("完整备份不提示", () => {
			const s = summarizeImport(
				{ ...empty, adapters: { upserted: 1, deleted: 0 }, globalsApplied: true },
				"full",
			);

			expect(s).not.toContain("不含凭据");
		});

		// 脱敏档但这次只导了订阅 —— 压根没碰带凭据的东西,别喊狼来了。
		it("脱敏档但没导入任何带凭据的段 → 不提示", () => {
			const s = summarizeImport(
				{ ...empty, subscriptions: { upserted: 3, deleted: 0 } },
				"sanitized",
			);

			expect(s).not.toContain("不含凭据");
		});
	});
});
