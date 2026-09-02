import { type FieldSection, getFieldLabel } from "../config/field-labels";
import type { FieldDiff } from "./walkTreeDiff";

/**
 * 灵动岛 expand panel 用的 diff 分组。按 plan Q12:
 * - section 顺序固定(SECTION_ORDER),不出现的 section 跳过
 * - section 内 code 按字母序
 * - 未在 FIELD_LABELS 字典里的 code(理论上 conformance test 会拦,这里兜底)归
 *   到 "other"
 */

export type GroupSectionKey = FieldSection | "other";

export interface DiffSection {
	section: GroupSectionKey;
	/** 中文 section 标题(panel 显示)。 */
	label: string;
	/** 该 section 下的 diff 行,已按 code 字母序。 */
	rows: FieldDiff[];
}

const SECTION_LABELS: Record<GroupSectionKey, string> = {
	general: "通用",
	master: "Master",
	ai: "AI 模型",
	persona: "AI 人格",
	cardStyle: "卡片样式",
	cardPreview: "卡片预览",
	filter: "动态过滤",
	templates: "消息模板",
	schedule: "调度",
	interaction: "直播互动",
	specialUsers: "特别关注",
	imageGroup: "动态图集",
	target: "推送目标",
	adapter: "适配器",
	transport: "传输",
	session: "会话",
	commands: "私聊指令",
	linkParsing: "链接解析",
	logging: "日志",
	other: "其他",
};

/**
 * section 渲染顺序。设计上把通用 → AI → 卡片 → 过滤/模板/调度 → 互动 →
 * 推送链路 → 日志 → 其他放在一起,UI 上稳定不抖。
 */
const SECTION_ORDER: GroupSectionKey[] = [
	"general",
	"master",
	"ai",
	"persona",
	"cardStyle",
	"cardPreview",
	"filter",
	"templates",
	"schedule",
	"interaction",
	"specialUsers",
	"imageGroup",
	"target",
	"adapter",
	"transport",
	"session",
	"commands",
	"linkParsing",
	"logging",
	"other",
];

/** 给定 code,返回它在字典中归属的 section,缺则 "other"。 */
export function sectionOf(code: string): GroupSectionKey {
	// 走 getFieldLabel 而不是直接读字典:动态 code(如「默认更新提示」的账本
	// `templateDefaultsSeen.*`)的归属规则住在那个函数里,绕过去就会掉进「其他」。
	return getFieldLabel(code)?.section ?? "other";
}

export function groupDiffsBySection(diffs: FieldDiff[]): DiffSection[] {
	const buckets = new Map<GroupSectionKey, FieldDiff[]>();
	for (const d of diffs) {
		const section = sectionOf(d.code);
		const arr = buckets.get(section);
		if (arr === undefined) buckets.set(section, [d]);
		else arr.push(d);
	}
	const out: DiffSection[] = [];
	for (const section of SECTION_ORDER) {
		const rows = buckets.get(section);
		if (rows === undefined || rows.length === 0) continue;
		// 不就地改 caller 的数组,先 shallow copy 再排
		const sorted = [...rows].sort((a, b) => a.code.localeCompare(b.code));
		out.push({ section, label: SECTION_LABELS[section], rows: sorted });
	}
	return out;
}
