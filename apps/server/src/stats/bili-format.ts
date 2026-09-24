import type { StatsFeedKind } from "./store.js";

/**
 * 统计里 B 站那头的写法 —— stats 目录里**唯一**认得 B 站动态类型串与「1.2万」压缩写法的地方。
 *
 * ADR-0020 决策 5 / 7 的 🔗:统计仓存中立的种类与数字,平台的写法由各来源自己在交进来之前
 * 翻好。用到这两样的只有两处,共用这一份免得两边的口径漂开:
 *   - B 站适配(`bili-source.ts`):引擎发来的新动态 / 新观看数,交给记录器之前翻;
 *   - store 的老行翻译:改之前落盘的 `{type}` 行与字符串峰值,读的时候照同样的规矩翻。
 */

/** 视频投稿 —— 「投稿」一栏的唯一来源(投稿 = 发了视频,跨平台同义)。 */
const VIDEO_TYPES = new Set(["DYNAMIC_TYPE_AV"]);
/**
 * 开播公告。B 站会把「某某开播了」塞进动态流,但直播场次已经从 `live-state-changed`
 * 单独记了,两边都算作品就会把一场直播算两次 —— 所以它们**不是作品**,记成 `live`:
 * 只当「最后活动」与「那天有记录」的证据(没开直播类推送的 UP 不记场次,这是他开过播的
 * 唯一痕迹;ADR-0020 决策 5 的第二个 🔗)。
 */
const LIVE_START_TYPES = new Set(["DYNAMIC_TYPE_LIVE_RCMD", "DYNAMIC_TYPE_LIVE"]);

/**
 * B 站动态类型 → 中立种类:AV → `video`,开播那两种 → `live`,其余 → `post`。
 *
 * 没见过的类型一律归 `post` 而不是丢弃 —— B 站随时会加新类型,漏计比错计更难被发现。
 */
export function classifyBiliDynamic(type: string): StatsFeedKind {
	if (VIDEO_TYPES.has(type)) return "video";
	if (LIVE_START_TYPES.has(type)) return "live";
	return "post";
}

/**
 * 把 B 站「X 人看过」的压缩写法("1.2万" / "3.5亿" / "9500")解析成数字;解析不出返回 `NaN`。
 *
 * 不能拿字符串直接比大小("9500" 会大于 "1.2万"),也不能把解析失败当 0 —— 未知不是零,
 * 一个静默的 0 会把场均拖下水。调用方拿 `Number.isFinite` 判。
 */
export function parseBiliViewers(raw: string): number {
	const m = raw.trim().match(/^([\d.]+)\s*(万|亿)?$/);
	if (!m) return Number.NaN;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return Number.NaN;
	if (m[2] === "万") return n * 10_000;
	if (m[2] === "亿") return n * 100_000_000;
	return n;
}
