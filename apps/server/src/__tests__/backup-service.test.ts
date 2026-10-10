import {
	type Connection,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	OnebotConnectionSettingsSchema,
	type PushTarget,
	type Subscription,
	type SubscriptionTag,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { openFullBackup } from "../backup/assemble.js";
import { BackupPinError } from "../backup/crypto.js";
import { type BackupSections, buildBackup } from "../backup/envelope.js";
import { BackupRejectedError } from "../backup/rejected-error.js";
import type { ImportMode } from "../backup/restore.js";
import { type BackupStore, createBackupService } from "../backup/service.js";
import type { SecretCellsReader } from "../push/connection-settings.js";
import { snapshotFor } from "./support/connection-snapshot.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/**
 * BackupService 把纯核心接到真实 ConfigStore + CookieStore:导出读四个 scope 与各集成、各拓展的设置(+cookie),
 * 导入按 plan 逐个写回。写回经 store 的既有方法 → 自动触发 config-changed 热重载;
 * cookie 恢复后回调 onCookiesRestored(bootstrap 接活体重登)。
 */
function sub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, identity: { sourceKey: "bilibili", externalId: uid } });
}

/** 查表:OneBot 适配器在场(真 schema);`declared` 是拓展声明的密钥键,按适配器键。 */
function secretsOf(
	declared: ReadonlyMap<string, readonly string[]> = new Map(),
): SecretCellsReader {
	return {
		settingsSchemaOf: (key) => (key === "onebot" ? OnebotConnectionSettingsSchema : undefined),
		declaredSecretKeysOf: (key) => declared.get(key),
	};
}

function onebot(id: string, token: string): Connection {
	return {
		id,
		platform: "onebot",
		name: "bot",
		enabled: true,
		adapterKey: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		settings: {
			transport: "ws",
			url: "ws://host",
			headers: {},
			accessToken: token,
			protocolVersion: "v11",
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			maxRetries: 0,
			retryIntervalMs: 1_000,
		},
	};
}

/** B 站的设置 —— 各集成的设置在备份里单独一节(`integrations`),按集成的键(今天只有 B 站)。 */
const BILIBILI_SETTINGS = { dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 };

function makeFakeStore(
	init: Partial<{
		subscriptions: Subscription[];
		subscriptionTags: SubscriptionTag[];
		connections: Connection[];
		integrations: Record<string, unknown>;
		extensionSettings: Record<string, unknown>;
	}> = {},
) {
	let globals = makeDefaultGlobalConfig();
	let integrations: Record<string, unknown> = init.integrations ?? { bilibili: BILIBILI_SETTINGS };
	let extensionSettings: Record<string, unknown> = init.extensionSettings ?? {};
	let subs = [...(init.subscriptions ?? [])];
	let subscriptionTags = [...(init.subscriptionTags ?? [])];
	let connections = [...(init.connections ?? [])];
	let targets: PushTarget[] = [];
	const store: BackupStore = {
		getGlobals: () => globals,
		getAllIntegrationSettings: () => integrations,
		getAllExtensionSettings: () => extensionSettings,
		getSubscriptions: () => subs,
		getSubscriptionTags: () => subscriptionTags,
		getConnections: () => connections,
		getTargets: () => targets,
		// 恢复是**一次整体替换**,不是一串编辑 —— 所以这个替身也只认终态,断言跟着看
		// 「最后剩下什么」而不是「按什么顺序调了哪些方法」。老替身把 upsertTarget 打成
		// 空函数,恰好把 webhook 目标根本恢复不了那个 bug 整个盖住了。
		replaceSections: vi.fn(async (next) => {
			if (next.globals) globals = next.globals;
			// 各集成的设置按键整份换(和真 store 一样:备份里没带的键不动)。
			if (next.integrations) integrations = { ...integrations, ...next.integrations };
			// 各拓展的设置也一样:带来的那几个整份换,没带的不动。
			if (next.extensionSettings) {
				extensionSettings = { ...extensionSettings, ...next.extensionSettings };
			}
			if (next.subscriptions) subs = next.subscriptions;
			if (next.subscriptionTags) subscriptionTags = next.subscriptionTags;
			if (next.connections) connections = next.connections;
			if (next.targets) targets = next.targets;
			return [];
		}),
	};
	return store;
}

function makeCookieStore(data: { cookiesJson: string; refreshToken?: string } | null) {
	return {
		load: vi.fn(async () => data),
		save: vi.fn(async () => {}),
	};
}

