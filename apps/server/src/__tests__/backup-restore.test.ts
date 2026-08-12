import {
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { type CurrentState, planImport } from "../backup/restore.js";

/**
 * planImport 把「当前状态 + 导入段 + 覆盖/合并」算成一组具体写操作(upsert / delete /
 * setGlobals),纯函数、无 IO。覆盖=整盘替换(删多余),合并=并集(不删),合并不动 globals。
 */
function sub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, uid });
}

function currentWith(subs: Subscription[]): CurrentState {
	return {
		globals: makeDefaultGlobalConfig(),
		subscriptions: subs,
		adapters: [],
		targets: [],
	};
}

describe("planImport", () => {
	it("overwrite replaces the subscription set (deletes entries absent from the backup)", () => {
		const current = currentWith([sub("1"), sub("2")]);
		const incoming = { subscriptions: [sub("2"), sub("3")] };

		const plan = planImport(current, incoming, "overwrite");

		expect(plan.subscriptions.upsert.map((s) => s.id).sort()).toEqual(["2", "3"]);
		expect(plan.subscriptions.delete).toEqual(["1"]);
	});

	it("merge unions the subscription set (upserts incoming, deletes nothing)", () => {
		const current = currentWith([sub("1"), sub("2")]);
		const incoming = { subscriptions: [sub("2"), sub("3")] };

		const plan = planImport(current, incoming, "merge");

		expect(plan.subscriptions.upsert.map((s) => s.id).sort()).toEqual(["2", "3"]);
		expect(plan.subscriptions.delete).toEqual([]);
	});

	it("overwrite applies globals when the backup carries them", () => {
		const current = currentWith([]);
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.activeProfile = "deepseek";
		g.defaults.ai.providers = {
			deepseek: {
				provider: "deepseek",
				label: "",
				apiKey: "sk-imported",
				baseUrl: "",
				model: "",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
			},
		};

		const plan = planImport(current, { globals: g }, "overwrite");

		expect(plan.setGlobals?.defaults.ai.providers.deepseek?.apiKey).toBe("sk-imported");
	});

	it("merge never touches globals, even when the backup carries them", () => {
		const current = currentWith([]);
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.activeProfile = "deepseek";
		g.defaults.ai.providers = {
			deepseek: {
				provider: "deepseek",
				label: "",
				apiKey: "sk-imported",
				baseUrl: "",
				model: "",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
			},
		};

		const plan = planImport(current, { globals: g }, "merge");

		expect(plan.setGlobals).toBeUndefined();
	});

	it("a scope absent from the backup produces no writes for it", () => {
		const current = currentWith([sub("1")]);

		const plan = planImport(current, { adapters: [] }, "overwrite");

		// subscriptions untouched (not in the backup) — no upserts, no deletes
		expect(plan.subscriptions.upsert).toEqual([]);
		expect(plan.subscriptions.delete).toEqual([]);
	});
});
