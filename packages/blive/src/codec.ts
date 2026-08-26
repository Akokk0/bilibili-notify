import { brotliDecompressSync, inflateSync } from "node:zlib";

/**
 * B 站直播信息流的二进制分帧编解码。
 *
 * 帧结构(大端):u32 包长(头+体) / u16 头长(恒 16) / u16 协议版本 /
 * u32 操作码 / u32 序列号,后随 body。
 *
 * 客户端只发 ver=1(数值版本)的心跳与认证包;服务器下行的压缩版本
 * (ver 2 zlib / ver 3 brotli)由解码侧处理。
 */

export enum WsOp {
	Heartbeat = 2,
	HeartbeatReply = 3,
	Message = 5,
	Auth = 7,
	AuthReply = 8,
}

const HEADER_LENGTH = 16;
const CLIENT_PROTOCOL_VERSION = 1;
const CLIENT_SEQUENCE = 1;

const textEncoder = new TextEncoder();

/** 服务器下行版本号。客户端上行恒为 1。 */
enum WsVersion {
	Json = 0,
	Number = 1,
	Zlib = 2,
	Brotli = 3,
}

/** 编码一个客户端上行包(心跳 / 认证)。body 为对象时 JSON 序列化。 */
export function encodePacket(op: WsOp, body: string | object): Uint8Array {
	const json = typeof body === "string" ? body : JSON.stringify(body);
	const bodyBytes = textEncoder.encode(json);
	const packet = new Uint8Array(HEADER_LENGTH + bodyBytes.length);
	const view = new DataView(packet.buffer);
	view.setUint32(0, packet.length);
	view.setUint16(4, HEADER_LENGTH);
	view.setUint16(6, CLIENT_PROTOCOL_VERSION);
	view.setUint32(8, op);
	view.setUint32(12, CLIENT_SEQUENCE);
	packet.set(bodyBytes, HEADER_LENGTH);
	return packet;
}

/** 解码后的顶层/内层包。压缩容器已展开,列表里只剩可消费的叶子包。 */
export interface DecodedPacket {
	op: number;
	/** op=3 → 人气值数字;op=5/8 → 解析后的 JSON。 */
	body: unknown;
}

/**
 * 解码一条服务器下行的完整 WS 消息。
 *
 * 一条消息可拼多个顶层包(按头部包长逐个切);ver=2/3 的压缩包解开后再按同样
 * 规则切内层包并展平。JSON 解析失败的包直接丢弃 —— codec 保持纯函数,坏包
 * 交给上层以「没收到」处理。
 */
export function decodeFrames(data: Uint8Array): DecodedPacket[] {
	const out: DecodedPacket[] = [];
	collectPackets(data, out);
	return out;
}

const textDecoder = new TextDecoder();

function collectPackets(data: Uint8Array, out: DecodedPacket[]): void {
	for (let offset = 0; offset + HEADER_LENGTH <= data.length; ) {
		const view = new DataView(data.buffer, data.byteOffset + offset);
		const packetLength = view.getUint32(0);
		if (packetLength < HEADER_LENGTH || offset + packetLength > data.length) return;
		const version = view.getUint16(6);
		const op = view.getUint32(8);
		const body = data.subarray(offset + HEADER_LENGTH, offset + packetLength);
		offset += packetLength;

		if (version === WsVersion.Zlib) {
			collectPackets(inflateSync(body), out);
			continue;
		}
		if (version === WsVersion.Brotli) {
			collectPackets(brotliDecompressSync(body), out);
			continue;
		}
		if (op === WsOp.HeartbeatReply) {
			out.push({ op, body: new DataView(body.buffer, body.byteOffset).getUint32(0) });
			continue;
		}
		try {
			out.push({ op, body: JSON.parse(textDecoder.decode(body)) });
		} catch {
			// 坏包丢弃
		}
	}
}
