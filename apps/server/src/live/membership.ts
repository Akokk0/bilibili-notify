/**
 * **会员(上舰)的装配**:过门槛 → 三支(自定义文案 / 出卡 / 兜底)→ 交出去。
 *
 * 中立:吃中立的 {@link MembershipEvent}、这一档的展示信息、这条订阅折好的门槛 / 文案包 / 卡样式、主播的名字与头像,
 * 不认 uid、房号、B 站的档位表。徽章与观众头像怎么取、发送怎么绑(推给谁、引擎拆了发不发)都由调用方交进来,
 * 这里只管次序:门槛没过什么都不做;自定义文案那一支不取数不出卡;确定要出卡才取徽章与头像。
 *
 * 消息经宿主给的内容构造口拼:会员有两支要发「一张按网址取的图加一句文字」拼成的一条消息,消息段装不下按网址取的图。
 */

import type { CardSkinChoice, ImageRenderer } from "@bilibili-notify/image";
import {
	type ImageRef,
	interpolate,
	type Logger,
	type MembershipEvent,
	type MembershipTemplateBundle,
	type MembershipTier,
	membershipTemplateOf,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message";
import type { LiveContentBuilder } from "./content-builder";
import { passesMembershipMinRank } from "./interaction-gates";
import type { CustomCardStyleLike } from "./live-types";

export interface MembershipOptions {
	/** 中立的会员事件。 */
	event: MembershipEvent;
	/** 这一档的展示信息(卡上画的名字、档色、宣告语;`icon` 是平台给的徽章图)。平台的档位表由调用方查好交进来。 */
	tier: MembershipTier;
	/** 这条订阅折好的门槛(按档的 rank 比);没配不拦。 */
	minRank: number | undefined;
	/** 生效的自定义文案包:订阅自己开了就是订阅的那份,否则是全局的那份;由调用方挑好。 */
	template: MembershipTemplateBundle;
	/** 主播:名字与头像(图库引用,没有就不带)。 */
	creator: { name: string; avatar?: ImageRef };
	/** 这条订阅折好的会员卡样式;没启用 = 吃渲染器的全局配置。 */
	cardStyle: CustomCardStyleLike;
	cardSkin?: string;
	cardSkinKnobs?: CardSkinChoice["cardSkinKnobs"];
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
	/** 宿主给的内容构造口:三支的消息照今天的拼法在这里拼。 */
	content: LiveContentBuilder;
	/** 绑到这条订阅上的发送:收一条拼好的消息。 */
	send: (message: unknown) => Promise<void>;
	logger: Logger;
}

/**
 * 会员:门槛 → 自定义文案 / 出卡 / 兜底。try 只包「取徽章 + 取头像 + 出卡」:发送抛了原样往外抛 —— 抛之前可能已经发出去了,
 * 再补一条兜底等于重发(失败规矩:发送抛了不许重发)。
 */
export async function pushMembership(
	options: MembershipOptions,
	deps: MembershipDeps,
): Promise<void> {
	const { event, tier, creator, cardStyle } = options;
	const { content } = deps;
	if (!passesMembershipMinRank(event, options.minRank)) return;
	// 档位表里这一档的徽章地址;没有就是空串(空串不是「缺」,所以下面用 `||` 回落而不是 `??`)。
	const badgeUrl = tier.icon?.url ?? "";

	if (options.template.enabled) {
		// 文案和图片取同一档:哪一档上舰,就用哪一档的;那一档没填的格用体系默认。
		const custom = membershipTemplateOf(options.template, event.tier.key);
		// 占位符走 `interpolate`;盘上文案里字面的 `\n`(反斜杠加 n)展开成真换行,照今天的行为。
		const text = interpolate(custom.template, {
			viewer: event.viewer.name,
			name: creator.name,
			tier: event.tier.name,
		}).replaceAll("\\n", "\n");
		await deps.send(
			content.message([content.image(custom.imageUrl || badgeUrl), content.text(text)]),
		);
		return;
	}

	const { renderer } = deps;
	if (renderer) {
		let card: Buffer | undefined;
		try {
			const icon = await deps.fetchTierIcon();
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
				// 样式启用了才展开(渲染器按「缺省 → 吃全局」判,递一份禁用的样式等于把它启用);皮肤两格恒带。
				{
					...(cardStyle.enable ? cardStyle : undefined),
					cardSkin: options.cardSkin,
					cardSkinKnobs: options.cardSkinKnobs,
				},
			);
		} catch (e) {
			deps.logger.error(`[image] 生成会员卡片失败：${errorMessageOf(e)}，降级为文字推送`);
		}
		if (card !== undefined) {
			await deps.send(content.image(card, "image/jpeg"));
			return;
		}
	}
	await deps.send(content.message([content.image(badgeUrl), content.text(options.fallbackText)]));
}
