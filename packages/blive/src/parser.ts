/**
 * MESSAGE 命令 → {@link LiveEvent} 的映射层。
 *
 * 解析 2026-08-27 定案的事件面(弹幕/SC/上舰/礼物/房间态/抽奖组/管理组/
 * 进场特效/点赞点击等),其余(以及形状缺损/protobuf 解不开的)一律降级为
 * `raw` 透传,绝不抛 —— 一条坏消息不该影响整条连接。
 *
 * 字段映射的底本:真实录制帧(fixtures/)与 blive-message-listener 0.5.4
 * (MIT,© ddiu8081)的 mock 真帧为主,该库解析器与 bilibili-api-collect
 * 文档为参照。
 *
 * **user-action 由 INTERACT_WORD_V2 一帧独供**:ENTRY_EFFECT / LIKE_INFO_V3_CLICK
 * 是独立 kind,绝不并入 user-action —— 混流正是舰长进房重复推旧 bug 的病根。
 *
 * 刻意不解析(要用走 raw):颜色族字段(牌子渐变/弹幕色,渲染细节)、文内
 * 小表情映射(in_message_emoticon)、礼物 send_master(连麦指向)、天选的
 * 送礼要求明细(require_text 已含人话描述)。
 */

import {
	type FanBadge,
	GuardLevel,
	type LiveEvent,
	type LiveUser,
	type UserActionType,
} from "./events.js";
import { decodeInteractWordV2 } from "./interact-word-v2-proto.js";
import { decodeSendGiftV2 } from "./send-gift-v2-proto.js";

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
			case "SEND_GIFT":
				return parseGift(record) ?? raw;
			case "SEND_GIFT_V2":
				return parseGiftV2(record) ?? raw;
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
			case "ROOM_CHANGE":
				return parseRoomChange(record) ?? raw;
			case "ONLINE_RANK_COUNT":
				return parseRankCount(record) ?? raw;
			case "POPULARITY_RED_POCKET_START":
				return parseRedPocketStart(record) ?? raw;
			case "POPULARITY_RED_POCKET_WINNER_LIST":
				return parseRedPocketEnd(record) ?? raw;
			case "ANCHOR_LOT_START":
				return parseAnchorLotteryStart(record) ?? raw;
			case "ANCHOR_LOT_AWARD":
				return parseAnchorLotteryEnd(record) ?? raw;
			case "WARNING":
				return parseRoomWarn(record, "warning") ?? raw;
			case "CUT_OFF":
				return parseRoomWarn(record, "cut") ?? raw;
			case "ROOM_SILENT_ON":
			case "ROOM_SILENT_OFF":
				return parseRoomSilent(record, cmd === "ROOM_SILENT_OFF") ?? raw;
			case "room_admin_entrance":
				return parseRoomAdmin(record, "set") ?? raw;
			case "ROOM_ADMIN_REVOKE":
				return parseRoomAdmin(record, "revoke") ?? raw;
			case "ENTRY_EFFECT":
				return parseEntryEffect(record) ?? raw;
			case "LIKE_INFO_V3_CLICK":
				return parseLikeClick(record) ?? raw;
			default:
				return raw;
		}
	} catch {
		return raw;
	}
}

// ── 公共小件 ────────────────────────────────────────────────────

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** guard_level > 0 才有意义;0(非舰长)一律省略。 */
function guardLevelOf(v: unknown): GuardLevel | undefined {
	return typeof v === "number" && v > 0 ? (v as GuardLevel) : undefined;
}

/**
 * data 系帧的粉丝牌(medal_info / fans_medal 同构:medal_level / medal_name /
 * is_lighted / target_id / anchor_roomid)。level 或 name 缺损 → 无牌。
 */
function badgeFromMedal(medal: unknown): FanBadge | undefined {
	const m = medal as
		| {
				medal_level?: unknown;
				medal_name?: unknown;
				is_lighted?: unknown;
				target_id?: unknown;
				anchor_roomid?: unknown;
		  }
		| undefined;
	const level = num(m?.medal_level);
	const name = str(m?.medal_name);
	if (!level || name === undefined) return undefined;
	const anchorUid = num(m?.target_id);
	const anchorRoomId = num(m?.anchor_roomid);
	return {
		level,
		name,
		active: m?.is_lighted === 1,
		...(anchorUid ? { anchorUid } : {}),
		...(anchorRoomId ? { anchorRoomId } : {}),
	};
}

