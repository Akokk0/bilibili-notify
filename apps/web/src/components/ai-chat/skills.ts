import type { IconName } from "@bilibili-notify/ui";

/**
 * 女仆技能 —— 输入框里打 `/` 唤起的那几条。
 *
 * 技能不是后端概念,只是**预置提问**:选中一条就等于把 `prompt` 那段话发出去。
 * 所以这里没有任何注册 / 校验机制,加一条就是往数组里加一行。后端那边照旧收
 * 到一句普通的用户消息。
 *
 * `cmd` 以 `/` 开头是给菜单匹配用的约定,{@link matchSkills} 依赖它。
 */
export interface AiSkill {
	/** 斜杠命令,如 `/锐评`。必须以 `/` 开头。 */
	cmd: string;
	icon: IconName;
	/** 菜单里那行说明,同时也是空态技能胶囊上的文字。 */
	desc: string;
	/** 选中后真正发给女仆的话。 */
	prompt: string;
}

export const AI_SKILLS: readonly AiSkill[] = [
	{
		cmd: "/锐评",
		icon: "fire",
		desc: "评选鸽王与勤奋 UP,毒舌锐评",
		prompt: "本周谁最勤奋?谁是鸽王?请读取全部 UP 数据评榜并锐评。",
	},
	{
		cmd: "/文案",
		icon: "edit",
		desc: "生成今晚直播推送文案",
		prompt: "帮我写一条今晚的直播推送文案,结合正在直播的 UP。",
	},
	{
		cmd: "/优化",
		icon: "filter",
		desc: "找出可取消订阅的账号",
		prompt: "哪些 UP 主可以考虑取消订阅?找出长期停更或掉粉的账号。",
	},
	{
		cmd: "/体检",
		icon: "bell",
		desc: "检查推送目标连接状态",
		prompt: "推送目标有没有异常?检查各群 / 频道的连接状态。",
	},
];

/**
 * 当前输入 → 该显示哪几条技能。空数组 = 不弹菜单。
 *
 * 只认**第一段**(到第一个空白为止):打完 `/锐评 ` 再补充要求时,菜单该收起来
 * 让位给正文,而不是一直悬在输入框上方挡着。
 */
export function matchSkills(input: string): AiSkill[] {
	if (!input.startsWith("/")) return [];
	const head = input.split(/\s/)[0] ?? "";
	// 打完整条命令又加了空格 → head 仍等于 cmd,但 input 比 head 长,说明已经在
	// 写正文了。此时不再弹菜单。
	if (input.length > head.length) return [];
	return AI_SKILLS.filter((s) => s.cmd.startsWith(head));
}

/**
 * 把输入解析成真正要发出去的那句话。
 *
 * 整条输入恰好是某个技能命令 → 换成它的 `prompt`;否则原样发送。刻意**只在
 * 完全相等时**替换 —— `/锐评 只看这三个人` 是主人在技能基础上追加要求,
 * 换成预置话术会把那句追加悄悄吃掉。
 */
export function resolveOutgoing(input: string): string {
	const text = input.trim();
	return AI_SKILLS.find((s) => s.cmd === text)?.prompt ?? text;
}
