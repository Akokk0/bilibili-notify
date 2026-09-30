import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { StorageManager } from "../index";

function makeFakeServiceCtx(): ServiceContext {
	const logger: Logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
	return {
		logger,
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: () => undefined,
		signal: new AbortController().signal,
		track: () => {},
	};
}

describe("StorageManager — 文件位置", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-storage-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("主密钥与 cookie 落在调用方给的位置,不另开目录", async () => {
		const keyPath = join(dataDir, "secrets", "master.key");
		const cookiePath = join(dataDir, "secrets", "cookies.json");
		const sm = new StorageManager({
			serviceCtx: makeFakeServiceCtx(),
			paths: { keyPath, cookiePath, saltPath: join(dataDir, "secrets", "kdf.salt") },
		});
		await sm.init();
		expect(await readFile(keyPath, "utf8")).toMatch(/^[0-9a-f]{64}$/i);

		await sm.cookieStore.save({ cookiesJson: '[{"k":"v"}]' });
		expect((await stat(cookiePath)).isFile()).toBe(true);
		expect(await readdir(dataDir)).toEqual(["secrets"]);
	});
});
