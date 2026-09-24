import { type ExtensionSubscription, makeEmptySubscription } from "@bilibili-notify/internal";

/**
 * 测试用的一条拓展订阅(ADR-0019 决策 9):没有 uid,身份是 `(extensionId, externalId)`。
 *
 * 从 B 站那支的空订阅上摘掉身份与 B 站专属的特别关注再补上拓展的身份 —— 共有的那些字段
 * (routing / extras / overrides / roastSchedule …)两支长得一样,跟着出厂默认走,不必在这儿再抄一份。
 */
export function makeExtensionSubscription(
	opts: {
		id?: string;
		extensionId?: string;
		externalId?: string;
	} & Partial<Omit<ExtensionSubscription, "kind" | "id" | "extensionId" | "externalId">> = {},
): ExtensionSubscription {
	const {
		id = "e0000000-0000-4000-8000-000000000001",
		extensionId = "douyin",
		externalId = "sec-uid-1",
		...rest
	} = opts;
	const {
		kind: _kind,
		uid: _uid,
		specialUsers: _special,
		...common
	} = makeEmptySubscription({ id, uid: "0" });
	return { ...common, ...rest, kind: "extension", id, extensionId, externalId };
}
