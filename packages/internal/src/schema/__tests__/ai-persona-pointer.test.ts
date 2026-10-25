/**
 * 人格只住在清单里,`activePreset` 指着当前那一份(内置没删的 + 主人自己的,见 `presetsOf`)。
 *
 * 这里的活 schema 只认新形状:没有指针的配置不会被补上指针,老盘上的顶层 `persona` / 两段提示词读时剥掉
 * (那是迁移器的事)。文件主体留的是消费方 `resolveActivePersona` 与「读时剥掉」。
 * 清单与回落的细节在 `__tests__/persona-list.test.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveActivePersona } from "../../ai";
import { builtinPresetsFor } from "../../builtin-texts";
import { AISettingsSchema } from "../common";

const BUILTINS = builtinPresetsFor("zh-CN");

/** 新格式的骨架;`presets` 由各条测试自己给。 */
function modern(over: Record<string, unknown> = {}) {
	return { enabled: true, providers: {}, ...over };
}

const HAND_WRITTEN = {
	name: "阿绫",
	addressUser: "老板",
	addressSelf: "我",
	traits: "话少、干脆",
	catchphrase: "",
	baseRole: "简洁汇报,不寒暄。",
	extraSystemPrompt: "",
};

/**
 * 指针得**有人读**才算数。「当前用哪份人格」只能有一个定义处,就是这个函数;
 * 常驻 generator、「试一句」、锐评、聊天窗抬头一律经它。
 */
describe("resolveActivePersona —— 当前用哪份人格,单一读法", () => {
	it("指针指着内置 → 用那份内置的人格", () => {
		const ai = AISettingsSchema.parse(modern({ activePreset: "tsundere" }));
		expect(resolveActivePersona(ai, BUILTINS).persona.name).toBe("凛子");
	});

	it("两段 prompt 也跟着那份预设走 —— 只换人格不换口吻等于换了一半", () => {
		const ai = AISettingsSchema.parse(
			modern({
				activePreset: "mine",
				presets: [
					{
						id: "mine",
						label: "我的",
						persona: HAND_WRITTEN,
						dynamicPrompt: "就照这个说",
						liveSummaryPrompt: "直播也照这个说",
					},
				],
			}),
		);
		expect(resolveActivePersona(ai, BUILTINS).dynamicPrompt).toBe("就照这个说");
		expect(resolveActivePersona(ai, BUILTINS).liveSummaryPrompt).toBe("直播也照这个说");
	});

	it("那份预设没写 prompt → 回落内置首份的那段,不发一段空的", () => {
		const ai = AISettingsSchema.parse(
			modern({
				activePreset: "mine",
				presets: [{ id: "mine", label: "我的", persona: HAND_WRITTEN }],
			}),
		);
		expect(resolveActivePersona(ai, BUILTINS).dynamicPrompt).toBe(BUILTINS[0]?.dynamicPrompt);
		expect(resolveActivePersona(ai, BUILTINS).liveSummaryPrompt).toBe(
			BUILTINS[0]?.liveSummaryPrompt,
		);
	});

	it("指针落空(没填 / 指着一份已删掉的)→ 回落清单第一份", () => {
		const ai = AISettingsSchema.parse(modern({ activePreset: "gone" }));
		expect(resolveActivePersona(ai, BUILTINS).persona).toEqual(BUILTINS[0]?.persona);
		expect(resolveActivePersona(AISettingsSchema.parse(modern()), BUILTINS).persona).toEqual(
			BUILTINS[0]?.persona,
		);
	});
});

describe("活 schema 不再认老形状(那是迁移器的事)", () => {
	it("没有 activePreset 的配置 → 不会被补上指针", () => {
		const ai = AISettingsSchema.parse(modern());
		expect(ai.activePreset).toBeUndefined();
		expect(ai.presets).toEqual([]);
	});

	it("老盘上的顶层 persona / 两段提示词 → 读时剥掉,手改的 persona 也不会被造成一份预设", () => {
		const ai = AISettingsSchema.parse(
			modern({ persona: HAND_WRITTEN, dynamicPrompt: "老的", liveSummaryPrompt: "老的" }),
		) as Record<string, unknown>;
		expect("persona" in ai).toBe(false);
		expect("dynamicPrompt" in ai).toBe(false);
		expect("liveSummaryPrompt" in ai).toBe(false);
		expect(ai.presets).toEqual([]);
	});

	it("指针指着一份不存在的预设 → 原样收下,不会被收回到第一份", () => {
		const ai = AISettingsSchema.parse(modern({ activePreset: "gone" }));
		expect(ai.activePreset).toBe("gone");
	});
});
