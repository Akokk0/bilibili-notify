/**
 * B 站「排好的字」→ 数字(㉑c 第 3 步,ADR-0021 决策 24:计数全程是数字,只在出口排一次版)。
 *
 * 动态接口给的播放 / 弹幕数是数字或「1.8万」这种成品字,时长是「16:07」这种成品字;而 `Post` 里它们
 * 都是数字(`video.views` / `danmaku` / `durationSec`),排版归 `@bilibili-notify/internal` 的
 * `formatCount` / `formatClock`。所以 B 站这条路要先把成品字解析回数字、再交给那两个函数排。
 *
 * 认不得的一律回 `undefined`,调用方据此**不画那一格**(别画 NaN,也别把认不得的字原样画上去)。
 *
 * **这是 B 站专属的解析,不进 internal。** 它属于「B 站原始数据到 `Post` 的翻译」(`post-from-dynamic.ts`),
 * 住在 `packages/dynamic`。`packages/image` 里还留着一份同样的拷贝,只给旧入口 `buildDynamicNode` 用,
 * 旧入口删除时一并删。
 */

const COUNT_TEXT = /^(\d+(?:\.\d+)?)(万|亿)?$/;

/** 「万」「亿」各乘多少。 */
const UNIT: Readonly<Record<string, number>> = { 万: 1e4, 亿: 1e8 };

/**
 * 计数:数字原样(要是非负的有限数),字符串吃纯数字、带小数、带「万」「亿」后缀(「129」「1.8万」「1.2亿」)。
 * 其余 —— 空串、「--」、「10万+」、「1,234」、负数、别的类型 —— 都是 `undefined`。
 *
 * 「万」「亿」乘出来的数取整:`0.07 * 1e4` 是 `700.0000000000001`,不取整的话往下排版会带着浮点尾巴。
 * 接口只给一位小数,所以取整不丢东西;丢的是「1.8万」本来就丢了的那几位。
 */
export function parseBiliCount(raw: unknown): number | undefined {
	if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
	if (typeof raw !== "string") return undefined;
	const hit = COUNT_TEXT.exec(raw.trim());
	if (!hit) return undefined;
	const value = Number(hit[1]);
	const unit = hit[2];
	return unit ? Math.round(value * (UNIT[unit] as number)) : value;
}

const CLOCK_TEXT = /^(?:(\d+):)?(\d+):(\d{2})$/;

/**
 * 时长:「16:07」「1:02:03」「00:29」(带不带前导零都行)→ 秒。
 *
 * 两段是「分:秒」,分钟不限位数(「75:30」);三段是「时:分:秒」,分与秒各两位。秒(以及三段里的分)
 * 必须小于 60,否则是 `undefined`。其余 —— 空串、一段、四段、全角冒号、小数、别的类型 —— 同样是 `undefined`。
 * 秒数本来就是数字的(链接预览手里的 `VideoInfo.duration`)不需要它,所以不收数字。
 */
export function parseBiliClock(raw: unknown): number | undefined {
	if (typeof raw !== "string") return undefined;
	const hit = CLOCK_TEXT.exec(raw.trim());
	if (!hit) return undefined;
	const [, hours, minutes, seconds] = hit;
	// 三段时分必须两位;两段时(没有 hours)分钟随便几位。
	if (hours !== undefined && (minutes as string).length !== 2) return undefined;
	const m = Number(minutes);
	const s = Number(seconds);
	if (s >= 60 || (hours !== undefined && m >= 60)) return undefined;
	return Number(hours ?? 0) * 3600 + m * 60 + s;
}
