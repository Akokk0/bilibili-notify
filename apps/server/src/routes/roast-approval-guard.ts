/**
 * 审批开关的前置检查 —— 全局那条榜单周报与每位 UP 的单人锐评**共用这一道闸**。
 *
 * 审批靠主人在 IM 里回一句 `y` 才走得下去,而独立端的推送通道不是每条都收得到
 * 回复(webhook 天生没有回程,别的平台是我们还没接)。在收不到回复的通道上把审批
 * 打开,结果是每期都生成、都私聊、然后 48 小时后全部超时作废,一份也发不出去,
 * 而配置页上看着一切正常。所以宁可不给开,并说清该去改什么。
 *
 * 判据是**主人那条私聊通道**所在的平台 —— 草稿预览就是发给他的。这是个全局设置,
 * 所以 per-UP 与全局用的是同一条判据、同一句话:两处各写一份的话,主人只要换个
 * 地方开同一个开关就绕过去了,而一道只拦一半的闸比没有更糟 —— 它让人以为拦住了。
 */

import {
	type Connection,
	fail,
	INBOUND_CAPABLE_PLATFORMS,
	inboundGapReason,
	ok,
	type PushTarget,
	platformCanReceiveReply,
	platformOfTarget,
	type Result,
} from "@bilibili-notify/internal";

/**
 * 审批开得成开不成。开不成的一律是 `not_configured`(ADR-0026):要主人先去配好主人私聊目标 /
 * 换一条收得到回复的通道,等是等不好的 —— 全局与 per-UP 两处共用这一个码,同一句话。
 */
export type ApprovalReachability = Result;

export function checkApprovalReachable(args: {
	/** 这次保存之后审批到底是不是开着的(调用方自己 merge 好 patch 与现值)。 */
	approvalOn: boolean;
	/** 全局的主人私聊目标 id。 */
	masterTargetId: string | undefined;
	targets: readonly PushTarget[];
	/** 平台取自主人目标挂着的那条连接。 */
	connections: readonly Pick<Connection, "id" | "platform">[];
}): ApprovalReachability {
	if (!args.approvalOn) return ok();

	if (!args.masterTargetId) {
		return fail(
			"not_configured",
			"审批需要先配好「主人私聊目标」—— 草稿要发给主人过目，没有这个目标就没人能批。",
		);
	}
	const target = args.targets.find((t) => t.id === args.masterTargetId);
	if (!target) {
		return fail("not_configured", "审批打不开：配置里的主人私聊目标已经不存在了，请先重新指定。");
	}
	const platform = platformOfTarget(target, args.connections);
	if (platform === undefined) {
		return fail("not_configured", "审批打不开：主人私聊目标挂的那条连接已经不在了，请先重新指定。");
	}
	if (!platformCanReceiveReply(platform)) {
		return fail(
			"not_configured",
			// 可选平台从常量里取,不手写 —— 手写的那份哪天补了平台就会漏。
			`审批打不开：${inboundGapReason(platform)}。请把主人私聊目标换成收得到回复的通道（${INBOUND_CAPABLE_PLATFORMS.join(" / ")}），或者关掉审批直接发送。`,
		);
	}
	return ok();
}