describe("BackupService × 订阅标签(ADR-0034)", () => {
	const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };

	it("导出:标签表跟订阅同进同出;只勾设置、不勾订阅的不带", async () => {
		const tagged = { ...sub("1"), tagIds: [GAME.id] };
		const store = makeFakeStore({ subscriptions: [tagged], subscriptionTags: [GAME] });
		const svc = createBackupService({ configStore: store, cookieStore: makeCookieStore(null) });

		const withSubs = await svc.exportBackup({ kind: "sanitized" });
		expect(withSubs.sections.subscriptionTags).toEqual([GAME]);
		const settingsOnly = await svc.exportBackup({
			kind: "sanitized",
			sections: { globals: true, subscriptions: false, connections: false, targets: false },
		});
		expect(settingsOnly.sections.subscriptionTags).toBeUndefined();
	});

	it("导回一台空机器(合并):标签表落地,订阅上挂的对得上", async () => {
		const tagged = { ...sub("1"), tagIds: [GAME.id] };
		const from = makeFakeStore({ subscriptions: [tagged], subscriptionTags: [GAME] });
		const env = await createBackupService({
			configStore: from,
			cookieStore: makeCookieStore(null),
		}).exportBackup({ kind: "sanitized" });

		const to = makeFakeStore();
		await createBackupService({ configStore: to, cookieStore: makeCookieStore(null) }).importBackup(
			{
				envelope: env,
				mode: "merge",
			},
		);

		expect(to.getSubscriptionTags()).toEqual([GAME]);
		expect(to.getSubscriptions().map((s) => s.tagIds)).toEqual([[GAME.id]]);
	});
});

