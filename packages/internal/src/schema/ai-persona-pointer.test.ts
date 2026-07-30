/**
 * 人格只住在 `presets[]` 里,`activePreset` 指着当前那一份。
 *
 * 起因:`DEFAULT_AI.persona` 与 `presets[0]`「温柔女仆」本来就是同一份(globals.ts
 * 那句「默认配置 = 首个预设,单一真相」),所以设置页左栏里的「默认」项是个**重复**
 * —— 同一份东西摆两遍,还得解释哪个才算数。删掉它,列表就是纯粹的人格清单。
 *
 * 但 `ai.persona` 是可以被手改的。删掉「默认」入口的同时若不管它,**老用户手写的
 * 那份人格就再也点不到了** —— 数据还在盘上,界面上却没了。所以要有这道迁移:
 *
 *   ① 已经有指针 → 什么都不做
 *   ② `persona` 与某份预设逐字段相同 → 指向那份,不造重复项
 *   ③ `persona` 是手改过的 → **造一份预设装着它**并指过去,一个字都不丢
 *
 * 另有一条不变量:`presets` 恒非空、`activePreset` 恒指向一个真实存在的项 ——
 * 界面上「当前这份人格」永远有着落。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveActivePersona } from "../constants";
import { AISettingsSchema } from "./common";
import { DEFAULT_AI } from "./globals";

/** 新格式的骨架;`presets` / `persona` 由各条测试自己给。 */
function modern(over: Record<string, unknown> = {}) {
	return {
		enabled: true,
		persona: DEFAULT_AI.persona,
		dynamicPrompt: "",
		liveSummaryPrompt: "",
		providers: {},
		presets: DEFAULT_AI.presets,
		...over,
	};
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

describe("首次带上指针", () => {
	it("全新配置 → 指向第一份「温柔女仆」", () => {
		const ai = AISettingsSchema.parse(modern());
		expect(ai.activePreset).toBe("gentle-maid");
		expect(ai.presets[0]?.label).toBe("温柔女仆");
	});

	it("persona 与某份预设一模一样 → 指向它,不平白多造一份重复的", () => {
		const ai = AISettingsSchema.parse(
			modern({ persona: DEFAULT_AI.presets[1]?.persona }), // 傲娇毒舌
		);
		expect(ai.activePreset).toBe("tsundere");
		expect(ai.presets).toHaveLength(DEFAULT_AI.presets.length);
	});

	it("persona 是手改过的 → 造一份预设装着它并指过去,一个字都不丢", () => {
		// 这是最要紧的一条:不这么做的话,主人手写的人格在新界面上就彻底点不到了。
		const ai = AISettingsSchema.parse(modern({ persona: HAND_WRITTEN }));
		const active = ai.presets.find((p) => p.id === ai.activePreset);
		expect(active?.persona).toEqual(HAND_WRITTEN);
	});

	it("手改的那份用 persona.name 当名字,认得出来是自己的", () => {
		const ai = AISettingsSchema.parse(modern({ persona: HAND_WRITTEN }));
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.label).toBe("阿绫");
	});

	it("手改且没起名 → 有个能看的兜底名字,不是一条空白行", () => {
		const ai = AISettingsSchema.parse(modern({ persona: { ...HAND_WRITTEN, name: "" } }));
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.label).toBe("我的性格");
	});

	it("新造那份的 id 不与已有的撞", () => {
		const ai = AISettingsSchema.parse(modern({ persona: HAND_WRITTEN }));
		const ids = ai.presets.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("指针已选定某份、而 persona 恰好像另一份 → **指针说了算**", () => {
		// 最阴的一条:主人选了「傲娇毒舌」,但 ai.persona 还留着女仆那份内容(指针本来
		// 就不改写 persona)。迁移若不先认指针,每次读配置都会按 persona 把选择重置回
		// 「温柔女仆」—— 主人换来换去发现「怎么重启又变回去了」。
		const ai = AISettingsSchema.parse(
			modern({ persona: DEFAULT_AI.persona, activePreset: "tsundere" }),
		);
		expect(ai.activePreset).toBe("tsundere");
	});

	it("已有的 id 就叫 custom-persona 时,新造那份要换个名字", () => {
		const ai = AISettingsSchema.parse(
			modern({
				persona: HAND_WRITTEN,
				presets: [{ id: "custom-persona", label: "占位的", persona: DEFAULT_AI.persona }],
			}),
		);
		const ids = ai.presets.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.persona).toEqual(HAND_WRITTEN);
	});

	it("已经有指针 → 一动不动(迁移只跑一次,不会反复往里塞)", () => {
		const once = AISettingsSchema.parse(modern({ persona: HAND_WRITTEN }));
		const twice = AISettingsSchema.parse(once);
		expect(twice.presets).toHaveLength(once.presets.length);
		expect(twice.activePreset).toBe(once.activePreset);
	});
});

