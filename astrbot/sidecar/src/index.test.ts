import { describe, expect, it } from "vitest";
import { parseOptionalParentPid, parseSidecarLaunchOptions } from "./index.js";

describe("sidecar launch options", () => {
	it("rejects malformed parent pids", () => {
		expect(parseOptionalParentPid("1")).toBe(1);
		expect(parseOptionalParentPid("12345")).toBe(12_345);
		expect(parseOptionalParentPid("0")).toBeUndefined();
		expect(parseOptionalParentPid("123abc")).toBeUndefined();
		expect(parseOptionalParentPid(" 123")).toBeUndefined();
		expect(parseOptionalParentPid("9007199254740993")).toBeUndefined();
	});

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