describe("BackupService", () => {
	it("exports a full backup whose secrets round-trip back through the PIN", async () => {
		const store = makeFakeStore({
			subscriptions: [sub("1")],
			connections: [onebot("a1", "tok-1")],
		});
		const cookieStore = makeCookieStore({ cookiesJson: "CJ", refreshToken: "RT" });
		const svc = createBackupService({
			configStore: store,
			cookieStore,
			now: () => "t0",
			connectionSecrets: secretsOf(),
		});

		const env = await svc.exportBackup({ kind: "full", pin: "123456" });

		expect(env.kind).toBe("full");
		expect(env.createdAt).toBe("t0");
		const opened = openFullBackup(env, "123456");
		expect(opened.cookies).toEqual({ cookiesJson: "CJ", refreshToken: "RT" });
		expect(opened.sections.connections?.[0]?.settings).toMatchObject({ accessToken: "tok-1" });
		// 完整档导出再导入逐格相等:连接整条(含平台快照)原样回来。
		expect(opened.sections.connections).toEqual(store.getConnections());
	});

	/**
	 * 拓展声明的密钥要真的走到脱敏那一步 —— 这条钉的是**接线**。
	 *
	 * `redactSecretKeys` 自己的单元测试证明它会抹,但那证明不了备份服务真的把拓展那份
	 * 名单递了进去。漏了这一环的症状是:拓展的密钥原样躺在主人发出去的备份文件里,
	 * 而所有测试全绿。
	 */
	it("拓展声明成密钥的 settings 键,在两种档里都被抹平", async () => {
		const extension: Connection = {
			id: "e1",
			name: "桥",
			enabled: true,
			adapterKey: "bridge",
			platform: "telegram",
			settings: { botKey: "s3cret", note: "家里那台" },
			platformSnapshot: snapshotFor("telegram"),
		};
		const svc = createBackupService({
			configStore: makeFakeStore({ connections: [extension] }),
			cookieStore: makeCookieStore(null),
			now: () => "t0",
			connectionSecrets: secretsOf(new Map([["bridge", ["botKey"]]])),
		});

		const sanitized = await svc.exportBackup({ kind: "sanitized" });
		expect(sanitized.sections.connections?.[0]?.settings).toEqual({
			botKey: "",
			note: "家里那台",
		});
		expect(JSON.stringify(sanitized.sections)).not.toContain("s3cret");

		// 完整档的明文段同样不许带 —— 真值只存在于加密袋里。
		const full = await svc.exportBackup({ kind: "full", pin: "123456" });
		expect(full.sections.connections?.[0]?.settings).toEqual({ botKey: "", note: "家里那台" });
		expect(JSON.stringify(full.sections)).not.toContain("s3cret");
	});

	/**
	 * 🔴 拓展**没跑起来**时(开关拨掉 / 清单坏了 / 连败停用)问不出它的字段表 —— 从前
	 * 那就等于「什么都不抹」,于是关掉一个拓展就把它连接里的密钥漏进备份文件,而备份是
	 * 主人会发出去求助的东西。这条钉的是接线:服务真的把「它不在表里」这件事带了下去。
	 */
	it("拓展没跑起来 → 它那条连接的 settings 整片抹平", async () => {
		const extension: Connection = {
			id: "e1",
			name: "桥",
			enabled: true,
			adapterKey: "bridge",
			platform: "telegram",
			settings: { botKey: "s3cret", note: "家里那台" },
			platformSnapshot: snapshotFor("telegram"),
		};
		const svc = createBackupService({
			configStore: makeFakeStore({ connections: [extension] }),
			cookieStore: makeCookieStore(null),
			now: () => "t0",
			// 跑着的一个都没有 —— 拓展全停用时就是这个样子。
			connectionSecrets: secretsOf(),
		});

		const sanitized = await svc.exportBackup({ kind: "sanitized" });
		expect(sanitized.sections.connections?.[0]?.settings).toEqual({ botKey: "", note: "" });
	});

	it("sanitized export respects the section selection and carries no secrets block", async () => {
		const store = makeFakeStore({
			subscriptions: [sub("1")],
			connections: [onebot("a1", "tok-1")],
		});
		const svc = createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t0",
		});

		const env = await svc.exportBackup({
			kind: "sanitized",
			sections: { subscriptions: true, connections: false, targets: false, globals: false },
		});

		expect(env.kind).toBe("sanitized");
		expect(env.secrets).toBeUndefined();
		expect(env.sections.subscriptions?.map((s) => s.id)).toEqual(["1"]);
		expect(env.sections.connections).toBeUndefined();
	});

	it("import overwrite replaces subscriptions, restores cookies, and fires the hot-reload hook", async () => {
		const store = makeFakeStore({ subscriptions: [sub("1"), sub("2")] });
		const cookieStore = makeCookieStore({ cookiesJson: "CJ", refreshToken: "RT" });
		const onCookiesRestored = vi.fn(async () => {});
		const svc = createBackupService({
			configStore: store,
			cookieStore,
			onCookiesRestored,
			now: () => "t",
		});

		// a full backup carrying subs {2,3} + cookies
		const source = makeFakeStore({ subscriptions: [sub("2"), sub("3")] });
		const srcSvc = createBackupService({
			configStore: source,
			cookieStore: makeCookieStore({ cookiesJson: "CJ2", refreshToken: "RT2" }),
			now: () => "t",
		});
		const env = await srcSvc.exportBackup({ kind: "full", pin: "123456" });

		await svc.importBackup({ envelope: env, pin: "123456", mode: "overwrite" });

		// overwrite:备份里的 2、3 留下,本地独有的 1 被清掉
		expect(
			store
				.getSubscriptions()
				.map((s) => s.id)
				.sort(),
		).toEqual(["2", "3"]);
		expect(cookieStore.save).toHaveBeenCalledWith({ cookiesJson: "CJ2", refreshToken: "RT2" });
		expect(onCookiesRestored).toHaveBeenCalledTimes(1);
	});

	it("import merge upserts but never deletes", async () => {
		const store = makeFakeStore({ subscriptions: [sub("1"), sub("2")] });
		const svc = createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t",
		});
		const source = makeFakeStore({ subscriptions: [sub("2"), sub("3")] });
		const srcSvc = createBackupService({
			configStore: source,
			cookieStore: makeCookieStore(null),
			now: () => "t",
		});
		const env = await srcSvc.exportBackup({ kind: "sanitized", sections: { subscriptions: true } });

		await svc.importBackup({ envelope: env, mode: "merge" });

		// merge:本地独有的 1 必须还在
		expect(
			store
				.getSubscriptions()
				.map((s) => s.id)
				.sort(),
		).toEqual(["1", "2", "3"]);
	});

	it("a dry-run import reports the same plan but writes nothing", async () => {
		const store = makeFakeStore({ subscriptions: [sub("1"), sub("2")] });
		const cookieStore = makeCookieStore(null);
		const onCookiesRestored = vi.fn(async () => {});
		const svc = createBackupService({ configStore: store, cookieStore, onCookiesRestored });

		const source = makeFakeStore({ subscriptions: [sub("2"), sub("3")] });
		const srcSvc = createBackupService({
			configStore: source,
			cookieStore: makeCookieStore({ cookiesJson: "CJ" }),
			now: () => "t",
		});
		const env = await srcSvc.exportBackup({ kind: "full", pin: "123456" });

		const planned = await svc.importBackup({
			envelope: env,
			pin: "123456",
			mode: "overwrite",
			dryRun: true,
		});

		expect(planned.subscriptions).toEqual({ upserted: 2, deleted: 1 });
		expect(planned.cookiesRestored).toBe(true);
		expect(store.replaceSections).not.toHaveBeenCalled();
		expect(cookieStore.save).not.toHaveBeenCalled();
		expect(onCookiesRestored).not.toHaveBeenCalled();
	});

	it("importing a full backup with the wrong PIN throws", async () => {
		const source = makeFakeStore({ subscriptions: [sub("1")] });
		const srcSvc = createBackupService({
			configStore: source,
			cookieStore: makeCookieStore({ cookiesJson: "CJ" }),
			now: () => "t",
		});
		const env = await srcSvc.exportBackup({ kind: "full", pin: "123456" });

		const store = makeFakeStore();
		const svc = createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t",
		});

		await expect(
			svc.importBackup({ envelope: env, pin: "0000", mode: "overwrite" }),
		).rejects.toBeInstanceOf(BackupPinError);
	});
});

