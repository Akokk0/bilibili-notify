import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASTRBOT_ADAPTER_ID,
	ASTRBOT_PUSH_ADAPTER,
	ASTRBOT_PUSH_TARGET,
	ASTRBOT_TARGET_ID,
} from "./callback-sink.js";
import { createAstrBotConfigStore } from "./config-store.js";
import { createAstrBotSubscription } from "./persistence.js";
import { createSidecarMessageBus } from "./platform.js";

const tempDirs: string[] = [];

afterEach(async () => {
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
