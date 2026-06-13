import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASTRBOT_ADAPTER_ID,
	ASTRBOT_PUSH_ADAPTER,
	ASTRBOT_PUSH_TARGET,
	ASTRBOT_TARGET_ID,
} from "./callback-sink.js";
import { createAstrBotConfigStore } from "./config-store.js";
import { createAstrBotSubscription } from "./persistence.js";
import { createSidecarMessageBus } from "./platform.js";

const fsMock = vi.hoisted(() => ({
	readFileCalls: [] as unknown[][],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
			fsMock.readFileCalls.push(args);
			return actual.readFile(...args);
		}),
	};
});

const tempDirs: string[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	fsMock.readFileCalls.length = 0;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("createAstrBotConfigStore", () => {
	it("initializes canonical AstrBot state files", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });

		await store.load();

		expect(store.getGlobals()).toEqual(makeDefaultGlobalConfig());
		expect(store.getSubscriptions()).toEqual([]);
		expect(store.getAdapters()).toEqual([ASTRBOT_PUSH_ADAPTER]);
		expect(store.getTargets()).toEqual([]);
		expect(await readJson(join(dataDir, "state", "meta.json"))).toEqual({ version: 1 });
		expect(await readJson(join(dataDir, "state", "globals.json"))).toEqual(
			makeDefaultGlobalConfig(),
		);
		expect(await readJson(join(dataDir, "state", "subscriptions.json"))).toEqual([]);
		expect(await readJson(join(dataDir, "state", "adapters.json"))).toEqual([ASTRBOT_PUSH_ADAPTER]);
		expect(await readJson(join(dataDir, "state", "targets.json"))).toEqual([]);
	});

	it("coalesces concurrent load calls into one filesystem read", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		const metaPath = join(dataDir, "state", "meta.json");

		await Promise.all([store.load(), store.load()]);

		expect(fsMock.readFileCalls.filter(([path]) => String(path) === metaPath)).toHaveLength(1);
	});

	it("skips filesystem reads after load completes", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		fsMock.readFileCalls.length = 0;

		await store.load();

		expect(fsMock.readFileCalls).toEqual([]);
	});

	it("removes hidden fallback target state once a real AstrBot target exists", async () => {
		const dataDir = await makeTempDir();
		const stateDir = join(dataDir, "state");
		const realTarget = {
			id: "22222222-2222-4222-8222-222222222222",
			name: "真实目标",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: true,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:123456" },
		};
		const subscription = createAstrBotSubscription(
			{ uid: "123456", name: "测试 UP" },
			{ defaultTargetIds: [ASTRBOT_TARGET_ID, realTarget.id] },
		);
		await writeJson(join(stateDir, "targets.json"), [ASTRBOT_PUSH_TARGET, realTarget]);
		await writeJson(join(stateDir, "subscriptions.json"), [subscription]);
		const store = createAstrBotConfigStore({ dataDir });

		await store.load();

		expect(store.getTargets()).toEqual([realTarget]);
		expect(store.getSubscriptions()[0]?.routing.dynamic).toEqual([realTarget.id]);
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([realTarget.id]);
		expect(await readJson(join(stateDir, "targets.json"))).toEqual([realTarget]);
		expect(await readJson(join(stateDir, "subscriptions.json"))).toEqual([
			expect.objectContaining({
				routing: expect.objectContaining({ dynamic: [realTarget.id], live: [realTarget.id] }),
			}),
		]);
	});

	it("backfills never-routed subscriptions onto a newly added enabled target", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const subscription = createAstrBotSubscription({ uid: "123456", name: "测试 UP" });
		expect(subscription.routing.dynamic).toEqual([]);
		expect(subscription.routing.live).toEqual([]);
		await store.upsertSubscription(subscription);

		const target = await store.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "默认频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: true,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:123456" },
		});

		const defaults = makeDefaultGlobalConfig().defaults.features;
		const saved = store.getSubscriptions()[0];
		expect(saved?.routing.dynamic).toEqual(defaults.dynamic ? [target.id] : []);
		expect(saved?.routing.live).toEqual([target.id]);
		expect(saved?.routing.liveEnd).toEqual([target.id]);
		expect(saved?.routing.wordcloud).toEqual([target.id]);
		expect(saved?.routing.liveSummary).toEqual([target.id]);
		expect(saved?.routing.liveGuardBuy).toEqual([]);
		expect(saved?.routing.superchat).toEqual([]);
		expect(saved?.routing.specialDanmaku).toEqual([]);
		const persisted = (await readJson(join(dataDir, "state", "subscriptions.json"))) as Array<{
			routing: { live: string[] };
		}>;
		expect(persisted[0]?.routing.live).toEqual([target.id]);
	});

	it("leaves already-routed subscriptions untouched when another target is added", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const targetA = await store.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "频道 A",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: true,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:111" },
		});
		await store.upsertSubscription(
			createAstrBotSubscription(
				{ uid: "123456", name: "测试 UP" },
				{ defaultTargetIds: [targetA.id] },
			),
		);

		const targetB = await store.upsertTarget({
			id: "33333333-3333-4333-8333-333333333333",
			name: "频道 B",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: true,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:222" },
		});

		const saved = store.getSubscriptions()[0];
		expect(saved?.routing.dynamic).toEqual([targetA.id]);
		expect(saved?.routing.live).toEqual([targetA.id]);
		expect(saved?.routing.dynamic).not.toContain(targetB.id);
	});

	it("respects per-subscription overrides and skips disabled targets when backfilling", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const subscription = createAstrBotSubscription({
			uid: "123456",
			name: "测试 UP",
			dynamic: false,
		});
		expect(subscription.overrides.features).toEqual({ dynamic: false });
		await store.upsertSubscription(subscription);

		const disabled = await store.upsertTarget({
			id: "44444444-4444-4444-8444-444444444444",
			name: "停用频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: false,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:333" },
		});
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);
		expect(disabled.enabled).toBe(false);

		const target = await store.upsertTarget({
			id: "55555555-5555-4555-8555-555555555555",
			name: "启用频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: true,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:444" },
		});

		const saved = store.getSubscriptions()[0];
		expect(saved?.routing.dynamic).toEqual([]);
		expect(saved?.routing.live).toEqual([target.id]);
		expect(saved?.routing.liveEnd).toEqual([target.id]);
	});

	it("backfills never-routed subscriptions when a target is bound via pairing code", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const subscription = createAstrBotSubscription({ uid: "123456", name: "测试 UP" });
		expect(subscription.routing.live).toEqual([]);
		await store.upsertSubscription(subscription);

		const pairing = store.createPairingCode(1_000);
		const confirmed = await store.confirmPairingCode(
			pairing.code,
			{
				unified_msg_origin: "aiocqhttp:GroupMessage:123456",
				platform: "aiocqhttp",
				messageType: "GroupMessage",
				sessionId: "123456",
				sessionName: "测试群聊",
			},
			2_000,
		);

		const targetId = confirmed?.target.id;
		expect(targetId).toBeDefined();
		const defaults = makeDefaultGlobalConfig().defaults.features;
		const saved = store.getSubscriptions()[0];
		expect(saved?.routing.live).toEqual([targetId]);
		expect(saved?.routing.liveEnd).toEqual([targetId]);
		expect(saved?.routing.wordcloud).toEqual([targetId]);
		expect(saved?.routing.liveSummary).toEqual([targetId]);
		expect(saved?.routing.dynamic).toEqual(defaults.dynamic ? [targetId] : []);
		expect(saved?.routing.liveGuardBuy).toEqual([]);
		expect(saved?.routing.superchat).toEqual([]);
		const persisted = (await readJson(join(dataDir, "state", "subscriptions.json"))) as Array<{
			routing: { live: string[] };
		}>;
		expect(persisted[0]?.routing.live).toEqual([targetId]);
	});

	it("does not backfill on incidental writes to an already-enabled target", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const target = await store.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: true,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:1" },
		});
		await store.upsertSubscription(createAstrBotSubscription({ uid: "123456", name: "测试 UP" }));
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);

		// 模拟测试推送回写 / 重命名等无关写：对已启用 target 的非跃迁写不应回填路由。
		await store.upsertTarget({ ...target, name: "频道改名" });

		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);
		const persisted = (await readJson(join(dataDir, "state", "subscriptions.json"))) as Array<{
			routing: { live: string[] };
		}>;
		expect(persisted[0]?.routing.live).toEqual([]);
	});

	it("backfills when a disabled target transitions to enabled", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const target = await store.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "group",
			enabled: false,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:1" },
		});
		await store.upsertSubscription(createAstrBotSubscription({ uid: "123456", name: "测试 UP" }));
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);

		await store.upsertTarget({ ...target, enabled: true });

		expect(store.getSubscriptions()[0]?.routing.live).toEqual([target.id]);
		expect(store.getSubscriptions()[0]?.routing.liveEnd).toEqual([target.id]);
	});

	it("keeps a disabled target disabled and skips backfill when re-paired", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const firstCode = store.createPairingCode(1_000);
		const first = await store.confirmPairingCode(
			firstCode.code,
			{ unified_msg_origin: "aiocqhttp:GroupMessage:1", sessionName: "群" },
			2_000,
		);
		const targetId = first?.target.id ?? "";
		const created = store.getTargets().find((entry) => entry.id === targetId);
		expect(created).toBeDefined();
		if (created) await store.upsertTarget({ ...created, enabled: false });
		await store.upsertSubscription(createAstrBotSubscription({ uid: "123456", name: "测试 UP" }));
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);

		const secondCode = store.createPairingCode(3_000);
		const second = await store.confirmPairingCode(
			secondCode.code,
			{ unified_msg_origin: "aiocqhttp:GroupMessage:1", sessionName: "群" },
			4_000,
		);

		expect(second?.created).toBe(false);
		expect(second?.target.enabled).toBe(false);
		expect(store.getTargets().find((entry) => entry.id === targetId)?.enabled).toBe(false);
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([]);
	});

	it("migrates legacy root subscriptions while preserving the old file and writing a backup", async () => {
		const dataDir = await makeTempDir();
		const legacy = [createAstrBotSubscription({ uid: "123456", name: "测试 UP", dynamic: false })];
		await writeJson(join(dataDir, "subscriptions.json"), legacy);
		const store = createAstrBotConfigStore({ dataDir });

		await store.load();

		expect(store.getSubscriptions()).toEqual(legacy);
		expect(await readJson(join(dataDir, "subscriptions.json"))).toEqual(legacy);
		expect(await readJson(join(dataDir, "state", "backups", "subscriptions.legacy.json"))).toEqual(
			legacy,
		);
		expect(await readJson(join(dataDir, "state", "subscriptions.json"))).toEqual(legacy);
	});

	it("keeps the AstrBot adapter hidden and rejects non-AstrBot adapter files", async () => {
		const dataDir = await makeTempDir();
		const stateDir = join(dataDir, "state");
		await mkdir(stateDir, { recursive: true });
		await writeJson(join(stateDir, "adapters.json"), [
			{
				id: ASTRBOT_ADAPTER_ID,
				name: "wrong platform",
				platform: "onebot",
				enabled: true,
				config: { baseUrl: "http://127.0.0.1:5700" },
			},
		]);
		const store = createAstrBotConfigStore({ dataDir });

		await expect(store.load()).rejects.toMatchObject({ scope: "adapters" });
	});

	it("rejects targets that do not reference the hidden AstrBot adapter", async () => {
		const dataDir = await makeTempDir();
		const stateDir = join(dataDir, "state");
		await mkdir(stateDir, { recursive: true });
		await writeJson(join(stateDir, "targets.json"), [
			{
				id: ASTRBOT_TARGET_ID,
				name: "bad target",
				adapterId: "22222222-2222-4222-8222-222222222222",
				platform: "astrbot",
				scope: "group",
				enabled: true,
				session: { unified_msg_origin: "aiocqhttp:GroupMessage:123456" },
			},
		]);
		const store = createAstrBotConfigStore({ dataDir });

		await expect(store.load()).rejects.toMatchObject({ scope: "targets" });
	});

	it("persists subscription writes and emits config change events", async () => {
		const dataDir = await makeTempDir();
		const bus = createSidecarMessageBus();
		const changed: string[] = [];
		bus.on("config-changed", (scope) => changed.push(scope));
		const store = createAstrBotConfigStore({ dataDir, bus });
		await store.load();
		const subscription = createAstrBotSubscription({ uid: "2233", live: false });

		await store.upsertSubscription(subscription);
		const removed = await store.deleteSubscription(subscription.id);

		expect(removed).toEqual(subscription);
		expect(await readJson(join(dataDir, "state", "subscriptions.json"))).toEqual([]);
		expect(changed).toEqual(["subscriptions", "subscriptions"]);
	});

	it("creates one-time pairing codes and confirms AstrBot targets", async () => {
		const dataDir = await makeTempDir();
		const bus = createSidecarMessageBus();
		const changed: string[] = [];
		bus.on("config-changed", (scope) => changed.push(scope));
		const store = createAstrBotConfigStore({ dataDir, bus });
		await store.load();

		const pairing = store.createPairingCode(1_000);
		const confirmed = await store.confirmPairingCode(
			pairing.code.toLowerCase(),
			{
				unified_msg_origin: "aiocqhttp:GroupMessage:123456",
				platform: "aiocqhttp",
				messageType: "GroupMessage",
				sessionId: "123456",
				sessionName: "测试群聊",
			},
			2_000,
		);

		expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/);
		expect(pairing.expiresAt).toBe(new Date(601_000).toISOString());
		expect(confirmed).toMatchObject({
			created: true,
			target: {
				name: "测试群聊",
				adapterId: ASTRBOT_ADAPTER_ID,
				platform: "astrbot",
				scope: "group",
				enabled: true,
				session: {
					unified_msg_origin: "aiocqhttp:GroupMessage:123456",
				},
			},
		});
		expect(await readJson(join(dataDir, "state", "targets.json"))).toEqual([
			expect.objectContaining({ id: confirmed?.target.id, name: "测试群聊" }),
		]);
		expect(await store.confirmPairingCode(pairing.code, { unified_msg_origin: "another" })).toBe(
			undefined,
		);
		expect(changed).toEqual(["targets"]);
	});

	it("expires pairing codes and updates existing targets for the same session", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();

		const expired = store.createPairingCode(1_000);
		expect(
			await store.confirmPairingCode(
				expired.code,
				{ unified_msg_origin: "aiocqhttp:GroupMessage:expired" },
				601_001,
			),
		).toBeUndefined();

		const active = store.createPairingCode(2_000);
		const first = await store.confirmPairingCode(
			active.code,
			{
				unified_msg_origin: "aiocqhttp:FriendMessage:42",
				messageType: "private",
				sessionName: "旧名称",
			},
			3_000,
		);
		const secondCode = store.createPairingCode(4_000);
		const second = await store.confirmPairingCode(
			secondCode.code,
			{
				unified_msg_origin: "aiocqhttp:FriendMessage:42",
				messageType: "private",
				sessionName: "新名称",
			},
			5_000,
		);

		expect(first?.created).toBe(true);
		expect(second?.created).toBe(false);
		expect(second?.target.id).toBe(first?.target.id);
		expect(second?.target.name).toBe("旧名称");
		expect(second?.target.session.sessionName).toBe("新名称");
		expect(second?.target.scope).toBe("private");
		expect(store.getTargets()).toHaveLength(1);
	});

	it("serializes concurrent subscription writes without losing updates", async () => {
		const dataDir = await makeTempDir();
		const store = createAstrBotConfigStore({ dataDir });
		await store.load();
		const first = createAstrBotSubscription({ uid: "1001" });
		const second = createAstrBotSubscription({ uid: "1002" });

		await Promise.all([store.upsertSubscription(first), store.upsertSubscription(second)]);

		expect(store.getSubscriptions()).toEqual([first, second]);
		expect(await readJson(join(dataDir, "state", "subscriptions.json"))).toEqual([first, second]);
	});
});

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bn-astrbot-config-"));
	tempDirs.push(dir);
	return dir;
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