/** 组装 LiveUser,可选字段仅在有意义时携带。 */
function makeUser(
	uid: number,
	uname: string,
	extra?: { badge?: FanBadge; guardLevel?: GuardLevel; isRoomAdmin?: boolean },
): LiveUser {
	return {
		uid,
		uname,
		...(extra?.badge ? { badge: extra.badge } : {}),
		...(extra?.guardLevel ? { guardLevel: extra.guardLevel } : {}),
		...(extra?.isRoomAdmin ? { isRoomAdmin: true } : {}),
	};
}

// ── 弹幕 ────────────────────────────────────────────────────────

function parseDanmu(record: Record<string, unknown> | null): LiveEvent | undefined {
	// info[0] = 元数据数组,info[1] = 正文,info[2] = [uid, uname, isAdmin, ...],
	// info[3] = 粉丝牌数组,info[7] = guard_level
	const info = record?.info;
	if (!Array.isArray(info)) return undefined;
	const content = info[1];
	const sender = info[2];
	if (typeof content !== "string" || !Array.isArray(sender)) return undefined;
	const uid = sender[0];
	const uname = sender[1];
	if (typeof uid !== "number" || typeof uname !== "string") return undefined;

	// 粉丝牌数组:[level, name, anchorUname, roomId, color, _, _, colorBorder,
	// colorStart, colorEnd, guardLevel, _, targetUid];灰牌的 colorBorder 恒为
	// 12632256(#c0c0c0),旧库以此判点亮 —— data 系帧才有显式 is_lighted。
	const badgeArr = Array.isArray(info[3]) && info[3].length > 0 ? info[3] : undefined;
	const badge: FanBadge | undefined = badgeArr
		? (() => {
				const level = num(badgeArr[0]);
				const name = str(badgeArr[1]);
				if (!level || name === undefined) return undefined;
				const anchorUid = num(badgeArr[12]);
				const anchorRoomId = num(badgeArr[3]);
				return {
					level,
					name,
					active: badgeArr[7] !== 12632256,
					...(anchorUid ? { anchorUid } : {}),
					...(anchorRoomId ? { anchorRoomId } : {}),
				};
			})()
		: undefined;

	const meta = Array.isArray(info[0]) ? info[0] : [];
	const danmuType = num(meta[1]);
	const timestamp = num(meta[4]);
	const isLottery = typeof meta[9] === "number" && meta[9] !== 0;
	const emoticonRaw = meta[13] as
		| { emoticon_unique?: unknown; url?: unknown; width?: unknown; height?: unknown }
		| undefined;
	const emoticonId = str(emoticonRaw?.emoticon_unique);
	const emoticon =
		emoticonId && typeof emoticonRaw?.url === "string"
			? {
					id: emoticonId,
					url: emoticonRaw.url,
					width: num(emoticonRaw.width) ?? 0,
					height: num(emoticonRaw.height) ?? 0,
				}
			: undefined;

	return {
		kind: "danmu",
		content,
		user: makeUser(uid, uname, {
			badge,
			guardLevel: guardLevelOf(info[7]),
			isRoomAdmin: sender[2] === 1,
		}),
		...(danmuType !== undefined ? { danmuType } : {}),
		...(timestamp !== undefined ? { timestamp } : {}),
		...(isLottery ? { isLottery } : {}),
		...(emoticon ? { emoticon } : {}),
	};
}

// ── SC / 上舰 / 礼物 ────────────────────────────────────────────

function parseSuperChat(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| {
				id?: unknown;
				uid?: unknown;
				user_info?: { uname?: unknown; guard_level?: unknown; manager?: unknown };
				medal_info?: unknown;
				message?: unknown;
				price?: unknown;
				time?: unknown;
		  }
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
	const id = num(data?.id);
	const durationSec = num(data?.time);
	return {
		kind: "superchat",
		content,
		price,
		user: makeUser(uid, uname, {
			badge: badgeFromMedal(data?.medal_info),
			guardLevel: guardLevelOf(data?.user_info?.guard_level),
			isRoomAdmin: data?.user_info?.manager === 1,
		}),
		...(id !== undefined ? { id } : {}),
		...(durationSec !== undefined ? { durationSec } : {}),
	};
}

