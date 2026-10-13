/**
 * 老会话里的工具痕迹现补标签 —— 痕迹自带 `label` / `argText` 是后来的事,盘上已经存下的
 * 那些没有。读会话的回应里由这里现补,面板就不必再自己抄一张「工具名 → 中文」的表。
 *
 * 补法与工具环发 start 事件时是同一个函数(`describeToolCall`),标签取今天在册的工具
 * (核心的经 `coreToolLabelOf`,注入的那十把经各家的标签文案)。**只补在回应里,不改写盘上
 * 的文件**;本来就带标签的原样保留(存下来的字不跟着现在的表变);认不出的工具名不补,
 * 面板回落显示原名。
 */

import { type AiTool, coreToolLabelOf, describeToolCall } from "@bilibili-notify/ai";
import {
	AI_CARD_WORKSHOP_TOOLS,
	AI_TOOL_CREATE_SKIN,
	AI_TOOL_LOAD_SKILL,
} from "@bilibili-notify/contract";
import type { StoredToolTrace } from "./conversation-store.js";
import { CARD_WORKSHOP_LABELS, CREATE_SKIN_LABEL, LOAD_SKILL_LABEL } from "./tool-label-texts.js";

type LabelFields = Pick<AiTool, "label" | "labelArgs" | "formatLabelArg">;

/** 服务端注入给聊天的那十把工具:工具名 → 标签。 */
const INJECTED_LABELS: ReadonlyMap<string, LabelFields> = new Map<string, LabelFields>([
	[AI_TOOL_LOAD_SKILL, LOAD_SKILL_LABEL],
	[AI_TOOL_CREATE_SKIN, CREATE_SKIN_LABEL],
	...(
		Object.entries(AI_CARD_WORKSHOP_TOOLS) as Array<[keyof typeof AI_CARD_WORKSHOP_TOOLS, string]>
	).map(([key, name]): [string, LabelFields] => [name, CARD_WORKSHOP_LABELS[key]]),
]);

/** 缺 `label` 的痕迹补上 `label` 与 `argText`(新数组、新对象,不碰传进来的)。 */
export function withTraceLabels(
	tools: readonly StoredToolTrace[] | undefined,
): StoredToolTrace[] | undefined {
	if (!tools) return undefined;
	return tools.map((t) => {
		if (t.label !== undefined) return t;
		const { label, argText } = describeToolCall(
			INJECTED_LABELS.get(t.name) ?? coreToolLabelOf(t.name),
			t.args,
		);
		if (label === undefined) return t;
		return { ...t, label, ...(argText !== undefined ? { argText } : {}) };
	});
}
