import { packageText } from "@bilibili-notify/internal/texts";
/**
 * 直播卡的**中立输入 → 块吃的那一份**(ADR-0019 决策 68)。
 *
 * 出卡入口(`ImageRenderer.generateLiveCard`)在这里把 {@link LiveCardInput} 排成
 * {@link LiveCardView}:数字排成「1.2万」、开播时刻算成卡上那句时间、图库引用换成可画的地址、
 * 自定义封面盖上去。块与皮肤契约只认排好的那一份,不读时钟 —— 预览的示例数据也就能直接写它、每次画出同一张。
 */

import {
	DEFAULT_TIMEZONE,
	type FormatCountOptions,
	formatCount,
	formatDuration,
	type PostImage,
} from "@bilibili-notify/internal";
import { DateTime } from "luxon";
import { formatCardTime } from "./format";
import { escapeHtml } from "./html-escape";
import type { ImageUrlOf } from "./rich-text";
import type { LiveCardInput, LiveCardStatus, LiveCardView } from "./templates/live-card";

/** ISO 开播时刻 → 时刻;不给、读不懂都是 `undefined`(没有开播时刻)。不带时区的 ISO 当给的时区读。 */
function startedAtOf(startedAt: string | undefined, timezone: string): DateTime | undefined {
	if (startedAt === undefined) return undefined;
	const at = DateTime.fromISO(startedAt, { zone: timezone });
	return at.isValid ? at : undefined;
}

/**
 * 卡上那句时间。没在播写「未开播」;其余要开播时刻,没有(或读不懂)就不写(空串)——
 * 写一个「开播时间：」后面却什么都没有,不如整句不出。
 */
function liveTimeText(
	status: LiveCardStatus,
	startedAt: string | undefined,
	timezone: string,
): string {
	if (status === "offline") return packageText("image.live-view.1");
	const start = startedAtOf(startedAt, timezone);
	if (start === undefined) return "";
	if (status === "streaming")
		return packageText("image.live-view.2", { value0: formatDuration(start.toMillis()) });
	return packageText("image.live-view.3", {
		value0: formatCardTime(start.toSeconds(), timezone),
	});
}

/**
 * 人数一类:精确数排成卡片同款的万 / 亿写法,没有(或不是有限的数)就空串。粉丝数变化传 `{ signed: true }`
 * (「+128」「+1.2万」「-35」)。
 */
function countText(v: number | undefined, options?: FormatCountOptions): string {
	return typeof v === "number" && Number.isFinite(v) ? formatCount(v, options) : "";
}

/**
 * 封面的地址(会员卡的徽章同一条规矩,{@link buildMembershipCardView} 也用它)。**只认 `ref`** 的解析结果:解析不到就是
 * 没有封面(不退回 `url`:引用说的是图库里那张,它没了就是没了);只有 `url`(来源没把图存进图库)、两样都没有同样是
 * 没有 —— 渲染页不联网,地址进了卡也画不出来。作品图的兜底(画透明占位,见 `pictureUrl`)在这里不适用:直播封面
 * 没有就整格换成「暂无封面」占位图。
 */
export function coverUrlOf(
	cover: PostImage | undefined,
	imageUrl?: ImageUrlOf,
): string | undefined {
	if (cover?.ref === undefined) return undefined;
	return imageUrl?.(cover.ref) || undefined;
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
export function liveCoverPlaceholder(): string {
	const svg = [
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
		`<text x="320" y="258" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#999">${escapeHtml(packageText("image.live-view.4"))}</text>`,
		"</svg>",
	].join("");

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export interface LiveCardViewOptions {
	/**
	 * 卡上时间按哪个时区排(全局时区设置)。生产调用方(出卡器)总传现取的那一格;
	 * 只看别的格的调用方不必重复,缺省取出厂值。
	 */
	timezone?: string;
	/** 主人给这条订阅设的自定义直播封面(已解析成可渲染的地址);有就盖在输入的封面上。 */
	coverOverride?: string;
	/** 图库引用 → 可画的地址。出图器事先把输入里用到的引用都解析好,这里同步查;不给 = 所有引用都解析不到。 */
	imageUrl?: ImageUrlOf;
}

/**
 * 中立输入 → 块吃的那一份。
 *
 * 封面:自定义封面 > 输入的封面({@link coverUrlOf}) > {@link liveCoverPlaceholder}。`hasCover` 只认前两样 ——
 * 占位图不算真封面,皮肤拿 `live.hasCover` 做 `showIf` 时照旧能把这一格收起。头像:`creator.avatar` 解析到了
 * 就是地址,没有或解析不到是空串(头像块整块收起)。
 */
export function buildLiveCardView(
	input: LiveCardInput,
	{ coverOverride, imageUrl, timezone = DEFAULT_TIMEZONE }: LiveCardViewOptions = {},
): LiveCardView {
	const cover = coverOverride || coverUrlOf(input.cover, imageUrl) || "";
	const avatar = input.creator.avatar;
	return {
		status: input.status,
		creatorName: input.creator.name,
		creatorAvatarUrl: (avatar !== undefined ? imageUrl?.(avatar) : undefined) || "",
		title: input.title ?? "",
		category: input.category ?? "",
		description: input.description ?? "",
		cover: cover || liveCoverPlaceholder(),
		hasCover: cover !== "",
		time: liveTimeText(input.status, input.startedAt, timezone),
		currentViewers: countText(input.currentViewers),
		likes: countText(input.likes),
		totalViewers: countText(input.totalViewers),
		followers: countText(input.followers),
		followersDelta: countText(input.followersDelta, { signed: true }),
	};
}
