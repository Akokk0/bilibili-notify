/**
 * 扩展事件面(2026-08-27 定案)的解析规格:礼物 / 房间态 / 抽奖组 / 管理组 /
 * entry-effect / like-click,以及既有 danmu / superchat / guard-buy 的字段深化。
 *
 * fixture 出处:`fixtures/payloads-ref.json`,取自 blive-message-listener 0.5.4
 * 的 mock/ 目录(MIT,© ddiu8081)—— 真实录制后匿名化的 payload,字段名与
 * 结构均为线上实测形状,比手工合成可信。自录真帧(capture)覆盖到的高频类
 * 以自录为准补充。
 *
 * 铁律回归:ENTRY_EFFECT / LIKE_INFO_V3_CLICK 是**独立 kind**,绝不产出
 * user-action —— 那是舰长进房重复推 bug 的防线(user-action 由 INTERACT_WORD_V2
 * 一帧独供)。
 */

import { describe, expect, it } from "vite-plus/test";
import { GuardLevel } from "../events.js";
import { parseCommand } from "../parser.js";
import payloads from "./fixtures/payloads.json" with { type: "json" };
import ref from "./fixtures/payloads-ref.json" with { type: "json" };

describe("parseCommand: gift(SEND_GIFT)", () => {
	it("银瓜子免费礼物:无连击无牌子", () => {
		expect(parseCommand(ref.giftNoBadge)).toEqual({
			kind: "gift",
			user: { uid: 77777777771, uname: "__MOCK_UNAME__" },
			giftId: 1,
			giftName: "辣条",
			coinType: "silver",
			price: 100,
			num: 1,
		});
	});

	it("金瓜子付费礼物:带连击与粉丝牌", () => {
		const ev = parseCommand(ref.giftGoldBadge);
		expect(ev).toMatchObject({
			kind: "gift",
			giftId: 31251,
			giftName: "干杯",
			coinType: "gold",
			price: 6600,
			num: 1,
			combo: {
				batchId: "batch:gift:combo_id:77777777771:77777777775:31251:1664028962.9340",
				comboNum: 1,
				totalCoin: 6600,
			},
		});
		if (ev.kind !== "gift") throw new Error("unreachable");
		expect(ev.user.badge).toEqual({
			level: 3,
			name: "__MOCK_BADGE_NAME__",
			active: false,
			anchorUid: 77777777772,
		});
	});
});

describe("parseCommand: gift(SEND_GIFT_V2,自录真帧)", () => {
	// 2026-08 实测:大房间的礼物帧已全部换成 SEND_GIFT_V2(protobuf in data.pb),
	// 同场 30 分钟录制里旧 SEND_GIFT 一条都没有 —— 旧库在这类房间会漏掉全部礼物。
	// 期望值由 protobuf wire 走查器独立解出(不经本包 schema),字段号对照
	// sjh8130/bili_danmaku 的 SEND_GIFT_V2.proto。

	it("V2 礼物帧 → gift(与 SEND_GIFT 同一 kind)", () => {
		expect(parseCommand(payloads.giftV2)).toEqual({
			kind: "gift",
			user: { uid: 1567394869, uname: "哎小呜Awu" },
			giftId: 33988,
			giftName: "人气票",
			coinType: "gold",
			price: 100,
			num: 1,
			combo: {
				batchId: "batch:gift:combo_id:1567394869:392836434:33988:1787832985.1554",
				comboNum: 1,
				totalCoin: 100,
			},
		});
	});

	it("V2 礼物帧带粉丝牌", () => {
		const ev = parseCommand(payloads.giftV2Medal);
		if (ev.kind !== "gift") throw new Error(`expected gift, got ${ev.kind}`);
		expect(ev.giftName).toBe("粉丝团灯牌");
		expect(ev.user).toEqual({
			uid: 2040421492,
			uname: "时代浩铭团",
			badge: { level: 2, name: "KPL", active: true, anchorUid: 392836434 },
		});
	});
});

