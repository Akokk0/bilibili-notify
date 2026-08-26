/**
 * MESSAGE 命令 → {@link LiveEvent} 的映射层。
 *
 * 只解业务在用的命令,其余(以及形状缺损/protobuf 解不开的)一律降级为
 * `raw` 透传,绝不抛 —— 一条坏消息不该影响整条连接。
 *
 * 字段映射的底本:真实录制帧(fixtures/)为主,blive-message-listener 0.5.4
 * (MIT)的解析器为参照;录制窗口没等到的稀有命令(SC / 上舰 / 开播 / 下播)
 * 以该库消费的字段 + bilibili-api-collect 文档为准。
 */

import { GuardLevel, type LiveEvent, type UserActionType } from "./events.js";
import { decodeInteractWordV2 } from "./interact-word-v2-proto.js";

/** 解析一条 MESSAGE 命令 payload。任何输入都返回事件,未知/缺损 → raw。 */
export function parseCommand(payload: unknown): LiveEvent {
	const record = payload as Record<string, unknown> | null;
	const cmd = typeof record?.cmd === "string" ? record.cmd : "unknown";
	const raw: LiveEvent = { kind: "raw", cmd, payload };

	try {
		// DANMU_MSG 有带后缀的变体(如 DANMU_MSG:4:0:2:2:2:0)
		if (cmd === "DANMU_MSG" || cmd.startsWith("DANMU_MSG:")) {
			return parseDanmu(record) ?? raw;
		}
		switch (cmd) {
			case "SUPER_CHAT_MESSAGE":
				return parseSuperChat(record) ?? raw;
			case "GUARD_BUY":
				return parseGuardBuy(record) ?? raw;
			case "WATCHED_CHANGE":
				return parseWatched(record) ?? raw;
			case "LIKE_INFO_V3_UPDATE":
				return parseLiked(record) ?? raw;
			case "LIVE":
				return { kind: "live-start" };
			case "PREPARING":
				return { kind: "live-end" };
			case "INTERACT_WORD_V2":
				return parseUserAction(record) ?? raw;
			default:
				return raw;
		}
	} catch {
		return raw;
	}
}

function parseDanmu(record: Record<string, unknown> | null): LiveEvent | undefined {
	// info[1] = 正文,info[2] = [uid, uname, ...]
	const info = record?.info;
	if (!Array.isArray(info)) return undefined;
	const content = info[1];
	const sender = info[2];
	if (typeof content !== "string" || !Array.isArray(sender)) return undefined;
	const uid = sender[0];
	const uname = sender[1];
	if (typeof uid !== "number" || typeof uname !== "string") return undefined;
	return { kind: "danmu", content, user: { uid, uname } };
}

function parseSuperChat(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| { uid?: unknown; user_info?: { uname?: unknown }; message?: unknown; price?: unknown }
		| undefined;
	const uid = data?.uid;
	const uname = data?.user_info?.uname;
	const content = data?.message;
	const price = data?.price;
	if (
		typeof uid !== "number" ||
		typeof uname !== "string" ||
		typeof content !== "string" ||
		typeof price !== "number"
	) {
		return undefined;
	}
	return { kind: "superchat", content, price, user: { uid, uname } };
}

function parseGuardBuy(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| { uid?: unknown; username?: unknown; guard_level?: unknown; gift_name?: unknown }
		| undefined;
	const uid = data?.uid;
	const uname = data?.username;
	const guardLevel = data?.guard_level;
	const giftName = data?.gift_name;
	if (
		typeof uid !== "number" ||
		typeof uname !== "string" ||
		typeof guardLevel !== "number" ||
		typeof giftName !== "string"
	) {
		return undefined;
	}
	return {
		kind: "guard-buy",
		guardLevel: guardLevel as GuardLevel,
		giftName,
		user: { uid, uname },
	};
}

function parseWatched(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as { num?: unknown; text_small?: unknown } | undefined;
	if (typeof data?.num !== "number" || typeof data?.text_small !== "string") return undefined;
	return { kind: "watched", num: data.num, textSmall: data.text_small };
}

function parseLiked(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as { click_count?: unknown } | undefined;
	if (typeof data?.click_count !== "number") return undefined;
	return { kind: "liked", count: data.click_count };
}

const USER_ACTION_TYPES: Record<number, UserActionType> = {
	1: "enter",
	2: "follow",
	3: "share",
};

function parseUserAction(record: Record<string, unknown> | null): LiveEvent | undefined {
	const pb = (record?.data as { pb?: unknown } | undefined)?.pb;
	if (typeof pb !== "string") return undefined;
	const decoded = decodeInteractWordV2(pb);
	const uid = decoded.uinfo?.uid ?? decoded.uid;
	const uname = decoded.uinfo?.base?.uname ?? decoded.uname;
	if (typeof uid !== "number" || typeof uname !== "string") return undefined;
	return {
		kind: "user-action",
		action: USER_ACTION_TYPES[decoded.msg_type ?? 0] ?? "unknown",
		user: { uid, uname },
	};
}

export { GuardLevel };
