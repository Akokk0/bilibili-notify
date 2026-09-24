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
	return makeEmptySubscription({ id: uid, uid });
}

function currentWith(
	subs: Subscription[],
	extensionSubscriptions: CurrentState["extensionSubscriptions"] = [],
): CurrentState {
	return {
		globals: makeDefaultGlobalConfig(),
		subscriptions: subs,
		extensionSubscriptions,
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
 * 拓展订阅单独一节(ADR-0019 决策 48),两支各算各的计划。改动之前导出的备份全都没有
 * 拓展那一节 —— 两种模式下都不许碰现有的拓展订阅。
 */
describe("planImport / foldPlan × 拓展订阅", () => {
	it.each(["overwrite", "merge"] as const)(
		"%s:没有拓展那一节的老备份 → 现有拓展订阅原样留着",
		(mode) => {
			const current = currentWith([sub("1")], [ext("e1")]);
			const plan = planImport(current, { subscriptions: [sub("2")] }, mode);
			expect(plan.extensionSubscriptions).toEqual({ upsert: [], delete: [] });
			const folded = foldPlan(current, plan);
			expect(folded.subscriptions?.filter((s) => s.kind === "extension")).toEqual([ext("e1")]);
		},
	);

	it("overwrite:带着拓展那一节(哪怕是空的)→ 拓展那支按它替换,B 站那支不动", () => {
		const current = currentWith([sub("1")], [ext("e1"), ext("e2")]);
		const plan = planImport(
			current,
			{ extensionSubscriptions: [ext("e2"), ext("e3")] },
			"overwrite",
		);
		expect(plan.extensionSubscriptions.delete).toEqual(["e1"]);
		expect(plan.subscriptions).toEqual({ upsert: [], delete: [] });
		expect(foldPlan(current, plan).subscriptions?.map((s) => s.id)).toEqual(["1", "e2", "e3"]);

		const cleared = planImport(current, { extensionSubscriptions: [] }, "overwrite");
		expect(foldPlan(current, cleared).subscriptions?.map((s) => s.id)).toEqual(["1"]);
	});

	it("两节都没有 → 订阅整个不给(保持不动)", () => {
		const current = currentWith([sub("1")], [ext("e1")]);
		expect(foldPlan(current, planImport(current, {}, "overwrite")).subscriptions).toBeUndefined();
	});
});
