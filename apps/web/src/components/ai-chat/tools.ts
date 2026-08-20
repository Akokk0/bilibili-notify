/**
 * 工具名 → 界面上那一行中文。
 *
 * 后端把工具名原样发上来(`list_subscriptions`),直接显示等于给主人看代码。
 * 这张表只管**怎么说**,不管调了什么 —— 工具清单的真身在 `packages/ai/src/tools.ts`,
 * 那边加一个,这边得跟着配一句(有一条测试盯着,漏了会红)。
 */

import { AI_TOOL_CREATE_SKIN, AI_TOOL_LOAD_SKILL } from "@bilibili-notify/contract";

/** 入参里挑哪几个键来补上下文,按顺序取第一个有值的。 */
interface LabelSpec {
	label: string;
	arg?: readonly string[];
}

const TOOL_LABELS: Record<string, LabelSpec> = {
	list_subscriptions: { label: "查看订阅列表" },
	get_live_status: { label: "查看直播状态" },
	// UP 主相关的几个都优先显示昵称:模型手里常常两个都有,而「咩栗」比一串
	// 数字好认得多;只有 UID 时再退回 UID。
	get_user_dynamics: { label: "查看最近动态", arg: ["name", "uid"] },
	get_user_info: { label: "查看 UP 主资料", arg: ["name", "uid"] },
	get_user_stats: { label: "查看数据概览", arg: ["name", "uid"] },
	get_user_videos: { label: "查看最近视频", arg: ["name", "uid"] },
	search_user: { label: "搜索 UP 主", arg: ["keyword"] },
	// 联网搜索(web_search)。转圈态就是「搜索中:关键词」—— 搜了什么比搜过有用。
	web_search: { label: "联网搜索", arg: ["query"] },
	// 做皮肤要跑一整趟嵌套生成,几十秒起步 —— 转圈那会儿写清「在做什么样的」,
	// 主人才知道这是在忙正事,而不是卡住了。
	[AI_TOOL_CREATE_SKIN]: { label: "制作皮肤", arg: ["brief"] },
	// 读技能。**两条路共用这一条**:女仆自己挑的,以及主人打斜杠点名的(那一枚
	// 痕迹是服务端手工补的)。名字一定要显示出来 —— 这枚胶囊存在的全部意义就是
	// 交代「她为什么突然换了套说法」。
	[AI_TOOL_LOAD_SKILL]: { label: "使用技能", arg: ["name"] },
	subscribe_user: { label: "添加订阅", arg: ["name", "uid"] },
	unsubscribe_user: { label: "取消订阅", arg: ["name", "uid"] },
	update_subscription: { label: "修改订阅设置", arg: ["name", "uid"] },
};

/** 入参在小条上最多占几个字。再长就把整条撑成一段话。 */
const ARG_MAX_CHARS = 14;

/**
 * 一次工具调用 → 一行中文。
 *
 * 认不出来的工具**回原名**而不是回空 —— 后端加了新工具而这张表还没跟上时,
 * 界面上留一片空白比留一个英文标识符难查得多。
 */
export function toolLabel(name: string, args: Record<string, string>): string {
	return labelWith(name, toolArgText(name, args));
}

function labelWith(name: string, flat: string | null): string {
	const spec = TOOL_LABELS[name];
	if (!spec) return name;
	if (!flat) return spec.label;
	const shown = flat.length <= ARG_MAX_CHARS ? flat : `${flat.slice(0, ARG_MAX_CHARS)}…`;
	return `${spec.label}「${shown}」`;
}

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
 * 一次工具调用 → 小条要的三样,入参**只规整一次**。
 *
 * 分开三个函数各问一遍的话,`toolArgText` 里那趟 `replace(/\s+/g," ")` 就要对
 * 同一份入参跑三遍 —— 而做皮肤的 brief 是几百字,小条又跟着流式分片每片重渲一次。
 */
export function describeTool(name: string, args: Record<string, string>): ToolDescription {
	const argText = toolArgText(name, args);
	return {
		label: labelWith(name, argText),
		argText,
		clipped: (argText?.length ?? 0) > ARG_MAX_CHARS,
	};
}

/**
 * 小条上那个入参的**完整原文**(没有则 null)。
 *
 * 与 {@link toolLabel} 挑的是同一个键,只是不截 —— 界面靠它判断「这条有没有被
 * 截短」,以及展开之后给主人看什么。做皮肤的 brief 是几百字的一段需求,那是主人
 * 唯一能核对「女仆理解对了没」的东西,只留十几个字等于没留。
 */
export function toolArgText(name: string, args: Record<string, string>): string | null {
	const raw = TOOL_LABELS[name]?.arg?.map((k) => args[k]?.trim()).find(Boolean);
	return raw ? raw.replace(/\s+/g, " ") : null;
}
