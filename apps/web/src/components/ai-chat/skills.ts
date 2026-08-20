/**
 * 斜杠命令 —— 输入框里打 `/` 唤起女仆技能的那条路。
 *
 * 技能是**服务端的东西**(`<dataDir>/maid-skills/<name>/SKILL.md`),这里只做解析:
 * 把主人打的那一行拆成「点名了哪条技能」+「他这一问是什么」,正文一个字都不经过
 * 浏览器 —— 落盘的用户消息就该是他真打的那几个字,而技能正文由服务端追加进 system。
 *
 * 与从前那版最要紧的分别:`/技能 补充内容` **技能照样生效**。旧版要求整条输入恰好
 * 等于命令,于是主人打 `/锐评 只看这三个人` 时技能一个字都不进(ADR-0001 背景第 1 条)。
 */

import type { MaidSkillDTO } from "@bilibili-notify/contract";

/** 输入的第一段(到第一个空白为止)。 */
function headOf(input: string): string {
	return input.split(/\s/)[0] ?? "";
}

/**
 * 当前输入 → 该显示哪几条技能。空数组 = 不弹菜单。
 *
 * 只认**第一段**:打完 `/weekly-report ` 再补充要求时菜单该收起来让位给正文,
 * 而不是一直悬在输入框上方挡着。
 */
export function matchSkills(input: string, skills: readonly MaidSkillDTO[]): MaidSkillDTO[] {
	if (!input.startsWith("/")) return [];
	const head = headOf(input);
	// 打完整条命令又加了空格 → head 仍等于命令,但 input 比 head 长,说明已经在
	// 写正文了。此时不再弹菜单。
	if (input.length > head.length) return [];
	return skills.filter((s) => `/${s.name}`.startsWith(head));
}

/** 一次发送里真正要交给服务端的两样东西。 */
export interface OutgoingMessage {
	/** 主人这一问。 */
	text: string;
	/** 他点名的技能名;不给 = 普通消息。 */
	skill?: string;
}

/**
 * 把输入拆成「哪条技能」+「这一问」。
 *
 * 认不得的命令**不点名任何技能**,原样当普通消息发:服务端会拒掉一个不存在的
 * 技能名,而主人打错一个字时他要的只是把这句话说出去,不是一个 400。
 */
export function resolveOutgoing(input: string, skills: readonly MaidSkillDTO[]): OutgoingMessage {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return { text: trimmed };
	const head = headOf(trimmed);
	const skill = skills.find((s) => `/${s.name}` === head);
	if (!skill) return { text: trimmed };
	const rest = trimmed.slice(head.length).trim();
	// 「后面那串字」是空的就把命令本身当这一问 —— 服务端要求消息非空,而气泡里
	// 显示主人真打的那几个字,配上旁边那枚痕迹胶囊刚好说得通。
	return { skill: skill.name, text: rest === "" ? head : rest };
}