function parseGuardBuy(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| {
				uid?: unknown;
				username?: unknown;
				guard_level?: unknown;
				gift_name?: unknown;
				gift_id?: unknown;
				price?: unknown;
				num?: unknown;
				start_time?: unknown;
				end_time?: unknown;
		  }
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
	const giftId = num(data?.gift_id);
	const price = num(data?.price);
	const count = num(data?.num);
	const startTime = num(data?.start_time);
	const endTime = num(data?.end_time);
	return {
		kind: "guard-buy",
		guardLevel: guardLevel as GuardLevel,
		giftName,
		user: { uid, uname },
		...(giftId !== undefined ? { giftId } : {}),
		...(price !== undefined ? { price } : {}),
		...(count !== undefined ? { num: count } : {}),
		...(startTime !== undefined ? { startTime } : {}),
		...(endTime !== undefined ? { endTime } : {}),
	};
}

function parseGift(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| {
				uid?: unknown;
				uname?: unknown;
				giftId?: unknown;
				giftName?: unknown;
				coin_type?: unknown;
				price?: unknown;
				num?: unknown;
				batch_combo_id?: unknown;
				super_batch_gift_num?: unknown;
				combo_total_coin?: unknown;
				medal_info?: unknown;
				guard_level?: unknown;
		  }
		| undefined;
	const uid = data?.uid;
	const uname = data?.uname;
	const giftId = data?.giftId;
	const giftName = data?.giftName;
	const coinType = data?.coin_type;
	const price = data?.price;
	const count = data?.num;
	if (
		typeof uid !== "number" ||
		typeof uname !== "string" ||
		typeof giftId !== "number" ||
		typeof giftName !== "string" ||
		(coinType !== "gold" && coinType !== "silver") ||
		typeof price !== "number" ||
		typeof count !== "number"
	) {
		return undefined;
	}
	// batch_combo_id 常驻存在(空串 = 非连击);combo_send 只在首击非空,不作依据。
	const batchId = str(data?.batch_combo_id);
	const combo = batchId
		? {
				batchId,
				comboNum: num(data?.super_batch_gift_num) ?? 0,
				totalCoin: num(data?.combo_total_coin) ?? 0,
			}
		: undefined;
	return {
		kind: "gift",
		user: makeUser(uid, uname, {
			badge: badgeFromMedal(data?.medal_info),
			guardLevel: guardLevelOf(data?.guard_level),
		}),
		giftId,
		giftName,
		coinType,
		price,
		num: count,
		...(combo ? { combo } : {}),
	};
}

/**
 * SEND_GIFT_V2(protobuf)→ 与 SEND_GIFT 同一个 `gift` kind。
 * gift_list 实测恒为单元素;多元素时取首个(协议允许,尚无真帧佐证语义)。
 */
function parseGiftV2(record: Record<string, unknown> | null): LiveEvent | undefined {
	const pb = (record?.data as { pb?: unknown } | undefined)?.pb;
	if (typeof pb !== "string") return undefined;
	const decoded = decodeSendGiftV2(pb);
	const item = decoded.gift_list?.[0];
	const uid = decoded.uid;
	const uname = decoded.uname;
	const giftId = item?.gift_id;
	const giftName = item?.gift_name;
	const coinType = item?.coin_type;
	const price = item?.price;
	const count = item?.num;
	if (
		typeof uid !== "number" ||
		typeof uname !== "string" ||
		typeof giftId !== "number" ||
		typeof giftName !== "string" ||
		(coinType !== "gold" && coinType !== "silver") ||
		typeof price !== "number" ||
		typeof count !== "number"
	) {
		return undefined;
	}
	// protobuf 缺省值语义:medal_level=0 即无牌,badgeFromMedal 自会拒收
	const medal = decoded.medal_info;
	const badge = badgeFromMedal(
		medal
			? {
					medal_level: medal.medal_level,
					medal_name: medal.medal_name,
					is_lighted: medal.is_lighted,
					target_id: medal.target_id,
					anchor_roomid: medal.anchor_roomid,
				}
			: undefined,
	);
	const batchId = item?.batch_combo_id;
	const combo = batchId
		? {
				batchId,
				comboNum: item?.super_batch_gift_num ?? 0,
				totalCoin: item?.combo_total_coin ?? 0,
			}
		: undefined;
	return {
		kind: "gift",
		user: makeUser(uid, uname, { badge, guardLevel: guardLevelOf(decoded.guard_level) }),
		giftId,
		giftName,
		coinType,
		price,
		num: count,
		...(combo ? { combo } : {}),
	};
}