/**
 * 订阅在备份里只有一节(ADR-0021 决策 15):B 站与拓展来源的订阅同在 `subscriptions`,行行带 `identity`;
 * 导出一个勾选、恢复一个 scope。没有订阅那一节的备份(只勾了别的)两种模式下都碰不到现有的订阅。
 */
describe("BackupService × 订阅一节里的两种来源", () => {
	const ext = (externalId: string) => makeExtensionSubscription({ id: externalId, externalId });

	function service(store: BackupStore) {
		return createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t",
		});
	}

	it.each(["sanitized", "full"] as const)(
		"%s 导出:B 站与拓展来源的订阅同在 subscriptions 一节,没有第二节;schemaVersion 是 1.0 的版本",
		async (kind) => {
			const store = makeFakeStore({ subscriptions: [sub("1"), ext("e1")] });
			const env = await service(store).exportBackup({ kind, pin: "123456" });
			expect(env.schemaVersion).toBe(13);
			const sections = kind === "full" ? openFullBackup(env, "123456").sections : env.sections;
			expect(sections.subscriptions?.map((s) => s.id)).toEqual(["1", "e1"]);
			expect(sections.subscriptions?.map((s) => s.identity.sourceKey)).toEqual([
				"bilibili",
				"douyin",
			]);
			// 节就这七个:订阅只有一节,没有按来源再拆出第二节(标签表跟订阅同一个勾选,ADR-0034);各集成、各拓展的设置跟「设置」同一个勾选。
			expect(Object.keys(sections).sort()).toEqual([
				"connections",
				"extensionSettings",
				"globals",
				"integrations",
				"subscriptionTags",
				"subscriptions",
				"targets",
			]);
		},
	);

	it("没勾订阅 → 没有订阅那一节;勾了、一条拓展来源的都没有 → 照样只有这一节", async () => {
		const store = makeFakeStore({ subscriptions: [sub("1")] });
		const withSubs = await service(store).exportBackup({ kind: "sanitized" });
		expect(withSubs.sections.subscriptions?.map((s) => s.id)).toEqual(["1"]);
		expect(Object.keys(withSubs.sections).sort()).toEqual([
			"connections",
			"extensionSettings",
			"globals",
			"integrations",
			"subscriptionTags",
			"subscriptions",
			"targets",
		]);
		const without = await service(store).exportBackup({
			kind: "sanitized",
			sections: { subscriptions: false },
		});
		expect(Object.keys(without.sections).sort()).toEqual([
			"connections",
			"extensionSettings",
			"globals",
			"integrations",
			"targets",
		]);
	});

	it.each(["overwrite", "merge"] as const)(
		"%s 恢复一份没有订阅那一节的备份 → 现有订阅(B 站与拓展来源的)原样留着",
		async (mode) => {
			const store = makeFakeStore({ subscriptions: [sub("1"), ext("e1")] });
			const source = makeFakeStore({ subscriptions: [sub("2")] });
			const env = await service(source).exportBackup({
				kind: "sanitized",
				sections: { subscriptions: false },
			});
			await service(store).importBackup({ envelope: env, mode });
			expect(store.getSubscriptions().map((s) => s.id)).toEqual(["1", "e1"]);
		},
	);

	it("overwrite 恢复:B 站与拓展来源的订阅按备份整个替换,计数就是这一节的计数", async () => {
		const source = makeFakeStore({ subscriptions: [sub("2"), ext("e2")] });
		const env = await service(source).exportBackup({ kind: "sanitized" });
		const store = makeFakeStore({ subscriptions: [sub("1"), ext("e1")] });
		const result = await service(store).importBackup({ envelope: env, mode: "overwrite" });
		expect(store.getSubscriptions().map((s) => s.id)).toEqual(["2", "e2"]);
		expect(result.subscriptions).toEqual({ upserted: 2, deleted: 2 });
	});

	it("merge 恢复:并集,本地独有的(B 站的、拓展来源的)都还在,身份原样带回来", async () => {
		const source = makeFakeStore({ subscriptions: [sub("2"), ext("e2")] });
		const env = await service(source).exportBackup({ kind: "sanitized" });
		const store = makeFakeStore({ subscriptions: [sub("1"), ext("e1")] });
		const result = await service(store).importBackup({ envelope: env, mode: "merge" });
		expect(
			store
				.getSubscriptions()
				.map((s) => `${s.id}@${s.identity.sourceKey}`)
				.sort(),
		).toEqual(["1@bilibili", "2@bilibili", "e1@douyin", "e2@douyin"]);
		expect(result.subscriptions).toEqual({ upserted: 2, deleted: 0 });
	});
});

