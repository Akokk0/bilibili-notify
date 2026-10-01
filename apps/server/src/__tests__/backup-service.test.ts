import {
	type Connection,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { openFullBackup } from "../backup/assemble.js";
import { BackupPinError } from "../backup/crypto.js";
import { type BackupStore, createBackupService } from "../backup/service.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/**
 * BackupService 把纯核心接到真实 ConfigStore + CookieStore:导出读四个 scope(+cookie),
 * 导入按 plan 逐个写回。写回经 store 的既有方法 → 自动触发 config-changed 热重载;
 * cookie 恢复后回调 onCookiesRestored(bootstrap 接活体重登)。
 */
function sub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, identity: { sourceKey: "bilibili", externalId: uid } });
}

function onebot(id: string, token: string): Connection {
	return {
		id,
		platform: "onebot",
		name: "bot",
		enabled: true,
		kind: "direct",
		connector: "ws",
		config: {
			transport: "ws",
			url: "ws://host",
			headers: {},
			accessToken: token,
			protocolVersion: "v11",
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			forwardMinTimeoutMs: 60_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
	};
}

function makeFakeStore(
	init: Partial<{ subscriptions: Subscription[]; connections: Connection[] }> = {},
) {
	let globals = makeDefaultGlobalConfig();
	let subs = [...(init.subscriptions ?? [])];
	let connections = [...(init.connections ?? [])];
	let targets: PushTarget[] = [];
	const store: BackupStore = {
		getGlobals: () => globals,
		getSubscriptions: () => subs,
		getConnections: () => connections,
		getTargets: () => targets,
		// 恢复是**一次整体替换**,不是一串编辑 —— 所以这个替身也只认终态,断言跟着看
		// 「最后剩下什么」而不是「按什么顺序调了哪些方法」。老替身把 upsertTarget 打成
		// 空函数,恰好把 webhook 目标根本恢复不了那个 bug 整个盖住了。
		replaceSections: vi.fn(async (next) => {
			if (next.globals) globals = next.globals;
			if (next.subscriptions) subs = next.subscriptions;
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

describe("BackupService", () => {
	it("exports a full backup whose secrets round-trip back through the PIN", async () => {
		const store = makeFakeStore({
			subscriptions: [sub("1")],
			connections: [onebot("a1", "tok-1")],
		});
		const cookieStore = makeCookieStore({ cookiesJson: "CJ", refreshToken: "RT" });
		const svc = createBackupService({ configStore: store, cookieStore, now: () => "t0" });

		const env = await svc.exportBackup({ kind: "full", pin: "123456" });

		expect(env.kind).toBe("full");
		expect(env.createdAt).toBe("t0");
		const opened = openFullBackup(env, "123456");
		expect(opened.cookies).toEqual({ cookiesJson: "CJ", refreshToken: "RT" });
		expect(opened.sections.connections?.[0]?.config).toMatchObject({ accessToken: "tok-1" });
	});

	/**
	 * 拓展声明的密钥要真的走到脱敏那一步 —— 这条钉的是**接线**。
	 *
	 * `redactSecretKeys` 自己的单元测试证明它会抹,但那证明不了备份服务真的把拓展那份
	 * 名单递了进去。漏了这一环的症状是:拓展的密钥原样躺在主人发出去的备份文件里,
	 * 而所有测试全绿。
	 */
	it("拓展声明成密钥的 config 键,在两种档里都被抹平", async () => {
		const extension = {
			id: "e1",
			name: "桥",
			enabled: true,
			kind: "extension",
			extensionId: "bridge",
			config: { botKey: "s3cret", note: "家里那台" },
		} as unknown as Connection;
		const svc = createBackupService({
			configStore: makeFakeStore({ connections: [extension] }),
			cookieStore: makeCookieStore(null),
			now: () => "t0",
			extensionSecretCodes: () => new Map([["bridge", ["botKey"]]]),
		});

		const sanitized = await svc.exportBackup({ kind: "sanitized" });
		expect(sanitized.sections.connections?.[0]?.config).toEqual({
			botKey: "",
			note: "家里那台",
		});

		// 完整档的明文段同样不许带 —— 真值只存在于加密袋里。
		const full = await svc.exportBackup({ kind: "full", pin: "123456" });
		expect(full.sections.connections?.[0]?.config).toEqual({ botKey: "", note: "家里那台" });
	});

	/**
	 * 🔴 拓展**没跑起来**时(开关拨掉 / 清单坏了 / 连败停用)问不出它的字段表 —— 从前
	 * 那就等于「什么都不抹」,于是关掉一个拓展就把它连接里的密钥漏进备份文件,而备份是
	 * 主人会发出去求助的东西。这条钉的是接线:服务真的把「它不在表里」这件事带了下去。
	 */
	it("拓展没跑起来 → 它那条连接的 config 整片抹平", async () => {
		const extension = {
			id: "e1",
			name: "桥",
			enabled: true,
			kind: "extension",
			extensionId: "bridge",
			config: { botKey: "s3cret", note: "家里那台" },
		} as unknown as Connection;
		const svc = createBackupService({
			configStore: makeFakeStore({ connections: [extension] }),
			cookieStore: makeCookieStore(null),
			now: () => "t0",
			// 跑着的一个都没有 —— 拓展全停用时就是这个样子。
			extensionSecretCodes: () => new Map(),
		});

		const sanitized = await svc.exportBackup({ kind: "sanitized" });
		expect(sanitized.sections.connections?.[0]?.config).toEqual({ botKey: "", note: "" });
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
			expect(env.schemaVersion).toBe(2);
			const sections = kind === "full" ? openFullBackup(env, "123456").sections : env.sections;
			expect(sections.subscriptions?.map((s) => s.id)).toEqual(["1", "e1"]);
			expect(sections.subscriptions?.map((s) => s.identity.sourceKey)).toEqual([
				"bilibili",
				"douyin",
			]);
			// 节就这四个:订阅只有一节,没有按来源再拆出第二节。
			expect(Object.keys(sections).sort()).toEqual([
				"connections",
				"globals",
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
			"globals",
			"subscriptions",
			"targets",
		]);
		const without = await service(store).exportBackup({
			kind: "sanitized",
			sections: { subscriptions: false },
		});
		expect(Object.keys(without.sections).sort()).toEqual(["connections", "globals", "targets"]);
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
