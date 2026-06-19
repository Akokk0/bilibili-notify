import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeUrl, createSidecarSnapshot, normalizeAiBackend } from "./state.js";

describe("sidecar state helpers", () => {
	it("normalizes ai backend values", () => {
		expect(normalizeAiBackend("astrbot")).toBe("astrbot");
		expect(normalizeAiBackend("own")).toBe("own");
		expect(normalizeAiBackend("disabled")).toBe("disabled");
		expect(normalizeAiBackend("unknown")).toBe("astrbot");
	});

	it("builds a runtime snapshot", () => {
		const snapshot = createSidecarSnapshot(
			{
				status: "ready",
				version: "0.0.0-dev",
				pid: 1234,
				host: "127.0.0.1",
				port: 19090,
				startedAt: "2026-06-03T00:00:00.000Z",
				readyAt: "2026-06-03T00:00:01.000Z",
				aiBackend: "astrbot",
				aiProviderId: "demo",
			},
			Date.parse("2026-06-03T00:00:05.000Z"),
		);

		expect(snapshot.url).toBe("http://127.0.0.1:19090");
		expect(snapshot.uptimeMs).toBe(5_000);
		expect(buildRuntimeUrl("127.0.0.1", 19090)).toBe("http://127.0.0.1:19090");
		expect(buildRuntimeUrl("0.0.0.0", 19090)).toBe("http://127.0.0.1:19090");
		expect(buildRuntimeUrl("::1", 19090)).toBe("http://[::1]:19090");
	});
});
