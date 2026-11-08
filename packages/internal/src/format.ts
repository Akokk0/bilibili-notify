import { packageLocale, packageText } from "./texts/index";
/**
 * 数字与时间的排版 —— 全仓只有这一份(data-model「数字、时间与「不知道」」;1.0 第 2 期 ⑪,
 * 2026-10-02 主人定口径)。卡片、推送文字、面板、`/status` 都走这里,守卫 4 钉着别处不许再有同名定义。
 *
 * 🔴 **值级 import 只许指向零依赖名单里的同伴**:它经 `@bilibili-notify/internal/format` 子路径直供浏览器端,
 * 和零依赖领域子路径同一条纪律(`scripts/__tests__/internal-package.test.mjs` 一起扫)。
 */

export interface FormatCountOptions {
	/** 带正负号:正数加「+」,负数是普通的「-」,零就写「0」。 */
	signed?: boolean;
	/** 统计表的紧凑档:小数取整，百万以上中文/日文取整到万、英文取整到M/B。 */
	compact?: boolean;
}

/**
 * 计数:中文/日文的万和亿一位小数、保留「.0」；英文用K/M/B一位小数。较小的数原样、不加千分位。负数按绝对值
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
	if (packageLocale() === "en") {
		const value = compact && abs < 1000 ? Math.round(abs) : abs;
		if (value < 1000) return String(value);
		const digits = compact && abs >= 1e6 ? 0 : 1;
		return new Intl.NumberFormat("en", {
			notation: "compact",
			compactDisplay: "short",
			useGrouping: false,
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(value);
	}
	if (abs >= 1e8) return packageText("internal.format.1", { value0: (abs / 1e8).toFixed(1) });
	if (abs >= 1e4) {
		const wan = compact && abs >= 1e6 ? String(Math.round(abs / 1e4)) : (abs / 1e4).toFixed(1);
		return Number(wan) >= 1e4
			? packageText("internal.format.2")
			: packageText("internal.format.3", { value0: wan });
	}
	const below = compact ? Math.round(abs) : abs;
	return below >= 1e4 ? packageText("internal.format.4") : String(below);
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
	if (delta < 60_000) return packageText("internal.format.5");
	if (delta < 3_600_000)
		return packageText("internal.format.6", { count: Math.floor(delta / 60_000) });
	if (delta < 86_400_000)
		return packageText("internal.format.7", { count: Math.floor(delta / 3_600_000) });
	return packageText("internal.format.8", { count: Math.floor(delta / 86_400_000) });
}

/**
 * 时长:「2小时13分5秒」。最大的单位到天(固定长度,不随时区与夏令时变),是零的那一位不写,
 * 整个是零写「0秒」,倒过来的带负号;不满一秒的零头舍掉。解析不了的也当零。
 */
export function formatDuration(start: string | number, end: string | number = Date.now()): string {
	const ms = toMs(end) - toMs(start);
	if (!Number.isFinite(ms)) return packageText("internal.format.9");
	const total = Math.trunc(ms / 1000);
	let s = Math.abs(total);
	const days = Math.floor(s / 86400);
	s %= 86400;
	const hours = Math.floor(s / 3600);
	s %= 3600;
	const minutes = Math.floor(s / 60);
	const seconds = s % 60;
	const parts: string[] = [];
	if (days) parts.push(packageText("internal.format.10", { count: days }));
	if (hours) parts.push(packageText("internal.format.11", { count: hours }));
	if (minutes) parts.push(packageText("internal.format.12", { count: minutes }));
	if (seconds) parts.push(packageText("internal.format.13", { count: seconds }));
	if (parts.length === 0) return packageText("internal.format.14");
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

/**
 * 金额:按币种用 `Intl.NumberFormat` 排,使用整台当前语言(不随机器语言变)、**不加千分位**。
 * 简中人民币整数写「¥30」「¥2000」,
 * 小数照写不补零(「¥30.5」),别的币种按它自己的符号(「US$30」「JP¥30」)。
 *
 * 两种不该出现、但来源说了算的情形都**不抛**:
 * - 币种代码不合法(`Intl` 抛 RangeError)→ 退成「金额 + 空格 + 币种原文」,多余的空格去掉(空串币种只剩金额);
 * - 金额不是有限的数(NaN / ±Infinity)→ 空串,与「不知道在出口缺了就是空串」同口径。
 */
export function formatAmount(amount: number, currency: string): string {
	// 金额不是有限的数(NaN / ±Infinity)= 不知道,出口写空串 —— `Intl` 会写出「¥NaN」「¥∞」,比空着更糟。
	if (!Number.isFinite(amount)) return "";
	try {
		return new Intl.NumberFormat(packageLocale(), {
			style: "currency",
			currency,
			minimumFractionDigits: 0,
			useGrouping: false,
		}).format(amount);
	} catch {
		// 币种代码不合法时 `Intl` 抛 RangeError;金额来自来源、币种也是来源报的,不能让一个怪币种把推送整条带倒。
		return `${amount} ${currency}`.trim();
	}
}
