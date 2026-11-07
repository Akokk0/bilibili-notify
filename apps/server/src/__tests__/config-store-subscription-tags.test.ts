/**
 * 订阅标签(ADR-0034):一份标签表,订阅只记 `tagIds`。标签表与订阅住同一个文件
 * `config/subscriptions.json`(`{ tags, subscriptions }`),删标签时订阅上的引用在同一次原子写里去掉 ——
 * 两个文件的话,崩在两次写之间就留下悬空 id(删目标清引用今天就是这样)。
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
	type SubscriptionTag,
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

function sub(uid: string, tagIds: string[] = []): Subscription {
	return {
		...makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "bilibili", externalId: uid },
		}),
		tagIds,
	};
}

function tag(name: string): SubscriptionTag {
	return { id: randomUUID(), name };
}

let dataDir: string;
let subsFile: string;
let bus: MessageBus;
let ctx: ServiceContext;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-subscription-tags-"));
	await mkdir(join(dataDir, ...CONFIG_DIR), { recursive: true });
	subsFile = join(dataDir, ...CONFIG_DIR, "subscriptions.json");
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

async function onDisk(): Promise<{ tags: SubscriptionTag[]; subscriptions: Subscription[] }> {
	return JSON.parse(await readFile(subsFile, "utf8"));
}

async function rejection(p: Promise<unknown>): Promise<ConfigValidationError> {
	const err = await p.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(ConfigValidationError);
	return err as ConfigValidationError;
}

describe("文件形状", () => {
	it("新开:标签表为空,订阅文件写成 { tags: [], subscriptions: [] }", async () => {
		const store = await open();
		expect(store.getSubscriptionTags()).toEqual([]);
		expect(await onDisk()).toEqual({ tags: [], subscriptions: [] });
	});

	it("开机读到 0.x 那种裸数组 → 拒(只认最新的形状,改形归迁移)", async () => {
		await writeFile(subsFile, JSON.stringify([sub("1")]), "utf8");
		await expect(open()).rejects.toBeInstanceOf(ConfigValidationError);
	});
});

describe("整张标签表一起换(新建、改名、排序、删除都走它)", () => {
	it("照顺序存下,名字去掉首尾空白;发一次 config-changed:subscriptions", async () => {
		const store = await open();
		const changed = vi.fn();
		bus.on("config-changed", changed);
		const a = tag(" 游戏 ");
		const b = tag("杂谈");
		await store.replaceSubscriptionTags([b, a]);
		const expected = [b, { ...a, name: "游戏" }];
		expect(store.getSubscriptionTags()).toEqual(expected);
		expect((await onDisk()).tags).toEqual(expected);
		expect(changed).toHaveBeenCalledWith({ scope: "subscriptions" });
	});

	it.each([
		["空名字", () => [tag("  ")]],
		["去掉空白后重名", () => [tag("游戏"), tag(" 游戏")]],
		[
			"id 重复",
			() => {
				const a = tag("游戏");
				return [a, { id: a.id, name: "杂谈" }];
			},
		],
	])("%s → invalid,盘上不动", async (_label, make) => {
		const store = await open();
		const before = await readFile(subsFile, "utf8");
		const err = await rejection(store.replaceSubscriptionTags(make()));
		expect(err.code).toBe("invalid");
		expect(await readFile(subsFile, "utf8")).toBe(before);
	});

	it("删掉一个标签:订阅上的这个 id 在同一次写里一起去掉,盘上不留悬空 id", async () => {
		const store = await open();
		const keep = tag("游戏");
		const drop = tag("杂谈");
		await store.replaceSubscriptionTags([keep, drop]);
		const a = sub("1", [keep.id, drop.id]);
		const b = sub("2", [drop.id]);
		await store.upsertSubscription(a);
		await store.upsertSubscription(b);

		await store.replaceSubscriptionTags([keep]);

		const disk = await onDisk();
		expect(disk.tags).toEqual([keep]);
		expect(disk.subscriptions.map((s) => s.tagIds)).toEqual([[keep.id], []]);
		expect(store.getSubscriptions().map((s) => s.tagIds)).toEqual([[keep.id], []]);
	});
});

describe("订阅只能挂标签表里有的标签", () => {
	it("upsert 挂了一个不存在的标签 → invalid,盘上不动", async () => {
		const store = await open();
		const before = await readFile(subsFile, "utf8");
		const err = await rejection(store.upsertSubscription(sub("1", [randomUUID()])));
		expect(err.code).toBe("invalid");
		expect(await readFile(subsFile, "utf8")).toBe(before);
	});

	it("patch 挂了一个不存在的标签 → invalid,盘上不动", async () => {
		const store = await open();
		const s = sub("1");
		await store.upsertSubscription(s);
		const before = await readFile(subsFile, "utf8");
		const err = await rejection(store.patchSubscription(s.id, { tagIds: [randomUUID()] }));
		expect(err.code).toBe("invalid");
		expect(await readFile(subsFile, "utf8")).toBe(before);
	});

	it("挂已有的标签照常存", async () => {
		const store = await open();
		const t = tag("游戏");
		await store.replaceSubscriptionTags([t]);
		const s = sub("1");
		await store.upsertSubscription(s);
		const saved = await store.patchSubscription(s.id, { tagIds: [t.id] });
		expect(saved.tagIds).toEqual([t.id]);
	});
});

describe("开机读到悬空的标签 id(只可能是手改了文件)", () => {
	it("剥掉,记一条警告,照常起来", async () => {
		const t = tag("游戏");
		const ghost = randomUUID();
		await writeFile(
			subsFile,
			JSON.stringify({ tags: [t], subscriptions: [sub("1", [t.id, ghost])] }),
			"utf8",
		);
		const store = await open();
		expect(store.getSubscriptions()[0]?.tagIds).toEqual([t.id]);
		expect(ctx.logger.warn).toHaveBeenCalledWith("已移除订阅中不存在于标签表的标签引用", {
			event: "config.unknown_tags_removed",
			tagIds: [ghost],
		});
	});
});

describe("整体替换(恢复备份)也守同一条规矩", () => {
	it("只给标签表:现有订阅上挂着、新表里没有的 id 一起剥掉,同一次写", async () => {
		const store = await open();
		const keep = tag("游戏");
		const drop = tag("杂谈");
		await store.replaceSubscriptionTags([keep, drop]);
		await store.upsertSubscription(sub("1", [keep.id, drop.id]));

		await store.replaceSections({ subscriptionTags: [keep] });

		const disk = await onDisk();
		expect(disk.tags).toEqual([keep]);
		expect(disk.subscriptions.map((s) => s.tagIds)).toEqual([[keep.id]]);
	});

	it("订阅与标签表一起给,订阅挂了表里没有的标签 → 整份拒,盘上不动", async () => {
		const store = await open();
		const before = await readFile(subsFile, "utf8");
		const err = await rejection(
			store.replaceSections({
				subscriptions: [sub("1", [randomUUID()])],
				subscriptionTags: [tag("游戏")],
			}),
		);
		expect(err.code).toBe("invalid");
		expect(await readFile(subsFile, "utf8")).toBe(before);
	});
});
