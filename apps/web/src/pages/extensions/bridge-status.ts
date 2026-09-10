import { useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";

/**
 * 桥接拓展交上来的活口状态 —— `/api/ext/bridge/status` 那份 JSON 在面板这头长什么样。
 *
 * ⚠️ **这是面板里唯一一处认得某个具体拓展的地方**,而且是有意的:那个口交上来的是
 * **任意 JSON**(ADR-0012 决策 36 —— 形状第一版不约束,因为「抽象要两个例子」,而我们
 * 手上只有桥这一个)。等第二个拓展也要一块面板时,再从两个真实例子里抽形状;现在就
 * 发明一套通用 schema,只会照着桥的样子编一遍。
 *
 * 所以这些类型是**本地的**:契约里一格桥的字都没有,也不该有。列表页(「N 个 bot 在线」)
 * 与详情页共用这一份 —— 两页读的是同一个口,抄两份就会各漂各的。
 */

/** 桥自报的能力,三态。 */
export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface BridgeBotView {
	botId: string;
	platform: string;
	name?: string;
	selfId?: string;
	capabilities?: Partial<Record<string, CapabilityState>>;
}

export interface BridgeSessionView {
	connectionId: string;
	connected: boolean;
	kind?: string;
	name?: string;
	version?: string;
	connectedAt?: number;
	/** 桥自己在哪台机器上 —— 「来自 192.168.1.5」。 */
	remoteAddress?: string;
	bots?: BridgeBotView[];
}

export interface BridgeStatusView {
	sessions?: BridgeSessionView[];
}

/**
 * 读桥的活口状态。**不重试**:拓展关着 / 没跑起来时这一口是 404,那是一个要当场说出来的
 * 状态,不是一次网络抖动。`enabled` 为假时干脆不问 —— 问了也是 404,还会在开关刚拨下去
 * 的那一秒闪一下「没跑起来」。
 */
export function useBridgeStatus(extensionId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["extension-status", extensionId],
		queryFn: () => api.get<BridgeStatusView>(`/api/ext/${extensionId}/status`),
		retry: false,
		enabled,
	});
}

/** 现在连着的会话里一共驮着几个 bot。 */
export function onlineBotCount(status: BridgeStatusView | undefined): number {
	return (status?.sessions ?? [])
		.filter((session) => session.connected)
		.reduce((sum, session) => sum + (session.bots?.length ?? 0), 0);
}
