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
	it("私聊走指令那一路,两坐标齐全 —— 平台在 meta 里,连接是绑成的那条", () => {
		const s = sinks();
		routeBridgeInbound(privateFrame(), source, s);
		expect(s.private).toHaveBeenCalledWith(
			{ userId: "u1", text: "/status" },
			{ connectionId: CONNECTION_ID, platform: "telegram" },
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
			{ connectionId: CONNECTION_ID, platform: "telegram" },
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
	 * 🔴 **platform 认名单,不认帧里自报的那一格**。它是主人身份比对(平台 + 地址 + bot
	 * 三坐标)与逐群策略的键 —— 一条 `inbound` 帧自己说自己是什么平台,就等于让对面挑
	 * 拿哪把钥匙开门。名单那份是握手 / bots 快照报上来的,与连接、与能力表同源。
	 */
	it("**platform 取名单里那个 bot 的**,不是帧里自报的", () => {
		const s = sinks();
		routeBridgeInbound(privateFrame({ platform: "onebot" }), source, s);
		expect(s.private.mock.calls[0]?.[1]).toEqual({
			connectionId: CONNECTION_ID,
			platform: "telegram",
		});
	});

	it("群那一路同样认名单", () => {
		const s = sinks();
		routeBridgeInbound(groupFrame({ platform: "onebot" }), source, s);
		expect(s.group.mock.calls[0]?.[1]).toMatchObject({ platform: "telegram" });
	});

	it("名单里还没有这个 bot → 退回帧里自报的(名单是快照,可能比消息晚到)", () => {
		const s = sinks();
		routeBridgeInbound(privateFrame({ botId: "b9", platform: "onebot" }), source, s);
		expect(s.private.mock.calls[0]?.[1]).toMatchObject({ platform: "onebot" });
	});

	it("两边对不上 → 叫一声,别让它悄悄发生", () => {
		const s = sinks();
		const mismatch = vi.fn();
		routeBridgeInbound(
			privateFrame({ platform: "onebot" }),
			{ ...source, onPlatformMismatch: mismatch },
			s,
		);
		expect(mismatch).toHaveBeenCalledWith("onebot", "telegram");
	});

	it("对得上就别叫 —— 每一条消息都会经这儿", () => {
		const s = sinks();
		const mismatch = vi.fn();
		routeBridgeInbound(privateFrame(), { ...source, onPlatformMismatch: mismatch }, s);
		routeBridgeInbound(
			privateFrame({ botId: "b9" }),
			{ ...source, onPlatformMismatch: mismatch },
			s,
		);
		expect(mismatch).not.toHaveBeenCalled();
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
