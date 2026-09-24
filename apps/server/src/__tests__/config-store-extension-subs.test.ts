/**
 * ConfigStore × 拓展订阅(ADR-0019 决策 47 / 50)。
 *
 * - 内存里**一份**联合列表(B 站在前、拓展在后),盘上**两个**文件:`subscriptions.json` 只装
 *   B 站订阅、形状与旧载荷写的一字不差(不带 `kind`);拓展订阅住 `extension-subscriptions.json`。
 * - 哪个文件的行变了才写哪个:改 B 站订阅不重写、也不凭空建出拓展那份。
 * - 两个文件任何一个读坏了都是开机报错(与另外几份同一个口径)。
 * - 身份(`kind` / uid / `extensionId` / `externalId`)改不动。
 * - 跨分区的级联(删目标清引用、托管目标改名、整体替换)两支都得覆盖到。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BiliSubscription,
	type ExtensionSubscription,
	FEATURE_KEYS,
	type MessageBus,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import {
	type ConfigStore,
	ConfigValidationError,
	createConfigStore,
	EXTENSION_SUBSCRIPTIONS_FILE,
} from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

function makeServiceCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
	};
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

/** 旧载荷写出来的那种 B 站行:没有 `kind`。 */
function diskBiliRow(uid: string, id = randomUUID()): Omit<BiliSubscription, "kind"> {
	const { kind: _kind, ...row } = makeEmptySubscription({ id, uid });
	return row;
}

