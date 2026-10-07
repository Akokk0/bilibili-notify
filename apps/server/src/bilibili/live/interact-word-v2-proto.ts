/**
 * INTERACT_WORD_V2 的 protobuf schema。
 *
 * 移植自 blive-message-listener 0.5.4(MIT,© ddiu8081,
 * src/protobuf/INTERACT_WORD_V2.proto.ts),仅保留本包消费的字段所需的结构 ——
 * 完整 schema 与线上真帧都验证过:未声明的字段号 protobufjs 会安全跳过。
 */

import protobuf from "protobufjs";

const root = protobuf.Root.fromJSON({
	nested: {
		InteractWordV2: {
			fields: {
				uid: { type: "uint64", id: 1 },
				uname: { type: "string", id: 2 },
				msg_type: { type: "MsgType", id: 5 },
				uinfo: { type: "UserInfo", id: 22 },
			},
			nested: {
				MsgType: {
					values: {
						MSG_UNKNOWN: 0,
						MSG_ENTER_ROOM: 1,
						MSG_FOLLOW: 2,
						MSG_SHARE_ROOM: 3,
					},
				},
				UserInfo: {
					fields: {
						uid: { type: "uint64", id: 1 },
						base: { type: "BaseInfo", id: 2 },
					},
					nested: {
						BaseInfo: {
							fields: {
								uname: { type: "string", id: 1 },
							},
						},
					},
				},
			},
		},
	},
});

const InteractWordV2 = root.lookupType("InteractWordV2");

export interface InteractWordV2Decoded {
	uid?: number;
	uname?: string;
	msg_type?: number;
	uinfo?: { uid?: number; base?: { uname?: string } };
}

/** 解开 INTERACT_WORD_V2 的 base64 protobuf。坏数据抛错,由调用方降级。 */
export function decodeInteractWordV2(pbBase64: string): InteractWordV2Decoded {
	const bytes = Buffer.from(pbBase64, "base64");
	return InteractWordV2.toObject(InteractWordV2.decode(bytes), {
		longs: Number,
	}) as InteractWordV2Decoded;
}
