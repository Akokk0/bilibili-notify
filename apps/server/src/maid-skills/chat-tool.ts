/**
 * 聊天里的 `load_skill` —— 女仆自己挑一条技能来用的那条路(ADR-0001 决策 7)。
 *
 * 与 `create_skin` 同一条注入路(dashboard 聊天的 ExtraTool),**绝不进
 * `TOOL_DEFINITIONS`** —— 那张表是群聊路径也共享的,而群里没有权限门,任何人都能
 * 触发主人写的技能正文。
 *
 * 常驻成本就是下面这份目录:每一条可自选技能的 `name` + `description`。正文只在
 * 真被读取那一轮才进上下文 —— 这正是「技能」比「一句预置提问」省的地方。
 */

import type { ExtraTool } from "@bilibili-notify/ai";
import { AI_TOOL_LOAD_SKILL } from "@bilibili-notify/contract";
import type { MaidSkillEntry } from "./store.js";

/**
 * 建一把 `load_skill`;一条可自选的技能都没有就返回 `null`。
 *
 * 返回 null 而不是一把空工具:挂上去只会让模型调它、拿回一句「一条都没有」,
 * 白烧一整轮。
 *
 * 收的是**快照**而不是 store:目录要写进工具定义,建的那一刻就得知道有哪些。
 * 调用方负责在建之前把盘读新(`reload()`)。
 */
/**
 * 一条技能正文交给模型时的说法。
 *
 * 两条路共用:女仆自己 `load_skill` 挑的,和主人打斜杠点名的(routes/ai.ts 把它
 * 当 `systemSuffix`)。ADR 决策 14 要求两条路把同一段正文以**同样方式**追加在
 * 人格之后 —— 各写一句的话,改了措辞而另一处不动,两条路就在教模型不同的东西,
 * 而这件事没有任何类型或测试会红,只能靠真机上分别触发两次去比对。
 */
export function skillInstruction(skill: Pick<MaidSkillEntry, "name" | "body">): string {
	return `以下是技能「${skill.name}」的做法,照着做:\n\n${skill.body}`;
}

export function createSkillChatTool(skills: readonly MaidSkillEntry[]): ExtraTool | null {
	// `disable-model-invocation` 的退出自选 —— 那是「只许主人打斜杠」的意思。
	const pickable = skills.filter((s) => !s.disableModelInvocation);
	if (pickable.length === 0) return null;

	const catalog = pickable.map((s) => `- ${s.name}:${s.description}`).join("\n");
	const byName = new Map(pickable.map((s) => [s.name, s]));

	return {
		definition: {
			type: "function",
			function: {
				name: AI_TOOL_LOAD_SKILL,
				description: [
					"读取一条「技能」——— 主人预先写好的做事步骤。手上的活儿对得上某一条时,先读它再动手;",
					"读回来的是一段指令,照着做即可。可用的技能:",
					catalog,
				].join("\n"),
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							// 枚举住:模型编一个名字出来,换回的只是一次白跑的工具轮。
							enum: pickable.map((s) => s.name),
							description: "要读取的技能名",
						},
					},
					required: ["name"],
				},
			},
		},
		execute: async (args) => {
			const skill = byName.get(args.name ?? "");
			if (!skill) {
				// 说清读不到,而不是抛:抛出去只是界面上一个叉,女仆不知道该改口读哪条。
				return `没有叫「${args.name ?? ""}」的技能。现在有这些:\n${catalog}`;
			}
			const text = skillInstruction(skill);
			if (!skill.allowedTools) return text;
			return {
				text,
				/**
				 * 把自己一并带上。收窄永远只会更窄(交集),所以留着这把工具扩大不了
				 * 任何东西 —— 但挑错技能时,女仆还有一次改口的机会。
				 */
				restrictTools: [...skill.allowedTools, AI_TOOL_LOAD_SKILL],
			};
		},
	};
}
