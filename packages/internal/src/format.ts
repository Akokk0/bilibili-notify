/**
 * 数字与时间的排版 —— 全仓只有这一份(data-model「数字、时间与「不知道」」;1.0 第 2 期 ⑪,
 * 2026-10-02 主人定口径)。卡片、推送文字、面板、`/status` 都走这里,守卫 4 钉着别处不许再有同名定义。
 *
 * 🔴 **一条值级 import 都不许有**:它经 `@bilibili-notify/internal/format` 子路径直供浏览器端,
 * 和 `/constants` 同一条纪律(`constants-imports.test.ts` 一起扫)。
 */

export interface FormatCountOptions {
	/** 带正负号:正数加「+」,负数是普通的「-」,零就写「0」。 */
	signed?: boolean;
	/** 统计表的紧凑档:万以下取整,百万以上取整到万;其余同卡片口径。 */
	compact?: boolean;
}

/**
 * 计数:万和亿都一位小数、保留「.0」,万以下原样、不加千分位(卡片现有的口径)。负数按绝对值
 * 压缩;快到一亿时进位成「1.0亿」,不写「10000.0万」。
 */
export function formatCount(
	n: number,
	{ signed = false, compact = false }: FormatCountOptions = {},
): string {
	const body = magnitude(Math.abs(n), compact);
	if (body === "0") return "0";
	return (n < 0 ? "-" : signed ? "+" : "") + body;
}

function magnitude(abs: number, compact: boolean): string {
	if (abs >= 1e8) return `${(abs / 1e8).toFixed(1)}亿`;
	if (abs >= 1e4) {
		const wan = compact && abs >= 1e6 ? String(Math.round(abs / 1e4)) : (abs / 1e4).toFixed(1);
		return Number(wan) >= 1e4 ? "1.0亿" : `${wan}万`;
	}
	const below = compact ? Math.round(abs) : abs;
	return below >= 1e4 ? "1.0万" : String(below);
}

function toMs(at: string | number): number {
	return typeof at === "number" ? at : Date.parse(at);
}

/**
 * 「N 分钟前」:一分钟以内(连同未来的时刻)是「刚刚」,往上是分钟、小时、天,数字和单位之间
 * 带空格,永远不改写成日期。解析不了回 `undefined` —— 缺值写「—」还是「无记录」由各处自己定。
 */
export function formatAgo(at: string | number, now: number = Date.now()): string | undefined {
	const t = toMs(at);
	if (!Number.isFinite(t)) return undefined;
	const delta = now - t;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 时长:「2小时13分5秒」。最大的单位到天(固定长度,不随时区与夏令时变),是零的那一位不写,
 * 整个是零写「0秒」,倒过来的带负号;不满一秒的零头舍掉。解析不了的也当零。
 */
export function formatDuration(start: string | number, end: string | number = Date.now()): string {
	const ms = toMs(end) - toMs(start);
	if (!Number.isFinite(ms)) return "0秒";
	const total = Math.trunc(ms / 1000);
	let s = Math.abs(total);
	const days = Math.floor(s / 86400);
	s %= 86400;
	const hours = Math.floor(s / 3600);
	s %= 3600;
	const minutes = Math.floor(s / 60);
	const seconds = s % 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}天`);
	if (hours) parts.push(`${hours}小时`);
	if (minutes) parts.push(`${minutes}分`);
	if (seconds) parts.push(`${seconds}秒`);
	if (parts.length === 0) return "0秒";
	return (total < 0 ? "-" : "") + parts.join("");
}

/** 按秒数排时钟格式(视频时长):一小时以内「m:ss」,以上「h:mm:ss」,小时不换天;负数与 NaN 写「0:00」。 */
export function formatClock(seconds: number): string {
	const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
