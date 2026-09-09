/**
 * 桥的入站帧 → 平台中立的那两个形状。
 *
 * 这一步的价值全在「交出去的东西跟直连交出来的一模一样」:指令分发与链接解析都不该
 * 知道这条消息是从桥来的。所以这里钉的是**归一化的结果**,不是协议本身(协议的形状
 * 归 `protocol.test.ts`)。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { BridgeBot, BridgeInboundFrame } from "../contract.js";
import { routeBridgeInbound } from "../inbound.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bot(over: Partial<BridgeBot> = {}): BridgeBot {
	return {
		botId: "b1",
		platform: "telegram",
		selfId: "77770000",
		capabilities: {
			atAll: "unsupported",
			inbound: "supported",
			forward: "unknown",
			miniAppCard: "unknown",
			shareCardLinks: "unknown",
			markdown: "unknown",
		},
		...over,
	};
}

function sinks() {
	return { private: vi.fn(), group: vi.fn() };
}

function privateFrame(over: Partial<BridgeInboundFrame> = {}): BridgeInboundFrame {
	return {
		type: "inbound",
		botId: "b1",
		platform: "telegram",
		message: { scope: "private", userId: "u1", text: "/status" },
		...over,
	};
}

function groupFrame(over: Partial<BridgeInboundFrame> = {}): BridgeInboundFrame {
	return {
		type: "inbound",
		botId: "b1",
		platform: "telegram",
		message: {
			scope: "group",
			groupId: "-100",
			userId: "u1",
			text: "看看 https://www.bilibili.com/video/BV1xx",
		},
		...over,
	};
}

const source = { connectionId: CONNECTION_ID, bots: [bot()] };

describe("routeBridgeInbound", () => {
	it("私聊走指令那一路,三坐标齐全 —— 平台与 bot 都在 meta 里", () => {
		const s = sinks();
		routeBridgeInbound(privateFrame(), source, s);
		expect(s.private).toHaveBeenCalledWith(
			{ userId: "u1", text: "/status" },
			{ connectionId: CONNECTION_ID, platform: "telegram", botId: "b1" },
		);
		expect(s.group).not.toHaveBeenCalled();
	});

	it("群消息走链接那一路,分享卡两格是空的 —— 桥把卡里的链接拼进正文再发上来", () => {
		const s = sinks();
		routeBridgeInbound(groupFrame(), source, s);
		expect(s.group).toHaveBeenCalledWith(
			{
				groupId: "-100",
				userId: "u1",
				text: "看看 https://www.bilibili.com/video/BV1xx",
				selfId: "77770000",
				cardLinks: [],
				miniAppCardLinks: [],
			},
			{ connectionId: CONNECTION_ID, platform: "telegram", botId: "b1" },
		);
		expect(s.private).not.toHaveBeenCalled();
	});

	it("selfId 从 bot 名单里查 —— 「机器人自己贴的链接不解析」那道闸全靠它", () => {
		const s = sinks();
		routeBridgeInbound(
			groupFrame({ botId: "b2" }),
			{ connectionId: CONNECTION_ID, bots: [bot(), bot({ botId: "b2", selfId: "88880000" })] },
			s,
		);
		expect(s.group.mock.calls[0]?.[0]).toMatchObject({ selfId: "88880000" });
	});

	it("名单里还没有这个 bot 也照走 —— 名单是全量快照,可能比消息晚到", () => {
		const s = sinks();
		routeBridgeInbound(groupFrame({ botId: "b9" }), source, s);
		expect(s.group.mock.calls[0]?.[0]).toMatchObject({ selfId: undefined });
		expect(s.group.mock.calls[0]?.[1]).toMatchObject({ botId: "b9" });
	});

	it("bot 没报 selfId 就没有 —— 不拿 botId 顶替(那是两套编号)", () => {
		const s = sinks();
		routeBridgeInbound(
			groupFrame(),
			{ connectionId: CONNECTION_ID, bots: [bot({ selfId: undefined })] },
			s,
		);
		expect(s.group.mock.calls[0]?.[0]).toMatchObject({ selfId: undefined });
	});

	/**
	 * 一帧只走一路 —— 私聊帧碰不到群那一路,反之亦然。从前这两路是可选的(核心那侧
	 * 可能没接),现在 `ctx.inbound` 两路恒在,所以钉的是**分流**而不是「没接不炸」。
	 */
	it("私聊帧不走群那一路", () => {
		const s = sinks();
		routeBridgeInbound(privateFrame(), source, s);
		expect(s.group).not.toHaveBeenCalled();
		routeBridgeInbound(groupFrame(), source, s);
		expect(s.private).toHaveBeenCalledTimes(1);
	});
});
