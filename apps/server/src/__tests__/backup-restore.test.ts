import {
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { type CurrentState, foldPlan, planImport } from "../backup/restore.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/**
 * planImport 把「当前状态 + 导入段 + 覆盖/合并」算成一组具体写操作(upsert / delete /
 * setGlobals),纯函数、无 IO。覆盖=整盘替换(删多余),合并=并集(不删),合并不动 globals。
 */
function sub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, identity: { sourceKey: "bilibili", externalId: uid } });
}

function currentWith(subs: Subscription[]): CurrentState {
	return {
		globals: makeDefaultGlobalConfig(),
		subscriptions: subs,
		connections: [],
		targets: [],
	};
}

const ext = (externalId: string) => makeExtensionSubscription({ id: externalId, externalId });

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
				apiFlavor: "chat",
				label: "",
				apiKey: "sk-imported",
				baseUrl: "",
				model: "",
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
				apiFlavor: "chat",
				label: "",
				apiKey: "sk-imported",
				baseUrl: "",
				model: "",
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

		const plan = planImport(current, { connections: [] }, "overwrite");

		// subscriptions untouched (not in the backup) — no upserts, no deletes
		expect(plan.subscriptions.upsert).toEqual([]);
		expect(plan.subscriptions.delete).toEqual([]);
	});
});

/**
 * 订阅只有一节(ADR-0021 决策 15):B 站与拓展来源的订阅同在 `subscriptions` 里、同一个计划,不分来源。
 * 备份里没有订阅那一节 —— 两种模式下都不许碰现有的订阅(含拓展来源的)。
 */
describe("planImport / foldPlan × 订阅一节里的两种来源", () => {
	it.each(["overwrite", "merge"] as const)(
		"%s:备份没有订阅那一节 → 现有订阅(B 站与拓展来源的)原样留着,折出来不给订阅",
		(mode) => {
			const current = currentWith([sub("1"), ext("e1")]);
			const plan = planImport(current, { connections: [] }, mode);
			expect(plan.subscriptions).toEqual({ upsert: [], delete: [] });
			expect(foldPlan(current, plan).subscriptions).toBeUndefined();
		},
	);

	it("overwrite:订阅那一节按它整个替换,不分来源 —— 备份里没有的(B 站的、拓展的)都删", () => {
		const current = currentWith([sub("1"), ext("e1"), ext("e2")]);
		const plan = planImport(
			current,
			{ subscriptions: [sub("2"), ext("e2"), ext("e3")] },
			"overwrite",
		);
		expect(plan.subscriptions.delete).toEqual(["1", "e1"]);
		expect(plan.subscriptions.upsert.map((s) => s.id)).toEqual(["2", "e2", "e3"]);
		expect(foldPlan(current, plan).subscriptions?.map((s) => s.id)).toEqual(["e2", "2", "e3"]);

		// 带着订阅那一节、哪怕是空的 → 真清空。
		const cleared = planImport(current, { subscriptions: [] }, "overwrite");
		expect(foldPlan(current, cleared).subscriptions?.map((s) => s.id)).toEqual([]);
	});

	it("merge:并集,什么都不删;同一个 id 以备份里的为准", () => {
		const current = currentWith([sub("1"), ext("e1")]);
		const renamed = { ...ext("e1"), notes: "备份里的备注" };
		const plan = planImport(current, { subscriptions: [renamed, ext("e2")] }, "merge");
		expect(plan.subscriptions.delete).toEqual([]);
		const folded = foldPlan(current, plan).subscriptions;
		expect(folded?.map((s) => s.id)).toEqual(["1", "e1", "e2"]);
		expect(folded?.find((s) => s.id === "e1")?.notes).toBe("备份里的备注");
	});
});
