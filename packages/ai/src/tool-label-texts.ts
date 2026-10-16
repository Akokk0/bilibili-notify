/**
 * 核心自带工具(含联网搜索、看图)给人看的标签 —— 聊天里那条「她正在查什么」小条上的字。
 *
 * 这个文件只放字(多语言字典落地后整个收进去);怎么取、怎么拼见 `tools.ts` 的
 * `coreToolLabelOf` / `describeToolCall`。注入的那几把工具(读技能、做皮肤、卡片工坊)
 * 的标签在服务端各家旁边,不在这里。
 *
 * `labelArg`:这里**单独写**的格,优先于工具定义里 `required` 的格(`coreToolLabelOf` 把必填格
 * 接在后面)—— UP 主相关的几个都优先显示昵称,模型手里常常两个都有,而「咩栗」比一串数字
 * 好认得多;没给昵称时由必填的那一格兜底。必填格不必在这里重抄一遍。
 */
export const CORE_TOOL_LABEL_TEXTS: Readonly<
	Record<string, { label: string; labelArg?: { keys: readonly string[] } }>
> = {
	list_subscriptions: { label: "查看订阅列表" },
	get_live_status: { label: "查看直播状态" },
	get_user_dynamics: { label: "查看最近动态", labelArg: { keys: ["name"] } },
	get_user_info: { label: "查看 UP 主资料", labelArg: { keys: ["name"] } },
	get_user_stats: { label: "查看数据概览", labelArg: { keys: ["name"] } },
	get_user_videos: { label: "查看最近视频", labelArg: { keys: ["name"] } },
	search_user: { label: "搜索 UP 主" },
	// 联网搜索。转圈态就是「联网搜索「关键词」」—— 搜了什么比搜过有用。
	web_search: { label: "联网搜索" },
	describe_image: { label: "查看图片" },
};
