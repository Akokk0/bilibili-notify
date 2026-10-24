/**
 * 工具调用痕迹 → 界面上那一行字。
 *
 * 标签(`label`)与入参文字(`argText`)由服务端随痕迹下发 —— 工具自己带的,存下来的
 * 痕迹也带着(落盘时就存了,读会话原样下发),面板没有一张按工具名查的表。这里只管
 * **怎么拼**:「标签「入参」」,入参超长时截短。
 */

/** 痕迹里这一行要用到的几格(流式在途的和落盘的痕迹都长这样)。 */
interface ToolTraceText {
	name: string;
	/** 给人看的名字;没带(认不出的工具 / 老痕迹补不出)就显示原名。 */
	label?: string;
	/** 小条上补的那一格入参的**完整**文字(没有则缺席);截短是这里的事。 */
	argText?: string;
}

/** 入参在小条上最多占几个字。再长就把整条撑成一段话。 */
const ARG_MAX_CHARS = 14;

/** 一条小条要的三样东西。 */
export interface ToolDescription {
	/** 界面上那一行中文,入参超长时截短。 */
	label: string;
	/** 入参完整原文(没有则 null)—— 展开时给主人看的就是它。 */
	argText: string | null;
	/** 入参被截短了吗。有才值得给展开钮。 */
	clipped: boolean;
}

/**
 * 一条痕迹 → 小条要的三样。
 *
 * 没带标签的**回原名**而不是回空 —— 后端加了新工具、或老痕迹里的工具已经下架时,界面上
 * 留一片空白比留一个英文标识符难查得多。
 */
export function describeTool(trace: ToolTraceText): ToolDescription {
	const argText = trace.argText ? trace.argText : null;
	const name = trace.label ?? trace.name;
	if (!argText) return { label: name, argText: null, clipped: false };
	const clipped = argText.length > ARG_MAX_CHARS;
	const shown = clipped ? `${argText.slice(0, ARG_MAX_CHARS)}…` : argText;
	return { label: `${name}「${shown}」`, argText, clipped };
}
