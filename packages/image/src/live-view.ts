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
	return durationBetween(start, DateTime.now());
}

/**
 * 从 `startedAt` 到 `at`(都是毫秒)过了多久 —— 与 {@link durationSince} 同一种写法,两个时刻都由调用方给。
 * 拓展订阅的直播文案 `{time}` 用它(ADR-0019 决策 67):下播卡的时长要定格在下播那一刻,断流接续等的那
 * 几分钟不算进去。
 */
export function liveDuration(startedAt: number, at: number): string {
	return durationBetween(DateTime.fromMillis(startedAt), DateTime.fromMillis(at));
}

/**
 * 先把整段取整到秒,再拆单位。反过来(拆完单独给秒取整)的话,119.6 秒拆成 1 分 59.6 秒、取整成
 * 「1分60秒」;300.3 秒拆出 0.3 秒,多一个「5分0秒」。取整按绝对值,正负两头对称。
 */
function durationBetween(start: DateTime, end: DateTime): string {
	const ms = end.toMillis() - start.toMillis();
	const wholeSeconds = Math.sign(ms) * Math.round(Math.abs(ms) / 1000);
	const diff = start
		.plus({ seconds: wholeSeconds })
		.diff(start, ["years", "months", "days", "hours", "minutes", "seconds"]);
	const { years, months, days, hours, minutes, seconds } = diff.toObject();
	const parts: string[] = [];
	if (years) parts.push(`${Math.abs(years)}年`);
	if (months) parts.push(`${Math.abs(months)}个月`);
	if (days) parts.push(`${Math.abs(days)}天`);
	if (hours) parts.push(`${Math.abs(hours)}小时`);
	if (minutes) parts.push(`${Math.abs(minutes)}分`);
	if (seconds) parts.push(`${Math.abs(seconds)}秒`);
	const sign = wholeSeconds < 0 ? "-" : "";
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
 * **直播封面的占位图**:没有真封面时封面那一格画它(从前是 `<img src="">`,画成一张只剩
 * alt 文字的裂图)。拓展直播没报封面、B 站关键帧与房间封面都空着,都走到这里。
 *
 * 内嵌的 SVG data URL —— 出卡不许联网。16:9(B 站封面的比例):声明了封面高度的皮肤
 * (默认皮肤 568×336)按 `object-fit:cover` 裁,只裁掉两侧一点底色;没声明高度的皮肤里它
 * 按自己的比例撑开。浅灰底 + 居中一个图标 +「暂无封面」,落在默认皮肤的白纱上像一张还没
 * 加载出来的图,换了底色的皮肤上也不跳色。字用 `sans-serif`:SVG 当图用时读不到卡片的字体,
 * 走系统字体(镜像里装了 Noto CJK)。
 *
 * 图标是 BN 自己画的(圆角屏幕框 + 播放三角 + 上方两道信号弧),不抄任何图标库 —— 抄来的
 * 图形得随发行物附上它的许可声明,而 bundle 会剥掉注释。颜色只用卡片里现成的两种灰:
 * `#999`(次要文字,底色取它的 12%)与 `#aaa`(「已下播」角标)。
 */
const LIVE_COVER_PLACEHOLDER_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
	'<rect width="640" height="360" fill="#999" fill-opacity="0.12"/>',
	// 图标画在 64 格的网格里、放大 2.5 倍,中心落在 (320, 150)。
	'<g transform="translate(240 77.5) scale(2.5)">',
	'<g fill="none" stroke="#aaa" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">',
	'<rect x="8" y="18" width="48" height="34" rx="6"/>',
	'<path d="M27 12.5a7 7 0 0 1 10 0"/>',
	'<path d="M22.5 8a13.5 13.5 0 0 1 19 0"/>',
	"</g>",
	'<path d="M28 28v14l12-7z" fill="#aaa"/>',
	"</g>",
	'<text x="320" y="258" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#999">暂无封面</text>',
	"</svg>",
].join("");

export const LIVE_COVER_PLACEHOLDER = `data:image/svg+xml;base64,${Buffer.from(
	LIVE_COVER_PLACEHOLDER_SVG,
).toString("base64")}`;

/**
 * 中立输入 → 块吃的那一份。
 *
 * 封面:自定义封面 > 输入的封面 > {@link LIVE_COVER_PLACEHOLDER}。`hasCover` 只认前两样 ——
 * 占位图不算真封面,皮肤拿 `live.hasCover` 做 `showIf` 时照旧能把这一格收起。
 *
 * @param coverOverride 主人给这条订阅设的自定义直播封面(已解析成可渲染的地址);有就盖在
 *   输入的封面上。
 */
export function buildLiveCardView(input: LiveCardInput, coverOverride?: string): LiveCardView {
	const cover = coverOverride || input.cover || "";
	return {
		status: input.status,
		username: input.author.name,
		userface: input.author.face,
		title: input.title ?? "",
		area: input.area ?? "",
		description: input.description ?? "",
		cover: cover || LIVE_COVER_PLACEHOLDER,
		hasCover: cover !== "",
		time: liveTimeText(input.status, input.startedAt),
		online: countText(input.online),
		likes: countText(input.likes),
		totalViewers: countText(input.totalViewers),
		fans: countText(input.fans),
		fansChanged: changeText(input.fansChanged),
	};
}