describe("parseCommand: 房间态", () => {
	it("ROOM_CHANGE → room-change(标题与分区)", () => {
		expect(parseCommand(ref.roomChange)).toEqual({
			kind: "room-change",
			title: "直播间标题",
			areaName: " 科技",
			parentAreaName: "知识",
			areaId: 375,
			parentAreaId: 11,
		});
	});

	it("ONLINE_RANK_COUNT → rank-count(高能用户数)", () => {
		expect(parseCommand(ref.rankCount)).toEqual({ kind: "rank-count", count: 1822 });
	});
});

describe("parseCommand: 抽奖组", () => {
	it("红包开始:口令/时长/总价/奖品清单", () => {
		expect(parseCommand(ref.redPocketStart)).toEqual({
			kind: "red-pocket-start",
			id: 8646402,
			user: { uid: 77777777771, uname: "__MOCK_UNAME__" },
			danmu: "老板大气！点点红包抽礼物",
			durationSec: 180,
			totalPrice: 1600,
			awards: [{ giftId: 31212, giftName: "打call", num: 2 }, expect.anything(), expect.anything()],
		});
	});

	it("红包结果:中奖名单带奖品名", () => {
		const ev = parseCommand(ref.redPocketEnd);
		expect(ev).toMatchObject({ kind: "red-pocket-end", id: 8646402, totalNum: 8 });
		if (ev.kind !== "red-pocket-end") throw new Error("unreachable");
		expect(ev.winners[0]).toEqual({
			uid: 77777777771,
			uname: "__MOCK_UNAME__",
			awardName: "打call",
		});
	});

	it("天选开始:奖品/时长/口令/参与要求", () => {
		expect(parseCommand(ref.anchorLotStart)).toEqual({
			kind: "anchor-lottery-start",
			id: 3783024,
			durationSec: 900,
			awardName: "情书",
			awardNum: 1,
			virtualAward: true,
			requireDanmu: "__MOCK_MESSAGE_CONTENT__",
			requireText: "关注主播",
		});
	});

	it("天选开始/开奖(自录真帧):实物奖 + 无口令要求", () => {
		// 赛事房真帧:award_type=0(实物)、danmu 是宣传语而非参与口令 ——
		// 但 require_text 才是参与要求;两帧 id 相同(同一场天选)。
		expect(parseCommand(payloads.anchorLotStartReal)).toEqual({
			kind: "anchor-lottery-start",
			id: 15933107,
			durationSec: 60,
			awardName: "50Q币（中奖登记Q号）",
			awardNum: 1,
			virtualAward: false,
			requireDanmu: "恭喜上海EDG.M！",
			requireText: "关注主播",
		});
		expect(parseCommand(payloads.anchorLotAwardReal)).toMatchObject({
			kind: "anchor-lottery-end",
			id: 15933107,
			awardName: "50Q币（中奖登记Q号）",
		});
	});

	it("天选开奖:中奖名单", () => {
		expect(parseCommand(ref.anchorLotAward)).toEqual({
			kind: "anchor-lottery-end",
			id: 3782966,
			awardName: "情书",
			winners: [{ uid: 77777777771, uname: "__MOCK_UNAME__", num: 1 }],
		});
	});
});

describe("parseCommand: 管理组", () => {
	it("WARNING → room-warn(warning)", () => {
		expect(parseCommand(ref.warning)).toEqual({
			kind: "room-warn",
			warnType: "warning",
			msg: "图片内容不适宜，请立即调整",
		});
	});

	it("CUT_OFF → room-warn(cut)", () => {
		expect(parseCommand(ref.cutOff)).toEqual({
			kind: "room-warn",
			warnType: "cut",
			msg: "违反直播言论规范，请立即调整",
		});
	});

	it("ROOM_SILENT_ON → room-silent(按等级)", () => {
		expect(parseCommand(ref.silentOnLevel)).toEqual({
			kind: "room-silent",
			silentType: "level",
			level: 1,
			second: 1673943135,
		});
	});

	it("ROOM_SILENT_OFF → room-silent(off)", () => {
		expect(parseCommand(ref.silentOff)).toEqual({
			kind: "room-silent",
			silentType: "off",
			level: 0,
			second: 0,
		});
	});

	it("房管任免:set 与 revoke", () => {
		expect(parseCommand(ref.adminSet)).toEqual({
			kind: "room-admin",
			adminType: "set",
			uid: 77777777771,
		});
		expect(parseCommand(ref.adminRevoke)).toEqual({
			kind: "room-admin",
			adminType: "revoke",
			uid: 77777777771,
		});
	});
});

