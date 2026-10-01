/**
 * 同一身份只能有一条订阅(守卫 9,docs/1.0/data-model.md):把关在真正写盘的 ConfigStore,所有能加进订阅的
 * 写入路径各一条 —— 逐条 upsert、整体替换(恢复备份)。改、删动不了身份(身份改不动另有一道闸),
 * 删目标清引用这类级联只改 routing,都加不出重复。
 *
 * 判据是「这次写入有没有**新增**重复」(跟写之前比),不是「整份有没有重复」:盘上留着一对遗留重复时,
 * 改任何一条不相干的订阅照常能存,删掉其中一条也行;往那一对上再加第三条才拦。遗留的一对开机照读、
 * 只记一条警告(事件照旧分给每一条)。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type MessageBus,
	makeEmptySubscription,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import {
	CONFIG_DIR,
	type ConfigStore,
	ConfigValidationError,
	createConfigStore,
} from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

function makeServiceCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

function biliSub(uid: string, over: Partial<Subscription> = {}): Subscription {
	return {
		...makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "bilibili", externalId: uid },
		}),
		...over,
	};
}

function extSub(externalId: string): Subscription {
	return makeExtensionSubscription({ id: randomUUID(), externalId });
}

let dataDir: string;
let stateDir: string;
let subsFile: string;
let bus: MessageBus;
let ctx: ServiceContext;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-identity-unique-"));
	stateDir = join(dataDir, ...CONFIG_DIR);
	await mkdir(stateDir, { recursive: true });
	subsFile = join(stateDir, "subscriptions.json");
	bus = createNodeMessageBus();
	ctx = makeServiceCtx();
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function open(): Promise<ConfigStore> {
	const store = createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		dataRoot: dataDir,
		bus,
		serviceCtx: ctx,
	});
	await store.load();
	return store;
}

/** 盘上那份订阅文件的原始字节(写盘被拦时要一个字节不差)。 */
async function subsBytes(): Promise<string> {
	return readFile(subsFile, "utf8");
}

async function rejection(p: Promise<unknown>): Promise<ConfigValidationError> {
	const err = await p.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(ConfigValidationError);
	return err as ConfigValidationError;
}

/** 盘上已经留着一对同身份的订阅(老版本留下的),再开一个 store。 */
async function openWithLegacyPair(): Promise<{
	store: ConfigStore;
	pair: [Subscription, Subscription];
	other: Subscription;
}> {
	const pair: [Subscription, Subscription] = [
		biliSub("12345", { notes: "第一条" }),
		biliSub("12345", { notes: "第二条" }),
	];
	const other = extSub("sec-1");
	await writeFile(subsFile, JSON.stringify([pair[0], other, pair[1]]), "utf8");
	return { store: await open(), pair, other };
}

describe("逐条 upsert:新的一条撞上已有的身份 → 拒", () => {
	it.each([
		["B 站来源", () => biliSub("12345"), () => biliSub("12345"), ["bilibili", "12345"]],
		["拓展来源", () => extSub("sec-1"), () => extSub("sec-1"), ["douyin", "sec-1"]],
	] as const)(
		"%s:conflict,话里点名来源与外部 id;盘上与内存都不动",
		async (_label, first, second, named) => {
			const store = await open();
			const existing = first();
			await store.upsertSubscription(existing);
			const bytes = await subsBytes();

			const err = await rejection(store.upsertSubscription(second()));
			expect(err.code).toBe("conflict");
			for (const word of named) expect(err.message).toContain(word);
			expect(await subsBytes()).toBe(bytes);
			expect(store.getSubscriptions()).toEqual([existing]);
		},
	);

	it("身份要两格都相等才算重:不同来源同一串外部 id、同来源不同外部 id 都照收", async () => {
		const store = await open();
		await store.upsertSubscription(biliSub("12345"));
		await store.upsertSubscription(extSub("12345"));
		await store.upsertSubscription(biliSub("67890"));
		expect(store.getSubscriptions()).toHaveLength(3);
	});

	it("同一条整份送回来(面板保存)不算新增", async () => {
		const store = await open();
		const sub = biliSub("12345");
		await store.upsertSubscription(sub);
		await store.upsertSubscription({ ...sub, enabled: false });
		expect(store.getSubscriptions()).toEqual([{ ...sub, enabled: false }]);
	});
});

