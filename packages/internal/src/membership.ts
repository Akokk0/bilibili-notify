/**
 * 会员与醒目留言的模型(ADR-0021 决策 26;形状全文在 `docs/1.0/data-model.md`「会员、醒目留言与特别关注」)。
 *
 * 来源交上来的会员事件与醒目留言都是这两个形状,核心不认识任何平台的档位怎么叫、怎么排。事件与体系的类型不落盘、
 * 不过 wire,所以没有 zod schema;会员文案那一份(`templates.membership`)落盘,它的 schema 在 `schema/common.ts`,
 * 这里只放取文案的纯函数 {@link membershipTemplateOf}。3a 建 `posts/` 一类的中立目录时整个搬过去(与 `post.ts` 同批)。
 */

import type { ImageRef } from "./constants";
import type { PostImage } from "./post";
import type { MembershipTemplateBundle, MembershipTemplateEntry } from "./schema/common";

/**
 * 一套会员体系:各平台档数不一、有的由主播自定,一个升序数字装不下。体系由来源在
 * `descriptor.membershipPrograms` 里声明。
 */
export interface MembershipProgram {
	/** 体系 id。B 站叫 `"guard"`。 */
	id: string;
	name: string;
	/** `"custom"` = 档位由主播自定,来源声明不了、事件到了才知道有哪一档。 */
	tiers: MembershipTier[] | "custom";
}

export interface MembershipTier {
	key: string;
	name: string;
	/** 从 1 起、1 最低。 */
	rank: number;
	/** 徽章。 */
	icon?: PostImage;
	/** 档色:面板与出图共读。 */
	color?: string;
	/** 档色的止色:卡的背景从 `color` 渐变到它;没声明就是单色(与 `color` 同值)。面板的色块只读 `color`。 */
	colorEnd?: string;
	/** 宣告语,可用 `{viewer}`、`{name}`、`{tier}`;没声明就不画。 */
	announcement?: string;
}

export interface MembershipEvent {
	subscriptionId: string;
	viewer: { id: string; name: string; avatar?: ImageRef };
	/** 体系 id,见 {@link MembershipProgram.id}。 */
	program: string;
	tier: { key: string; name: string; rank?: number };
	action?: "new" | "renew" | "upgrade";
	months?: number;
	/** 时长等级:虎牙的 V 等级、累计月数。 */
	tenure?: string;
	gift?: { gifter: string; count: number };
	amount?: number;
	currency?: string;
}

export interface SuperchatEvent {
	subscriptionId: string;
	viewer: { id: string; name: string; avatar?: ImageRef };
	text: string;
	amount: number;
	currency: string;
	/** 醒目留言的档,来源按平台规矩算;`durationSec` 是留言挂多久。 */
	tier?: { rank: number; durationSec?: number };
}

/**
 * 取一档的会员文案:**按档的 key** 取那一档自己的文案与图片,档里没填(缺、或空串)的格用体系默认。图片默认也是空串时
 * 回空串,由调用方回落该档自己的徽章。
 *
 * 不认识任何体系:B 站的 `guard`、以后由主播自定档名的 `custom` 体系都走这一条 —— key 是什么字符串都行,取不到就是默认。
 * 只认档自己的键(`Object.hasOwn`):档 key 叫 `constructor` 之类的名字也不会取到原型上的东西。回的是新对象。
 */
export function membershipTemplateOf(
	bundle: Pick<MembershipTemplateBundle, "default" | "tiers">,
	tierKey: string,
): MembershipTemplateEntry {
	const own = Object.hasOwn(bundle.tiers, tierKey) ? bundle.tiers[tierKey] : undefined;
	return {
		template: own?.template || bundle.default.template,
		imageUrl: own?.imageUrl || bundle.default.imageUrl,
	};
}
