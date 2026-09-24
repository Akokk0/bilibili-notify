/**
 * 直播卡的**中立输入 → 块吃的那一份**(ADR-0019 决策 68)。
 *
 * 出卡入口(`ImageRenderer.generateNeutralLiveCard`)在这里把 {@link LiveCardInput} 排成
 * {@link LiveCardView}:数字排成「1.2万」、开播时刻算成卡上那句时间、自定义封面盖上去。
 * 块与皮肤契约只认排好的那一份,不读时钟 —— 预览的示例数据也就能直接写它、每次画出同一张。
 */

import { DateTime } from "luxon";
import { numberToStr } from "./format";
import type { LiveCardInput, LiveCardStatus, LiveCardView } from "./templates/live-card";

/**
 * 卡上的时间按**北京时间**写 —— B 站接口的 `live_time` 就是这个时区的字符串,卡上一直原样
 * 印它;开播时刻改交时间戳之后,照这个时区排回去,B 站的卡一个字不变。
 */
export const LIVE_TIME_ZONE = "UTC+8";
/** 卡上「开播时间：…」那句的写法,与 B 站 `live_time` 同形。 */
export const LIVE_TIME_FORMAT = "yyyy-MM-dd HH:mm:ss";

/**
 * 从 `start` 到此刻过了多久,写成「2小时13分5秒」。`start` 在此刻之后时带负号;两者相等时
 * 是「0秒」。
 */
export function durationSince(start: DateTime): string {
	const diff = DateTime.now().diff(start, [
		"years",
		"months",
		"days",
		"hours",
		"minutes",
		"seconds",
	]);
	const { years, months, days, hours, minutes, seconds } = diff.toObject();
	const parts: string[] = [];
	if (years) parts.push(`${Math.abs(years)}年`);
	if (months) parts.push(`${Math.abs(months)}个月`);
	if (days) parts.push(`${Math.abs(days)}天`);
	if (hours) parts.push(`${Math.abs(hours)}小时`);
	if (minutes) parts.push(`${Math.abs(minutes)}分`);
	if (seconds) parts.push(`${Math.round(Math.abs(seconds))}秒`);
	const sign = diff.as("seconds") < 0 ? "-" : "";
	return parts.length > 0 ? `${sign}${parts.join("")}` : "0秒";
}

/**
 * 卡上那句时间。没在播写「未开播」;其余要开播时刻,没有就不写(空串)——
 * 写一个「开播时间：」后面却什么都没有,不如整句不出。
 */
function liveTimeText(status: LiveCardStatus, startedAt: number | undefined): string {
	if (status === "offline") return "未开播";
	if (startedAt === undefined || !Number.isFinite(startedAt)) return "";
	const start = DateTime.fromMillis(startedAt, { zone: LIVE_TIME_ZONE });
	if (status === "streaming") return `直播时长：${durationSince(start)}`;
	return `开播时间：${start.toFormat(LIVE_TIME_FORMAT)}`;
}

/** 人数一类:数字排成卡片同款的万 / 亿写法,文字原样,没有就空串。 */
function countText(v: number | string | undefined): string {
	return typeof v === "number" ? numberToStr(v) : (v ?? "");
}

/** 粉丝数变化:数字带正负号(「+128」「+1.2万」「-35」),文字原样,没有就空串。 */
function changeText(v: number | string | undefined): string {
	if (typeof v !== "number") return v ?? "";
	if (v > 0) return v >= 10_000 ? `+${(v / 10_000).toFixed(1)}万` : `+${v}`;
	return v <= -10_000 ? `${(v / 10_000).toFixed(1)}万` : v.toString();
}

/**
 * 中立输入 → 块吃的那一份。
 *
 * @param coverOverride 主人给这条订阅设的自定义直播封面(已解析成可渲染的地址);有就盖在
 *   输入的封面上。
 */
export function buildLiveCardView(input: LiveCardInput, coverOverride?: string): LiveCardView {
	return {
		status: input.status,
		username: input.author.name,
		userface: input.author.face,
		title: input.title ?? "",
		area: input.area ?? "",
		description: input.description ?? "",
		cover: coverOverride || (input.cover ?? ""),
		time: liveTimeText(input.status, input.startedAt),
		online: countText(input.online),
		likes: countText(input.likes),
		totalViewers: countText(input.totalViewers),
		fans: countText(input.fans),
		fansChanged: changeText(input.fansChanged),
	};
}