describe("不变量:恒有一份人格可用", () => {
	it("presets 空 → 把**内置四份**补齐,而不是只留一份派生的", () => {
		// 回归守护:`presets: []` 是预设功能上线前写的 globals.json。此前由
		// `ConfigStore` 在加载后补齐内置四份;人格指针那道迁移一旦抢先塞进一份派生的,
		// store 里 `presets.length === 0` 就不再成立,补齐**永远不触发** ——
		// 那些老用户从此只剩孤零零一份,内置的三份凭空消失。
		const ai = AISettingsSchema.parse(modern({ presets: [], persona: HAND_WRITTEN }));
		for (const b of DEFAULT_AI.presets) {
			expect(ai.presets.some((p) => p.id === b.id)).toBe(true);
		}
	});

	it("presets 空且 persona 是手改过的 → 内置四份**加上**他自己那份,并选中自己那份", () => {
		const ai = AISettingsSchema.parse(modern({ presets: [], persona: HAND_WRITTEN }));
		expect(ai.presets).toHaveLength(DEFAULT_AI.presets.length + 1);
		expect(ai.presets.find((p) => p.id === ai.activePreset)?.persona).toEqual(HAND_WRITTEN);
	});

	it("presets 空且 persona 就是内置那份 → 只补内置四份,不多造重复的", () => {
		const ai = AISettingsSchema.parse(modern({ presets: [], persona: DEFAULT_AI.persona }));
		expect(ai.presets).toHaveLength(DEFAULT_AI.presets.length);
		expect(ai.activePreset).toBe("gentle-maid");
	});

	it("指针指着一份不存在的预设 → 收回到第一份,不留悬空", () => {
		const ai = AISettingsSchema.parse(modern({ activePreset: "gone" }));
		expect(ai.activePreset).toBe(ai.presets[0]?.id);
	});
});

/**
 * 指针得**有人读**才算数。
 *
 * 这是「换了人格没反应」那个 bug 的根:指针语义原先只写在 `resolve()` 里(per-UP
 * 那条路),而别的消费方 —— 常驻 generator、「试一句」、锐评、聊天窗抬头 —— 一律
 * 直读 `ai.persona`。那个字段自从指针上线就**再没有界面入口**、永远冻在老值上,
 * 于是主人在设置页换来换去,女仆开口还是原来那位。
 *
 * 所以「当前用哪份人格」只能有一个定义处,就是这个函数;各消费方一律经它。
 */
describe("resolveActivePersona —— 当前用哪份人格,单一读法", () => {
	it("指针指着某份预设 → 用那份的人格,而不是冻在 ai.persona 的那份", () => {
		const ai = AISettingsSchema.parse(
			modern({ persona: DEFAULT_AI.persona, activePreset: "tsundere" }),
		);
		expect(resolveActivePersona(ai).persona.name).toBe("凛子");
	});

	it("两段 prompt 也跟着那份预设走 —— 只换人格不换口吻等于换了一半", () => {
		const ai = AISettingsSchema.parse(
			modern({
				activePreset: "mine",
				presets: [
					...DEFAULT_AI.presets,
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
		expect(resolveActivePersona(ai).dynamicPrompt).toBe("就照这个说");
		expect(resolveActivePersona(ai).liveSummaryPrompt).toBe("直播也照这个说");
	});

	it("那份预设没写 prompt → 回落到全局那两段,不发一段空的", () => {
		// 预设的两段 prompt 是 optional,`undefined` = 「用全局那份」。存空串会让
		// `??` 链落不到全局,女仆从此发一段**空** prompt 出去。
		const ai = AISettingsSchema.parse(
			modern({
				dynamicPrompt: "全局这段",
				liveSummaryPrompt: "全局直播那段",
				activePreset: "mine",
				presets: [{ id: "mine", label: "我的", persona: HAND_WRITTEN }],
			}),
		);
		expect(resolveActivePersona(ai).dynamicPrompt).toBe("全局这段");
		expect(resolveActivePersona(ai).liveSummaryPrompt).toBe("全局直播那段");
	});

	it("指针落空(没填 / 指着一份已删掉的)→ 回落 ai.persona,老配置一字不变", () => {
		const legacy = {
			persona: HAND_WRITTEN,
			dynamicPrompt: "老的那段",
			liveSummaryPrompt: "老的直播那段",
			presets: [],
		};
		expect(resolveActivePersona(legacy).persona).toEqual(HAND_WRITTEN);
		expect(resolveActivePersona({ ...legacy, activePreset: "gone" }).persona).toEqual(HAND_WRITTEN);
		expect(resolveActivePersona({ ...legacy, activePreset: "gone" }).dynamicPrompt).toBe(
			"老的那段",
		);
	});
});
