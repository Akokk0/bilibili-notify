/**
 * ConfigStore × 订阅里的两种来源(ADR-0021 决策 14、15;身份不许改见 ADR-0019 决策 50)。
 *
 * - 订阅只有一种形状:每行带 `identity`。内存里**一份**列表,盘上**一个**文件 `config/subscriptions.json`,
 *   B 站与拓展来源的行同在、顺序就是写入的顺序;每次写都是一次原子写 —— 写不下去时盘上与内存都停在原样。
 * - 那个文件读坏了是开机报错(与另外几份同一个口径):跳过坏行,下次写回那几行就永久没了。0.x 的老形状
 *   (身份在顶层 `uid` / `extensionId` + `externalId`)活 schema 不认 —— 那是迁移器的事,不在这里。
 * - 身份(`identity.sourceKey` / `identity.externalId`)改不动。
 * - 跨分区的级联(删目标清引用、托管目标改名、整体替换)对两种来源的行都得覆盖到。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FEATURE_KEYS,
	type MessageBus,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import {
	CONFIG_DIR,
	CORE_SETTINGS_FILE,
	type ConfigStore,
	ConfigValidationError,
	createConfigStore,
} from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { legacyBiliRow } from "./support/legacy-subscription.js";

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

/** 一条 B 站来源的订阅。 */
function biliSub(uid: string, id = randomUUID()): Subscription {
	return makeEmptySubscription({ id, identity: { sourceKey: "bilibili", externalId: uid } });
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
/** 订阅的那一个文件。 */
let subsFile: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-subs-"));
	stateDir = join(dataDir, ...CONFIG_DIR);
	await mkdir(stateDir, { recursive: true });
	subsFile = join(stateDir, "subscriptions.json");
	bus = createNodeMessageBus();
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function open(): Promise<ConfigStore> {
	const store = createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		dataRoot: dataDir,
		bus,
		serviceCtx: makeServiceCtx(),
	});
	await store.load();
	return store;
}

/** 盘上那个文件里的行。 */
async function rowsOnDisk(): Promise<Array<Record<string, unknown>>> {
	return JSON.parse(await readFile(subsFile, "utf8")) as Array<Record<string, unknown>>;
}

