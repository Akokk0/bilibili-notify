import { CronTime } from "cron";

/** cron 读不出来时拓展上报粉丝的间隔 —— 与默认的 `DEFAULT_PROFILE_REFRESH_CRON`(`*\/10 * * * *`)同一个数。 */
export const DEFAULT_FOLLOWERS_SAMPLE_GAP_MS = 10 * 60_000;

/** 往后看几次触发。够跨过一个小时的边界(`*\/7` 那种在整点处只隔 4 分钟),算一次也就几毫秒。 */
const CRON_LOOKAHEAD = 32;

const gapCache = new Map<string, number>();

/**
 * 资料刷新两次采样之间**最短**隔多久:取 cron 往后几次触发里相邻两次的最小间隔 —— 「不密过它」要比的是它
 * 最密的地方(`0 9,21 * * *` 是 12 小时,`*\/10 9-17 * * *` 是 10 分钟)。读不出来(面板上是自由文本框,
 * 资料刷新这时也起不来)就按 {@link DEFAULT_FOLLOWERS_SAMPLE_GAP_MS}。按表达式缓存。
 */
export function followersSampleGapMs(cron: string): number {
	const cached = gapCache.get(cron);
	if (cached !== undefined) return cached;
	let gap = DEFAULT_FOLLOWERS_SAMPLE_GAP_MS;
	try {
		const fires = new CronTime(cron).sendAt(CRON_LOOKAHEAD);
		let min = Number.POSITIVE_INFINITY;
		for (let i = 1; i < fires.length; i++) {
			const prev = fires[i - 1];
			const next = fires[i];
			if (prev && next) min = Math.min(min, next.toMillis() - prev.toMillis());
		}
		if (Number.isFinite(min) && min > 0) gap = min;
	} catch {
		// 读不出来:用默认间隔。
	}
	gapCache.set(cron, gap);
	return gap;
}
