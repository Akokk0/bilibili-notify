import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASTRBOT_ADAPTER_ID, ASTRBOT_TARGET_ID } from "./callback-sink.js";
import { createAstrBotSubscription } from "./persistence.js";

const authMock = vi.hoisted(() => {
	const state = {
		apiInstances: [] as object[],
		flowInstances: [] as object[],
		reportStarted: undefined as (() => void) | undefined,
		reportRelease: Promise.resolve(),
	};
	class BilibiliAPI {
		start = vi.fn(async () => undefined);
		loadCookies = vi.fn(async () => undefined);
		stop = vi.fn();
		setUserAgent = vi.fn();

		constructor() {
			state.apiInstances.push(this);
		}
	}
	class LoginFlow {
		start = vi.fn(async () => undefined);
		reportAccountInfo = vi.fn(async () => {
			state.reportStarted?.();
			await state.reportRelease;
		});
		beginLogin = vi.fn(async () => undefined);
		current = vi.fn(() => ({ status: 0, msg: "未登录" }));
		stop = vi.fn();
		setHealthCheckMs = vi.fn();

		constructor() {
			state.flowInstances.push(this);
		}
	}
	return Object.assign(state, { BilibiliAPI, LoginFlow });
});

const pushMock = vi.hoisted(() => {
	const instances: object[] = [];
	const options: unknown[] = [];
	class BilibiliPush {
		start = vi.fn();
		stop = vi.fn();
		sendToTarget = vi.fn(async () => ({ ok: true, latencyMs: 7 }));
		sendPrivateMsg = vi.fn(async () => undefined);
		sendErrorMsg = vi.fn(async () => undefined);
		broadcastToFeature = vi.fn(async () => []);

		constructor(opts: unknown) {
			instances.push(this);
			options.push(opts);
		}
	}
	return { BilibiliPush, instances, options };
});

const storageMock = vi.hoisted(() => {
	const instances: object[] = [];
	class StorageManager {
		cookieStore = {
			load: vi.fn(async () => undefined),
			save: vi.fn(async () => undefined),
		};
		init = vi.fn(async () => undefined);

		constructor() {
			instances.push(this);
		}
	}
	return { StorageManager, instances };
});

const enginesMock = vi.hoisted(() => {
	const createSidecarEngines = vi.fn(() => ({
		dynamic: {},
		live: {},
		start: vi.fn(),
		updateGlobals: vi.fn(),
		dispose: vi.fn(),
		status: () => ({ dynamic: true, live: false }),
	}));
	return { createSidecarEngines };
});

vi.mock("@bilibili-notify/api", () => ({
	BilibiliAPI: authMock.BilibiliAPI,
	LoginFlow: authMock.LoginFlow,
}));

vi.mock("@bilibili-notify/push", () => ({
	BilibiliPush: pushMock.BilibiliPush,
}));

vi.mock("@bilibili-notify/storage", () => ({
	StorageManager: storageMock.StorageManager,
}));

vi.mock("./engines.js", () => ({
	createSidecarEngines: enginesMock.createSidecarEngines,
}));

const { createBusinessRuntime } = await import("./business-runtime.js");

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
	authMock.apiInstances.length = 0;
	authMock.flowInstances.length = 0;
	authMock.reportStarted = undefined;
	authMock.reportRelease = Promise.resolve();
	pushMock.instances.length = 0;
	pushMock.options.length = 0;
	storageMock.instances.length = 0;
	enginesMock.createSidecarEngines.mockClear();
});

