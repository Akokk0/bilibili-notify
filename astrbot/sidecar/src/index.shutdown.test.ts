import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
	const callOrder: string[] = [];
	let removeCalls = 0;
	return {
		callOrder,
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
		createSidecarHttpServer: vi.fn(() => ({}) as never),
		listenSidecarServer: vi.fn(async () => ({ host: "127.0.0.1", port: 19_090 })),
		closeSidecarServer: vi.fn(async () => {
			callOrder.push("close");
		}),
	};
});

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
		expect(fixture.callOrder).toEqual(["close", "remove"]);
	});

	it("aborts startup cleanly when readiness is interrupted", async () => {
		const controller = new AbortController();
		let resolveListen!: (value: { host: string; port: number }) => void;
		fixture.closeSidecarServer.mockClear();
		fixture.writeReadyFile.mockClear();
		fixture.removeReadyFile.mockImplementation(async () => undefined);
		fixture.listenSidecarServer.mockImplementationOnce(
			async () =>
				new Promise<{ host: string; port: number }>((resolve) => {
					resolveListen = resolve;
				}),
		);

		const runtimePromise = startSidecar({ readyFile: "ready.json", signal: controller.signal });
		await Promise.resolve();
		controller.abort("SIGTERM");
		resolveListen({ host: "127.0.0.1", port: 19_090 });

		await expect(runtimePromise).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.closeSidecarServer).toHaveBeenCalled();
		expect(fixture.writeReadyFile).not.toHaveBeenCalled();
	});
});
