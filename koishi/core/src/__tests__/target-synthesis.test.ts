/**
 * 回归守护 — P0-2 fix(koishi/targets): use deterministicUuid for synthesized adapter+target ids
 *
 * target-synthesis 三个函数的 id 由 `deterministicUuid(<种子串>)` 派生,**种子串**
 * 本身是契约的一部分:任何人改写种子模板(例如把 "adapter:koishi-bot:<platform>"
 * 改成 "koishi:adapter:<platform>")都会让所有线上 history 引用的 target id 变成
 * 孤儿。本测试锁住三个种子串与 id 的等式关系,出问题立即告警。
 */

import { deterministicUuid } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	synthesizeKoishiBotAdapter,
	synthesizeMasterTarget,
	synthesizeTargetsForFlatSub,
} from "../target-synthesis";

describe("target-synthesis seed-string contracts", () => {
	it("adapter:不带 selfId,种子串 = adapter:koishi-bot:<platform>", () => {
		const a = synthesizeKoishiBotAdapter("qq");
		expect(a.id).toBe(deterministicUuid("adapter:koishi-bot:qq"));
	});

	it("adapter:带 selfId,种子串 = adapter:koishi-bot:<platform>:<selfId>", () => {
		const a = synthesizeKoishiBotAdapter("qq", "12345");
		expect(a.id).toBe(deterministicUuid("adapter:koishi-bot:qq:12345"));

		// selfId 区分性:不同 selfId → 不同 id
		const b = synthesizeKoishiBotAdapter("qq", "67890");
		expect(a.id).not.toBe(b.id);
	});

	it("target(flat-sub):种子串 = target:<adapterId>:<channelId>", () => {
		const adapter = synthesizeKoishiBotAdapter("qq");
		const t = synthesizeTargetsForFlatSub(adapter, "group-1");
		expect(t.id).toBe(deterministicUuid(`target:${adapter.id}:group-1`));
		expect(t.adapterId).toBe(adapter.id);
	});

	it("target(master):不带 guildId,种子串 = target:master:<adapterId>:<userId>", () => {
		const adapter = synthesizeKoishiBotAdapter("qq");
		const t = synthesizeMasterTarget(adapter, "u100");
		expect(t.id).toBe(deterministicUuid(`target:master:${adapter.id}:u100`));
	});

	it("target(master):带 guildId,种子串 = target:master:<adapterId>:<userId>:<guildId>", () => {
		const adapter = synthesizeKoishiBotAdapter("discord");
		const t = synthesizeMasterTarget(adapter, "u100", "g200");
		expect(t.id).toBe(deterministicUuid(`target:master:${adapter.id}:u100:g200`));

		// guildId 区分性
		const t2 = synthesizeMasterTarget(adapter, "u100", "g300");
		expect(t.id).not.toBe(t2.id);
	});
});
