import type { AiChatMode } from "@bilibili-notify/contract";
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
	/**
	 * 这条技能要在哪个模式下跑。不给 = 用这场对话本来的面孔。
	 *
	 * `/皮肤` 必须带上它:做皮肤那把工具只在皮肤工坊里挂着。模式锁定之后它不再
	 * 「切」,而是**另开一场**工坊会话 —— 留在日常聊天里发出去的话,女仆会答应
	 * 下来然后什么也做不出来。
	 *
	 * **只有斜杠命令这条路认得它。** 空态那排胶囊直接发 `prompt`,而
	 * {@link resolveSkill} 要求整条输入恰好等于 `cmd` —— 带 `mode` 的技能于是
	 * 传不出面孔,聊天空态刻意把它们滤掉(见 index.tsx 那排胶囊)。
	 *
	 * **给下一个往这儿加技能的人**:给一条技能配上 `mode`,它就会**自动从空态那排
	 * 胶囊里消失**,只在打斜杠时出现。这是刻意的(主人 2026-08-20 拍板保留),不是
	 * 漏写 —— 别看到「胶囊少了一个」就去掉那道 filter。真要让它也能当胶囊,得先修
	 * 信道:让胶囊发 `cmd` 而不是 `prompt`(`resolveOutgoing` 照样展开成同一句话,
	 * 但 `resolveSkill` 拿得到 `mode`),那是一次产品决定,不是顺手清理。
	 */
	mode?: AiChatMode;
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
		cmd: "/皮肤",
		icon: "palette",
		mode: "skin",
		desc: "让女仆做一套界面皮肤",
		// 技能选中就直接发出去,所以这句得自洽:主人这会儿还没想好风格,让她先问
		// 一句再动手 —— 生成是一整趟模型调用,凭空猜一套多半是白做。
		prompt:
			"帮我做一套新的界面皮肤吧。先问我想要什么样的(氛围、主色、浅色还是暗色、想要什么质感),我说完你再动手做。",
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
 * 整条输入恰好是某个技能命令时,给出那条技能;否则 undefined。
 *
 * 判据与 {@link resolveOutgoing} 是同一个(必须整条相等)—— 两处若各判各的,
 * 就会出现「话按技能换了、模式却没跟着换」这种半吊子状态。
 */
export function resolveSkill(input: string): AiSkill | undefined {
	return AI_SKILLS.find((s) => s.cmd === input.trim());
}

/**
 * 把输入解析成真正要发出去的那句话。
 *
 * 整条输入恰好是某个技能命令 → 换成它的 `prompt`;否则原样发送。刻意**只在
 * 完全相等时**替换 —— `/锐评 只看这三个人` 是主人在技能基础上追加要求,
 * 换成预置话术会把那句追加悄悄吃掉。
 */
export function resolveOutgoing(input: string): string {
	return resolveSkill(input)?.prompt ?? input.trim();
}
