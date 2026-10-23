/**
 * **中立的直播详情 → 直播卡输入**(ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c)。
 *
 * 出卡入口 `ImageRenderer.generateLiveCard` 只认中立的 {@link LiveCardInput}(图只收引用)。详情
 * ({@link LiveDetails})里的图本来就是图库引用 —— 来源在交信号之前存好了 ——
 * 所以这里是同步的纯翻译,不碰图库:
 *
 * - 主播名由调用方取好({@link LiveCardInputFromDetailsOptions.authorName},也是模板的 `{name}`);
 *   头像:详情里带的引用优先,否则订阅资料里的头像引用;都没有就没有头像(头像块整块收起);
 * - 开播时刻是毫秒(场次里仍是毫秒),交给卡之前转成 ISO;不是有效时刻就不给;
 * - 人数只收精确数:报了才有,没报就没有这个键。
 */

import type { LiveCardInput, LiveCardStatus } from "@bilibili-notify/image";
import type { ImageRef, LiveDetails } from "@bilibili-notify/internal";

export interface LiveCardInputFromDetailsOptions {
	status: LiveCardStatus;
	/** 开播时刻(毫秒);没有、或不是有效时刻就不给卡。 */
	startedAt?: number;
	/** 卡上的「当前粉丝数」。 */
	followers?: number;
	/** 本场粉丝数变化(下播)。 */
	followersDelta?: number;
	/** 卡上的主播名(`displayNameOf` 取好的,也是模板的 `{name}`)。 */
	authorName: string;
	/** 订阅资料里存进图库的头像引用;详情没带头像时用它。 */
	profileAvatar?: ImageRef;
}

/** 毫秒 → ISO;不是有效时刻就是 `undefined`(卡上不写开播时间)。 */
function isoOfMillis(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 值是 `undefined` 的键去掉:缺了就缺键。 */
function present<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, cell]) => cell !== undefined)) as T;
}

export function liveCardInputFromDetails(
	details: LiveDetails,
	opts: LiveCardInputFromDetailsOptions,
): LiveCardInput {
	const avatar = details.creator?.avatar ?? opts.profileAvatar;
	return present({
		status: opts.status,
		creator: { name: opts.authorName, ...(avatar === undefined ? {} : { avatar }) },
		title: details.title,
		category: details.category,
		description: details.description,
		cover: details.cover,
		startedAt: isoOfMillis(opts.startedAt),
		currentViewers: details.currentViewers,
		totalViewers: details.totalViewers,
		likes: details.likes,
		followers: opts.followers,
		followersDelta: opts.followersDelta,
	});
}
