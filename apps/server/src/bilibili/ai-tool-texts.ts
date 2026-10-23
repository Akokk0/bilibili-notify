/** B 站女仆工具给模型的说明与回话。与提示词同性质,不翻译。 */
export const BILI_AI_TOOL_TEXTS = {
	upTotalsDescription:
		"获取一位 B 站 UP 主的累计数据：总播放量、总获赞数、视频数、动态数。都是历史总量，看不出最近活不活跃。",
	upVideosDescription:
		"获取一位 B 站 UP 主最近投稿的视频（最多 5 条，新的在前），每条带发布时间、标题、播放量。",
	creatorParameter:
		"B 站订阅的 creator（来源键:外部 id），从订阅列表或搜人结果原样传；必须是 bilibili:纯数字 UID",
	dataFailed: (message: string) => `获取数据失败: ${message}`,
	videosFailed: (message: string) => `获取视频失败: ${message}`,
	invalidCreator: (creator: string) =>
		`「${creator}」不是 B 站订阅的 creator（要写成 bilibili:纯数字 UID）；这两把工具只查 B 站订阅。`,
	upTotals: (view: number, likes: number, videos: number | string, dynamics: number | string) =>
		`总播放量: ${view}, 总获赞: ${likes}, 视频数: ${videos}, 动态数: ${dynamics}`,
	noVideos: "暂无投稿视频",
	upVideo: (index: number, published: string, title: string, play: number | string): string =>
		`${index + 1}. [${published}] ${title}（播放: ${play}）`,
} as const;
