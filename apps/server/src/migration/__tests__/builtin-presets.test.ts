/**
 * 0.x 的内置人格不搬进 1.0:清单里只留主人自己的,并记下主人当年删过哪几份。
 *
 * 输入从冻住的 0.12 出厂夹具起步,只经完整迁移流水;期望值独立写成字面量,不拿运行时的内置表反算。
 */

import { GlobalSettingsSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { migrateGlobalsToCurrent } from "../settings.js";
import { makeZeroGlobals } from "./zero-fixtures.js";

type Obj = Record<string, unknown>;

interface MigratedGlobals {
	defaults: { templates: Obj };
	templatesSeen?: Obj;
	ai: Obj;
}

function zeroGlobals() {
	return makeZeroGlobals() as unknown as {
		defaults: { ai: Obj & { presets: Obj[] } };
	};
}

function migrated(raw: ReturnType<typeof zeroGlobals>): MigratedGlobals {
	return migrateGlobalsToCurrent(raw) as MigratedGlobals;
}

function presets(raw: ReturnType<typeof zeroGlobals>): Obj[] {
	return raw.defaults.ai.presets;
}

/** 预设上线前的清单迁移后得到的那份主人副本:文字取自冻住的 0.12 夹具,不拿运行时内置表反算。 */
function customPersonaFromZeroTop(raw: ReturnType<typeof zeroGlobals>): Obj[] {
	return [
		{
			id: "custom-persona",
			label: "小绫",
			persona: structuredClone(raw.defaults.ai.persona),
			dynamicPrompt:
				"主人订阅的 UP 主刚刚更新了动态,请用温柔的语气向主人转述核心内容,并补一两句你的看法。",
			liveSummaryPrompt:
				"用温柔的语气向主人讲讲直播主要发生了什么(150-200 字),从弹幕和氛围中提炼亮点。",
		},
	];
}

/** 0.x 不会自己写出的三种「预设上线前」清单形状:手改过的 globals.json 才可能有。 */
const PRE_PRESETS_SHAPES: [string, (ai: Obj) => void][] = [
	["缺 presets 键", (ai) => delete ai.presets],
	["presets 是 null", (ai) => (ai.presets = null)],
	["presets 是非数组对象", (ai) => (ai.presets = {})],
];

const OWNER_PRESET: Obj = {
	id: "mine",
	label: "我的人格",
	persona: {
		name: "阿绫",
		addressUser: "老板",
		addressSelf: "我",
		traits: "话少、干脆",
		catchphrase: "",
		baseRole: "简洁汇报,不寒暄。",
		extraSystemPrompt: "",
	},
	dynamicPrompt: "用我自己的口气汇报。",
	liveSummaryPrompt: "用我自己的口气总结。",
};

describe("0.x 内置人格 → removedBuiltinPresets", () => {
	it("四份都在:只留主人自己的,不写删除清单;顶层人格三格删掉,内置指针照指", () => {
		const raw = zeroGlobals();
		raw.defaults.ai.presets = [...presets(raw), OWNER_PRESET];
		raw.defaults.ai.activePreset = "mine";

		const out = migrated(raw);

		expect(out.ai.presets).toEqual([OWNER_PRESET]);
		expect(out.ai).not.toHaveProperty("removedBuiltinPresets");
		expect(out.ai.activePreset).toBe("mine");
		for (const key of ["persona", "dynamicPrompt", "liveSummaryPrompt"]) {
			expect(out.ai).not.toHaveProperty(key);
		}

		const rawBuiltIn = zeroGlobals();
		rawBuiltIn.defaults.ai.activePreset = "analyst";
		expect(migrated(rawBuiltIn).ai.activePreset).toBe("analyst");
	});

	it("少一份:写那一个 id,主人自己的预设顺序不变", () => {
		const raw = zeroGlobals();
		raw.defaults.ai.presets = [
			...presets(raw).filter((preset) => preset.id !== "tsundere"),
			OWNER_PRESET,
		];

		const out = migrated(raw);

		expect(out.ai.removedBuiltinPresets).toEqual(["tsundere"]);
		expect(out.ai.presets).toEqual([OWNER_PRESET]);
	});

	it("少两份:按冻住的表写,不按盘上的先后写", () => {
		const raw = zeroGlobals();
		raw.defaults.ai.presets = presets(raw).filter(
			(preset) => preset.id !== "analyst" && preset.id !== "tsundere",
		);

		expect(migrated(raw).ai.removedBuiltinPresets).toEqual(["tsundere", "analyst"]);
	});

	it("非空清单里一份内置都没有:四份都记成删过", () => {
		const raw = zeroGlobals();
		raw.defaults.ai.presets = [OWNER_PRESET];
		raw.defaults.ai.activePreset = "mine";

		const out = migrated(raw);

		expect(out.ai.removedBuiltinPresets).toEqual(["gentle-maid", "tsundere", "analyst", "genki"]);
		expect(out.ai.presets).toEqual([OWNER_PRESET]);
	});

	it("presets 原本为空:不写删除清单,顶层人格造成主人的一份", () => {
		const raw = zeroGlobals();
		raw.defaults.ai.presets = [];

		const out = migrated(raw);

		expect(out.ai).not.toHaveProperty("removedBuiltinPresets");
		expect(out.ai.presets).toEqual(customPersonaFromZeroTop(raw));
		expect(out.ai.activePreset).toBe("custom-persona");
	});

	it.each(PRE_PRESETS_SHAPES)(
		"预设上线前的清单(%s):不写删除清单,顶层人格造成主人的一份",
		(_label, makePrePresets) => {
			const raw = zeroGlobals();
			makePrePresets(raw.defaults.ai);

			const out = migrated(raw);

			expect(out.ai).not.toHaveProperty("removedBuiltinPresets");
			expect(out.ai.presets).toEqual(customPersonaFromZeroTop(raw));
			expect(out.ai.activePreset).toBe("custom-persona");
		},
	);

	it("按 id 认内置:内容换成 0.x 原文之外的句子也照样拆出", () => {
		const raw = zeroGlobals();
		const builtins = presets(raw);
		const changed = structuredClone(builtins);
		const first = changed[0];
		if (first === undefined) throw new Error("missing first built-in preset");
		(first.persona as Obj).name = "手改过的女仆";
		first.label = "我自己的女仆";
		raw.defaults.ai.presets = [...changed, OWNER_PRESET];

		const out = migrated(raw);

		expect(out.ai.presets).toEqual([OWNER_PRESET]);
		expect(out.ai).not.toHaveProperty("removedBuiltinPresets");
	});

	it("原样 0.12 出厂设置走完整流水:文字与账本都空,人格只剩运行时那套,过得了活 schema", () => {
		const out = migrated(zeroGlobals());

		expect(out.defaults.templates).toEqual({
			wordcloudStopWords: "",
			membership: {
				guard: {
					enabled: false,
					default: { imageUrl: "" },
					tiers: {},
				},
			},
		});
		expect(out.templatesSeen).toEqual({});
		expect(out.ai.presets).toEqual([]);
		expect(out.ai).not.toHaveProperty("removedBuiltinPresets");
		for (const key of ["persona", "dynamicPrompt", "liveSummaryPrompt"]) {
			expect(out.ai).not.toHaveProperty(key);
		}
		expect(GlobalSettingsSchema.safeParse(out).success).toBe(true);
	});
});
