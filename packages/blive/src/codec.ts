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
