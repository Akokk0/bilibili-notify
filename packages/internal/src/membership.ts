/**
 * 会员与醒目留言的模型(ADR-0021 决策 26;形状全文在 `docs/1.0/data-model.md`「会员、醒目留言与特别关注」)。
 *
 * 来源交上来的会员事件与醒目留言都是这两个形状,核心不认识任何平台的档位怎么叫、怎么排。只有类型:它们不落盘、
 * 不过 wire,所以没有 zod schema。3a 建 `posts/` 一类的中立目录时整个搬过去(与 `post.ts` 同批)。
 *
 * ㉓b 起步:类型与 B 站的档位表(`bilibili-guard.ts`)、两个翻译函数都还没有调用方,接线在 ㉓c。
 */

import type { ImageRef } from "./constants";
import type { PostImage } from "./post";

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
	/** 档色:面板与出图共读,每档一个值。 */
	color?: string;
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