describe("开机读一个文件", () => {
	it("B 站与拓展来源的行同在一个文件:一份列表,顺序就是文件里的顺序,身份原样", async () => {
		const b1 = biliSub("1");
		const e1 = makeExtensionSubscription({ id: randomUUID(), externalId: "x" });
		const b2 = biliSub("2");
		const e2 = makeExtensionSubscription({ id: randomUUID(), externalId: "y" });
		await writeFile(subsFile, JSON.stringify([b1, e1, b2, e2]), "utf8");
		const store = await open();
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([b1.id, e1.id, b2.id, e2.id]);
		expect(store.getSubscriptions().map((s) => s.identity)).toEqual([
			{ sourceKey: "bilibili", externalId: "1" },
			{ sourceKey: "douyin", externalId: "x" },
			{ sourceKey: "bilibili", externalId: "2" },
			{ sourceKey: "douyin", externalId: "y" },
		]);
	});

	it("没有文件 = 一条都没有;拓展订阅不再有自己的文件,开机也不会建它", async () => {
		const store = await open();
		expect(store.getSubscriptions()).toEqual([]);
		expect(await exists(join(stateDir, "extension-subscriptions.json"))).toBe(false);
	});

	it("盘上留着一份 extension-subscriptions.json 也不读它(它只是 0.x 的迁移输入)", async () => {
		const ext = makeExtensionSubscription();
		await writeFile(join(stateDir, "extension-subscriptions.json"), JSON.stringify([ext]), "utf8");
		const store = await open();
		expect(store.getSubscriptions()).toEqual([]);
	});

	it.each([
		[
			"一行坏的(外部 id 是空串)",
			[{ ...biliSub("1"), identity: { ...biliSub("1").identity, externalId: "" } }],
		],
		["不是数组", { not: "an array" }],
		["0.x 的老形状(身份在顶层 uid、没有 identity)", [legacyBiliRow(biliSub("1"))]],
		[
			"identity 里多一格",
			[{ ...biliSub("1"), identity: { ...biliSub("1").identity, extra: "x" } }],
		],
	])("订阅文件里有%s → 开机报错,不跳过", async (_label, content) => {
		await writeFile(subsFile, JSON.stringify(content), "utf8");
		await expect(open()).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it("好行后面跟一行坏的 → 整份拒,报错点名第几行", async () => {
		await writeFile(
			subsFile,
			JSON.stringify([
				biliSub("1"),
				{ ...biliSub("2"), identity: { sourceKey: "Bad!", externalId: "2" } },
			]),
			"utf8",
		);
		const err = await open().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConfigValidationError);
		expect((err as ConfigValidationError).message).toContain("第 2 行");
	});
});

describe("写:一个文件、一次原子写", () => {
	it("落盘的就是订阅本体:两格缩进、行里有 identity,没有 kind / uid / extensionId 这些老键", async () => {
		const store = await open();
		const sub = biliSub("42");
		await store.upsertSubscription(sub);
		expect(await readFile(subsFile, "utf8")).toBe(`${JSON.stringify([sub], null, 2)}\n`);
		const [row] = await rowsOnDisk();
		for (const key of ["kind", "uid", "extensionId"]) expect(row, key).not.toHaveProperty(key);
		expect(row).toHaveProperty("identity", { sourceKey: "bilibili", externalId: "42" });
	});

	it("B 站与拓展来源的订阅落同一个文件,顺序按写入;拓展那份不被建出来", async () => {
		const store = await open();
		const ext = makeExtensionSubscription();
		const bili = biliSub("7");
		await store.upsertSubscription(ext);
		await store.upsertSubscription(bili);
		// 谁先写谁在前 —— 不再有「B 站在前、拓展在后」的分区。
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([ext.id, bili.id]);
		expect((await rowsOnDisk()).map((r) => r.id)).toEqual([ext.id, bili.id]);
		expect(await exists(join(stateDir, "extension-subscriptions.json"))).toBe(false);
	});

	it("加 / 改 / 删各来源的订阅,每一步盘上就是内存里的那一份", async () => {
		const store = await open();
		const bili = biliSub("1");
		const ext = makeExtensionSubscription();

		await store.upsertSubscription(bili);
		await store.upsertSubscription(ext);
		expect(await rowsOnDisk()).toEqual([bili, ext]);

		await store.patchSubscription(ext.id, { enabled: false, notes: "抖音那位" });
		expect(await rowsOnDisk()).toEqual([bili, { ...ext, enabled: false, notes: "抖音那位" }]);

		await store.deleteSubscription(bili.id);
		expect(await rowsOnDisk()).toEqual([{ ...ext, enabled: false, notes: "抖音那位" }]);
		await store.deleteSubscription(ext.id);
		expect(await rowsOnDisk()).toEqual([]);
	});

	it("一个新 store 读回同样的一份", async () => {
		const store = await open();
		await store.upsertSubscription(makeExtensionSubscription());
		await store.upsertSubscription(biliSub("7"));
		const again = await open();
		expect(again.getSubscriptions()).toEqual(store.getSubscriptions());
	});

	it("写不下去 → 盘上与内存都停在原样,不留半新半旧", async () => {
		const store = await open();
		const before = biliSub("5");
		await store.upsertSubscription(before);
		const bytes = await readFile(subsFile, "utf8");
		// 原子写是先写临时文件再改名:把目标的位置换成一个非空目录,改名必炸。
		await rm(subsFile);
		await mkdir(join(subsFile, "blocker"), { recursive: true });

		await expect(store.upsertSubscription(makeExtensionSubscription())).rejects.toThrow();
		await expect(store.patchSubscription(before.id, { enabled: false })).rejects.toThrow();
		await expect(store.deleteSubscription(before.id)).rejects.toThrow();

		expect(store.getSubscriptions()).toEqual([before]);
		await rm(subsFile, { recursive: true });
		await writeFile(subsFile, bytes, "utf8");
		expect((await open()).getSubscriptions()).toEqual([before]);
	});
});

describe("拓展来源订阅的单人定时锐评(ADR-0020 决策 14)", () => {
	it("上一版写的行没有 roastSchedule → 读进来补出厂默认;改了它落进那一个文件,新 store 读得回来", async () => {
		// 上一版写出来的那种行:订阅上没有这一格。
		const { roastSchedule: _r, ...legacy } = makeExtensionSubscription({ id: randomUUID() });
		await writeFile(subsFile, JSON.stringify([legacy]), "utf8");
		const store = await open();
		const loaded = store.getSubscriptions()[0];
		expect(loaded?.identity.sourceKey).toBe("douyin");
		expect(loaded?.roastSchedule.enabled).toBe(false);

		const target = makeSessionTarget(randomUUID()).id;
		await store.patchSubscription(legacy.id, {
			roastSchedule: { enabled: true, cron: "0 9 * * 1", days: 14, targets: [target] },
		});
		const onDisk = (await rowsOnDisk())[0];
		expect(onDisk?.roastSchedule).toMatchObject({
			enabled: true,
			cron: "0 9 * * 1",
			days: 14,
			targets: [target],
		});
		const again = await open();
		expect(again.getSubscriptions()).toEqual(store.getSubscriptions());
	});
});

describe("身份改不动(ADR-0019 决策 50)", () => {
	let store: ConfigStore;
	let bili: Subscription;
	let ext: Subscription;

	beforeEach(async () => {
		store = await open();
		bili = biliSub("100");
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
		// 身份改不动是「请求不合规矩」(invalid),点名是 identity 的哪一格;不是「与状态冲突」。
		expect(err).toMatchObject({ code: "invalid", scope: "subscriptions" });
		expect((err as ConfigValidationError).issues).toEqual([
			{ path: ["identity", key], message: "身份格不许改" },
		]);
		expect((err as ConfigValidationError).message).toContain(`identity.${key}`);
	}

	it.each([
		["B 站换外部 id", "bili", { identity: { externalId: "200" } }, "externalId"],
		["B 站换成拓展来源", "bili", { identity: { sourceKey: "douyin" } }, "sourceKey"],
		["拓展换外部 id", "ext", { identity: { externalId: "sec-2" } }, "externalId"],
		["拓展换拓展", "ext", { identity: { sourceKey: "kuaishou" } }, "sourceKey"],
		["拓展换成 bilibili", "ext", { identity: { sourceKey: "bilibili" } }, "sourceKey"],
		[
			"两格一起换(先点名来源那格)",
			"bili",
			{ identity: { sourceKey: "douyin", externalId: "200" } },
			"sourceKey",
		],
	] as const)("patch:%s → 拒", async (_label, which, patch, key) => {
		const id = which === "bili" ? bili.id : ext.id;
		await expectIdentityRejected(store.patchSubscription(id, patch as never), key);
		expect(store.getSubscriptions()).toEqual([bili, ext]);
	});

	it("upsert 同一个 id:改来源 / 改外部 id → 拒", async () => {
		await expectIdentityRejected(
			store.upsertSubscription({ ...bili, identity: { ...bili.identity, externalId: "200" } }),
			"externalId",
		);
		await expectIdentityRejected(
			store.upsertSubscription({ ...ext, identity: { ...ext.identity, sourceKey: "kuaishou" } }),
			"sourceKey",
		);
		// 拿拓展的身份顶掉 B 站那一条的位置(同一个 id)也是换人。
		await expectIdentityRejected(store.upsertSubscription({ ...ext, id: bili.id }), "sourceKey");
		expect(store.getSubscriptions()).toEqual([bili, ext]);
	});

	it("身份两格原样送回来(面板整份 POST)不算改;别的字段照改", async () => {
		await store.upsertSubscription({ ...ext, enabled: false });
		await store.patchSubscription(bili.id, {
			identity: { sourceKey: "bilibili", externalId: "100" },
			notes: "改个备注",
		});
		expect(store.getSubscriptions()).toEqual([
			{ ...bili, notes: "改个备注" },
			{ ...ext, enabled: false },
		]);
		// 补丁里只送了一格、且与现有的一样,也不算改。
		await store.patchSubscription(ext.id, { identity: { externalId: "sec-1" }, notes: "同一个人" });
		expect(store.getSubscriptions()[1]).toEqual({ ...ext, enabled: false, notes: "同一个人" });
	});

	it("没送身份的补丁照常改别的字段;整条 upsert 缺 identity 则过不了 schema,盘上不变", async () => {
		await store.patchSubscription(bili.id, { groups: ["g"] });
		expect(store.getSubscriptions()[0]).toEqual({ ...bili, groups: ["g"] });

		const { identity: _identity, ...noIdentity } = bili;
		const err = await store.upsertSubscription(noIdentity as never).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConfigValidationError);
		expect((err as ConfigValidationError).issues?.[0]?.path).toEqual(["identity"]);
		expect(store.getSubscriptions()[0]).toEqual({ ...bili, groups: ["g"] });
	});

	it("补丁把 identity 整个清成 null → 拒,身份清不掉", async () => {
		const err = await store.patchSubscription(bili.id, { identity: null } as never).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConfigValidationError);
		expect(store.getSubscriptions()).toEqual([bili, ext]);
	});
});

