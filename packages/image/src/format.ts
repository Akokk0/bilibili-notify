/**
 * 卡片上的计数写法 —— 万 / 亿,一位小数。播放、弹幕、在线、粉丝……渲染器上所有数字
 * 都走这一份;别处要拼「与卡片同款」的数字(链接解析把视频信息拼成动态)也从这里拿,
 * 免得两份手抄的规矩哪天悄悄分道扬镳,而差异只在渲染出来的图上看得见。
 */
export function numberToStr(num: number): string {
	if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`;
	if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
	return num.toString();
}
