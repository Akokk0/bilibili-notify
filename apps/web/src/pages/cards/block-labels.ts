/**
 * 卡片块的人话名(编辑器展示用)。键对齐 packages/internal 的 DEFAULT_CARD_LAYOUT
 * 块 id;新增内置块时这里补一条,缺失则回退展示 id。
 */

export type LayoutKind = "live" | "dyn" | "sc" | "guard";

/** 分割线块的展示名(所有卡通用)。 */
export const DIVIDER_LABEL = "分割线";

/** 编辑器 kind → CardLayout 的字段名(dyn 对应 dynamic)。 */
export const KIND_TO_LAYOUT_KEY: Record<LayoutKind, "live" | "dynamic" | "sc" | "guard"> = {
	live: "live",
	dyn: "dynamic",
	sc: "sc",
	guard: "guard",
};

export const BLOCK_LABELS: Record<LayoutKind, Record<string, string>> = {
	live: {
		cover: "封面图",
		header: "主播信息",
		title: "直播标题",
		stats: "人气 / 分区",
		follower: "粉丝信息",
		desc: "简介",
	},
	dyn: {
		header: "头部信息",
		content: "动态正文",
		additional: "附加内容",
		stats: "转发 / 评论 / 点赞",
	},
	sc: {
		amount: "金额",
		divider: "分割线",
		sender: "发送者",
		message: "留言",
	},
	guard: {
		name: "姓名",
		text: "文字信息",
	},
};
