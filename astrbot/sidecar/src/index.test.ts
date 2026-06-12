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

	it("parses CLI and env overrides while keeping the host local-only", () => {
		const options = parseSidecarLaunchOptions(
			[
				"--host",
				"0.0.0.0",
				"--port",
				"27890",
				"--ready-file",
				"/tmp/ready.json",
				"--data-dir",
				"/tmp/data",
				"--ai-backend",
				"own",
				"--ai-provider-id",
				"astrbot-openai",
				"--log-level",
				"debug",
				"--version",
				"v0.1.0",
			],
			{
				BN_SIDECAR_HOST: "0.0.0.0",
				BN_SIDECAR_PORT: "19090",
				BN_SIDECAR_READY_FILE: "/tmp/env-ready.json",
				BN_SIDECAR_DATA_DIR: "/tmp/env-data",
				BN_SIDECAR_AI_BACKEND: "astrbot",
				BN_SIDECAR_AI_PROVIDER_ID: "env-provider",
				BN_SIDECAR_LOG_LEVEL: "info",
				BN_SIDECAR_TOKEN: "env-secret",
				BN_SIDECAR_VERSION: "v0.0.1",
			},
		);

		expect(options).toMatchObject({
			host: "127.0.0.1",
			port: 27_890,
			readyFile: "/tmp/ready.json",
			dataDir: "/tmp/data",
			aiBackend: "own",
			aiProviderId: "astrbot-openai",
			logLevel: "debug",
			authToken: "env-secret",
			version: "v0.1.0",
		});
	});

	it("refuses to read sensitive secrets from argv", () => {
		// token / cookie 加密 key 只能走 env；argv 传 --token 必须被 parseArgs 直接拒绝，
		// 否则密钥会经 ps / /proc 泄漏给本机任意用户。
		expect(() => parseSidecarLaunchOptions(["--token", "argv-secret"], {})).toThrow();
		expect(() => parseSidecarLaunchOptions(["--cookie-encryption-key", "argv-key"], {})).toThrow();
		const options = parseSidecarLaunchOptions([], {
			BN_SIDECAR_TOKEN: "env-only",
			BN_SIDECAR_COOKIE_ENCRYPTION_KEY: "env-key",
		});
		expect(options.authToken).toBe("env-only");
		expect(options.cookieEncryptionKey).toBe("env-key");
	});

	it("parses chromePath from --chrome-path flag and BN_SIDECAR_CHROME_PATH env (CLI 优先)", () => {
		const fromCli = parseSidecarLaunchOptions(["--chrome-path", "/cli/chrome"], {
			BN_SIDECAR_CHROME_PATH: "/env/chrome",
		});
		expect(fromCli.chromePath).toBe("/cli/chrome");

		const fromEnv = parseSidecarLaunchOptions([], { BN_SIDECAR_CHROME_PATH: "/env/chrome" });
		expect(fromEnv.chromePath).toBe("/env/chrome");

		const unset = parseSidecarLaunchOptions([], {});
		expect(unset.chromePath).toBeUndefined();
	});
});
