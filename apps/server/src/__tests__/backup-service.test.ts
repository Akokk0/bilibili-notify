import {
	type Connection,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { openFullBackup } from "../backup/assemble.js";
import { type BackupStore, createBackupService } from "../backup/service.js";

/**
 * BackupService 把纯核心接到真实 ConfigStore + CookieStore:导出读四个 scope(+cookie),
 * 导入按 plan 逐个写回。写回经 store 的既有方法 → 自动触发 config-changed 热重载;
 * cookie 恢复后回调 onCookiesRestored(bootstrap 接活体重登)。
 */
function sub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, uid });
}

function onebot(id: string, token: string): Connection {
	return {
		id,
		platform: "onebot",
		name: "bot",
		enabled: true,
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
	init: Partial<{ subscriptions: Subscription[]; adapters: Connection[] }> = {},
) {
	let globals = makeDefaultGlobalConfig();
	let subs = [...(init.subscriptions ?? [])];
	let adapters = [...(init.adapters ?? [])];
	let targets: PushTarget[] = [];
	const store: BackupStore = {
		getGlobals: () => globals,
		getSubscriptions: () => subs,
		getConnections: () => adapters,
		getTargets: () => targets,
		// 恢复是**一次整体替换**,不是一串编辑 —— 所以这个替身也只认终态,断言跟着看
		// 「最后剩下什么」而不是「按什么顺序调了哪些方法」。老替身把 upsertTarget 打成
		// 空函数,恰好把 webhook 目标根本恢复不了那个 bug 整个盖住了。
		replaceSections: vi.fn(async (next) => {
			if (next.globals) globals = next.globals;
			if (next.subscriptions) subs = next.subscriptions;
			if (next.adapters) adapters = next.adapters;
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
		const store = makeFakeStore({ subscriptions: [sub("1")], adapters: [onebot("a1", "tok-1")] });
		const cookieStore = makeCookieStore({ cookiesJson: "CJ", refreshToken: "RT" });
		const svc = createBackupService({ configStore: store, cookieStore, now: () => "t0" });

		const env = await svc.exportBackup({ kind: "full", pin: "123456" });

		expect(env.kind).toBe("full");
		expect(env.createdAt).toBe("t0");
		const opened = openFullBackup(env, "123456");
		expect(opened.cookies).toEqual({ cookiesJson: "CJ", refreshToken: "RT" });
		expect(opened.sections.adapters?.[0]?.config).toMatchObject({ accessToken: "tok-1" });
	});

	it("sanitized export respects the section selection and carries no secrets block", async () => {
		const store = makeFakeStore({ subscriptions: [sub("1")], adapters: [onebot("a1", "tok-1")] });
		const svc = createBackupService({
			configStore: store,
			cookieStore: makeCookieStore(null),
			now: () => "t0",
		});

		const env = await svc.exportBackup({
			kind: "sanitized",
			sections: { subscriptions: true, adapters: false, targets: false, globals: false },
		});

		expect(env.kind).toBe("sanitized");
		expect(env.secrets).toBeUndefined();
		expect(env.sections.subscriptions?.map((s) => s.id)).toEqual(["1"]);
		expect(env.sections.adapters).toBeUndefined();
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
		).rejects.toThrow();
	});
});
