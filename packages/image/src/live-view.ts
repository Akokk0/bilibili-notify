/**
 * 直播卡的**中立输入 → 块吃的那一份**(ADR-0019 决策 68)。
 *
 * 出卡入口(`ImageRenderer.generateNeutralLiveCard`)在这里把 {@link LiveCardInput} 排成
 * {@link LiveCardView}:数字排成「1.2万」、开播时刻算成卡上那句时间、自定义封面盖上去。
 * 块与皮肤契约只认排好的那一份,不读时钟 —— 预览的示例数据也就能直接写它、每次画出同一张。
 */

import { type FormatCountOptions, formatCount, formatDuration } from "@bilibili-notify/internal";
import { DateTime } from "luxon";
import type { LiveCardInput, LiveCardStatus, LiveCardView } from "./templates/live-card";

/**
 * 卡上的时间按**北京时间**写 —— B 站接口的 `live_time` 就是这个时区的字符串,卡上一直原样
 * 印它;开播时刻改交时间戳之后,照这个时区排回去,B 站的卡一个字不变。
 */
export const LIVE_TIME_ZONE = "UTC+8";
/** 卡上「开播时间：…」那句的写法,与 B 站 `live_time` 同形。 */
export const LIVE_TIME_FORMAT = "yyyy-MM-dd HH:mm:ss";

/**
 * 卡上那句时间。没在播写「未开播」;其余要开播时刻,没有就不写(空串)——
 * 写一个「开播时间：」后面却什么都没有,不如整句不出。
 */
function liveTimeText(status: LiveCardStatus, startedAt: number | undefined): string {
	if (status === "offline") return "未开播";
	if (startedAt === undefined || !Number.isFinite(startedAt)) return "";
	if (status === "streaming") return `直播时长：${formatDuration(startedAt)}`;
	const start = DateTime.fromMillis(startedAt, { zone: LIVE_TIME_ZONE });
	return `开播时间：${start.toFormat(LIVE_TIME_FORMAT)}`;
}

/**
 * 人数一类:数字排成卡片同款的万 / 亿写法,文字原样,没有就空串。粉丝数变化传 `{ signed: true }`
 * (「+128」「+1.2万」「-35」)。
 */
function countText(v: number | string | undefined, options?: FormatCountOptions): string {
	return typeof v === "number" ? formatCount(v, options) : (v ?? "");
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
		userface: input.author.face ?? "",
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
		fansChanged: countText(input.fansChanged, { signed: true }),
	};
}