/**
 * 恢复完不许多出同身份的重复(docs/1.0/data-model.md)。按身份并入之后还剩下的重复,只能是备份自己里面
 * 就有一对(老版本留下、跟着导了出来)—— 整份拒收、点名是谁(主人 10-01 定:不悄悄丢设置)。预览
 * (dry run)那一步就拒,不等主人点了确认才说。
 */
describe("BackupService × 同一身份只能有一条订阅", () => {
	/** `notes` 用来认出内容是哪一边的。 */
	function person(id: string, uid: string, notes?: string): Subscription {
		return {
			...makeEmptySubscription({ id, identity: { sourceKey: "bilibili", externalId: uid } }),
			notes,
		};
	}

	function service(store: BackupStore) {
		return createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t",
		});
	}

	async function backupOf(subscriptions: Subscription[]) {
		return service(makeFakeStore({ subscriptions })).exportBackup({ kind: "sanitized" });
	}

	it.each([
		["overwrite", false],
		["merge", false],
		["overwrite", true],
	] as const)(
		"%s(dry run=%s):备份自己带一对同身份 → 拒收,点名是谁,一样都不写",
		async (mode, dryRun) => {
			const env = await backupOf([
				person("b1", "12345", "第一条"),
				person("b2", "12345", "第二条"),
			]);
			const store = makeFakeStore({ subscriptions: [sub("9")] });

			const err = await service(store)
				.importBackup({ envelope: env, mode, dryRun })
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			expect(err).toBeInstanceOf(BackupRejectedError);
			const { code, message } = (err as BackupRejectedError).toFailure();
			expect(code).toBe("invalid");
			for (const word of ["bilibili", "12345"]) expect(message).toContain(word);
			expect(store.replaceSections).not.toHaveBeenCalled();
		},
	);

	it("恢复本机自己的备份、本机留着同样那一对(同样的 id)→ 不算新增,照收", async () => {
		const pair = [person("a1", "12345"), person("a2", "12345")];
		const env = await backupOf(pair);
		const store = makeFakeStore({ subscriptions: pair });
		await service(store).importBackup({ envelope: env, mode: "overwrite" });
		expect(store.getSubscriptions().map((s) => s.id)).toEqual(["a1", "a2"]);
	});

	it("备份里同一个人换了个 id → 并进本机那条,计数照「更新了一条」算", async () => {
		const env = await backupOf([person("backup", "12345", "备份")]);
		const store = makeFakeStore({ subscriptions: [person("local", "12345")] });
		const result = await service(store).importBackup({ envelope: env, mode: "merge" });
		expect(store.getSubscriptions()).toEqual([person("local", "12345", "备份")]);
		expect(result.subscriptions).toEqual({ upserted: 1, deleted: 0 });
	});
});

/**
 * 各集成的设置(今天只有 B 站)在备份里是单独一节 `integrations`,按集成的键。它跟核心设置(`globals`)走
 * **同一个勾选**(「设置」)和**同一种恢复口径**(覆盖才换、合并不动主人自己的设置);完整档与脱敏档一个样。
 *
 * 这几条钉的是**接线** —— 纯函数各自的测试证明不了服务真的把这一节读出来、递给打包、再递给 `replaceSections`:
 * 漏了哪一环,症状都是「恢复完 B 站的设置回到默认值」,而别的测试全绿。
 */
