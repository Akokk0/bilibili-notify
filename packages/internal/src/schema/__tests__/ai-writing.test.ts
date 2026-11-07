/**
 * AI 写正文(`ai.writing`,ADR-0032):动态与直播总结各一份「默认 + 按目标例外」。
 * 形状只经 `GlobalSettingsSchema.parse` 验,折叠只经 `aiWritingFor` / `aiWritingNeeded` 验。
 */

import { describe, expect, it } from "vite-plus/test";
import { aiWritingFor, aiWritingNeeded } from "../ai-writing";
import { GlobalSettingsSchema, makeDefaultGlobalSettings } from "../globals";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("schema:ai.writing", () => {
	it("老设置没有 writing 这一格 → 两份都是 { isOnByDefault: true, byTarget: {} }", () => {
		const old = structuredClone(makeDefaultGlobalSettings()) as Record<string, unknown>;
		const ai = { ...(old.ai as Record<string, unknown>) };
		delete ai.writing;
		const parsed = GlobalSettingsSchema.parse({ ...old, ai });
		expect(parsed.ai.writing).toEqual({
			post: { isOnByDefault: true, byTarget: {} },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		});
	});

	it("写了的例外原样读回,两个方向都行", () => {
		const base = structuredClone(makeDefaultGlobalSettings());
		const parsed = GlobalSettingsSchema.parse({
			...base,
			ai: {
				...base.ai,
				writing: {
					post: { isOnByDefault: false, byTarget: { [A]: true } },
					liveSummary: { isOnByDefault: true, byTarget: { [B]: false } },
				},
			},
		});
		expect(parsed.ai.writing.post).toEqual({ isOnByDefault: false, byTarget: { [A]: true } });
		expect(parsed.ai.writing.liveSummary).toEqual({
			isOnByDefault: true,
			byTarget: { [B]: false },
		});
	});

	it("目标 id 不是 uuid → 整份解析不过", () => {
		const base = structuredClone(makeDefaultGlobalSettings());
		const r = GlobalSettingsSchema.safeParse({
			...base,
			ai: { ...base.ai, writing: { post: { byTarget: { 不是uuid: true } } } },
		});
		expect(r.success).toBe(false);
	});
});

describe("aiWritingFor", () => {
	it.each([
		["默认开、例外写开", true, true, true],
		["默认开、例外写关", true, false, false],
		["默认开、没写例外", true, undefined, true],
		["默认关、例外写开", false, true, true],
		["默认关、例外写关", false, false, false],
		["默认关、没写例外", false, undefined, false],
	] as const)("%s", (_name, isOnByDefault, exception, expected) => {
		const byTarget: Record<string, boolean> = exception === undefined ? {} : { [A]: exception };
		const entry = { isOnByDefault, byTarget };
		expect(aiWritingFor(entry, A)).toBe(expected);
	});

	it("别的目标写了例外不影响这个目标", () => {
		expect(aiWritingFor({ isOnByDefault: false, byTarget: { [B]: true } }, A)).toBe(false);
	});
});

describe("aiWritingNeeded", () => {
	it("默认开 → 要生成,哪怕没有目标", () => {
		expect(aiWritingNeeded({ isOnByDefault: true, byTarget: {} }, [])).toBe(true);
	});

	it("默认关、无例外 → 不用生成", () => {
		expect(aiWritingNeeded({ isOnByDefault: false, byTarget: {} }, [A, B])).toBe(false);
	});

	it("默认关、一条例外开且目标还在 → 要生成", () => {
		expect(aiWritingNeeded({ isOnByDefault: false, byTarget: { [A]: true } }, [A, B])).toBe(true);
	});

	it("默认关、唯一一条开的例外指向已经不在的目标 → 不用生成", () => {
		expect(aiWritingNeeded({ isOnByDefault: false, byTarget: { [A]: true } }, [B])).toBe(false);
	});

	it("默认关、例外写的是关 → 不用生成", () => {
		expect(aiWritingNeeded({ isOnByDefault: false, byTarget: { [A]: false } }, [A])).toBe(false);
	});
});
