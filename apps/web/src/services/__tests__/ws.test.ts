/**
 * 收帧的外形核验:对得上 contract 的 `WsEnvelope` 才交给 hook,对不上丢掉。
 *
 * 只核外形(控制帧的 `type`、事件帧的频道与事件名);`data` 不核 —— hook 读格时自己判空。
 */

import { describe, expect, it } from "vite-plus/test";
import { wsEnvelopeOf } from "../ws";

describe("wsEnvelopeOf:收", () => {
	it("五种控制帧", () => {
		for (const type of ["subscribed", "unsubscribed", "ping", "pong", "error"]) {
			const frame = { type, ts: "2026-09-30T00:00:00.000Z" };
			expect(wsEnvelopeOf(frame)).toBe(frame);
		}
	});

	it("已知频道、事件名是字符串的事件帧", () => {
		const frame = { type: "state", event: "hydrate", ts: "t", data: null };
		expect(wsEnvelopeOf(frame)).toBe(frame);
	});

	it("data 形状不对也收:那一层由 hook 按格判空", () => {
		const frame = { type: "push-events", event: "live-viewers-changed", ts: "t", data: "乱的" };
		expect(wsEnvelopeOf(frame)).toBe(frame);
	});
});

describe("wsEnvelopeOf:丢", () => {
	it("不是对象", () => {
		for (const raw of [null, undefined, "state", 1, true]) expect(wsEnvelopeOf(raw)).toBeNull();
	});

	it("type 不是字符串,或既不是控制帧也不是已知频道", () => {
		expect(wsEnvelopeOf({ event: "hydrate" })).toBeNull();
		expect(wsEnvelopeOf({ type: 1, event: "hydrate" })).toBeNull();
		expect(wsEnvelopeOf({ type: "nope", event: "hydrate" })).toBeNull();
	});

	it("频道对了,事件名缺了或不是字符串", () => {
		expect(wsEnvelopeOf({ type: "state", data: null })).toBeNull();
		expect(wsEnvelopeOf({ type: "state", event: 7 })).toBeNull();
	});

	it("原型链上的名字不算控制帧", () => {
		expect(wsEnvelopeOf({ type: "toString" })).toBeNull();
		expect(wsEnvelopeOf({ type: "constructor" })).toBeNull();
	});
});