describe("BackupService × 各集成的设置", () => {
	/** 第二个集成是假想的:设置里带一个叫 `token` 的密钥,看脱敏与完整档的往返有没有走到这一节里。 */
	const SETTINGS = {
		bilibili: { dynamicCron: "0 */5 * * * *", healthCheckMinutes: 45 },
		other: { token: "tok-other", note: "另一个集成" },
	};
	const PIN = "123456";

	function service(store: BackupStore) {
		return createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t",
		});
	}

	/** 本机的设置是 B 站的默认,和备份里那份不一样 —— 恢复有没有换进去一眼看得出。 */
	const LOCAL = { bilibili: BILIBILI_SETTINGS };

	it("sanitized 导出:勾了「设置」→ integrations 随 globals 一起带上,密钥照样抹平", async () => {
		const env = await service(makeFakeStore({ integrations: SETTINGS })).exportBackup({
			kind: "sanitized",
		});
		expect(env.sections.globals).toBeDefined();
		expect(env.sections.integrations).toEqual({
			bilibili: SETTINGS.bilibili,
			other: { token: "", note: "另一个集成" },
		});
	});

	it("full 导出:明文段同样抹平,真值在加密袋里 —— 用 PIN 打开原样回来", async () => {
		const env = await service(makeFakeStore({ integrations: SETTINGS })).exportBackup({
			kind: "full",
			pin: PIN,
		});
		expect(env.sections.integrations).toEqual({
			bilibili: SETTINGS.bilibili,
			other: { token: "", note: "另一个集成" },
		});
		expect(openFullBackup(env, PIN).sections.integrations).toEqual(SETTINGS);
	});

	it.each(["sanitized", "full"] as const)(
		"%s 导出:没勾「设置」→ globals 与 integrations 一起不带",
		async (kind) => {
			const env = await service(makeFakeStore({ integrations: SETTINGS })).exportBackup({
				kind,
				pin: PIN,
				sections: { globals: false },
			});
			const sections = kind === "full" ? openFullBackup(env, PIN).sections : env.sections;
			expect(sections.globals).toBeUndefined();
			expect(sections.integrations).toBeUndefined();
			// 文件里(JSON)也没有这一节 —— 完整档的内存形状里没勾的节是 undefined 键,落盘时才丢。
			expect(Object.keys(JSON.parse(JSON.stringify(env)).sections)).not.toContain("integrations");
		},
	);

	it("overwrite 恢复:备份带着的 integrations 交给 replaceSections,本机的换成备份里的", async () => {
		const env = await service(makeFakeStore({ integrations: SETTINGS })).exportBackup({
			kind: "full",
			pin: PIN,
		});
		const store = makeFakeStore({ integrations: LOCAL });

		await service(store).importBackup({ envelope: env, pin: PIN, mode: "overwrite" });

		expect(store.replaceSections).toHaveBeenCalledTimes(1);
		expect(store.replaceSections).toHaveBeenCalledWith(
			expect.objectContaining({ integrations: SETTINGS }),
		);
		expect(store.getAllIntegrationSettings()).toEqual(SETTINGS);
	});

	it("merge 恢复:不碰本机的各集成设置(合并不动主人自己的设置)", async () => {
		const env = await service(makeFakeStore({ integrations: SETTINGS })).exportBackup({
			kind: "sanitized",
		});
		const store = makeFakeStore({ integrations: LOCAL });

		await service(store).importBackup({ envelope: env, mode: "merge" });

		const [folded] = vi.mocked(store.replaceSections).mock.calls[0] ?? [];
		expect(folded?.integrations).toBeUndefined();
		expect(store.getAllIntegrationSettings()).toEqual(LOCAL);
	});

	it.each(["overwrite", "merge"] as const)(
		"%s 恢复一份没勾「设置」的备份 → 本机各集成的设置原样留着",
		async (mode) => {
			const env = await service(makeFakeStore({ integrations: SETTINGS })).exportBackup({
				kind: "sanitized",
				sections: { globals: false },
			});
			const store = makeFakeStore({ integrations: LOCAL });

			await service(store).importBackup({ envelope: env, mode });

			const [folded] = vi.mocked(store.replaceSections).mock.calls[0] ?? [];
			expect(folded?.integrations).toBeUndefined();
			expect(store.getAllIntegrationSettings()).toEqual(LOCAL);
		},
	);

	/**
	 * 「设置已应用」不能只看核心那份:备份里只有各集成的设置(没有 `globals`)也是应用了设置 —— 面板据此说
	 * 「设置已恢复」。手搭一份只带这一节的备份(导出走勾选,两节同进同出,出不了这种)。
	 */
	describe.each([false, true])("globalsApplied(dry run=%s)", (dryRun) => {
		function restore(sections: BackupSections, mode: ImportMode) {
			const envelope = buildBackup({ kind: "sanitized", createdAt: "t", sections });
			return service(makeFakeStore({ integrations: LOCAL })).importBackup({
				envelope,
				mode,
				dryRun,
			});
		}

		it("overwrite 只带 integrations → true", async () => {
			expect((await restore({ integrations: SETTINGS }, "overwrite")).globalsApplied).toBe(true);
		});

		it("overwrite 只带 globals → true", async () => {
			expect(
				(await restore({ globals: makeDefaultGlobalConfig() }, "overwrite")).globalsApplied,
			).toBe(true);
		});

		it("merge 两样都带着 → false(合并不动设置)", async () => {
			const sections = { globals: makeDefaultGlobalConfig(), integrations: SETTINGS };
			expect((await restore(sections, "merge")).globalsApplied).toBe(false);
		});

		it("overwrite 两样都没带 → false", async () => {
			expect((await restore({ subscriptions: [sub("1")] }, "overwrite")).globalsApplied).toBe(
				false,
			);
		});
	});
});

