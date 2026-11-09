/**
 * 图库内置引用方的稳定标识（ADR-0027 决策 10 / 17）。
 *
 * 同时用于登记表的键、ImageStore.usage() 的 holders 和存储分类，不能使用会随语言变化的展示文字。
 * 标识只在内存登记，不写进图库引用或历史数据；图片仍按内容摘要寻址。
 */
export const IMAGE_REFERRERS = {
	history: "history",
	repush: "repush",
	profiles: "profiles",
	chat: "chat",
	posts: "posts",
	inTransit: "in-transit",
	live: "live",
	sourceDeclared: "source-declared",
	accounts: "accounts",
} as const;