describe("跨分区的级联对两种来源的行都覆盖", () => {
	it("删目标:拓展来源订阅里的引用一并清掉,落盘", async () => {
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

		const onDisk = (await rowsOnDisk()) as unknown as Subscription[];
		for (const sub of [store.getSubscriptions()[0], onDisk[0]]) {
			for (const k of FEATURE_KEYS) expect(sub?.routing[k]).toEqual([kept.id]);
			expect(sub?.extras.atAllDynamic).toEqual({ [kept.id]: false });
		}
	});

	it("删 webhook 连接:托管目标跟着走,两种来源订阅里的引用一并清掉", async () => {
		const store = await open();
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const managedId = store.getTargets()[0]?.id as string;
		const ext = makeExtensionSubscription();
		ext.routing.live = [managedId];
		const bili = biliSub("9");
		bili.routing.live = [managedId];
		await store.upsertSubscription(ext);
		await store.upsertSubscription(bili);

		await store.deleteConnection(connection.id);

		expect(store.getSubscriptions().map((s) => s.routing.live)).toEqual([[], []]);
		expect(((await rowsOnDisk()) as unknown as Subscription[]).map((s) => s.routing.live)).toEqual([
			[],
			[],
		]);
	});

	it("开机合并托管目标:两种来源订阅里的老 id 一并迁到托管 id", async () => {
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
		const bili = biliSub("9");
		bili.routing.dynamic = [extra.id];
		await writeFile(join(stateDir, "connections.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(stateDir, "targets.json"), JSON.stringify([primary, extra]), "utf8");
		await writeFile(subsFile, JSON.stringify([bili, ext]), "utf8");

		const store = await open();

		expect(store.getSubscriptions().map((s) => s.routing.dynamic)).toEqual([
			[primary.id],
			[primary.id],
		]);
		expect(
			((await rowsOnDisk()) as unknown as Subscription[]).map((s) => s.routing.dynamic),
		).toEqual([[primary.id], [primary.id]]);
	});
});

describe("恢复备份(整体替换)", () => {
	it("两种来源的订阅一次整体替换,落进同一个文件、顺序照给的", async () => {
		const store = await open();
		const bili = biliSub("5");
		const ext = makeExtensionSubscription();
		await store.replaceSections({ subscriptions: [ext, bili] });
		expect(store.getSubscriptions()).toEqual([ext, bili]);
		expect(await rowsOnDisk()).toEqual([ext, bili]);
		expect(await exists(join(stateDir, "extension-subscriptions.json"))).toBe(false);
	});

	it("订阅那一节给了空表 → 真清空;没给 → 一条不动", async () => {
		const store = await open();
		const bili = biliSub("5");
		const ext = makeExtensionSubscription();
		await store.upsertSubscription(bili);
		await store.upsertSubscription(ext);
		await store.replaceSections({ globals: store.getGlobals() });
		expect(store.getSubscriptions()).toEqual([bili, ext]);
		await store.replaceSections({ subscriptions: [] });
		expect(store.getSubscriptions()).toEqual([]);
		expect(await rowsOnDisk()).toEqual([]);
	});

	it("整体替换写到一半炸了:订阅那份推回原样,内存也不变", async () => {
		const store = await open();
		const before = biliSub("5");
		const ext = makeExtensionSubscription();
		await store.upsertSubscription(before);
		await store.upsertSubscription(ext);
		const bytes = await readFile(subsFile, "utf8");
		// globals 最后写:把它的位置换成一个非空目录,写它必炸。
		await rm(join(dataDir, ...CORE_SETTINGS_FILE));
		await mkdir(join(dataDir, ...CORE_SETTINGS_FILE, "blocker"), { recursive: true });

		await expect(
			store.replaceSections({
				globals: store.getGlobals(),
				subscriptions: [biliSub("6"), makeExtensionSubscription({ id: randomUUID() })],
			}),
		).rejects.toThrow();

		expect(await readFile(subsFile, "utf8")).toBe(bytes);
		expect(store.getSubscriptions()).toEqual([before, ext]);
	});

	it("整体替换(清空订阅)写到一半炸了:已有的行也推回原样", async () => {
		const ext = makeExtensionSubscription();
		const bytes = JSON.stringify([ext]);
		await writeFile(subsFile, bytes, "utf8");
		const store = await open();
		await rm(join(dataDir, ...CORE_SETTINGS_FILE));
		await mkdir(join(dataDir, ...CORE_SETTINGS_FILE, "blocker"), { recursive: true });

		await expect(
			store.replaceSections({ globals: store.getGlobals(), subscriptions: [] }),
		).rejects.toThrow();

		expect(await readFile(subsFile, "utf8")).toBe(bytes);
		expect(store.getSubscriptions()).toEqual([ext]);
	});
});

describe("按 UP 覆盖(ADR-0019 决策 64):拓展来源的订阅存得进、清得掉", () => {
	it("高级规则页给拓展来源订阅开的那几格照收;发 null 的那一格清掉,盘上也跟着没了", async () => {
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
		expect((await rowsOnDisk())[0]?.overrides).toEqual(kept);
	});
});
