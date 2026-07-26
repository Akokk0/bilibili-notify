/**
 * 内置人格的图标。
 *
 * 主人加的性格用通用的小人像;四份**内置**的各有各的样子 —— 它们是主人一眼要认出
 * 「哪个是哪个」的那几份,清一色小人像等于没图标。
 *
 * 这里守的是**别漏画**:内置预设清单住在 `packages/internal` 的 `DEFAULT_AI`,
 * 哪天往那儿加了第五份而没人画图标,左栏就会混进一个不合群的小人像 —— 而这种事
 * 在界面上要盯着看才发现得了。
 */

import { DEFAULT_AI } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_PERSONA_ICONS, personaIconKey } from "../persona-icons";

describe("BUILTIN_PERSONA_ICONS", () => {
	it("每一份内置人格都画了图标", () => {
		const missing = DEFAULT_AI.presets
			.map((p) => p.id)
			.filter((id) => !(id in BUILTIN_PERSONA_ICONS));
		expect(missing).toEqual([]);
	});

	it("四份内置各不相同 —— 图标是用来区分的,撞了就白画", () => {
		const used = Object.values(BUILTIN_PERSONA_ICONS);
		expect(new Set(used).size).toBe(used.length);
	});

	it("没有多余条目 —— 指着一份并不存在的预设说明是改 id 时漏改了", () => {
		const builtin = new Set<string>(DEFAULT_AI.presets.map((p) => p.id));
		expect(Object.keys(BUILTIN_PERSONA_ICONS).filter((id) => !builtin.has(id))).toEqual([]);
	});
});

describe("personaIconKey", () => {
	it("四份各是哪个,逐一钉住 —— 这是主人点名挑的,不该被顺手改掉", () => {
		// 「表与界面一致」那条测试(Ai.rails)比的是两边对不对得上,改表两边一起变,
		// 所以挡不住「悄悄换成别的图标」。主人的选择要在这里落成白纸黑字。
		expect(personaIconKey("gentle-maid")).toBe("heart");
		expect(personaIconKey("tsundere")).toBe("fire");
		expect(personaIconKey("analyst")).toBe("calculator");
		expect(personaIconKey("genki")).toBe("sun");
	});

	it("主人新加的用通用小人像", () => {
		expect(personaIconKey("persona-1")).toBe("user");
	});

	it("迁移出来的「我的性格」也走通用那个", () => {
		// 它是老配置里手改过的 persona 被搬出来的那一份,不属于内置四份。
		expect(personaIconKey("custom-persona")).toBe("user");
	});
});
