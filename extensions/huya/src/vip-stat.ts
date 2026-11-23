import { BinBuffer, type TarsInputStream, type TarsOutputStream, Tup } from "@tars/stream";

const service = "liveui";
const method = "getVipBarListStat";

/** 虎牙房间的贵宾汇总。lPid 使用主播 UID，tUserId 保持游客默认值。 */
export function vipStatRequest(uid: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[1-9]\d{0,18}$/.test(uid) || BigInt(uid) > 0x7fffffffffffffffn) return;
	const packet = new Tup();
	packet.tupVersion = Tup.TUP_SIMPLE;
	packet.servantName = service;
	packet.funcName = method;
	packet.requestId = 1;
	packet.writeStruct("tReq", {
		_writeTo(writer: TarsOutputStream) {
			writer.writeStruct(0, {
				_writeTo(user: TarsOutputStream) {
					user.writeInt64(0, 0);
				},
			});
			writer.writeInt64(1, uid, true);
		},
	});
	return Uint8Array.from(packet.encode().toNodeBuffer());
}

class VipBarStat {
	constructor(
		readonly uid: string,
		readonly viewers: number,
	) {}

	static _readFrom(reader: TarsInputStream) {
		// 网页贵宾标签取 iTotal（tag 1）。统计接口按主播返回，无需读取贵宾名单。
		return new VipBarStat(
			String(reader.readInt64(0, true, undefined, true)),
			reader.readInt32(1, true),
		);
	}
}

export function vipViewersFrom(bytes: Uint8Array, uid: string): number | undefined {
	const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (frame.length < 4 || frame.readUInt32BE() !== frame.length) return;
	try {
		const packet = new Tup();
		packet.decode(new BinBuffer(frame));
		if (
			packet.servantName !== service ||
			packet.funcName !== method ||
			packet.getTarsResultCode() !== 0 ||
			packet.readInt32("", -1) !== 0
		)
			return;
		const stat = packet.readStruct("tRsp", VipBarStat);
		if (stat.uid === uid && stat.viewers >= 0) return stat.viewers;
	} catch {
		// 贵宾统计是可选数据，协议变化时仍交付已核实的直播状态。
	}
}
