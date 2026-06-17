import { describe, expect, it } from "vitest";
import {
	buildQQHeartbeat,
	buildQQIdentify,
	buildQQResume,
	parseQQFrame,
	QQ_OPCODE,
	QQ_PUSH_INTENTS,
	qqApiBase,
	qqGatewayUrlForHost,
	qqShouldResetSessionOnClose,
} from "../qq-official";

describe("qqApiBase — 沙箱/正式 REST host", () => {
	it("正式 → api.sgroup.qq.com", () => {
		expect(qqApiBase(false)).toBe("https://api.sgroup.qq.com");
	});
	it("沙箱 → sandbox.api.sgroup.qq.com", () => {
		expect(qqApiBase(true)).toBe("https://sandbox.api.sgroup.qq.com");
	});
});

describe("qqGatewayUrlForHost — /gateway 返回 url 的沙箱改写", () => {
	it("正式:原样返回", () => {
		expect(qqGatewayUrlForHost("wss://api.sgroup.qq.com/websocket", false)).toBe(
			"wss://api.sgroup.qq.com/websocket",
		);
	});
	it("沙箱:host 改写到 sandbox", () => {
		expect(qqGatewayUrlForHost("wss://api.sgroup.qq.com/websocket", true)).toBe(
			"wss://sandbox.api.sgroup.qq.com/websocket",
		);
	});
});

describe("QQ_PUSH_INTENTS — push-only intents 超集", () => {
	it("含 GUILDS(1<<0)/USER_MESSAGE(1<<25)/MESSAGE_AUDIT(1<<27)/PUBLIC_GUILD_MESSAGES(1<<30)", () => {
		const expected = (1 << 0) | (1 << 25) | (1 << 27) | (1 << 30);
		expect(QQ_PUSH_INTENTS).toBe(expected >>> 0);
	});
	it("含 USER_MESSAGE 位(群/C2C 入站,openid 捞取命门)", () => {
		expect(QQ_PUSH_INTENTS & (1 << 25)).toBeTruthy();
	});
});

describe("buildQQIdentify — op2 鉴权帧", () => {
	it("token 前缀 QQBot、带 intents + shard[0,1]", () => {
		expect(buildQQIdentify("ACCESS")).toEqual({
			op: QQ_OPCODE.IDENTIFY,
			d: { token: "QQBot ACCESS", intents: QQ_PUSH_INTENTS, shard: [0, 1] },
		});
	});
	it("可覆盖 intents", () => {
		expect(buildQQIdentify("ACCESS", 5).d.intents).toBe(5);
	});
});

describe("buildQQResume — op6 续连帧", () => {
	it("token 前缀 QQBot、带 session_id + seq", () => {
		expect(buildQQResume("ACCESS", "SID", 42)).toEqual({
			op: QQ_OPCODE.RESUME,
			d: { token: "QQBot ACCESS", session_id: "SID", seq: 42 },
		});
	});
});

describe("buildQQHeartbeat — op1 心跳帧", () => {
	it("d = 最近 seq", () => {
		expect(buildQQHeartbeat(99)).toEqual({ op: QQ_OPCODE.HEARTBEAT, d: 99 });
	});
	it("尚无 seq → d 为 null", () => {
		expect(buildQQHeartbeat(null)).toEqual({ op: QQ_OPCODE.HEARTBEAT, d: null });
	});
});

describe("parseQQFrame — 解析入站帧", () => {
	it("合法 DISPATCH 帧 → {op,s,t,d}", () => {
		const raw = JSON.stringify({ op: 0, s: 7, t: "READY", d: { session_id: "S" } });
		expect(parseQQFrame(raw)).toEqual({ op: 0, s: 7, t: "READY", d: { session_id: "S" } });
	});
	it("HELLO 帧 → 带 heartbeat_interval", () => {
		const raw = JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } });
		expect(parseQQFrame(raw)).toEqual({ op: 10, d: { heartbeat_interval: 45000 } });
	});
	it("非法 JSON → null(不崩)", () => {
		expect(parseQQFrame("not json{")).toBeNull();
	});
	it("缺 op 字段 → null", () => {
		expect(parseQQFrame(JSON.stringify({ t: "X" }))).toBeNull();
	});
});

describe("qqShouldResetSessionOnClose — 关闭码是否清会话(强制重新 IDENTIFY)", () => {
	it("4000+ 且非 4008/4009 → 清会话", () => {
		expect(qqShouldResetSessionOnClose(4006)).toBe(true);
	});
	it("4008(限流)/4009(超时可续连)→ 不清,可 RESUME", () => {
		expect(qqShouldResetSessionOnClose(4008)).toBe(false);
		expect(qqShouldResetSessionOnClose(4009)).toBe(false);
	});
	it("普通断开(1006 等 <4000)→ 不清,可 RESUME", () => {
		expect(qqShouldResetSessionOnClose(1006)).toBe(false);
	});
});
