/**
 * 中立 AI 工具认人的值:`creator` = 「来源键:外部 id」(ADR-0030 决策 1)。
 *
 * 外部 id 是那个来源自己的 id,可能自己带冒号,所以**按第一个冒号切**,后面整段都是外部 id;
 * 来源键是登记时认领的键,不含冒号。
 */

/** 订阅身份 → `creator` 串。 */
export function creatorOf(sourceKey: string, externalId: string): string {
	return `${sourceKey}:${externalId}`;
}

/** `creator` 串 → 来源键与外部 id;没有冒号、或任何一半是空的 → `undefined`。 */
export function parseCreator(
	creator: string,
): { sourceKey: string; externalId: string } | undefined {
	const at = creator.indexOf(":");
	if (at <= 0 || at === creator.length - 1) return undefined;
	return { sourceKey: creator.slice(0, at), externalId: creator.slice(at + 1) };
}
