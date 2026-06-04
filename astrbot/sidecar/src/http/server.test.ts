import { afterEach, describe, expect, it } from "vitest";
import { createSidecarSnapshot } from "../runtime/state.js";
import { closeSidecarServer, createSidecarHttpServer, listenSidecarServer } from "./server.js";

describe("sidecar http server", () => {
	const servers: ReturnType<typeof createSidecarHttpServer>[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			const server = servers.pop();
			if (server) await closeSidecarServer(server);
		}
	});

	it("exposes health and root routes", async () => {
		const snapshot = createSidecarSnapshot({
			status: "ready",
			version: "0.0.0-dev",
			pid: 4321,
			host: "127.0.0.1",
			port: 0,
			startedAt: "2026-06-03T00:00:00.000Z",
			readyAt: "2026-06-03T00:00:01.000Z",
			aiBackend: "astrbot",
		});
		const server = createSidecarHttpServer(() => snapshot);
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const healthResponse = await fetch(`${baseUrl}/api/health`);
		expect(healthResponse.status).toBe(200);
		expect(await healthResponse.json()).toMatchObject({
			status: "ready",
			version: "0.0.0-dev",
			aiBackend: "astrbot",
		});

		const rootResponse = await fetch(baseUrl);
		expect(rootResponse.status).toBe(200);
		expect(await rootResponse.text()).toContain("bilibili-notify AstrBot sidecar");
	});
});
