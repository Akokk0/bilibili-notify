/**
 * **会员(上舰)的装配**:过门槛 → 三支(自定义文案 / 出卡 / 兜底)→ 交出去。
 *
 * 中立:吃中立的 {@link MembershipEvent}、这一档的展示信息、这条订阅折好的门槛 / 文案包 / 卡样式、主播的名字与头像,
 * 不认 uid、房号、B 站的档位表。徽章与观众头像怎么取、发送怎么绑(推给谁、引擎拆了发不发)都由调用方交进来,
 * 这里只管次序:门槛没过什么都不做;自定义文案那一支不取数不出卡;确定要出卡才取徽章与头像。
 *
 * 发出去的是中立的消息段(同醒目留言):图一律是取回来的字节,不是网址。自定义图经宿主的抓图口取回、徽章取自图库,
 * 取不到图只发文字并记一条带原因的警告。
 */

import type { CardSkinChoice, ImageRenderer } from "@bilibili-notify/image";
import {
	type ImageRef,
	type Logger,
	type MembershipEvent,
	type MembershipTier,
	type MessageLayoutSegment,
	membershipTemplateOf,
	type Result,
} from "@bilibili-notify/internal";
import type { EffectiveMembershipTemplate } from "@bilibili-notify/internal/texts/builtin";
import { errorMessageOf } from "../util/error-message";
import { renderTemplate } from "../util/render-template";
import { passesMembershipMinRank } from "./interaction-gates";

export interface MembershipOptions extends CardSkinChoice {
	/** 中立的会员事件。 */
	event: MembershipEvent;
	/** 这一档的展示信息(卡上画的名字、档色、宣告语;`icon` 是平台给的徽章图)。平台的档位表由调用方查好交进来。 */
	tier: MembershipTier;
	/** 这条订阅折好的门槛(按档的 rank 比);没配不拦。 */
	minRank: number | undefined;
	/** 生效的自定义文案包:订阅自己开了就是订阅的那份,否则是全局的那份;由调用方挑好。 */
	template: EffectiveMembershipTemplate;
	/** 主播:名字与头像(图库引用,没有就不带)。 */
	creator: { name: string; avatar?: ImageRef };
	/** 出不了卡时发的那句文字;平台自己的叫法由调用方拼好交进来。 */
	fallbackText: string;
}

export interface MembershipDeps {
	/** 出卡的渲染器;null / 不给 = 不出卡。 */
	renderer?: Pick<ImageRenderer, "generateMembershipCard"> | null;
	/** 确定要出卡时才取:这一档的徽章(图库里的那份,可能要补抓一次);没有回 `undefined`,卡上的徽章块自己收起。 */
	fetchTierIcon: () => Promise<{ ref: ImageRef } | undefined>;
	/** 确定要出卡时才取观众头像(可能走网络);取不到回 `undefined`。 */
	fetchViewerAvatar: () => Promise<ImageRef | undefined>;
	/** 使用者自己填的图片网址:宿主的抓图口把它抓进图库(只准公网、png / jpg / webp / gif、8 MiB 内),回引用。 */
	fetchImage: (url: string) => Promise<Result<{ ref: ImageRef }>>;
	/** 图库引用 → 字节;读不到回 `undefined`。 */
	readImage: (ref: ImageRef) => Promise<{ bytes: Uint8Array; mime: string } | undefined>;
	/** 绑到这条订阅上的发送:收一条消息的中立段(图在前、文字在后)。 */
	send: (segments: readonly MessageLayoutSegment[]) => Promise<void>;
	logger: Logger;
}

type ImageSegment = Extract<MessageLayoutSegment, { kind: "image" }>;

/** 图库引用 → 图段;读不到记一条警告、回 `undefined`(消息就只发文字)。 */
async function imageSegmentOf(
	ref: ImageRef,
	source: "custom" | "badge",
	deps: MembershipDeps,
): Promise<ImageSegment | undefined> {
	const image = await deps.readImage(ref);
	if (image === undefined) {
		deps.logger.warn(
			`[guard] ${source === "custom" ? "自定义图" : "徽章"}在图库里读不到，这条上舰只发文字`,
		);
		return undefined;
	}
	return { kind: "image", buffer: Buffer.from(image.bytes), mime: image.mime };
}