function makeOnebotConnection() {
	return {
		id: randomUUID(),
		name: "NapCat",
		platform: "onebot" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "http" as const,
		config: {
			transport: "http" as const,
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11" as const,
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			forwardMinTimeoutMs: 60_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
	};
}

function makeSessionTarget(connectionId: string) {
	return {
		id: randomUUID(),
		name: "群聊",
		connectionId,
		kind: "session" as const,
		platform: "onebot" as const,
		scope: "group" as const,
		enabled: true,
		address: "10001",
	};
}

function makeWebhookConnection() {
	return {
		id: randomUUID(),
		name: "团队 Webhook",
		platform: "feishu" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "webhook" as const,
		config: { url: "https://example.com/hook", headers: {} },
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

let dataDir: string;
let stateDir: string;
let bus: MessageBus;
let extFile: string;
let biliFile: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-ext-subs-"));
	stateDir = join(dataDir, "state");
	await mkdir(stateDir, { recursive: true });
	extFile = join(stateDir, EXTENSION_SUBSCRIPTIONS_FILE);
	biliFile = join(stateDir, "subscriptions.json");
	bus = createNodeMessageBus();
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function open(): Promise<ConfigStore> {
	const store = createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		bus,
		serviceCtx: makeServiceCtx(),
	});
	await store.load();
	return store;
}

describe("开机读两个文件", () => {
	it("没有拓展订阅那份 = 一条都没有,且不替它建文件", async () => {
		await writeFile(biliFile, JSON.stringify([diskBiliRow("1")]), "utf8");
		const store = await open();
		expect(store.getSubscriptions().map((s) => s.kind)).toEqual(["bilibili"]);
		expect(await exists(extFile)).toBe(false);
	});

	it("拼成一份:B 站在前、拓展在后,各按文件里的顺序;B 站行补上 kind", async () => {
		const b1 = diskBiliRow("1");
		const b2 = diskBiliRow("2");
		const e1 = makeExtensionSubscription({ id: randomUUID(), externalId: "x" });
		const e2 = makeExtensionSubscription({ id: randomUUID(), externalId: "y" });
		await writeFile(biliFile, JSON.stringify([b1, b2]), "utf8");
		await writeFile(extFile, JSON.stringify([e1, e2]), "utf8");
		const store = await open();
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([b1.id, b2.id, e1.id, e2.id]);
		expect(store.getSubscriptions()[0]).toMatchObject({ kind: "bilibili", uid: "1" });
	});

	it.each([
		["一行坏的", [{ kind: "extension", id: randomUUID(), externalId: "" }]],
		["不是数组", { not: "an array" }],
		["混进一行 B 站订阅", [diskBiliRow("1")]],
	])("拓展订阅那份%s → 开机报错,不跳过", async (_label, content) => {
		await writeFile(extFile, JSON.stringify(content), "utf8");
		await expect(open()).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it("subscriptions.json 里混进一行拓展订阅 → 开机报错", async () => {
		await writeFile(biliFile, JSON.stringify([makeExtensionSubscription()]), "utf8");
		await expect(open()).rejects.toBeInstanceOf(ConfigValidationError);
	});
});

describe("写:哪个文件的行变了才写哪个", () => {
	it("B 站订阅落盘不带 kind —— 与旧载荷写的一字不差;拓展那份不被建出来", async () => {
		const store = await open();
		const sub = makeEmptySubscription({ id: randomUUID(), uid: "42" });
		await store.upsertSubscription(sub);
		const { kind: _kind, ...row } = sub;
		expect(await readFile(biliFile, "utf8")).toBe(`${JSON.stringify([row], null, 2)}\n`);
		expect(await exists(extFile)).toBe(false);
	});

	it("改 B 站订阅不重写拓展那份", async () => {
		const bili = diskBiliRow("1");
		const ext = makeExtensionSubscription();
		await writeFile(biliFile, JSON.stringify([bili]), "utf8");
		// 故意写成紧凑格式:被重写过的话,缩进会变回两格。
		const extBytes = JSON.stringify([ext]);
		await writeFile(extFile, extBytes, "utf8");
		const store = await open();

		await store.patchSubscription(bili.id, { enabled: false });
		await store.deleteSubscription(bili.id);

		expect(await readFile(extFile, "utf8")).toBe(extBytes);
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([ext.id]);
	});

	it("加 / 改 / 删拓展订阅只写拓展那份", async () => {
		const bili = diskBiliRow("1");
		const biliBytes = JSON.stringify([bili]);
		await writeFile(biliFile, biliBytes, "utf8");
		const store = await open();
		const ext = makeExtensionSubscription();

		await store.upsertSubscription(ext);
		expect(JSON.parse(await readFile(extFile, "utf8"))).toEqual([ext]);
		await store.patchSubscription(ext.id, { enabled: false, name: "抖音那位" });
		expect(JSON.parse(await readFile(extFile, "utf8"))).toEqual([
			{ ...ext, enabled: false, name: "抖音那位" },
		]);
		await store.deleteSubscription(ext.id);
		expect(JSON.parse(await readFile(extFile, "utf8"))).toEqual([]);

		expect(await readFile(biliFile, "utf8")).toBe(biliBytes);
	});

	it("新加的 B 站订阅排在拓展订阅前面(内存里 B 站在前)", async () => {
		const store = await open();
		const ext = makeExtensionSubscription();
		await store.upsertSubscription(ext);
		const bili = makeEmptySubscription({ id: randomUUID(), uid: "7" });
		await store.upsertSubscription(bili);
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([bili.id, ext.id]);
	});

	it("一个新 store 读回同样的一份", async () => {
		const store = await open();
		const bili = makeEmptySubscription({ id: randomUUID(), uid: "7" });
		const ext = makeExtensionSubscription();
		await store.upsertSubscription(ext);
		await store.upsertSubscription(bili);
		const again = await open();
		expect(again.getSubscriptions()).toEqual(store.getSubscriptions());
	});
});

describe("身份改不动(ADR-0019 决策 50)", () => {
	let store: ConfigStore;
	let bili: BiliSubscription;
	let ext: ExtensionSubscription;

	beforeEach(async () => {
		store = await open();
		bili = makeEmptySubscription({ id: randomUUID(), uid: "100" });
		ext = makeExtensionSubscription({ id: randomUUID(), externalId: "sec-1" });
		await store.upsertSubscription(bili);
		await store.upsertSubscription(ext);
	});

	async function expectIdentityRejected(p: Promise<unknown>, key: string): Promise<void> {
		const err = await p.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConfigValidationError);
		expect((err as ConfigValidationError).issues).toMatchObject({
			key,
			message: "subscription identity cannot be changed",
		});
	}

	it.each([
		["B 站换 uid", "bili", { uid: "200" }, "uid"],
		["B 站换成拓展", "bili", { kind: "extension", extensionId: "douyin", externalId: "z" }, "kind"],
		["B 站塞一个 extensionId", "bili", { extensionId: "douyin" }, "extensionId"],
		["拓展换外部 id", "ext", { externalId: "sec-2" }, "externalId"],
		["拓展换拓展", "ext", { extensionId: "kuaishou" }, "extensionId"],
		["拓展塞一个 uid", "ext", { uid: "100" }, "uid"],
		["拓展把 kind 清掉", "ext", { kind: null }, "kind"],
	] as const)("patch:%s → 拒", async (_label, which, patch, key) => {
		const id = which === "bili" ? bili.id : ext.id;
		await expectIdentityRejected(store.patchSubscription(id, patch as never), key);
		expect(store.getSubscriptions()).toEqual([bili, ext]);
	});

	it("upsert 同一个 id:换 uid / 换成拓展 → 拒", async () => {
		await expectIdentityRejected(store.upsertSubscription({ ...bili, uid: "200" }), "uid");
		await expectIdentityRejected(
			store.upsertSubscription({ ...ext, id: bili.id } as ExtensionSubscription),
			"kind",
		);
		await expectIdentityRejected(
			store.upsertSubscription({ ...ext, externalId: "sec-2" }),
			"externalId",
		);
		expect(store.getSubscriptions()).toEqual([bili, ext]);
	});

	it("身份几格原样送回来(面板整份 POST)不算改;别的字段照改", async () => {
		await store.upsertSubscription({ ...ext, enabled: false });
		await store.patchSubscription(bili.id, { uid: "100", kind: "bilibili", notes: "改个备注" });
		expect(store.getSubscriptions()[0]).toEqual({ ...bili, notes: "改个备注" });
		// 老客户端送来的整条没有 kind —— 缺省就是 B 站。
		const { kind: _kind, ...noKind } = { ...bili, groups: ["g"] };
		await store.upsertSubscription(noKind as BiliSubscription);
		expect(store.getSubscriptions()).toEqual([
			{ ...bili, groups: ["g"] },
			{ ...ext, enabled: false },
		]);
	});
});

describe("跨分区的级联两支都覆盖", () => {
	it("删目标:拓展订阅里的引用一并清掉,拓展那份落盘", async () => {
		const store = await open();
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		const gone = makeSessionTarget(connection.id);
		const kept = makeSessionTarget(connection.id);
		await store.upsertTarget(gone);
		await store.upsertTarget(kept);
		const ext = makeExtensionSubscription();
		for (const k of FEATURE_KEYS) ext.routing[k] = [gone.id, kept.id];
		ext.extras.atAllDynamic = { [gone.id]: true, [kept.id]: false };
		await store.upsertSubscription(ext);

		await store.deleteTarget(gone.id);

		const onDisk = JSON.parse(await readFile(extFile, "utf8")) as ExtensionSubscription[];
		for (const sub of [store.getSubscriptions()[0], onDisk[0]]) {
			for (const k of FEATURE_KEYS) expect(sub?.routing[k]).toEqual([kept.id]);
			expect(sub?.extras.atAllDynamic).toEqual({ [kept.id]: false });
		}
	});

	it("删 webhook 连接:托管目标跟着走,拓展订阅里的引用一并清掉", async () => {
		const store = await open();
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const managedId = store.getTargets()[0]?.id as string;
		const ext = makeExtensionSubscription();
		ext.routing.live = [managedId];
		await store.upsertSubscription(ext);

		await store.deleteConnection(connection.id);

		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);
		const onDisk = JSON.parse(await readFile(extFile, "utf8")) as ExtensionSubscription[];
		expect(onDisk[0]?.routing.live).toEqual([]);
	});

	it("开机合并托管目标:拓展订阅里的老 id 一并迁到托管 id", async () => {
		const connection = makeWebhookConnection();
		const primary = {
			id: randomUUID(),
			name: "主",
			connectionId: connection.id,
			kind: "endpoint" as const,
			platform: connection.platform,
			scope: "channel" as const,
			enabled: true,
		};
		const extra = { ...primary, id: randomUUID(), name: "多余" };
		const ext = makeExtensionSubscription();
		ext.routing.dynamic = [extra.id];
		await writeFile(join(stateDir, "connections.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(stateDir, "targets.json"), JSON.stringify([primary, extra]), "utf8");
		await writeFile(extFile, JSON.stringify([ext]), "utf8");

		const store = await open();

		expect(store.getSubscriptions()[0]?.routing.dynamic).toEqual([primary.id]);
		const onDisk = JSON.parse(await readFile(extFile, "utf8")) as ExtensionSubscription[];
		expect(onDisk[0]?.routing.dynamic).toEqual([primary.id]);
	});

	it("整体替换:两支各落各的文件;B 站那份不带 kind", async () => {
		const store = await open();
		const bili = makeEmptySubscription({ id: randomUUID(), uid: "5" });
		const ext = makeExtensionSubscription();
		await store.replaceSections({ subscriptions: [bili, ext] });
		expect(store.getSubscriptions()).toEqual([bili, ext]);
		const { kind: _kind, ...row } = bili;
		expect(JSON.parse(await readFile(biliFile, "utf8"))).toEqual([row]);
		expect(JSON.parse(await readFile(extFile, "utf8"))).toEqual([ext]);
	});

	it("整体替换写到一半炸了:订阅那份推回原样,刚建出来的拓展那份删掉", async () => {
		const store = await open();
		const before = makeEmptySubscription({ id: randomUUID(), uid: "5" });
		await store.upsertSubscription(before);
		const biliBytes = await readFile(biliFile, "utf8");
		// globals 最后写:把它的位置换成一个非空目录,写它必炸。
		await rm(join(stateDir, "globals.json"));
		await mkdir(join(stateDir, "globals.json", "blocker"), { recursive: true });

		await expect(
			store.replaceSections({
				globals: store.getGlobals(),
				subscriptions: [
					makeEmptySubscription({ id: randomUUID(), uid: "6" }),
					makeExtensionSubscription(),
				],
			}),
		).rejects.toThrow();

		expect(await readFile(biliFile, "utf8")).toBe(biliBytes);
		expect(await exists(extFile)).toBe(false);
		expect(store.getSubscriptions()).toEqual([before]);
	});

	it("整体替换写到一半炸了:已有的拓展那份也推回原样", async () => {
		const ext = makeExtensionSubscription();
		const extBytes = JSON.stringify([ext]);
		await writeFile(extFile, extBytes, "utf8");
		const store = await open();
		await rm(join(stateDir, "globals.json"));
		await mkdir(join(stateDir, "globals.json", "blocker"), { recursive: true });

		await expect(
			store.replaceSections({ globals: store.getGlobals(), subscriptions: [] }),
		).rejects.toThrow();

		expect(await readFile(extFile, "utf8")).toBe(extBytes);
		expect(store.getSubscriptions()).toEqual([ext]);
	});
});

describe("按 UP 覆盖(ADR-0019 决策 64):拓展订阅存得进、清得掉", () => {
	it("高级规则页给拓展订阅开的那几格照收;发 null 的那一格清掉,盘上也跟着没了", async () => {
		const store = await open();
		const ext = makeExtensionSubscription();
		await store.upsertSubscription(ext);

		// 拓展订阅露的那几节写的格:过滤(只有看内容的那几格)、推送时段、两种文案、版式、人格。
		const kept = {
			filters: {
				blockKeywords: ["广告"],
				blockRegex: ["抽奖"],
				whitelistKeywords: [],
				whitelistRegex: [],
			},
			ai: { preset: "maid" },
			messageLayout: makeDefaultGlobalConfig().defaults.messageLayout,
		};
		const overrides = {
			...kept,
			schedule: { quietHours: [{ start: 23, end: 7 }] },
			templates: { dynamic: "新作品!", liveStart: "开播啦" },
		};
		await store.patchSubscription(ext.id, { overrides });
		expect(store.getSubscriptions().find((s) => s.id === ext.id)?.overrides).toEqual(overrides);

		// 面板关掉一节时的线格式(buildOverridesPatch):那一格显式 null。
		await store.patchSubscription(ext.id, {
			overrides: { schedule: null, templates: null },
		} as never);
		expect(store.getSubscriptions().find((s) => s.id === ext.id)?.overrides).toEqual(kept);
		expect(JSON.parse(await readFile(extFile, "utf8"))[0].overrides).toEqual(kept);
	});
});
