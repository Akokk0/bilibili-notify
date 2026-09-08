/**
 * 桥接协议的解析层 —— 帧从**不受信的外部插件**进来,所以这一层是边界。
 *
 * 这个文件钉的是三件容易写错的事:
 * 1. **不认识的帧要忽略、不认识的字段形状要拒**。两者反过来都是 bug:
 *    前者反了 → 桥升级多发一种帧就把老 BN 打死(协议再也没法单边演进);
 *    后者反了 → 一条畸形帧被当成正常帧喂进 BN 内部。
 * 2. **能力表要归一**。桥报的是开放词表(它可能少报、多报、报个 BN 没见过的值),
 *    BN 内部只该看见闭合的五项三态 —— 归一放在边界上做一次,别让「缺失」漏进业务层
 *    再被 `?? true` 之类的兜底悄悄当成「支持」。
 * 3. **版本按 major 判**。minor 不同要能连上,不然协议加一个可选字段就得两边同时发版。
 */

import {
	BRIDGE_CAPABILITIES,
	BRIDGE_MESSAGE_KINDS,
	BRIDGE_PROTOCOL_VERSION,
	type BridgeMessageKind,
} from "@bilibili-notify/contract";
import type { NotificationPayload } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	isBridgeProtocolCompatible,
	normalizeBridgeCapabilities,
	parseBridgeFrame,
} from "../protocol.js";

function helloFrame(over: Record<string, unknown> = {}) {
	return {
		type: "hello",
		protocol: { major: 1, minor: 0 },
		bridge: { kind: "koishi", name: "家里那台", version: "0.1.0" },
		bots: [
			{
				botId: "telegram:12345",
				platform: "telegram",
				name: "阿伦",
				capabilities: { atAll: "unsupported", inbound: "supported" },
			},
		],
		...over,
	};
}

describe("parseBridgeFrame", () => {
	it("认得握手帧 —— bots 与能力表原样带出来", () => {
		const parsed = parseBridgeFrame(helloFrame());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.frame.type).toBe("hello");
		if (parsed.frame.type !== "hello") return;
		expect(parsed.frame.protocol).toEqual({ major: 1, minor: 0 });
		expect(parsed.frame.bridge.kind).toBe("koishi");
		expect(parsed.frame.bots[0]?.botId).toBe("telegram:12345");
		expect(parsed.frame.bots[0]?.capabilities).toEqual({
			atAll: "unsupported",
			inbound: "supported",
		});
	});

	it("握手帧缺字段 / 形状不对 → invalid,消息里点得出是哪一格", () => {
		const noProtocol = parseBridgeFrame(helloFrame({ protocol: undefined }));
		expect(noProtocol).toMatchObject({ ok: false, reason: "invalid" });
		if (noProtocol.ok || noProtocol.reason !== "invalid") return;
		expect(noProtocol.message).toContain("protocol");

		const badBots = parseBridgeFrame(helloFrame({ bots: "一堆" }));
		expect(badBots).toMatchObject({ ok: false, reason: "invalid" });
		if (badBots.ok || badBots.reason !== "invalid") return;
		expect(badBots.message).toContain("bots");
	});

	it("**不认识的帧类型是忽略,不是拒绝** —— 桥比 BN 新时要还连得住", () => {
		const parsed = parseBridgeFrame({ type: "telemetry", payload: { anything: 1 } });
		expect(parsed).toEqual({ ok: false, reason: "unknown-type", type: "telemetry" });
	});

	it("连 type 都没有 / 不是对象 → invalid(这不叫「新帧」,叫垃圾)", () => {
		expect(parseBridgeFrame({ nope: 1 })).toMatchObject({ ok: false, reason: "invalid" });
		expect(parseBridgeFrame("hello")).toMatchObject({ ok: false, reason: "invalid" });
		expect(parseBridgeFrame(null)).toMatchObject({ ok: false, reason: "invalid" });
	});

	it("bots 帧是**全量快照**,空数组合法(桥的宿主里一个 bot 都没有)", () => {
		const parsed = parseBridgeFrame({ type: "bots", bots: [] });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.frame.type !== "bots") return;
		expect(parsed.frame.bots).toEqual([]);
	});

	it("bot 少报 capabilities 也合法 —— 归一那步再补成 unknown", () => {
		const parsed = parseBridgeFrame({
			type: "bots",
			bots: [{ botId: "b1", platform: "discord" }],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.frame.type !== "bots") return;
		expect(parsed.frame.bots[0]?.capabilities).toBeUndefined();
	});

	it("入站帧两支都解得开", () => {
		const priv = parseBridgeFrame({
			type: "inbound",
			botId: "b1",
			platform: "telegram",
			message: { scope: "private", userId: "u1", text: "订阅列表" },
		});
		expect(priv.ok).toBe(true);
		if (!priv.ok || priv.frame.type !== "inbound") return;
		expect(priv.frame.message).toEqual({ scope: "private", userId: "u1", text: "订阅列表" });

		const group = parseBridgeFrame({
			type: "inbound",
			botId: "b1",
			platform: "telegram",
			message: { scope: "group", groupId: "g1", userId: "u1", text: "https://b23.tv/x" },
		});
		expect(group.ok).toBe(true);
		if (!group.ok || group.frame.type !== "inbound") return;
		expect(group.frame.message.scope).toBe("group");
	});

	it("入站帧的 scope 不认识 → invalid(别静默当私聊)", () => {
		const parsed = parseBridgeFrame({
			type: "inbound",
			botId: "b1",
			platform: "telegram",
			message: { scope: "channel", userId: "u1", text: "x" },
		});
		expect(parsed).toMatchObject({ ok: false, reason: "invalid" });
	});

	it("result 帧把 id 与成败带回来", () => {
		const okFrame = parseBridgeFrame({ type: "result", id: "r1", ok: true });
		expect(okFrame.ok).toBe(true);
		if (!okFrame.ok || okFrame.frame.type !== "result") return;
		expect(okFrame.frame).toEqual({ type: "result", id: "r1", ok: true });

		const failed = parseBridgeFrame({ type: "result", id: "r2", ok: false, err: "bot 掉线了" });
		expect(failed.ok).toBe(true);
		if (!failed.ok || failed.frame.type !== "result") return;
		expect(failed.frame.err).toBe("bot 掉线了");
	});

	it("pong 帧", () => {
		expect(parseBridgeFrame({ type: "pong" })).toEqual({
			ok: true,
			frame: { type: "pong" },
		});
	});
});

