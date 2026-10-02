/**
 * 「编辑标签」弹框的纯逻辑(ADR-0034):勾选切换订阅挂的标签 id、把新建输入算成一份「要不要建、建完整张表
 * 长什么样」的计划、按 id 去标签表里查名字。
 * 抽成纯函数便于穷举边界(空白 / 重名 / 顺序 / 悬空 id),弹框组件只做渲染与状态承接。
 */

import type { SubscriptionTag } from "../../types/domain";

/** 勾选切换:已挂则去掉,未挂则追加(保序追加到末尾)。 */
export function toggleTagId(ids: string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * 新建输入算出来的计划:
 *   - `empty`    去掉首尾空白后什么都不剩 —— 不建;
 *   - `existing` 表里已经有这个名字(与服务端同一把尺:去空白后逐字相等)—— 不建,指向那一个,弹框把它勾上;
 *   - `create`   要建:`tag` 是新标签(id 由调用方给),`table` 是 PUT 出去的整张新表(旧表末尾追加)。
 */
export type NewTagPlan =
	| { kind: "empty" }
	| { kind: "existing"; id: string }
	| { kind: "create"; tag: SubscriptionTag; table: SubscriptionTag[] };

export function planNewTag(
	tags: ReadonlyArray<SubscriptionTag>,
	raw: string,
	id: string,
): NewTagPlan {
	const name = raw.trim();
	if (!name) return { kind: "empty" };
	const found = tags.find((t) => t.name === name);
	if (found) return { kind: "existing", id: found.id };
	const tag: SubscriptionTag = { id, name };
	return { kind: "create", tag, table: [...tags, tag] };
}

/** 只留标签表里还有的 id(别处删了标签、这边的勾选还留着旧 id 时,别把它交给服务端 —— 会回 400)。 */
export function keepKnownTagIds(ids: string[], tags: ReadonlyArray<SubscriptionTag>): string[] {
	const known = new Set(tags.map((t) => t.id));
	return ids.filter((id) => known.has(id));
}

/** 按订阅上 id 的顺序查出名字;表里没有的 id(两张表各自重取、一时对不上)静默跳过。 */
export function resolveTagNames(ids: ReadonlyArray<string>, tags: ReadonlyArray<SubscriptionTag>) {
	const nameById = new Map(tags.map((t) => [t.id, t.name]));
	const names: string[] = [];
	for (const id of ids) {
		const name = nameById.get(id);
		if (name !== undefined) names.push(name);
	}
	return names;
}
