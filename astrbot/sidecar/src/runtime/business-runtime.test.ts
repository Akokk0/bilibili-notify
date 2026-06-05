import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
	class BilibiliPush {
		start = vi.fn();
		stop = vi.fn();
		sendPrivateMsg = vi.fn(async () => undefined);
		sendErrorMsg = vi.fn(async () => undefined);
		broadcastToFeature = vi.fn(async () => []);

		constructor() {
			instances.push(this);
		}
	}
	return { BilibiliPush, instances };
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
	pushMock.instances.length = 0;
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
});
