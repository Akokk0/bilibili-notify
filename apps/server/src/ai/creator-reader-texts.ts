/** 女仆的读口给模型看的失败话(集中放这里;日志不算)。 */
export const CREATOR_READER_TEXTS = {
	/** 没订阅 / 停用:读缓存类的工具只答订阅着的人。 */
	notSubscribed: (creator: string): string =>
		`「${creator}」不在订阅里（没订阅，或订阅已停用），这把工具只答订阅着的人`,
	/** 订阅着,但资料缓存里还没有,而他所属的来源又不在登记表里。 */
	profileNotCached: (creator: string): string => `BN 手里还没有「${creator}」的资料缓存`,
	/** 数据统计总开关关着:去设置里打开。 */
	statsOff: "数据统计没开，BN 没在记作品和涨粉，请主人到设置里打开数据统计",
	/** 统计的读口没接上。 */
	statsUnwired: "统计功能当前不可用",
	/** 总览里还没有这条订阅的统计行(刚订阅,数据还没汇总出来)。 */
	noStatsRow: (creator: string): string => `BN 还没有「${creator}」的统计数据`,
} as const;