describe("整体替换(恢复备份):新增的重复 → 整份拒,哪一份都不写", () => {
	it("给的订阅里有一条与留下来的同身份 → conflict;订阅与设置都不动", async () => {
		const store = await open();
		const existing = biliSub("12345");
		await store.upsertSubscription(existing);
		const bytes = await subsBytes();
		const globalsBytes = await readFile(join(stateDir, "globals.json"), "utf8");
		const globals = store.getGlobals();
		globals.app.dynamicCron = "*/7 * * * *";

		const err = await rejection(
			store.replaceSections({ globals, subscriptions: [existing, biliSub("12345")] }),
		);
		expect(err.code).toBe("conflict");
		expect(err.message).toContain("12345");
		expect(await subsBytes()).toBe(bytes);
		expect(await readFile(join(stateDir, "globals.json"), "utf8")).toBe(globalsBytes);
		expect(store.getSubscriptions()).toEqual([existing]);
	});

	it("给的订阅自己带一对同身份、盘上原来没有 → 拒", async () => {
		const store = await open();
		await expect(
			store.replaceSections({ subscriptions: [extSub("sec-1"), extSub("sec-1")] }),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getSubscriptions()).toEqual([]);
	});

	it("换掉同身份的那条(旧的不在给的里)→ 不算新增,照收", async () => {
		const store = await open();
		await store.upsertSubscription(biliSub("12345"));
		const replacement = biliSub("12345");
		await store.replaceSections({ subscriptions: [replacement] });
		expect(store.getSubscriptions()).toEqual([replacement]);
	});
});

describe("盘上遗留的一对(老版本留下的)", () => {
	it("开机照读、一条不丢,记一条警告:点名身份与两条订阅", async () => {
		const { store, pair, other } = await openWithLegacyPair();
		expect(store.getSubscriptions()).toEqual([pair[0], other, pair[1]]);

		const warnings = vi.mocked(ctx.logger.warn).mock.calls.map((c) => String(c[0]));
		const hit = warnings.filter((w) => w.includes("12345"));
		expect(hit).toHaveLength(1);
		for (const word of ["bilibili", pair[0].id, pair[1].id]) expect(hit[0]).toContain(word);
	});

	it("没有重复 → 开机不为这个警告", async () => {
		await writeFile(subsFile, JSON.stringify([biliSub("1"), extSub("1")]), "utf8");
		await open();
		const warnings = vi.mocked(ctx.logger.warn).mock.calls.map((c) => String(c[0]));
		expect(warnings.filter((w) => w.includes("不止一条"))).toEqual([]);
	});

	it("改不相干的那条、改那一对里的一条、删掉其中一条 —— 都照常存", async () => {
		const { store, pair, other } = await openWithLegacyPair();
		await store.patchSubscription(other.id, { enabled: false });
		await store.upsertSubscription({ ...pair[0], notes: "改一下" });
		await store.patchSubscription(pair[1].id, { enabled: false });
		expect(await store.deleteSubscription(pair[1].id)).toBe(true);
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([pair[0].id, other.id]);
	});

	it("往那一对上再加第三条 → 拒", async () => {
		const { store } = await openWithLegacyPair();
		const bytes = await subsBytes();
		const err = await rejection(store.upsertSubscription(biliSub("12345")));
		expect(err.code).toBe("conflict");
		expect(await subsBytes()).toBe(bytes);
	});

	it("整体替换原样带回那一对(恢复本机自己的备份)→ 不算新增,照收", async () => {
		const { store, pair, other } = await openWithLegacyPair();
		await store.replaceSections({ subscriptions: [other, ...pair] });
		expect(store.getSubscriptions()).toEqual([other, ...pair]);
	});
});
