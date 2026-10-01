import { makeEmptySubscription, type Subscription } from "@bilibili-notify/internal";

/**
 * 测试用的一条拓展来源的订阅(ADR-0021 决策 14):身份是 `identity: { sourceKey: <拓展 id>, externalId }`。
 *
 * 订阅只有一种形状,所以就是一条空订阅换上拓展的身份 —— 其余字段(routing / extras / overrides /
 * roastSchedule …)跟着出厂默认走,不必在这儿再抄一份。`opts` 里除了身份三项,其余照盖在空订阅上。
 */
export function makeExtensionSubscription(
	opts: {
		id?: string;
		extensionId?: string;
		externalId?: string;
	} & Partial<Omit<Subscription, "id" | "identity">> = {},
): Subscription {
	const {
		id = "e0000000-0000-4000-8000-000000000001",
		extensionId = "douyin",
		externalId = "sec-uid-1",
		...rest
	} = opts;
	return {
		...makeEmptySubscription({ id, identity: { sourceKey: extensionId, externalId } }),
		...rest,
	};
}
