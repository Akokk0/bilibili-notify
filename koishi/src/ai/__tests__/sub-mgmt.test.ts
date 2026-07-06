import { randomUUID } from "node:crypto";
import type { PushTarget, Subscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { buildSubManagement, type SubMgmtRegistryLike, type SubMgmtStoreLike } from "../sub-mgmt";

function makeFakeStore(): SubMgmtStoreLike & { upserted: Subscription[] } {
	const upserted: Subscription[] = [];
	const map = new Map<string, Subscription>();
	return {
		upserted,
		upsert(sub) {
			upserted.push(sub as Subscription);
			map.set((sub as Subscription).uid, sub as Subscription);
		},
		findByUid(uid) {
			return map.get(uid);
		},
		removeById(id) {
			for (const [uid, sub] of map.entries()) {
				if (sub.id === id) map.delete(uid);
			}
		},
	};
}

function makeFakeRegistry(targets: PushTarget[]): SubMgmtRegistryLike {
	return { all: () => [...targets] };
}

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("buildSubManagement().addSub", () => {
	it("with empty registry: routing stays empty and the message warns operator", async () => {
		const store = makeFakeStore();
		const registry = makeFakeRegistry([]);
		const mgmt = buildSubManagement({ store, registry });

		const msg = await mgmt.addSub({
			uid: "12345",
			name: "测试 UP",
			platform: "onebot",
			target: "ignored",
		});

		expect(msg).toContain("无 PushTarget");
		expect(store.upserted).toHaveLength(1);
		const sub = store.upserted[0];
		// Every routing slot must be empty when no target exists.
		for (const ids of Object.values(sub.routing)) {
			expect(ids).toEqual([]);
		}
	});

	it("with one registered target: enabled features get that target's id, never a fresh UUID", async () => {
		const store = makeFakeStore();
		const adapterId = randomUUID();
		const t: PushTarget = {
			id: randomUUID(),
			name: "ob:111",
			adapterId,
			platform: "koishi-bot",
			scope: "group",
			session: { channelId: "111" },
			enabled: true,
		};
		const registry = makeFakeRegistry([t]);
		const mgmt = buildSubManagement({ store, registry });

		const msg = await mgmt.addSub({
			uid: "67890",
			name: "另一个 UP",
			platform: "onebot",
			target: "ignored",
			dynamic: true,
			live: true,
			dynamicAtAll: false,
			liveAtAll: true,
			wordcloud: true,
			liveSummary: false,
		});

		expect(msg).not.toContain("无 PushTarget");
		expect(msg).toContain("已成功订阅");
		const sub = store.upserted.at(-1) as Subscription;
		expect(sub.routing.dynamic).toEqual([t.id]);
		expect(sub.routing.live).toEqual([t.id]);
		expect(sub.routing.wordcloud).toEqual([t.id]);
		expect(sub.routing.liveSummary).toEqual([]);
		// AI tool 写 atAllDefaults(订阅级默认),不动 per-target Map。
		expect(sub.atAllDefaults).toEqual({ dynamic: false, live: true });
		expect(sub.atAll.dynamic).toEqual({});
		expect(sub.atAll.live).toEqual({});
	});

	it("prefers the master (private-scope) target over a group target", async () => {
		const store = makeFakeStore();
		const adapterId = randomUUID();
		const group: PushTarget = {
			id: randomUUID(),
			name: "ob:111",
			adapterId,
			platform: "koishi-bot",
			scope: "group",
			session: { channelId: "111" },
			enabled: true,
		};
		const master: PushTarget = {
			id: randomUUID(),
			name: "master:onebot:42",
			adapterId,
			platform: "koishi-bot",
			scope: "private",
			session: { userId: "42" },
			enabled: true,
		};
		const registry = makeFakeRegistry([group, master]);
		const mgmt = buildSubManagement({ store, registry });

		await mgmt.addSub({
			uid: "11111",
			name: "X",
			platform: "onebot",
			target: "ignored",
		});
		const sub = store.upserted.at(-1) as Subscription;
		expect(sub.routing.dynamic).toEqual([master.id]);
		expect(sub.routing.live).toEqual([master.id]);
	});

	// silence unused import lint
	it("VALID_UUID stays referenced", () => {
		expect(VALID_UUID.length).toBeGreaterThan(0);
	});
});