describe("parseCommand: entry-effect / like-click(独立 kind,不碰 user-action)", () => {
	it("ENTRY_EFFECT → entry-effect,昵称从 copy_writing 提取", () => {
		expect(parseCommand(ref.entryEffectNone)).toEqual({
			kind: "entry-effect",
			user: { uid: 77777777771, uname: "__MOCK_UNAME__" },
		});
	});

	it("舰长进场特效带 guardLevel —— 但 kind 仍是 entry-effect,绝不是 user-action", () => {
		const ev = parseCommand(ref.entryEffectJianzhang);
		expect(ev).toEqual({
			kind: "entry-effect",
			user: { uid: 77777777771, uname: "__MOCK_UNAME__", guardLevel: GuardLevel.Captain },
		});
	});

	it("LIKE_INFO_V3_CLICK → like-click,带粉丝牌", () => {
		expect(parseCommand(ref.likeClick)).toEqual({
			kind: "like-click",
			user: {
				uid: 77777777771,
				uname: "__MOCK_UNAME__",
				badge: { level: 5, name: "__MOCK_BADGE_NAME__", active: true, anchorUid: 77777777772 },
			},
		});
	});
});

describe("字段深化:danmu", () => {
	it("舰长弹幕:粉丝牌/舰长等级/类型/时间戳/表情弹幕", () => {
		expect(parseCommand(ref.danmuGuardBadge)).toEqual({
			kind: "danmu",
			content: "赞",
			user: {
				uid: 77777777771,
				uname: "__MOCK_UNAME__",
				guardLevel: GuardLevel.Captain,
				badge: {
					level: 21,
					name: "__MOCK_BADGE_NAME__",
					active: true,
					anchorUid: 77777777772,
					anchorRoomId: 77777777773,
				},
			},
			danmuType: 1,
			timestamp: 1662305224469,
			emoticon: {
				id: "official_147",
				url: "http://i0.hdslb.com/bfs/live/bbd9045570d0c022a984c637e406cb0e1f208aa9.png",
				width: 150,
				height: 60,
			},
		});
	});

	it("天选口令弹幕:isLottery", () => {
		const ev = parseCommand(ref.danmuLottery);
		expect(ev).toMatchObject({ kind: "danmu", isLottery: true });
	});

	it("房管的底部弹幕:isRoomAdmin + danmuType=4", () => {
		const ev = parseCommand(ref.danmuRoomAdmin);
		if (ev.kind !== "danmu") throw new Error(`expected danmu, got ${ev.kind}`);
		expect(ev.user.isRoomAdmin).toBe(true);
		expect(ev.danmuType).toBe(4);
	});

	it("无牌子表情弹幕:badge 缺省,emoticon 在", () => {
		const ev = parseCommand(ref.danmuEmoticon);
		if (ev.kind !== "danmu") throw new Error(`expected danmu, got ${ev.kind}`);
		expect(ev.user.badge).toBeUndefined();
		expect(ev.emoticon?.id).toBe("official_147");
	});
});

describe("字段深化:superchat / guard-buy", () => {
	it("SC:id/持续时长/粉丝牌", () => {
		expect(parseCommand(ref.superchat)).toEqual({
			kind: "superchat",
			content: "__MOCK_MESSAGE_CONTENT__",
			price: 30,
			id: 4898587,
			durationSec: 60,
			user: {
				uid: 77777777771,
				uname: "__MOCK_UNAME__",
				badge: {
					level: 16,
					name: "__MOCK_BADGE_NAME__",
					active: true,
					anchorUid: 77777777772,
					anchorRoomId: 77777777773,
				},
			},
		});
	});

	it("上舰:礼物 id/价格/数量/起止时间", () => {
		expect(parseCommand(ref.guardBuy)).toEqual({
			kind: "guard-buy",
			guardLevel: GuardLevel.Captain,
			giftName: "舰长",
			giftId: 10003,
			price: 198000,
			num: 1,
			startTime: 1661604507,
			endTime: 1661604507,
			user: { uid: 77777777771, uname: "__MOCK_UNAME__" },
		});
	});
});

