import { t as serverText } from "../i18n/index.js";
/**
 * 审批开关的前置检查 —— 全局那条榜单周报与每位 UP 的单人锐评**共用这一道闸**。
 *
 * 审批靠主人在 IM 里回一句 `y` 才走得下去,而独立端的连接不是每条都收得到
 * 回复(webhook 天生没有回程,别的连接是适配器还没接,或者对面没报)。在收不到回复的连接上把审批
 * 打开,结果是每期都生成、都私聊、然后 48 小时后全部超时作废,一份也发不出去,
 * 而配置页上看着一切正常。所以宁可不给开,并说清该去改什么。
 *
 * 判据是**主人那条私聊目标所挂连接**的 `inbound` 能力(适配器的回答)—— 草稿预览就是发给他的;
 * 只有「支持」才放行,「还不知道」也拦(见 {@link canReceiveReply})。这是个全局设置,
 * 所以 per-UP 与全局用的是同一条判据、同一句话:两处各写一份的话,主人只要换个
 * 地方开同一个开关就绕过去了,而一道只拦一半的闸比没有更糟 —— 它让人以为拦住了。
 */

import {
	type Connection,
	type ConnectionCapabilities,
	canReceiveReply,
	fail,
	ok,
	type PushTarget,
	type Result,
} from "@bilibili-notify/internal";

/**
 * 审批开得成开不成。开不成的一律是 `not_configured`(ADR-0026):要主人先去配好主人私聊目标 /
 * 换一条收得到回复的连接,等是等不好的 —— 全局与 per-UP 两处共用这一个码,同一句话。
 */
export type ApprovalReachability = Result;

export function checkApprovalReachable(args: {
	/** 这次保存之后审批到底是不是开着的(调用方自己 merge 好 patch 与现值)。 */
	approvalOn: boolean;
	/** 全局的主人私聊目标 id。 */
	masterTargetId: string | undefined;
	targets: readonly PushTarget[];
	/** 主人目标挂着的那条连接还在不在,看这张名单。 */
	connections: readonly Pick<Connection, "id">[];
	/** 一条连接眼下的能力(适配器的回答);取不到(推送链路还没就绪、没有适配器)回 `undefined`,按「还不知道」算。 */
	capabilitiesOf: (connectionId: string) => ConnectionCapabilities | undefined;
}): ApprovalReachability {
	if (!args.approvalOn) return ok();

	if (!args.masterTargetId) {
		return fail("not_configured", serverText("service.routes.roast-approval-guard.text.1"));
	}
	const target = args.targets.find((t) => t.id === args.masterTargetId);
	if (!target) {
		return fail("not_configured", serverText("service.routes.roast-approval-guard.text.2"));
	}
	if (!args.connections.some((c) => c.id === target.connectionId)) {
		return fail("not_configured", serverText("service.routes.roast-approval-guard.text.3"));
	}
	const inbound = args.capabilitiesOf(target.connectionId)?.inbound;
	if (canReceiveReply(inbound)) return ok();
	const advice = serverText("service.routes.roast-approval-guard.text.4");
	if (inbound?.state === "unsupported") {
		return fail(
			"not_configured",
			serverText("service.routes.roast-approval-guard.text.5", {
				value0: inbound.reason,
				value1: advice,
			}),
		);
	}
	// 还不知道:不是这条连接的毛病,说成「收不到」主人会去查自己的配置 —— 如实说还不知道,有原因就带上。
	const why =
		inbound?.state === "unknown" && inbound.reason
			? serverText("roast.approvalReason", { reason: inbound.reason })
			: "";
	return fail(
		"not_configured",
		serverText("service.routes.roast-approval-guard.text.6", { value0: why, value1: advice }),
	);
}
