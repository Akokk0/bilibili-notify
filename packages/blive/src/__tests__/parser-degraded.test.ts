/**
 * 协议漂移观测:已知命令解析失败时降级 raw 必须带 `degraded: true` 标记。
 *
 * 背景:SEND_GIFT → SEND_GIFT_V2 大迁移时旧库在大房间漏掉 100% 礼物且无任何
 * 报警 —— 静默降级对上游是不可见的。degraded 标志让上游(RoomSession)能区分
 * 「本来就不解析的命令」(plain raw)和「B 站可能改了字段形状」(degraded raw),
 * 后者才是漂移报警信号。
 */

import { describe, expect, it } from "vite-plus/test";
import { PARSED_COMMANDS, parseCommand } from "../parser.js";

describe("parseCommand: 漂移观测(degraded 标志)", () => {
	it("已知命令形状缺损 → raw 带 degraded: true", () => {
		const payload = { cmd: "SUPER_CHAT_MESSAGE" }; // 缺 data
		expect(parseCommand(payload)).toEqual({
			kind: "raw",
			cmd: "SUPER_CHAT_MESSAGE",
			payload,
			degraded: true,
		});
	});

	it("SEND_GIFT_V2 protobuf 解不开(抛错路径)→ degraded raw", () => {
		const payload = {
			cmd: "SEND_GIFT_V2",
			data: { pb: Buffer.from("这不是 protobuf").toString("base64") },
		};
		const ev = parseCommand(payload);
		expect(ev).toMatchObject({ kind: "raw", cmd: "SEND_GIFT_V2", degraded: true });
	});

	it("DANMU_MSG 后缀变体形状缺损 → degraded raw", () => {
		const payload = { cmd: "DANMU_MSG:4:0:2:2:2:0", info: null };
		expect(parseCommand(payload)).toMatchObject({ kind: "raw", degraded: true });
	});

	it("不认识的命令 → plain raw,不带 degraded", () => {
		const payload = { cmd: "STOP_LIVE_ROOM_LIST", data: {} };
		const ev = parseCommand(payload);
		expect(ev.kind).toBe("raw");
		if (ev.kind !== "raw") throw new Error("unreachable");
		expect(ev.degraded).toBeUndefined();
	});

	it("PARSED_COMMANDS 全表:空 data 喂进去,要么解析成功要么 degraded,绝不 plain raw", () => {
		// 钉住「已知命令集合」与 switch 分支同步:集合里的命令一旦从 switch 掉出,
		// 空 data 会落进 default 的 plain raw,这条测试就红。
		for (const cmd of PARSED_COMMANDS) {
			const ev = parseCommand({ cmd, data: {} });
			const ok = ev.kind !== "raw" || ev.degraded === true;
			expect(ok, `${cmd} 掉出了已知命令处理面`).toBe(true);
		}
	});
});