describe("parseCommand: guard-toast(USER_TOAST_MSG / _V2,独立 kind,不碰 guard-buy)", () => {
	// 铁律(与 entry-effect 同构):新购时 B 站可能同发 GUARD_BUY 与
	// USER_TOAST_MSG 两帧 —— 并进 guard-buy 就是舰长重复推的翻版。
	// 续费(op_type 2/3)据实测只走 toast,这正是补这个 kind 的动机。

	it("v1 新购:全字段", () => {
		expect(parseCommand(ref.userToastNew)).toEqual({
			kind: "guard-toast",
			opType: 1,
			guardLevel: GuardLevel.Captain,
			roleName: "舰长",
			num: 1,
			unit: "月",
			price: 198000,
			startTime: 1674568760,
			endTime: 1674568760,
			toastMsg: "<%__MOCK_UNAME__%> 开通了舰长，今天是TA陪伴主播的第1天",
			user: { uid: 77777777771, uname: "__MOCK_UNAME__" },
		});
	});

	it("v1 自动续费:opType=3,续费价 —— kind 仍是 guard-toast 绝不是 guard-buy", () => {
		const ev = parseCommand(ref.userToastRenew);
		expect(ev).toMatchObject({
			kind: "guard-toast",
			opType: 3,
			guardLevel: GuardLevel.Captain,
			price: 138000,
		});
	});

	it("V2 嵌套结构:sender_uinfo / guard_info / pay_info 抽取", () => {
		expect(parseCommand(ref.userToastV2)).toEqual({
			kind: "guard-toast",
			opType: 1,
			guardLevel: GuardLevel.Captain,
			roleName: "舰长",
			num: 1,
			unit: "月",
			price: 138000,
			startTime: 1722503296,
			endTime: 1722503296,
			toastMsg:
				"<%__MOCK_UNAME__%> 在主播__MOCK_ANCHOR_UNAME__的直播间开通了舰长，今天是TA陪伴主播的第1天",
			user: { uid: 77777777771, uname: "__MOCK_UNAME__" },
		});
	});

	it("V2 形状缺损(缺 guard_info)→ degraded raw", () => {
		const payload = { cmd: "USER_TOAST_MSG_V2", data: { sender_uinfo: { uid: 1 } } };
		expect(parseCommand(payload)).toMatchObject({ kind: "raw", degraded: true });
	});

	describe("2026-08-28 蹲守真帧(房 6154037):续费三帧同秒齐发", () => {
		// 60 分钟蹲到 5 单上舰,全部 op_type=2(续费),**每单都同发**
		// GUARD_BUY + USER_TOAST_MSG + USER_TOAST_MSG_V2 三帧 ——「续费只走
		// toast、GUARD_BUY 不发」的参考资料推断被现网证伪。三帧必须各归各的
		// kind,去重责任在业务侧;并流 = 一次上舰三连推。
		// 另一发现:GUARD_BUY 报原价,toast 报实付折扣价(提督 1998000 vs 1598000)。

		it("GUARD_BUY 帧 → guard-buy(原价)", () => {
			expect(parseCommand(payloads.guardBuyRenewReal)).toEqual({
				kind: "guard-buy",
				guardLevel: GuardLevel.Admiral,
				giftName: "提督",
				giftId: 10002,
				price: 1998000,
				num: 1,
				startTime: 1787843141,
				endTime: 1787843141,
				user: { uid: 237158, uname: "想不起名字的哈曼" },
			});
		});

		it("同一单的 v1 / V2 toast → guard-toast,op_type=2,实付价", () => {
			const expected = {
				kind: "guard-toast",
				opType: 2,
				guardLevel: GuardLevel.Admiral,
				roleName: "提督",
				num: 1,
				unit: "月",
				price: 1598000,
				user: { uid: 237158, uname: "想不起名字的哈曼" },
			};
			expect(parseCommand(payloads.userToastRenewReal)).toMatchObject(expected);
			expect(parseCommand(payloads.userToastV2RenewReal)).toMatchObject(expected);
		});
	});
});
