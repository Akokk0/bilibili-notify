import { describe, expect, it, vi } from "vite-plus/test";
import { buildStorageManagerOptions } from "../bootstrap-helpers";

describe("buildStorageManagerOptions", () => {
	const serviceCtx = {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	} as never;

	it("把 config.cookieEncryptionKey 透传为注入加密口令(启用真加密)", () => {
		const opts = buildStorageManagerOptions(serviceCtx, "/data", {
			cookieEncryptionKey: "s3cret-pass",
		});

		expect(opts).toEqual({
			serviceCtx,
			dataDir: "/data",
			encryptionKey: "s3cret-pass",
		});
	});

	it("未设置口令时 encryptionKey 为 undefined(回退随机密钥)", () => {
		const opts = buildStorageManagerOptions(serviceCtx, "/data", {});

		expect(opts.encryptionKey).toBeUndefined();
	});
});