/** 自定义图的网址 → 图段:先抓进图库再读字节;抓不到把原因记进警告、回 `undefined`。 */
async function customImageSegment(
	url: string,
	deps: MembershipDeps,
): Promise<ImageSegment | undefined> {
	const fetched = await deps.fetchImage(url);
	if (!fetched.ok) {
		deps.logger.warn(`[guard] 自定义图抓不到：${fetched.message}，这条上舰只发文字`);
		return undefined;
	}
	return await imageSegmentOf(fetched.ref, "custom", deps);
}

/** 这一档的徽章 → 图段;没有徽章、取不到都回 `undefined`(取不到记警告)。 */
async function badgeSegment(
	tierIcon: MembershipDeps["fetchTierIcon"],
	deps: MembershipDeps,
): Promise<ImageSegment | undefined> {
	try {
		const icon = await tierIcon();
		return icon === undefined ? undefined : await imageSegmentOf(icon.ref, "badge", deps);
	} catch (e) {
		deps.logger.warn(`[guard] 取徽章失败：${errorMessageOf(e)}，这条上舰只发文字`);
		return undefined;
	}
}

/**
 * 会员:门槛 → 自定义文案 / 出卡 / 兜底。try 只包「取徽章 + 取头像 + 出卡」:发送抛了原样往外抛 —— 抛之前可能已经发出去了,
 * 再补一条兜底等于重发(失败规矩:发送抛了不许重发)。
 */
export async function pushMembership(
	options: MembershipOptions,
	deps: MembershipDeps,
): Promise<void> {
	const { event, tier, creator } = options;
	if (!passesMembershipMinRank(event, options.minRank)) return;
	// 出卡与兜底共用一次取徽章(失败的那次也记住,兜底不再重打一遍网络)。
	let iconOnce: ReturnType<MembershipDeps["fetchTierIcon"]> | undefined;
	const tierIcon = (): ReturnType<MembershipDeps["fetchTierIcon"]> => {
		iconOnce ??= deps.fetchTierIcon();
		return iconOnce;
	};

	if (options.template.enabled) {
		// 文案和图片取同一档:哪一档上舰,就用哪一档的;那一档没填的格用体系默认。
		const custom = membershipTemplateOf(options.template, event.tier.key);
		// 盘上文案里字面的 `\n`(反斜杠加 n)展开成真换行,照今天的行为。
		const text = renderTemplate(custom.template, {
			viewer: event.viewer.name,
			name: creator.name,
			tier: event.tier.name,
		});
		// 这一档没填图就回落徽章(空串不是「缺」,所以用 `||`)。
		const picture = custom.imageUrl
			? await customImageSegment(custom.imageUrl, deps)
			: await badgeSegment(tierIcon, deps);
		await deps.send([...(picture ? [picture] : []), { kind: "text", text }]);
		return;
	}

	const { renderer } = deps;
	if (renderer) {
		let card: Buffer | undefined;
		try {
			const icon = await tierIcon();
			const viewerAvatar = await deps.fetchViewerAvatar();
			card = await renderer.generateMembershipCard(
				{
					viewer: {
						name: event.viewer.name,
						...(viewerAvatar === undefined ? {} : { avatar: viewerAvatar }),
					},
					creator: {
						name: creator.name,
						...(creator.avatar === undefined ? {} : { avatar: creator.avatar }),
					},
					tier: {
						name: tier.name,
						rank: tier.rank,
						...(icon ? { icon } : {}),
						color: tier.color,
						colorEnd: tier.colorEnd,
						announcement: tier.announcement,
					},
				},
				// 会员卡只认皮肤两格(封面只有直播卡带),恒带。
				{ cardSkin: options.cardSkin, cardSkinKnobs: options.cardSkinKnobs },
			);
		} catch (e) {
			deps.logger.error(`[image] 生成会员卡片失败：${errorMessageOf(e)}，降级为文字推送`);
		}
		if (card !== undefined) {
			await deps.send([{ kind: "image", buffer: card, mime: "image/jpeg" }]);
			return;
		}
	}
	const badge = await badgeSegment(tierIcon, deps);
	await deps.send([...(badge ? [badge] : []), { kind: "text", text: options.fallbackText }]);
}
