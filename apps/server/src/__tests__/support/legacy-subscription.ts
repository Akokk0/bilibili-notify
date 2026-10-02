import type { Subscription } from "@bilibili-notify/internal";

/**
 * 0.x 盘上的 B 站订阅(`state/subscriptions.json` 里的一行):身份在**顶层 `uid`**,没有 `kind`、没有 `identity`。
 *
 * 往第 0 代摆夹具用它 —— 那是迁移器的**输入**,得是 0.x 的样子:摆成现在的 `identity` 行,迁移器的「身份收进
 * `identity`」那一步就没跑,测试照绿、「0.x 原样」成了假话(迁移的用例见 `migration/__tests__/`)。同理,0.x 的
 * 分组是一串名字 `groups`,不是 1.0 的 `tagIds`(ADR-0034),要摆分组的传第二个参数。
 */
export function legacyBiliRow(sub: Subscription, groups: string[] = []): Record<string, unknown> {
	const { id, identity, tagIds: _tagIds, ...rest } = sub;
	return { id, uid: identity.externalId, groups, ...rest };
}

/**
 * 0.x 盘上的拓展订阅(`state/extension-subscriptions.json` 里的一行):`kind: "extension"`,身份是顶层的
 * `extensionId` + `externalId`,没有 `identity`。同样是迁移器的输入。
 */
export function legacyExtensionRow(
	sub: Subscription,
	groups: string[] = [],
): Record<string, unknown> {
	const { id, identity, tagIds: _tagIds, ...rest } = sub;
	return {
		kind: "extension",
		id,
		extensionId: identity.sourceKey,
		externalId: identity.externalId,
		groups,
		...rest,
	};
}