describe("isBridgeProtocolCompatible", () => {
	it("major 相同就接受 —— minor 差多少都行,两个方向都行", () => {
		const { major } = BRIDGE_PROTOCOL_VERSION;
		expect(isBridgeProtocolCompatible({ major, minor: 0 })).toBe(true);
		expect(isBridgeProtocolCompatible({ major, minor: 99 })).toBe(true);
	});

	it("major 不同就拒 —— 大的小的都拒", () => {
		const { major } = BRIDGE_PROTOCOL_VERSION;
		expect(isBridgeProtocolCompatible({ major: major + 1, minor: 0 })).toBe(false);
		expect(isBridgeProtocolCompatible({ major: major - 1, minor: 0 })).toBe(false);
	});
});

describe("normalizeBridgeCapabilities", () => {
	it("五项恒在 —— 桥没报的一律 unknown,不是 unsupported 也不是支持", () => {
		const caps = normalizeBridgeCapabilities({ atAll: "supported" });
		expect(Object.keys(caps).sort()).toEqual([...BRIDGE_CAPABILITIES].sort());
		expect(caps.atAll).toBe("supported");
		expect(caps.forward).toBe("unknown");
		expect(caps.miniAppCard).toBe("unknown");
	});

	it("整张表都没有也行", () => {
		const caps = normalizeBridgeCapabilities(undefined);
		expect(Object.values(caps).every((v) => v === "unknown")).toBe(true);
	});

	it("桥多报的键**静默丢掉** —— 让协议两个方向都能单边演进", () => {
		const caps = normalizeBridgeCapabilities({
			atAll: "supported",
			"pigeon-post": "supported",
		}) as Record<string, string>;
		expect(caps["pigeon-post"]).toBeUndefined();
	});

	it("值不是那三态 → 当 unknown(保守),不是当支持", () => {
		const caps = normalizeBridgeCapabilities({ atAll: "yes", forward: "true" });
		expect(caps.atAll).toBe("unknown");
		expect(caps.forward).toBe("unknown");
	});
});

describe("消息投影", () => {
	/**
	 * `BridgeMessage` 是 {@link NotificationPayload} 在 wire 上的 JSON 投影(图从 Buffer
	 * 换成一次性 blob URL)。这张表是**编译期穷尽守卫**,两个方向都钉:
	 * 给 payload 加一个 kind 而协议里没它的路 → 键少了,编译不过;
	 * 协议词表少一档 → 值不在 {@link BridgeMessageKind} 里,也编译不过。
	 * 不然那个 kind 会在运行时静默发不出去。
	 */
	const PAYLOAD_KIND_TO_WIRE: Record<NotificationPayload["kind"], BridgeMessageKind> = {
		text: "text",
		image: "image",
		composite: "composite",
		"forward-images": "forward-images",
		"miniapp-card": "miniapp-card",
	};

	it("payload kind 与 wire kind **一一对上**,两边都不许有多出来的", () => {
		const mapped = [...new Set(Object.values(PAYLOAD_KIND_TO_WIRE))].sort();
		expect(mapped).toEqual([...BRIDGE_MESSAGE_KINDS].sort());
	});
});
