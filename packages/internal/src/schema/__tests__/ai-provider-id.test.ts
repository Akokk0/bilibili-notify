/**
 * AI 实例表(`ai.providers`)的键是实例 id:拿来查表的键,所以过原型名那道检查(与日志模块的键、来源键同一条)。
 *
 * 钉:`constructor` / `toString` 这类原型名当键被拒,逐格原因的路径落在 `["providers", "<id>"]`;
 * 面板生成的 id(`deepseek`、`deepseek-2`)与带点、带冒号的手写 id 不受影响(这一道只管原型名,不改别的)。
 * `__proto__` 不在这里钉:zod 的 record 在把键交给键的规则之前就跳过它,schema 拦不住,由配置仓的解析层自己记坏格。
 */

import { describe, expect, it } from "vite-plus/test";
import { AISettingsSchema } from "../common";
import { DEFAULT_AI } from "../globals";

const GOOD_PROFILE = { provider: "deepseek" };

function withProviders(providers: Record<string, unknown>): unknown {
	return { ...structuredClone(DEFAULT_AI), providers };
}

describe("ai.providers 的实例 id", () => {
	it("面板生成的 id 与手写的带点、带冒号的 id 照常通过", () => {
		for (const id of ["deepseek", "deepseek-2", "my.local", "a:vision"]) {
			expect(AISettingsSchema.safeParse(withProviders({ [id]: GOOD_PROFILE })).success).toBe(true);
		}
	});

	it("原型名当实例 id 被拒,原因落在这一家的键上", () => {
		for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
			const parsed = AISettingsSchema.safeParse(withProviders({ [id]: GOOD_PROFILE }));
			expect(parsed.success).toBe(false);
			if (parsed.success) continue;
			const paths = parsed.error.issues.map((i) => i.path.join("."));
			expect(paths.some((p) => p.startsWith("providers"))).toBe(true);
		}
	});
});
