/**
 * 工具名 → 界面上那一行中文。
 *
 * 后端把工具名原样发上来(`list_subscriptions`),直接显示等于给主人看代码。
 * 这张表只管**怎么说**,不管调了什么 —— 工具清单的真身在 `packages/ai/src/tools.ts`,
 * 那边加一个,这边得跟着配一句(有一条测试盯着,漏了会红)。
 */

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
	const spec = TOOL_LABELS[name];
	if (!spec) return name;
	const raw = spec.arg?.map((k) => args[k]?.trim()).find(Boolean);
	if (!raw) return spec.label;
	const flat = raw.replace(/\s+/g, " ");
	const shown = flat.length <= ARG_MAX_CHARS ? flat : `${flat.slice(0, ARG_MAX_CHARS)}…`;
	return `${spec.label}「${shown}」`;
}
