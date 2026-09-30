/**
 * 人格只住在 `presets[]` 里,`activePreset` 指着当前那一份。
 *
 * 起因:`DEFAULT_AI.persona` 与 `presets[0]`「温柔女仆」本来就是同一份(globals.ts
 * 那句「默认配置 = 首个预设,单一真相」),所以设置页左栏里的「默认」项是个**重复**
 * —— 同一份东西摆两遍,还得解释哪个才算数。删掉它,列表就是纯粹的人格清单。
 *
 * 但 `ai.persona` 是可以被手改的。删掉「默认」入口的同时若不管它,**老用户手写的
 * 那份人格就再也点不到了** —— 数据还在盘上,界面上却没了。所以开新代时由迁移器改写
 * (`apps/server/src/migration/ai.ts`,用例在服务端的 `migration/__tests__/settings.test.ts`):
 *
 *   ① 已经有指针 → 什么都不做
 *   ② `persona` 与某份预设逐字段相同 → 指向那份,不造重复项
 *   ③ `persona` 是手改过的 → **造一份预设装着它**并指过去,一个字都不丢
 *
 * 另有一条不变量:`presets` 恒非空(空的补齐内置四份)、`activePreset` 恒指向一个真实存在的项 ——
 * 界面上「当前这份人格」永远有着落。这条由迁移器保证;全新安装的默认值自带指针
 * (`DEFAULT_AI.activePreset`)。
 *
 * 这里的活 schema 只认新形状:没有指针的配置不会被补上指针(见文末「活 schema 不再认老形状」),
 * 文件主体留的是消费方 `resolveActivePersona`。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveActivePersona } from "../../constants";
import { AISettingsSchema } from "../common";
import { DEFAULT_AI } from "../globals";

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

describe("活 schema 不再认老形状(那是迁移器的事)", () => {
	// schema 上没有 preprocess:喂老形状进来得到的是原样收下,而不是「悄悄帮你迁」。0.x 的老形状只在开新代时由
	// 迁移器改写一次;谁把老数据的兜底加回 schema,这几条就红(那会让同一份迁移逻辑在 schema 和迁移器里各住一份)。

	it("没有 activePreset 的配置 → 不会被补上指针,手改的 persona 也不会被造成一份预设", () => {
		const ai = AISettingsSchema.parse(modern({ persona: HAND_WRITTEN }));
		expect(ai.activePreset).toBeUndefined();
		expect(ai.presets).toEqual(DEFAULT_AI.presets);
	});

	it("presets 是空的 → 不会被补齐内置四份", () => {
		const ai = AISettingsSchema.parse(modern({ presets: [], persona: HAND_WRITTEN }));
		expect(ai.presets).toEqual([]);
		expect(ai.activePreset).toBeUndefined();
	});

	it("指针指着一份不存在的预设 → 原样收下,不会被收回到第一份", () => {
		const ai = AISettingsSchema.parse(modern({ activePreset: "gone" }));
		expect(ai.activePreset).toBe("gone");
	});
});
