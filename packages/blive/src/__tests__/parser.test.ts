/**
 * MESSAGE 命令 → LiveEvent 联合的映射。
 *
 * 真值来源分两档:
 * - danmu / watched / liked / interactV2:真实录制帧(fixtures/payloads.json),
 *   期望字面量抄自录制时的独立盘点(interactV2 的 pb 用 blive 0.5.4 的 schema
 *   在移植前解开取得,与本实现无关)。
 * - superchat / guard-buy / live-start / live-end:录制窗口没等到的稀有事件,
 *   payload 按 blive 0.5.4 解析器消费的字段 + bilibili-api-collect 文档合成。
 */

import { describe, expect, it } from "vite-plus/test";
import { GuardLevel, parseCommand } from "../parser.js";
import payloads from "./fixtures/payloads.json" with { type: "json" };

describe("parseCommand(真实录制 payload)", () => {
	it("DANMU_MSG → danmu:正文 + 发送者", () => {
		// 字段深化(danmuType/timestamp 等)在 parser-extended.test.ts 里钉;
		// 这里只钉真实录制帧的基础字段映射。
		expect(parseCommand(payloads.danmu)).toMatchObject({
			kind: "danmu",
			content: "太有互动感了",
			user: { uid: 6170115, uname: "琴七" },
		});
	});

	it("带后缀的 DANMU_MSG 变体同样按 danmu 解", () => {
		const variant = { ...payloads.danmu, cmd: "DANMU_MSG:4:0:2:2:2:0" };

		expect(parseCommand(variant)).toMatchObject({ kind: "danmu", content: "太有互动感了" });
	});

	it("WATCHED_CHANGE → watched", () => {
		expect(parseCommand(payloads.watched)).toEqual({
			kind: "watched",
			num: 87334,
			textSmall: "8.7万",
		});
	});

	it("LIKE_INFO_V3_UPDATE → liked(字段名是 click_count)", () => {
		expect(parseCommand(payloads.liked)).toEqual({ kind: "liked", count: 147837 });
	});

	it("INTERACT_WORD_V2 → user-action:protobuf 解出进场者", () => {
		expect(parseCommand(payloads.interactV2)).toEqual({
			kind: "user-action",
			action: "enter",
			user: { uid: 33088372, uname: "_无言I" },
		});
	});
});

describe("parseCommand(合成 payload)", () => {
	it("SUPER_CHAT_MESSAGE → superchat:message 字段是正文", () => {
		const payload = {
			cmd: "SUPER_CHAT_MESSAGE",
			data: {
				id: 1,
				uid: 8888,
				user_info: { uname: "金主" },
				message: "加油",
				price: 30,
				time: 60,
			},
		};

		expect(parseCommand(payload)).toMatchObject({
			kind: "superchat",
			content: "加油",
			price: 30,
			user: { uid: 8888, uname: "金主" },
		});
	});

	it("GUARD_BUY → guard-buy:username 字段是昵称", () => {
		const payload = {
			cmd: "GUARD_BUY",
			data: {
				uid: 7777,
				username: "舰长大人",
				guard_level: 3,
				num: 1,
				price: 198000,
				gift_id: 10003,
				gift_name: "舰长",
			},
		};

		expect(parseCommand(payload)).toMatchObject({
			kind: "guard-buy",
			guardLevel: GuardLevel.Captain,
			giftName: "舰长",
			user: { uid: 7777, uname: "舰长大人" },
		});
	});

	it("LIVE → live-start,PREPARING → live-end", () => {
		expect(parseCommand({ cmd: "LIVE", roomid: 5050 })).toEqual({ kind: "live-start" });
		expect(parseCommand({ cmd: "PREPARING", roomid: "5050" })).toEqual({ kind: "live-end" });
	});
});

describe("parseCommand(降级路径)", () => {
	it("不认识的命令 → raw 透传", () => {
		const payload = { cmd: "STOP_LIVE_ROOM_LIST", data: { room_id_list: [1] } };

		expect(parseCommand(payload)).toEqual({
			kind: "raw",
			cmd: "STOP_LIVE_ROOM_LIST",
			payload,
		});
	});

	it("ENTRY_EFFECT / v1 INTERACT_WORD 不产出 user-action —— 进房事件由 V2 一帧独供", () => {
		// 舰长进一次房 B 站会同时发 INTERACT_WORD_V2 与 ENTRY_EFFECT;blive 库把
		// 两帧都解析成 action:"enter",特别关注进房被推两次。这里钉死:只有 V2
		// 产出 user-action,别的进房形态一律 raw。别把 ENTRY_EFFECT 加回解析器。
		const entry = { cmd: "ENTRY_EFFECT", data: { uid: 42, copy_writing: "欢迎舰长" } };
		const v1 = { cmd: "INTERACT_WORD", data: { uid: 42, uname: "舰长", msg_type: 1 } };

		expect(parseCommand(entry).kind).toBe("raw");
		expect(parseCommand(v1).kind).toBe("raw");
	});

	it("认识的命令但形状缺损 → raw,不抛", () => {
		expect(parseCommand({ cmd: "DANMU_MSG" })).toMatchObject({ kind: "raw", cmd: "DANMU_MSG" });
		expect(
			parseCommand({ cmd: "INTERACT_WORD_V2", data: { pb: "!!!not-base64-pb" } }),
		).toMatchObject({ kind: "raw", cmd: "INTERACT_WORD_V2" });
	});

	it("没有 cmd 字段 → raw,cmd 标 unknown", () => {
		expect(parseCommand({ foo: 1 })).toEqual({ kind: "raw", cmd: "unknown", payload: { foo: 1 } });
	});
});
