/**
 * 编解码层的独立真值有两种,分工如下:
 *
 * - **编码(客户端 → 服务器)**:期望字节按协议规范手算成字面量(16 字节大端头:
 *   u32 包长 / u16 头长=16 / u16 版本 / u32 op / u32 seq)。断言不调用任何
 *   实现侧的头结构常量,坏一个字节就红。
 * - **解码(服务器 → 客户端)**:以真实录制帧为准(fixtures/,由 capture 脚本
 *   录自线上弹幕服),规范文档只当索引用 —— 它自己声明可能过时。
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { decodeFrames, encodePacket, WsOp } from "../codec.js";
import frames from "./fixtures/frames.json" with { type: "json" };

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

describe("encodePacket", () => {
	it("心跳包:op=2 ver=1 seq=1,body 为 {}", () => {
		// 手算:总长 16+2=18 → 00 00 00 12;头长 00 10;ver 00 01;
		// op 00 00 00 02;seq 00 00 00 01;body "{}" = 7B 7D
		const expected = new Uint8Array([
			0x00, 0x00, 0x00, 0x12, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
			0x01, 0x7b, 0x7d,
		]);

		expect(encodePacket(WsOp.Heartbeat, {})).toEqual(expected);
	});

	it("认证包:op=7,body 为认证 JSON 原样序列化", () => {
		const body = { uid: 42, roomid: 1, protover: 3, platform: "web", type: 2, key: "k" };
		const json = JSON.stringify(body);
		const packet = encodePacket(WsOp.Auth, body);

		// 头部逐字段手算(不引用实现的偏移常量)
		const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
		expect(view.getUint32(0)).toBe(16 + json.length);
		expect(view.getUint16(4)).toBe(16);
		expect(view.getUint16(6)).toBe(1);
		expect(view.getUint32(8)).toBe(7);
		expect(view.getUint32(12)).toBe(1);
		expect(new TextDecoder().decode(packet.subarray(16))).toBe(json);
	});

	it("body 含多字节 UTF-8 时,包长按字节数不按字符数", () => {
		const packet = encodePacket(WsOp.Auth, { key: "弹幕" });
		const bodyBytes = new TextEncoder().encode(JSON.stringify({ key: "弹幕" }));
		const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

		expect(view.getUint32(0)).toBe(16 + bodyBytes.length);
		expect(packet.byteLength).toBe(16 + bodyBytes.length);
	});
});

describe("decodeFrames(真实录制帧)", () => {
	it("心跳回执:op=3,body 为大端 u32 人气值", () => {
		// 录制时该帧 body 为 00 00 00 01(人气值 1)
		expect(decodeFrames(b64(frames.heartbeatReply))).toEqual([
			{ op: WsOp.HeartbeatReply, body: 1 },
		]);
	});

	it("认证回执:op=8,body 为 JSON", () => {
		expect(decodeFrames(b64(frames.authReply))).toEqual([
			{ op: WsOp.AuthReply, body: { code: 0 } },
		]);
	});

	it("未压缩 MESSAGE(ver=0):body 直接是 JSON", () => {
		const packets = decodeFrames(b64(frames.plainMessage));

		expect(packets).toHaveLength(1);
		expect(packets[0]?.op).toBe(WsOp.Message);
		expect((packets[0]?.body as { cmd: string }).cmd).toBe("NOTICE_MSG");
	});

	it("brotli MESSAGE(ver=3):解压后展平内层包", () => {
		// 录制时该帧解压出 2 个内包,均为 INTERACT_WORD_V2
		const packets = decodeFrames(b64(frames.brotliMessage));

		expect(packets).toHaveLength(2);
		for (const p of packets) {
			expect(p.op).toBe(WsOp.Message);
			expect((p.body as { cmd: string }).cmd).toBe("INTERACT_WORD_V2");
		}
	});

	it("zlib MESSAGE(ver=2):规范仍列出的旧压缩版本也认(合成帧)", () => {
		// 线上已只见 brotli,zlib 帧按规范手工合成:内包 = 一条 ver=0 的 MESSAGE
		const innerBody = new TextEncoder().encode('{"cmd":"TEST_ZLIB"}');
		const inner = new Uint8Array(16 + innerBody.length);
		const iv = new DataView(inner.buffer);
		iv.setUint32(0, inner.length);
		iv.setUint16(4, 16);
		iv.setUint16(6, 0);
		iv.setUint32(8, 5);
		inner.set(innerBody, 16);
		const compressed = deflateSync(inner);
		const outer = new Uint8Array(16 + compressed.length);
		const ov = new DataView(outer.buffer);
		ov.setUint32(0, outer.length);
		ov.setUint16(4, 16);
		ov.setUint16(6, 2);
		ov.setUint32(8, 5);
		outer.set(compressed, 16);

		expect(decodeFrames(outer)).toEqual([{ op: WsOp.Message, body: { cmd: "TEST_ZLIB" } }]);
	});

	it("心跳回执 body 不足 4 字节 → 丢弃该包,不抛 RangeError", () => {
		// 恶意/损坏帧:头部合法但 body 为空
		const bad = new Uint8Array(16);
		const view = new DataView(bad.buffer);
		view.setUint32(0, 16);
		view.setUint16(4, 16);
		view.setUint16(6, 1);
		view.setUint32(8, 3);

		expect(decodeFrames(bad)).toEqual([]);
	});

	it("压缩容器解不开 → 丢弃该包,不抛(交给上层当没收到)", () => {
		const bad = new Uint8Array(20);
		const view = new DataView(bad.buffer);
		view.setUint32(0, 20);
		view.setUint16(4, 16);
		view.setUint16(6, 3);
		view.setUint32(8, 5);
		// body 是 4 字节垃圾,brotli 解压必然失败

		expect(decodeFrames(bad)).toEqual([]);
	});

	it("一条 WS 消息可拼多个顶层包,按包长逐个切", () => {
		const hb = b64(frames.heartbeatReply);
		const auth = b64(frames.authReply);
		const joined = new Uint8Array(hb.length + auth.length);
		joined.set(hb, 0);
		joined.set(auth, hb.length);

		expect(decodeFrames(joined)).toEqual([
			{ op: WsOp.HeartbeatReply, body: 1 },
			{ op: WsOp.AuthReply, body: { code: 0 } },
		]);
	});
});
