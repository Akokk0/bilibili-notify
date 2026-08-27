/**
 * SEND_GIFT_V2 的 protobuf schema。
 *
 * 2026-08 实测:大房间的礼物帧已全部换成 SEND_GIFT_V2(base64 protobuf in
 * `data.pb`),旧 SEND_GIFT 在 30 分钟录制里一条都没有。字段号对照
 * sjh8130/bili_danmaku 的 SEND_GIFT_V2.proto,并经自录真帧的 wire 走查独立
 * 验证;仅保留本包消费的字段 —— 未声明的字段号 protobufjs 会安全跳过。
 */

import protobuf from "protobufjs";

const root = protobuf.Root.fromJSON({
	nested: {
		SendGiftV2: {
			fields: {
				uid: { type: "uint64", id: 1 },
				uname: { type: "string", id: 2 },
				guard_level: { type: "uint32", id: 5 },
				medal_info: { type: "MedalInfo", id: 8 },
				// 实测恒为单元素;协议上 repeated,保留数组形状
				gift_list: { type: "GiftItem", id: 10, rule: "repeated" },
			},
			nested: {
				MedalInfo: {
					fields: {
						target_id: { type: "uint64", id: 1 },
						anchor_roomid: { type: "uint64", id: 4 },
						medal_level: { type: "uint32", id: 5 },
						medal_name: { type: "string", id: 6 },
						is_lighted: { type: "uint32", id: 11 },
					},
				},
				GiftItem: {
					fields: {
						gift_id: { type: "uint64", id: 1 },
						gift_name: { type: "string", id: 2 },
						num: { type: "uint32", id: 3 },
						price: { type: "uint64", id: 5 },
						coin_type: { type: "string", id: 8 },
						super_batch_gift_num: { type: "uint64", id: 11 },
						batch_combo_id: { type: "string", id: 12 },
						combo_total_coin: { type: "uint64", id: 14 },
					},
				},
			},
		},
	},
});

const SendGiftV2 = root.lookupType("SendGiftV2");

export interface SendGiftV2Decoded {
	uid?: number;
	uname?: string;
	guard_level?: number;
	medal_info?: {
		target_id?: number;
		anchor_roomid?: number;
		medal_level?: number;
		medal_name?: string;
		is_lighted?: number;
	};
	gift_list?: {
		gift_id?: number;
		gift_name?: string;
		num?: number;
		price?: number;
		coin_type?: string;
		super_batch_gift_num?: number;
		batch_combo_id?: string;
		combo_total_coin?: number;
	}[];
}

/** 解开 SEND_GIFT_V2 的 base64 protobuf。坏数据抛错,由调用方降级。 */
export function decodeSendGiftV2(pbBase64: string): SendGiftV2Decoded {
	const bytes = Buffer.from(pbBase64, "base64");
	return SendGiftV2.toObject(SendGiftV2.decode(bytes), {
		longs: Number,
	}) as SendGiftV2Decoded;
}
