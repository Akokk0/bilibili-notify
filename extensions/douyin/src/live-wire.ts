import { gunzipSync } from "node:zlib";
import type { ExtensionLiveInteractionReport } from "@bilibili-notify/extension";
import protobuf from "protobufjs/light.js";

// Wire field numbers for the public room stream. Only the fields BN consumes
// are declared. https://github.com/opedium/douyin-live-proto/blob/master/douyin_live.proto
const root = protobuf.Root.fromJSON({
	nested: {
		PushFrame: {
			fields: {
				logId: { type: "uint64", id: 2 },
				encoding: { type: "string", id: 6 },
				kind: { type: "string", id: 7 },
				payload: { type: "bytes", id: 8 },
			},
		},
		Response: {
			fields: {
				messages: { rule: "repeated", type: "Message", id: 1 },
				internalExt: { type: "string", id: 5 },
				needAck: { type: "bool", id: 9 },
			},
		},
		Message: {
			fields: {
				method: { type: "string", id: 1 },
				payload: { type: "bytes", id: 2 },
				id: { type: "uint64", id: 3 },
			},
		},
		Common: { fields: { id: { type: "uint64", id: 2 }, roomId: { type: "uint64", id: 3 } } },
		User: {
			fields: {
				id: { type: "uint64", id: 1 },
				name: { type: "string", id: 3 },
				secUid: { type: "string", id: 46 },
				idString: { type: "string", id: 1028 },
			},
		},
		Control: {
			fields: {
				common: { type: "Common", id: 1 },
				status: { type: "uint32", id: 2 },
			},
		},
		Chat: {
			fields: {
				common: { type: "Common", id: 1 },
				user: { type: "User", id: 2 },
				text: { type: "string", id: 3 },
			},
		},
		Gift: {
			fields: {
				common: { type: "Common", id: 1 },
				giftId: { type: "uint64", id: 2 },
				groupCount: { type: "uint64", id: 4 },
				repeatCount: { type: "uint64", id: 5 },
				comboCount: { type: "uint64", id: 6 },
				user: { type: "User", id: 7 },
				repeatEnd: { type: "uint32", id: 9 },
				groupId: { type: "uint64", id: 11 },
				info: { type: "GiftInfo", id: 15 },
			},
		},
		GiftInfo: { fields: { combo: { type: "bool", id: 10 } } },
	},
});
const PushFrame = root.lookupType("PushFrame");
const Response = root.lookupType("Response");
const Control = root.lookupType("Control");
const Chat = root.lookupType("Chat");
const Gift = root.lookupType("Gift");
const limit = 2 * 1024 * 1024;

function decode<T>(type: protobuf.Type, bytes: Uint8Array): T {
	return type.toObject(type.decode(bytes), { longs: String }) as T;
}

export const heartbeat = Buffer.from(PushFrame.encode({ kind: "hb" }).finish());

interface RoomMessage {
	method?: string;
	payload?: Uint8Array;
	id?: string;
}

interface Common {
	id?: string;
	roomId?: string;
}

interface Viewer {
	id?: string;
	idString?: string;
	secUid?: string;
	name?: string;
}

interface Interaction {
	key: string;
	report: ExtensionLiveInteractionReport;
}

interface RoomFrame {
	ended: boolean;
	ack?: Uint8Array;
	interactions: Interaction[];
}

function viewerId(user: Viewer | undefined) {
	const id = user?.secUid || user?.idString || user?.id;
	return id && id !== "0" ? id : undefined;
}

function messageKey(message: RoomMessage, common: Common) {
	const id = message.id && message.id !== "0" ? message.id : common.id;
	return id && id !== "0" ? `message:${id}` : undefined;
}

function interactionOf(message: RoomMessage, roomId: string): Interaction | undefined {
	if (!message.payload) return;
	if (message.method === "WebcastChatMessage") {
		const chat = decode<{ common?: Common; user?: Viewer; text?: string }>(Chat, message.payload);
		if (chat.common?.roomId !== roomId) return;
		const id = viewerId(chat.user);
		const name = chat.user?.name?.trim();
		const key = messageKey(message, chat.common);
		if (key && id && name && chat.text?.trim()) {
			return { key, report: { kind: "viewerChat", viewer: { id, name }, text: chat.text } };
		}
	} else if (message.method === "WebcastGiftMessage") {
		const gift = decode<{
			common?: Common;
			giftId?: string;
			user?: Viewer;
			groupId?: string;
			groupCount?: string;
			repeatCount?: string;
			comboCount?: string;
			repeatEnd?: number;
			info?: { combo?: boolean };
		}>(Gift, message.payload);
		if (gift.common?.roomId !== roomId) return;
		const repeat = Math.max(Number(gift.repeatCount ?? 0), Number(gift.comboCount ?? 0), 1);
		const hasGroup = gift.groupId && gift.groupId !== "0";
		const combo = gift.info?.combo === true || hasGroup || repeat > 1;
		if (combo && gift.repeatEnd !== 1) return;
		const count = (Number(gift.groupCount ?? 1) || 1) * repeat;
		const sender = viewerId(gift.user);
		const key =
			gift.repeatEnd === 1 && hasGroup && gift.giftId && sender
				? `gift:${gift.groupId}:${gift.giftId}:${sender}`
				: messageKey(message, gift.common);
		if (key && Number.isSafeInteger(count)) return { key, report: { kind: "gift", count } };
	}
}

export function readRoomFrame(bytes: Uint8Array, roomId: string): RoomFrame | undefined {
	if (bytes.byteLength === 0 || bytes.byteLength > limit) return;
	const frame = decode<{
		logId?: string;
		encoding?: string;
		kind?: string;
		payload?: Uint8Array;
	}>(PushFrame, bytes);
	if (frame.kind === "hb" || frame.kind === "pong") return { ended: false, interactions: [] };
	if (!frame.payload?.byteLength) return;
	const compressed =
		frame.encoding === "gzip" || (frame.payload[0] === 31 && frame.payload[1] === 139);
	const body = compressed ? gunzipSync(frame.payload, { maxOutputLength: limit }) : frame.payload;
	const response = decode<{
		messages?: RoomMessage[];
		internalExt?: string;
		needAck?: boolean;
	}>(Response, body);
	const ack =
		response.needAck && frame.logId !== undefined
			? Buffer.from(
					PushFrame.encode({
						logId: frame.logId,
						kind: "ack",
						payload: Buffer.from(response.internalExt ?? ""),
					}).finish(),
				)
			: undefined;
	let ended = false;
	const interactions: Interaction[] = [];
	for (const message of response.messages ?? []) {
		if (!message.payload) continue;
		try {
			if (message.method === "WebcastControlMessage") {
				const control = decode<{ common?: Common; status?: number }>(Control, message.payload);
				if (control.common?.roomId === roomId && control.status === 3) ended = true;
			} else {
				const interaction = interactionOf(message, roomId);
				if (interaction) interactions.push(interaction);
			}
		} catch {
			// A malformed message does not invalidate the rest of the batch.
		}
	}
	return { ack, ended, interactions };
}
