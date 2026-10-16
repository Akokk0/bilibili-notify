/** 宿主调来源搜人时回给人 / 模型看的话(集中放这里;日志不算)。 */
export const SEARCH_CREATORS_TEXTS = {
	/** `listing` 是在册来源的「键（平台名）」,顿号隔开;模型凭它能自己改正。 */
	noSuchSource: (sourceKey: string, listing: string): string =>
		`没有叫「${sourceKey}」的订阅来源。在册的来源有：${listing === "" ? "（一个都没有）" : listing}`,
	timeout: (label: string, seconds: number): string => `${label}的搜人超过 ${seconds} 秒没回`,
	failed: (label: string): string => `${label}的搜人出错了，详情在日志里`,
} as const;
