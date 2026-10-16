/**
 * 核心 AI 工具回给模型的话(集中放一处,逻辑里不拼句子)。别的工具的话仍写在 `tools.ts` 里。
 */
export const TOOL_TEXTS = {
	/** `get_creator_posts` 一条都没有:BN 没记到 ≠ 他没发过(没开作品记录、或还没记到)。 */
	postsNotRecorded:
		"BN 没记到这位最近的作品：可能这条订阅没开作品记录，或者还没记到。这不等于他没发过，不要据此说他没更新。",
	/** `creator` 切不出「来源键:外部 id」。 */
	creatorMalformed: "creator 要写成「来源键:外部 id」，照订阅列表或搜人结果里的 creator 原样传",
	/** 没接读口。 */
	readerMissing: "查询功能当前不可用（没有接上订阅数据）",
} as const;
