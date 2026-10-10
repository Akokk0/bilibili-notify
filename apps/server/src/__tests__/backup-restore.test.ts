import {
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
	type SubscriptionTag,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { type CurrentState, foldPlan, planImport } from "../backup/restore.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/**
 * planImport 把「当前状态 + 导入段 + 覆盖/合并」算成一组具体写操作(upsert / delete /
 * setGlobals / setIntegrations / setExtensionSettings),纯函数、无 IO。覆盖=整盘替换(删多余),合并=并集(不删),
 * 合并不动 globals 与各集成、各拓展的设置。
 */
function sub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, identity: { sourceKey: "bilibili", externalId: uid } });
}

function currentWith(subs: Subscription[], subscriptionTags: SubscriptionTag[] = []): CurrentState {
	return {
		globals: makeDefaultGlobalConfig(),
		subscriptions: subs,
		subscriptionTags,
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
		g.ai.activeProfile = "deepseek";
		g.ai.providers = {
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

		expect(plan.setGlobals?.ai.providers.deepseek?.apiKey).toBe("sk-imported");
	});

	it("merge never touches globals, even when the backup carries them", () => {
		const current = currentWith([]);
		const g = makeDefaultGlobalConfig();
		g.ai.activeProfile = "deepseek";
		g.ai.providers = {
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
 * 各集成的设置(今天只有 B 站)是备份里单独一节 `integrations`,恢复的口径与核心设置(`globals`)一个样:
 * 覆盖才换,合并不动主人自己的设置;备份里没有这一节就不写。
 */
describe("planImport / foldPlan × 各集成的设置", () => {
	const integrations = {
		bilibili: { dynamicCron: "0 */5 * * * *", healthCheckMinutes: 45 },
	};

	it("overwrite:备份带着 integrations → 计划里整份换,折出来的终态也带着", () => {
		const current = currentWith([]);
		const plan = planImport(current, { integrations }, "overwrite");
		expect(plan.setIntegrations).toEqual(integrations);
		expect(foldPlan(current, plan).integrations).toEqual(integrations);
	});

	it("merge:备份带着 integrations 也不动 —— 合并别人分享的订阅,不能冲掉自己的设置", () => {
		const current = currentWith([]);
		const plan = planImport(current, { integrations }, "merge");
		expect(plan.setIntegrations).toBeUndefined();
		expect(foldPlan(current, plan).integrations).toBeUndefined();
	});

	it("overwrite:备份带着空的 integrations → 当没带(不算「设置恢复了」)", () => {
		const current = currentWith([]);
		const plan = planImport(current, { integrations: {} }, "overwrite");
		expect(plan.setIntegrations).toBeUndefined();
		expect(foldPlan(current, plan).integrations).toBeUndefined();
	});

	it("overwrite:备份没有 integrations 那一节 → 不写,折出来也没有", () => {
		const current = currentWith([sub("1")]);
		const plan = planImport(current, { subscriptions: [sub("2")] }, "overwrite");
		expect(plan.setIntegrations).toBeUndefined();
		expect(foldPlan(current, plan).integrations).toBeUndefined();
	});
});

/**
 * 各拓展的设置(一个拓展一个文件,ADR-0021 决策 42)是备份里单独一节 `extensionSettings`,按拓展 id;
 * 恢复的口径同上:覆盖才换(带来的那几个整份换),合并不动主人自己的设置;空的、没有这一节都等于没带。
 */
describe("planImport / foldPlan × 各拓展的设置", () => {
	const extensionSettings = {
		bridge: { links: [{ id: "l1", name: "家里那台", botKey: "s3cret" }] },
		douyin: { cron: "0 */5 * * * *" },
	};

	it("overwrite:备份带着 extensionSettings → 计划里整份换,折出来的终态也带着", () => {
		const current = currentWith([]);
		const plan = planImport(current, { extensionSettings }, "overwrite");
		expect(plan.setExtensionSettings).toEqual(extensionSettings);
		expect(foldPlan(current, plan).extensionSettings).toEqual(extensionSettings);
	});

	it("merge:备份带着 extensionSettings 也不动 —— 合并别人分享的订阅,不能冲掉自己的设置", () => {
		const current = currentWith([]);
		const plan = planImport(current, { extensionSettings }, "merge");
		expect(plan.setExtensionSettings).toBeUndefined();
		expect(foldPlan(current, plan).extensionSettings).toBeUndefined();
	});

	it("overwrite:备份带着空的 extensionSettings → 当没带(不算「设置恢复了」)", () => {
		const current = currentWith([]);
		const plan = planImport(current, { extensionSettings: {} }, "overwrite");
		expect(plan.setExtensionSettings).toBeUndefined();
		expect(foldPlan(current, plan).extensionSettings).toBeUndefined();
	});

	it("overwrite:备份没有 extensionSettings 那一节 → 不写,折出来也没有", () => {
		const current = currentWith([sub("1")]);
		const plan = planImport(current, { subscriptions: [sub("2")] }, "overwrite");
		expect(plan.setExtensionSettings).toBeUndefined();
		expect(foldPlan(current, plan).extensionSettings).toBeUndefined();
	});

	it("拓展设置与 integrations / globals 各算各的:只带 extensionSettings 时别的都不写", () => {
		const plan = planImport(currentWith([]), { extensionSettings }, "overwrite");
		expect(plan.setGlobals).toBeUndefined();
		expect(plan.setIntegrations).toBeUndefined();
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

/**
 * 恢复先按 id 对、再按身份并入(docs/1.0/data-model.md):备份里一行的 id 本机没有、身份却和本机某条一样,
 * 就当它是那一条 —— 留本机的 id(统计、历史、锐评都挂在本机的订阅 id 上,备份不带这些),内容用备份的
 * (和按 id 对上的行一个口径)。本机每条只认领一次;覆盖与合并两种模式都这样并。
 */
describe("planImport / foldPlan × 按身份并入", () => {
	/** 一条 B 站来源的订阅,id 与外部 id 分开给;`notes` 用来认出内容是哪一边的。 */
	function person(id: string, uid: string, notes?: string): Subscription {
		return {
			...makeEmptySubscription({ id, identity: { sourceKey: "bilibili", externalId: uid } }),
			notes,
		};
	}

	it.each(["overwrite", "merge"] as const)(
		"%s:备份里同一个人换了个 id → 并进本机那条:id 留本机的,内容用备份的,本机那条不删",
		(mode) => {
			const current = currentWith([person("local", "12345", "本机的备注"), sub("9")]);
			const plan = planImport(
				current,
				{ subscriptions: [person("backup", "12345", "备份里的备注"), sub("9")] },
				mode,
			);
			expect(plan.subscriptions.delete).toEqual([]);
			const folded = foldPlan(current, plan).subscriptions;
			expect(folded).toEqual([person("local", "12345", "备份里的备注"), sub("9")]);
		},
	);

	it("先按 id 对:id 对上的那条认领了本机那一行,同身份的另一行不再并进来", () => {
		const current = currentWith([person("local", "12345")]);
		const plan = planImport(
			current,
			{ subscriptions: [person("local", "12345", "按 id 对上"), person("other", "12345")] },
			"merge",
		);
		expect(foldPlan(current, plan).subscriptions?.map((s) => s.id)).toEqual(["local", "other"]);
	});

	it("本机每条只认领一次:备份里同一个人有两行,只有第一行并进本机那条", () => {
		const current = currentWith([person("local", "12345")]);
		const plan = planImport(
			current,
			{ subscriptions: [person("b1", "12345"), person("b2", "12345")] },
			"overwrite",
		);
		expect(foldPlan(current, plan).subscriptions?.map((s) => s.id)).toEqual(["local", "b2"]);
	});

	it("本机留着遗留的一对:备份里那一行并进其中第一条,覆盖模式删掉没认领的那条", () => {
		const current = currentWith([person("a1", "12345"), person("a2", "12345")]);
		const plan = planImport(
			current,
			{ subscriptions: [person("b", "12345", "备份")] },
			"overwrite",
		);
		expect(plan.subscriptions.delete).toEqual(["a2"]);
		expect(foldPlan(current, plan).subscriptions).toEqual([person("a1", "12345", "备份")]);
	});

	it("身份要两格都相等才并:拓展来源同一串外部 id 不算同一个人", () => {
		const current = currentWith([person("local", "12345")]);
		const fromExtension = makeExtensionSubscription({ id: "backup", externalId: "12345" });
		const plan = planImport(current, { subscriptions: [fromExtension] }, "merge");
		expect(foldPlan(current, plan).subscriptions?.map((s) => s.id)).toEqual(["local", "backup"]);
	});
});

describe("planImport / foldPlan × 订阅标签(ADR-0034)", () => {
	const X = "11111111-1111-4111-8111-111111111111";
	const Y = "22222222-2222-4222-8222-222222222222";
	const Z = "33333333-3333-4333-8333-333333333333";
	const tagged = (uid: string, tagIds: string[]): Subscription => ({ ...sub(uid), tagIds });

	it("备份没带标签表:折出来不碰标签表,订阅上挂的原样", () => {
		const current = currentWith([], [{ id: X, name: "游戏" }]);
		const folded = foldPlan(
			current,
			planImport(current, { subscriptions: [tagged("1", [X])] }, "merge"),
		);
		expect(folded.subscriptionTags).toBeUndefined();
		expect(folded.subscriptions?.map((s) => s.tagIds)).toEqual([[X]]);
	});

	it("overwrite:标签表整张用备份的,订阅上挂的原样", () => {
		const current = currentWith([], [{ id: X, name: "游戏" }]);
		const tags = [{ id: Y, name: "杂谈" }];
		const folded = foldPlan(
			current,
			planImport(
				current,
				{ subscriptions: [tagged("1", [Y])], subscriptionTags: tags },
				"overwrite",
			),
		);
		expect(folded.subscriptionTags).toEqual(tags);
		expect(folded.subscriptions?.map((s) => s.tagIds)).toEqual([[Y]]);
	});

	it("merge 先按 id 对:同一个标签在本机改过名,留本机的名字", () => {
		const current = currentWith([], [{ id: X, name: "Games" }]);
		const folded = foldPlan(
			current,
			planImport(
				current,
				{ subscriptions: [tagged("1", [X])], subscriptionTags: [{ id: X, name: "游戏" }] },
				"merge",
			),
		);
		expect(folded.subscriptionTags).toEqual([{ id: X, name: "Games" }]);
		expect(folded.subscriptions?.map((s) => s.tagIds)).toEqual([[X]]);
	});

	it("merge 再按名字对:换成本机的 id,备份订阅上挂的跟着换", () => {
		const current = currentWith([], [{ id: X, name: "杂谈" }]);
		const folded = foldPlan(
			current,
			planImport(
				current,
				{ subscriptions: [tagged("1", [Y])], subscriptionTags: [{ id: Y, name: "杂谈" }] },
				"merge",
			),
		);
		expect(folded.subscriptionTags).toEqual([{ id: X, name: "杂谈" }]);
		expect(folded.subscriptions?.map((s) => s.tagIds)).toEqual([[X]]);
	});

	it("merge 都对不上:接在本机那张后面,id 照用备份的", () => {
		const current = currentWith([], [{ id: X, name: "游戏" }]);
		const folded = foldPlan(
			current,
			planImport(
				current,
				{ subscriptions: [tagged("1", [Z])], subscriptionTags: [{ id: Z, name: "阿婆主" }] },
				"merge",
			),
		);
		expect(folded.subscriptionTags).toEqual([
			{ id: X, name: "游戏" },
			{ id: Z, name: "阿婆主" },
		]);
		expect(folded.subscriptions?.map((s) => s.tagIds)).toEqual([[Z]]);
	});

	it("merge:备份里两个标签落到本机同一个上,订阅上只挂一次", () => {
		const current = currentWith([], [{ id: X, name: "游戏" }]);
		const folded = foldPlan(
			current,
			planImport(
				current,
				{
					subscriptions: [tagged("1", [X, Y])],
					subscriptionTags: [
						{ id: X, name: "Games" },
						{ id: Y, name: "游戏" },
					],
				},
				"merge",
			),
		);
		expect(folded.subscriptionTags).toEqual([{ id: X, name: "游戏" }]);
		expect(folded.subscriptions?.map((s) => s.tagIds)).toEqual([[X]]);
	});
});
