/**
 * **拓展上报的直播状态 → 中立的直播卡输入**(ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c;拓展直播的图进图库,
 * 原计划的 ㉒e 并进了这一步)。
 *
 * 拓展交的直播状态是 v2 的上报:封面与事件带来的作者头像是字节。出卡入口 `ImageRenderer.generateLiveCard` 只认
 * 中立的 {@link LiveCardInput}(图只收引用),所以这里一次翻好 —— 照 `postFromReport` 的样子:
 *
 * - 封面、事件带来的作者头像的字节经 `liveImages` **存进图库**,输入里只放引用;图库不收的图(格式不认、超限)当没有;
 * - 作者头像:事件带了字节且图库收就用它;否则用订阅资料里的头像引用(资料缓存的 `cachedProfile.avatar`,早已在图库里);
 *   都没有就没有头像(头像块整块收起 —— 从前这里给一张透明占位,留一块空的头像位);
 * - 开播时刻是毫秒(在播表、场次里仍是毫秒),交给卡之前转成 ISO;不是有效时刻就不给;
 * - 人数只收精确数:报了才有,没报就没有这个键。
 *
 * 图的写盘由调用方用 `deferImageWrites` 推迟到出卡那一刻:关了出图、版式把卡片藏起来的直播不为图写盘。
 * 直播可以超过 24 小时,周期卡几小时后还要用封面 —— 字节一直在在播表里,每次出卡都重新存一遍(同一份字节只刷新
 * 修改时间),图库那头也把在播表里的封面与头像登记为这一家的名单(`bootstrap.ts` 的 `liveImages`)。
 */

import type { LiveCardInput, LiveCardStatus } from "@bilibili-notify/image";
import type { ImageRef } from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { storeOrSkip } from "../images/image-writes.js";
import type { LiveTableEntry } from "./live-table.js";

/** 卡上要的直播那几格 —— 在播表那一行与事件长得一样(都是拓展交的原件:封面与头像是字节)。 */
export type LiveCardFields = Partial<
	Pick<
		LiveTableEntry,
		"title" | "cover" | "category" | "description" | "viewers" | "totalViewers" | "likes" | "author"
	>
>;

export interface LiveCardInputFromReportOptions {
	status: LiveCardStatus;
	/** 开播时刻(毫秒);没有、或不是有效时刻就不给卡。 */
	startedAt?: number;
	/** 卡上的「当前粉丝数」。 */
	followers?: number;
	/** 本场粉丝数变化(下播)。 */
	followersDelta?: number;
	/** 卡上的主播名(`extensionSubscriptionName` 取好的,也是模板的 `{name}`)。 */
	authorName: string;
	/** 订阅资料里存进图库的头像引用;事件没带头像(或带的不是图库收的图)时用它。 */
	profileAvatar?: ImageRef;
	/** 存图的口。 */
	images: Pick<ImageWriter, "put">;
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

export async function liveCardInputFromReport(
	facts: LiveCardFields,
	opts: LiveCardInputFromReportOptions,
): Promise<LiveCardInput> {
	let avatar: ImageRef | undefined;
	if (facts.author?.avatar) avatar = await storeOrSkip(opts.images, facts.author.avatar);
	avatar ??= opts.profileAvatar;

	let cover: LiveCardInput["cover"];
	if (facts.cover) {
		const ref = await storeOrSkip(opts.images, facts.cover);
		if (ref !== undefined) cover = { ref };
	}

	return present({
		status: opts.status,
		creator: { name: opts.authorName, ...(avatar === undefined ? {} : { avatar }) },
		title: facts.title,
		category: facts.category,
		description: facts.description,
		cover,
		startedAt: isoOfMillis(opts.startedAt),
		currentViewers: facts.viewers,
		totalViewers: facts.totalViewers,
		likes: facts.likes,
		followers: opts.followers,
		followersDelta: opts.followersDelta,
	});
}
