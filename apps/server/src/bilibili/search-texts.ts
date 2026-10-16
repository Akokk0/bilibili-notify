/** B 站搜人回给人看的话(集中放这里;日志不算)。 */
export const SEARCH_TEXTS = {
	blankQuery: "搜索关键词不能为空",
	/** B 站自己的话(`message`)是平台的业务说明,可以给人看;没带就写一句固定的。 */
	failed: (reason: string | undefined): string => `B 站没能完成搜索${reason ? `：${reason}` : ""}`,
} as const;