// ── 高频计数 ────────────────────────────────────────────────────

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

// ── user-action(INTERACT_WORD_V2 独供)──────────────────────────

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

// ── 房间态 ──────────────────────────────────────────────────────

function parseRoomChange(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| {
				title?: unknown;
				area_name?: unknown;
				parent_area_name?: unknown;
				area_id?: unknown;
				parent_area_id?: unknown;
		  }
		| undefined;
	const title = str(data?.title);
	if (title === undefined) return undefined;
	const areaName = str(data?.area_name);
	const parentAreaName = str(data?.parent_area_name);
	const areaId = num(data?.area_id);
	const parentAreaId = num(data?.parent_area_id);
	return {
		kind: "room-change",
		title,
		...(areaName !== undefined ? { areaName } : {}),
		...(parentAreaName !== undefined ? { parentAreaName } : {}),
		...(areaId !== undefined ? { areaId } : {}),
		...(parentAreaId !== undefined ? { parentAreaId } : {}),
	};
}

function parseRankCount(record: Record<string, unknown> | null): LiveEvent | undefined {
	const count = num((record?.data as { count?: unknown } | undefined)?.count);
	if (count === undefined) return undefined;
	return { kind: "rank-count", count };
}

// ── 抽奖组 ──────────────────────────────────────────────────────

function parseRedPocketStart(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| {
				lot_id?: unknown;
				sender_uid?: unknown;
				sender_name?: unknown;
				danmu?: unknown;
				last_time?: unknown;
				total_price?: unknown;
				awards?: unknown;
		  }
		| undefined;
	const id = num(data?.lot_id);
	const uid = num(data?.sender_uid);
	const uname = str(data?.sender_name);
	const danmu = str(data?.danmu);
	const durationSec = num(data?.last_time);
	const totalPrice = num(data?.total_price);
	if (
		id === undefined ||
		uid === undefined ||
		uname === undefined ||
		danmu === undefined ||
		durationSec === undefined ||
		totalPrice === undefined
	) {
		return undefined;
	}
	const awardsRaw = Array.isArray(data?.awards) ? data.awards : [];
	const awards = awardsRaw.flatMap((a: unknown) => {
		const award = a as { gift_id?: unknown; gift_name?: unknown; num?: unknown };
		const giftId = num(award?.gift_id);
		const giftName = str(award?.gift_name);
		const n = num(award?.num);
		return giftId !== undefined && giftName !== undefined && n !== undefined
			? [{ giftId, giftName, num: n }]
			: [];
	});
	return {
		kind: "red-pocket-start",
		id,
		user: { uid, uname },
		danmu,
		durationSec,
		totalPrice,
		awards,
	};
}

function parseRedPocketEnd(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| { lot_id?: unknown; total_num?: unknown; winner_info?: unknown; awards?: unknown }
		| undefined;
	const id = num(data?.lot_id);
	const totalNum = num(data?.total_num);
	if (id === undefined || totalNum === undefined) return undefined;
	const awardNames = (data?.awards ?? {}) as Record<string, { award_name?: unknown }>;
	const winnerRaw = Array.isArray(data?.winner_info) ? data.winner_info : [];
	// winner_info 的元素是数组:[uid, uname, _, award_id]
	const winners = winnerRaw.flatMap((w: unknown) => {
		if (!Array.isArray(w)) return [];
		const uid = num(w[0]);
		const uname = str(w[1]);
		if (uid === undefined || uname === undefined) return [];
		const awardName = str(awardNames[String(w[3])]?.award_name);
		return [{ uid, uname, ...(awardName !== undefined ? { awardName } : {}) }];
	});
	return { kind: "red-pocket-end", id, totalNum, winners };
}