/**
 * 各拓展的设置(ADR-0021 决策 42:一个拓展一个文件)在备份里是单独一节 `extensionSettings`,按拓展 id。它跟
 * 核心设置(`globals`)、各集成的设置走**同一个勾选**(「设置」)和**同一种恢复口径**(覆盖才换、合并不动主人
 * 自己的设置)。开关留在 `globals.extensions`,不在这一节里。
 *
 * 这几条钉的是**接线**:纯函数各自的测试证明不了服务真的把这一节读出来、递给脱敏与打包、再递给 `replaceSections`
 * —— 漏了哪一环,症状都是「恢复完拓展的设置(桥的接入名单)回到空的」或者「拓展的密钥原样躺在备份文件里」,而
 * 别的测试全绿。
 */
describe("BackupService × 各拓展的设置", () => {
	const SETTINGS = {
		bridge: { links: [{ id: "l1", name: "家里那台", botKey: "s3cret" }] },
		other: { note: "另一个拓展", token: "tok-other" },
	};
	/** 脱敏档里的样子:bridge 声明了 `botKey`;`other` 不在跑着的拓展表里 = 问不出来 → 整片抹平。 */
	const REDACTED = {
		bridge: { links: [{ id: "l1", name: "家里那台", botKey: "" }] },
		other: { note: "", token: "" },
	};
	/** 本机的设置和备份里的不一样,外加一个备份里没有的拓展 —— 恢复换进去了什么、留下了什么一眼看得出。 */
	const LOCAL = { bridge: { links: [] }, newer: { keep: "me" } };
	const PIN = "123456";

	function service(store: BackupStore) {
		return createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t",
			connectionSecrets: secretsOf(new Map([["bridge", ["botKey"]]])),
		});
	}

	it("sanitized 导出:勾了「设置」→ extensionSettings 随 globals 一起带上,拓展声明的密钥抹平", async () => {
		const env = await service(makeFakeStore({ extensionSettings: SETTINGS })).exportBackup({
			kind: "sanitized",
		});
		expect(env.sections.globals).toBeDefined();
		expect(env.sections.extensionSettings).toEqual(REDACTED);
		// 不改本机那份:抹的是拷贝。
		expect(SETTINGS.bridge.links[0]?.botKey).toBe("s3cret");
	});

	it("full 导出:明文段同样抹平,真值在加密袋里 —— 用 PIN 打开原样回来", async () => {
		const env = await service(makeFakeStore({ extensionSettings: SETTINGS })).exportBackup({
			kind: "full",
			pin: PIN,
		});
		expect(env.sections.extensionSettings).toEqual(REDACTED);
		expect(openFullBackup(env, PIN).sections.extensionSettings).toEqual(SETTINGS);
	});

	it.each(["sanitized", "full"] as const)(
		"%s 导出:没勾「设置」→ globals 与 extensionSettings 一起不带",
		async (kind) => {
			const env = await service(makeFakeStore({ extensionSettings: SETTINGS })).exportBackup({
				kind,
				pin: PIN,
				sections: { globals: false },
			});
			const sections = kind === "full" ? openFullBackup(env, PIN).sections : env.sections;
			expect(sections.globals).toBeUndefined();
			expect(sections.extensionSettings).toBeUndefined();
			// 文件里(JSON)也没有这一节。
			expect(Object.keys(JSON.parse(JSON.stringify(env)).sections)).not.toContain(
				"extensionSettings",
			);
		},
	);

	it("overwrite 恢复:备份带着的 extensionSettings 交给 replaceSections,带来的那几个换成备份里的,没带的不动", async () => {
		const env = await service(makeFakeStore({ extensionSettings: SETTINGS })).exportBackup({
			kind: "full",
			pin: PIN,
		});
		const store = makeFakeStore({ extensionSettings: LOCAL });

		await service(store).importBackup({ envelope: env, pin: PIN, mode: "overwrite" });

		expect(store.replaceSections).toHaveBeenCalledTimes(1);
		expect(store.replaceSections).toHaveBeenCalledWith(
			expect.objectContaining({ extensionSettings: SETTINGS }),
		);
		expect(store.getAllExtensionSettings()).toEqual({ ...LOCAL, ...SETTINGS });
	});

	it("merge 恢复:不碰本机的各拓展设置(合并不动主人自己的设置)", async () => {
		const env = await service(makeFakeStore({ extensionSettings: SETTINGS })).exportBackup({
			kind: "sanitized",
		});
		const store = makeFakeStore({ extensionSettings: LOCAL });

		await service(store).importBackup({ envelope: env, mode: "merge" });

		const [folded] = vi.mocked(store.replaceSections).mock.calls[0] ?? [];
		expect(folded?.extensionSettings).toBeUndefined();
		expect(store.getAllExtensionSettings()).toEqual(LOCAL);
	});

	it.each(["overwrite", "merge"] as const)(
		"%s 恢复一份没勾「设置」的备份 → 本机各拓展的设置原样留着",
		async (mode) => {
			const env = await service(makeFakeStore({ extensionSettings: SETTINGS })).exportBackup({
				kind: "sanitized",
				sections: { globals: false },
			});
			const store = makeFakeStore({ extensionSettings: LOCAL });

			await service(store).importBackup({ envelope: env, mode });

			const [folded] = vi.mocked(store.replaceSections).mock.calls[0] ?? [];
			expect(folded?.extensionSettings).toBeUndefined();
			expect(store.getAllExtensionSettings()).toEqual(LOCAL);
		},
	);

	/**
	 * 一个拓展设置都没存过时,导出的这一节是空对象 `{}`(勾了「设置」就一定带着)。空的等于没带:覆盖恢复它时
	 * 不往 `replaceSections` 递任何东西,也不算「设置已应用」。
	 */
	it("导出时一个拓展设置都没存过 → 这一节是 {};覆盖恢复它等于没带", async () => {
		const env = await service(makeFakeStore()).exportBackup({ kind: "sanitized" });
		expect(env.sections.extensionSettings).toEqual({});
		const store = makeFakeStore({ extensionSettings: LOCAL });

		await service(store).importBackup({ envelope: env, mode: "overwrite" });

		const [folded] = vi.mocked(store.replaceSections).mock.calls[0] ?? [];
		expect(folded?.extensionSettings).toBeUndefined();
		expect(store.getAllExtensionSettings()).toEqual(LOCAL);
	});

	/**
	 * 「设置已应用」不能漏看拓展那一节:备份里只有各拓展的设置(没有 `globals` / `integrations`)也是应用了设置
	 * —— 面板据此说「设置已恢复」。手搭一份只带这一节的备份(导出走勾选,几节同进同出,出不了这种)。
	 */
	describe.each([false, true])("globalsApplied(dry run=%s)", (dryRun) => {
		function restore(sections: BackupSections, mode: ImportMode) {
			const envelope = buildBackup({ kind: "sanitized", createdAt: "t", sections });
			return service(makeFakeStore({ extensionSettings: LOCAL })).importBackup({
				envelope,
				mode,
				dryRun,
			});
		}

		it("overwrite 只带 extensionSettings → true", async () => {
			expect((await restore({ extensionSettings: SETTINGS }, "overwrite")).globalsApplied).toBe(
				true,
			);
		});

		it("merge 只带 extensionSettings → false(合并不动设置)", async () => {
			expect((await restore({ extensionSettings: SETTINGS }, "merge")).globalsApplied).toBe(false);
		});

		it("overwrite 只带空的 extensionSettings → false(空的等于没带)", async () => {
			expect((await restore({ extensionSettings: {} }, "overwrite")).globalsApplied).toBe(false);
		});
	});
});
