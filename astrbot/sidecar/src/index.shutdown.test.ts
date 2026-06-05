import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
	const callOrder: string[] = [];
	let removeCalls = 0;
	const runtimeSnapshot = {
		started: true,
		authStarted: true,
		engines: { dynamic: true, live: true },
		subscriptions: { count: 2, path: "/tmp/astrbot/subscriptions.json" },
		events: { nextId: 4, size: 3 },
		login: { status: 5, msg: "已登录" },
	};
	const runtime = {
		start: vi.fn(async () => undefined),
		close: vi.fn(async (reason?: string) => {
			callOrder.push(`runtime:${reason ?? "shutdown"}`);
		}),
		snapshot: vi.fn(() => runtimeSnapshot),
		ensureAuthStarted: vi.fn(async () => runtimeSnapshot.login),
		refreshLoginStatus: vi.fn(async () => runtimeSnapshot.login),
		beginLogin: vi.fn(async () => runtimeSnapshot.login),
		listSubscriptions: vi.fn(() => []),
		upsertSubscription: vi.fn(async () => ({}) as never),
		removeSubscription: vi.fn(async () => undefined),
		drainEvents: vi.fn(() => []),
	};
	return {
		callOrder,
		runtime,
		runtimeSnapshot,
		createBusinessRuntime: vi.fn(() => runtime),
		removeReadyFile: vi.fn(async () => {
			callOrder.push("remove");
			removeCalls += 1;
			if (removeCalls === 2) {
				throw new Error("ready file removal failed");
			}
		}),
		writeReadyFile: vi.fn(async () => undefined),
		readReadyFile: vi.fn(async () => {
			throw new Error("unexpected read");
		}),
		createSidecarHttpServer: vi.fn(
			(_options: Parameters<typeof import("./http/server.js").createSidecarHttpServer>[0]) => {
				return {} as never;
			},
		),
		listenSidecarServer: vi.fn(async () => ({ host: "127.0.0.1", port: 19_090 })),
		closeSidecarServer: vi.fn(async () => {
			callOrder.push("close");
		}),
	};
});

vi.mock("./runtime/business-runtime.js", () => ({
	createBusinessRuntime: fixture.createBusinessRuntime,
}));

vi.mock("./runtime/ready-file.js", () => ({
	removeReadyFile: fixture.removeReadyFile,
	writeReadyFile: fixture.writeReadyFile,
	readReadyFile: fixture.readReadyFile,
}));

vi.mock("./http/server.js", () => ({
	createSidecarHttpServer: fixture.createSidecarHttpServer,
	listenSidecarServer: fixture.listenSidecarServer,
	closeSidecarServer: fixture.closeSidecarServer,
}));

const { startSidecar } = await import("./index.js");

describe("sidecar shutdown cleanup", () => {
	it("keeps closing the server even when ready file cleanup fails", async () => {
		const runtime = await startSidecar({ readyFile: "ready.json" });
		fixture.callOrder.length = 0;

		await expect(runtime.close("test shutdown")).resolves.toBeUndefined();
		expect(fixture.callOrder).toEqual(["close", "runtime:test shutdown", "remove"]);
		expect(fixture.runtime.close).toHaveBeenCalledWith("test shutdown");
	});

	it("exposes the business snapshot through the HTTP snapshot provider", async () => {
		fixture.createSidecarHttpServer.mockClear();
		fixture.writeReadyFile.mockClear();
		fixture.removeReadyFile.mockImplementation(async () => undefined);

		const runtime = await startSidecar({ readyFile: "ready.json" });
		const options = fixture.createSidecarHttpServer.mock.calls[0]?.[0];

		expect(options).toBeDefined();
		expect(options?.getSnapshot()).toMatchObject({
			status: "ready",
			business: fixture.runtimeSnapshot,
		});
		expect(fixture.writeReadyFile).toHaveBeenCalled();
		await runtime.close("snapshot test");
	});

	it("aborts startup cleanly when readiness is interrupted", async () => {
		const controller = new AbortController();
		let resolveListen!: (value: { host: string; port: number }) => void;
		const listenReady = new Promise<void>((resolve) => {
			fixture.listenSidecarServer.mockImplementationOnce(
				async () =>
					new Promise<{ host: string; port: number }>((listenResolve) => {
						resolveListen = listenResolve;
						resolve();
					}),
			);
		});
		fixture.closeSidecarServer.mockClear();
		fixture.writeReadyFile.mockClear();
		fixture.removeReadyFile.mockImplementation(async () => undefined);

		const runtimePromise = startSidecar({ readyFile: "ready.json", signal: controller.signal });
		await listenReady;
		controller.abort("SIGTERM");
		resolveListen({ host: "127.0.0.1", port: 19_090 });

		await expect(runtimePromise).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.closeSidecarServer).toHaveBeenCalled();
		expect(fixture.writeReadyFile).not.toHaveBeenCalled();
	});

	it("closes runtime while server drain is still pending", async () => {
		let releaseServerClose!: () => void;
		const serverCloseStarted = new Promise<void>((resolve) => {
			fixture.closeSidecarServer.mockImplementationOnce(async () => {
				fixture.callOrder.push("close:start");
				resolve();
				await new Promise<void>((release) => {
					releaseServerClose = release;
				});
				fixture.callOrder.push("close:end");
			});
		});
		fixture.callOrder.length = 0;
		fixture.writeReadyFile.mockClear();
		fixture.removeReadyFile.mockImplementation(async () => {
			fixture.callOrder.push("remove");
		});

		const runtime = await startSidecar({ readyFile: "ready.json" });
		fixture.callOrder.length = 0;
		const closePromise = runtime.close("drain test");
		await serverCloseStarted;

		expect(fixture.callOrder).toEqual(["close:start", "runtime:drain test"]);
		releaseServerClose();
		await expect(closePromise).resolves.toBeUndefined();
		expect(fixture.callOrder).toEqual(["close:start", "runtime:drain test", "close:end", "remove"]);
	});

	it("stops startup immediately when runtime startup is aborted", async () => {
		const controller = new AbortController();
		const startReady = new Promise<void>((resolve) => {
			fixture.runtime.start.mockImplementationOnce(async () => {
				resolve();
				return new Promise<undefined>(() => undefined);
			});
		});
		fixture.closeSidecarServer.mockClear();
		fixture.writeReadyFile.mockClear();
		fixture.removeReadyFile.mockImplementation(async () => undefined);

		const runtimePromise = startSidecar({ readyFile: "ready.json", signal: controller.signal });
		await startReady;
		controller.abort("SIGTERM");

		await expect(runtimePromise).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.closeSidecarServer).toHaveBeenCalled();
		expect(fixture.writeReadyFile).not.toHaveBeenCalled();
	});
});