function parseAnchorLotteryStart(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| {
				id?: unknown;
				max_time?: unknown;
				award_name?: unknown;
				award_num?: unknown;
				award_type?: unknown;
				danmu?: unknown;
				require_text?: unknown;
		  }
		| undefined;
	const id = num(data?.id);
	const durationSec = num(data?.max_time);
	const awardName = str(data?.award_name);
	const awardNum = num(data?.award_num);
	if (
		id === undefined ||
		durationSec === undefined ||
		awardName === undefined ||
		awardNum === undefined
	) {
		return undefined;
	}
	const requireDanmu = str(data?.danmu);
	const requireText = str(data?.require_text);
	return {
		kind: "anchor-lottery-start",
		id,
		durationSec,
		awardName,
		awardNum,
		virtualAward: data?.award_type === 1,
		...(requireDanmu ? { requireDanmu } : {}),
		...(requireText ? { requireText } : {}),
	};
}

function parseAnchorLotteryEnd(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| { id?: unknown; award_name?: unknown; award_users?: unknown }
		| undefined;
	const id = num(data?.id);
	const awardName = str(data?.award_name);
	if (id === undefined || awardName === undefined) return undefined;
	const usersRaw = Array.isArray(data?.award_users) ? data.award_users : [];
	const winners = usersRaw.flatMap((u: unknown) => {
		const user = u as { uid?: unknown; uname?: unknown; num?: unknown };
		const uid = num(user?.uid);
		const uname = str(user?.uname);
		return uid !== undefined && uname !== undefined
			? [{ uid, uname, num: num(user?.num) ?? 1 }]
			: [];
	});
	return { kind: "anchor-lottery-end", id, awardName, winners };
}

// ── 管理组 ──────────────────────────────────────────────────────

function parseRoomWarn(
	record: Record<string, unknown> | null,
	warnType: "warning" | "cut",
): LiveEvent | undefined {
	// WARNING / CUT_OFF 的 msg 在顶层,不在 data 里
	const msg = str(record?.msg);
	if (msg === undefined) return undefined;
	return { kind: "room-warn", warnType, msg };
}

function parseRoomSilent(
	record: Record<string, unknown> | null,
	isOff: boolean,
): LiveEvent | undefined {
	const data = record?.data as { type?: unknown; level?: unknown; second?: unknown } | undefined;
	if (!data) return undefined;
	const rawType = str(data.type);
	const silentType = isOff
		? "off"
		: rawType === "level" || rawType === "medal" || rawType === "member"
			? rawType
			: undefined;
	if (silentType === undefined) return undefined;
	return {
		kind: "room-silent",
		silentType,
		level: num(data.level) ?? 0,
		second: num(data.second) ?? 0,
	};
}

function parseRoomAdmin(
	record: Record<string, unknown> | null,
	adminType: "set" | "revoke",
): LiveEvent | undefined {
	// uid 在顶层(room_admin_entrance / ROOM_ADMIN_REVOKE 同构)
	const uid = num(record?.uid);
	if (uid === undefined) return undefined;
	return { kind: "room-admin", adminType, uid };
}

// ── 进场特效 / 点赞点击(独立 kind)───────────────────────────────

function parseEntryEffect(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as
		| { uid?: unknown; copy_writing?: unknown; privilege_type?: unknown }
		| undefined;
	const uid = num(data?.uid);
	const copyWriting = str(data?.copy_writing);
	if (uid === undefined || copyWriting === undefined) return undefined;
	// 昵称嵌在文案里:「欢迎<%昵称%>进入直播间」(超长会被 B 站截断加省略号)
	const uname = /<%(.*?)%>/.exec(copyWriting)?.[1];
	if (uname === undefined) return undefined;
	return {
		kind: "entry-effect",
		user: makeUser(uid, uname, { guardLevel: guardLevelOf(data?.privilege_type) }),
	};
}

function parseLikeClick(record: Record<string, unknown> | null): LiveEvent | undefined {
	const data = record?.data as { uid?: unknown; uname?: unknown; fans_medal?: unknown } | undefined;
	const uid = num(data?.uid);
	const uname = str(data?.uname);
	if (uid === undefined || uname === undefined) return undefined;
	return {
		kind: "like-click",
		user: makeUser(uid, uname, { badge: badgeFromMedal(data?.fans_medal) }),
	};
}

export { GuardLevel };
