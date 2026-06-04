import { describe, expect, it } from "vitest";
import { parseSidecarLaunchOptions } from "./index.js";

describe("sidecar launch options", () => {
	it("parses CLI and env overrides", () => {
		const options = parseSidecarLaunchOptions(
			[
				"--host",
				"0.0.0.0",
				"--port",
				"27890",
				"--ready-file",
				"/tmp/ready.json",
				"--ai-backend",
				"own",
				"--ai-provider-id",
				"astrbot-openai",
				"--version",
				"v0.1.0",
			],
			{
				BN_SIDECAR_HOST: "127.0.0.1",
				BN_SIDECAR_PORT: "19090",
				BN_SIDECAR_READY_FILE: "/tmp/env-ready.json",
				BN_SIDECAR_AI_BACKEND: "astrbot",
				BN_SIDECAR_AI_PROVIDER_ID: "env-provider",
				BN_SIDECAR_VERSION: "v0.0.1",
			},
		);

		expect(options).toEqual({
			host: "0.0.0.0",
			port: 27_890,
			readyFile: "/tmp/ready.json",
			aiBackend: "own",
			aiProviderId: "astrbot-openai",
			version: "v0.1.0",
		});
	});
});
