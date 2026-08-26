/**
 * 编解码层的独立真值有两种,分工如下:
 *
 * - **编码(客户端 → 服务器)**:期望字节按协议规范手算成字面量(16 字节大端头:
 *   u32 包长 / u16 头长=16 / u16 版本 / u32 op / u32 seq)。断言不调用任何
 *   实现侧的头结构常量,坏一个字节就红。
 * - **解码(服务器 → 客户端)**:以真实录制帧为准(fixtures/,由 capture 脚本
 *   录自线上弹幕服),规范文档只当索引用 —— 它自己声明可能过时。
 */

import { describe, expect, it } from "vite-plus/test";
import { encodePacket, WsOp } from "../codec.js";

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