describe("createBusinessRuntime", () => {
	it("does not resurrect engines when auth startup finishes after close", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const reportStarted = new Promise<void>((resolve) => {
			authMock.reportStarted = resolve;
		});
		let releaseReport!: () => void;
		authMock.reportRelease = new Promise<void>((resolve) => {
			releaseReport = resolve;
		});
		const runtime = createBusinessRuntime({ dataDir });

		const startPromise = runtime.start();
		await reportStarted;
		await runtime.close("test close during auth startup");
		releaseReport();

		await expect(startPromise).rejects.toMatchObject({ name: "AbortError" });
		expect(enginesMock.createSidecarEngines).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toMatchObject({
			started: false,
			authStarted: false,
			engines: { dynamic: false, live: false },
		});
	});

	it("coalesces concurrent startBase work through public startup", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		const loadSpy = vi.spyOn(runtime.configStore, "load");

		await Promise.all([runtime.ensureAuthStarted(), runtime.ensureAuthStarted()]);

		const storage = storageMock.instances[0] as { init: ReturnType<typeof vi.fn> };
		expect(storage.init).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledTimes(1);
		await runtime.close("test done");
	});

	it("loads subscriptions from the AstrBot config store before engines start", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const subscription = createAstrBotSubscription({ uid: "123456", name: "测试 UP" });
		await writeJson(join(dataDir, "state", "subscriptions.json"), [subscription]);
		const runtime = createBusinessRuntime({ dataDir });

		await runtime.start();

		expect(runtime.listSubscriptions()).toEqual([subscription]);
		expect(runtime.snapshot()).toMatchObject({
			subscriptions: { count: 1, path: join(dataDir, "state", "subscriptions.json") },
			config: {
				version: 1,
				stateDir: join(dataDir, "state"),
			},
		});
		expect(enginesMock.createSidecarEngines).toHaveBeenCalledTimes(1);
		await runtime.close("test done");
	});

	it("provides current globals defaults to BilibiliPush", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const globals = makeDefaultGlobalConfig();
		globals.defaults.features.dynamic = false;
		await runtime.configStore.setGlobals(globals);
		const options = pushMock.options[0] as { defaults: () => typeof globals.defaults };

		expect(options.defaults().features.dynamic).toBe(false);
		await runtime.close("test done");
	});

	it("uses current AstrBot targets for new minimal subscription defaults and preserves route patches", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const target = await runtime.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "默认频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "channel",
			enabled: true,
			session: {
				unified_msg_origin: "astrbot://room-1",
				platform: "astrbot",
				messageType: "channel",
				sessionName: "Room 1",
			},
		});

		const subscription = await runtime.upsertSubscription({ uid: "123456", name: "测试 UP" });
		const patched = await runtime.patchSubscription(subscription.id, {
			routing: { ...subscription.routing, dynamic: [], live: [target.id], liveEnd: [target.id] },
		});

		expect(subscription.overrides).toEqual({});
		expect(subscription.routing.dynamic).toEqual([target.id]);
		expect(subscription.routing.live).toEqual([target.id]);
		expect(subscription.routing.liveEnd).toEqual([target.id]);
		expect(subscription.routing.wordcloud).toEqual([target.id]);
		expect(subscription.routing.liveSummary).toEqual([target.id]);
		expect(subscription.routing.liveGuardBuy).toEqual([]);
		expect(patched.routing.dynamic).toEqual([]);
		expect(patched.routing.live).toEqual([target.id]);
		expect(runtime.listSubscriptions()[0]?.routing.dynamic).toEqual([]);
		await runtime.close("test done");
	});

	it("uses current global feature defaults without creating subscription overrides", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const globals = makeDefaultGlobalConfig();
		globals.defaults.features.dynamic = false;
		globals.defaults.features.superchat = true;
		await runtime.configStore.setGlobals(globals);
		const target = await runtime.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "默认频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "channel",
			enabled: true,
			session: {
				unified_msg_origin: "astrbot://room-1",
				platform: "astrbot",
				messageType: "channel",
				sessionName: "Room 1",
			},
		});

		const subscription = await runtime.upsertSubscription({ uid: "123456", name: "测试 UP" });

		expect(subscription.overrides).toEqual({});
		expect(subscription.routing.dynamic).toEqual([]);
		expect(subscription.routing.superchat).toEqual([target.id]);
		expect(subscription.routing.live).toEqual([target.id]);
		await runtime.close("test done");
	});

	it("replaces subscription overrides so disabled sections stay disabled after save", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const subscription = await runtime.upsertSubscription({
			uid: "123456",
			name: "测试 UP",
			dynamic: false,
		});

		const patched = await runtime.patchSubscription(subscription.id, { overrides: {} });

		expect(subscription.overrides.features).toEqual({ dynamic: false });
		expect(patched.overrides).toEqual({});
		expect(runtime.listSubscriptions()[0]?.overrides).toEqual({});
		await runtime.close("test done");
	});

	it("keeps resource ids stable when patch bodies contain another id", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const subscription = await runtime.upsertSubscription(
			createAstrBotSubscription({ uid: "123456", name: "测试 UP" }),
		);
		const target = await runtime.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "默认频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "channel",
			enabled: true,
			session: {
				unified_msg_origin: "astrbot://room-1",
				platform: "astrbot",
				messageType: "channel",
				sessionName: "Room 1",
			},
		});

		expect(
			await runtime.patchSubscription(subscription.id, { id: "other-sub", notes: "备注" }),
		).toMatchObject({
			id: subscription.id,
			notes: "备注",
		});
		expect(
			await runtime.patchTarget(target.id, { id: "other-target", name: "频道 2" }),
		).toMatchObject({
			id: target.id,
			name: "频道 2",
		});
		expect(runtime.listSubscriptions()).toHaveLength(1);
		expect(runtime.listTargets()).toHaveLength(1);
		await runtime.close("test done");
	});

	it("prunes atAll entries outside patched dynamic routing without mutating the stored subscription", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const targetA = "22222222-2222-4222-8222-222222222222";
		const targetB = "33333333-3333-4333-8333-333333333333";
		const base = createAstrBotSubscription(
			{ uid: "123456", name: "测试 UP" },
			{ defaultTargetIds: [targetA, targetB] },
		);
		const subscription = await runtime.upsertSubscription({
			...base,
			routing: { ...base.routing, dynamic: [targetA, targetB] },
			atAll: { dynamic: { [targetA]: true, [targetB]: false }, live: {} },
		});
		const storedBefore = runtime.listSubscriptions()[0];

		const patched = await runtime.patchSubscription(subscription.id, {
			routing: { dynamic: [targetA] },
		});

		expect(patched.routing.dynamic).toEqual([targetA]);
		expect(patched.atAll.dynamic).toEqual({ [targetA]: true });
		expect(runtime.listSubscriptions()[0]?.atAll.dynamic).toEqual({ [targetA]: true });
		expect(storedBefore?.atAll.dynamic).toEqual({ [targetA]: true, [targetB]: false });
		await runtime.close("test done");
	});

	it("rejects pushTest for the hidden AstrBot fallback target", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();

		const result = await runtime.pushTest(ASTRBOT_TARGET_ID, { kind: "text", text: "hello" });

		expect(result).toMatchObject({ ok: false, err: "target not found" });
		expect(runtime.listTargets()).toEqual([]);
		await runtime.close("test done");
	});

	it("pushTest sends to an enabled target and writes testStatus", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const target = await runtime.upsertTarget({
			id: "22222222-2222-4222-8222-222222222222",
			name: "默认频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "channel",
			enabled: true,
			session: {
				unified_msg_origin: "astrbot://room-1",
				platform: "astrbot",
				messageType: "channel",
				sessionName: "Room 1",
			},
		});

		const result = await runtime.pushTest(target.id, { kind: "text", text: "hello" });

		expect(result).toEqual({ ok: true, latencyMs: 7 });
		expect(runtime.listTargets()[0]).toMatchObject({
			id: target.id,
			testStatus: { ok: true, latencyMs: 7 },
		});
		expect(runtime.listTargets()[0]?.testStatus?.lastCheckedAt).toEqual(expect.any(String));
		await runtime.close("test done");
	});

	it("pushTest rejects disabled targets", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-astrbot-runtime-"));
		tempDirs.push(dataDir);
		const runtime = createBusinessRuntime({ dataDir });
		await runtime.configStore.load();
		const target = await runtime.upsertTarget({
			id: "33333333-3333-4333-8333-333333333333",
			name: "停用频道",
			adapterId: ASTRBOT_ADAPTER_ID,
			platform: "astrbot",
			scope: "channel",
			enabled: false,
			session: {
				unified_msg_origin: "astrbot://room-disabled",
				platform: "astrbot",
				messageType: "channel",
				sessionName: "Disabled Room",
			},
		});

		const result = await runtime.pushTest(target.id, { kind: "text", text: "hello" });

		expect(result).toMatchObject({ ok: false, err: "target disabled" });
		expect(runtime.listTargets()[0]?.testStatus).toBeUndefined();
		await runtime.close("test done");
	});
});

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
