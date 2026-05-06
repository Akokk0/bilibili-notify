import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	};
}

describe("StorageManager paths option", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-storage-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("defaults to <dataDir>/bilibili-notify/{master.key,cookies.json}", async () => {
		const sm = new StorageManager({ serviceCtx: makeFakeServiceCtx(), dataDir });
		await sm.init();

		// init() loads or creates the master key — verify it landed at the default path.
		const defaultKey = join(dataDir, "bilibili-notify", "master.key");
		const keyContent = await readFile(defaultKey, "utf8");
		expect(keyContent).toMatch(/^[0-9a-f]{64}$/i);

		// Save a cookie payload to confirm cookiePath default also resolves correctly.
		await sm.cookieStore.save({ cookiesJson: "[]" });
		const defaultCookies = join(dataDir, "bilibili-notify", "cookies.json");
		const stats = await stat(defaultCookies);
		expect(stats.isFile()).toBe(true);
	});

	it("paths.keyPath override actually writes to the requested location", async () => {
		const customKey = join(dataDir, "secrets", "master.key");
		const customCookie = join(dataDir, "secrets", "cookies.json");
		const sm = new StorageManager({
			serviceCtx: makeFakeServiceCtx(),
			dataDir,
			paths: { keyPath: customKey, cookiePath: customCookie },
		});
		await sm.init();

		// Custom location must contain a valid 32-byte hex key.
		const keyContent = await readFile(customKey, "utf8");
		expect(keyContent).toMatch(/^[0-9a-f]{64}$/i);

		// Default location must NOT have been created.
		await expect(stat(join(dataDir, "bilibili-notify", "master.key"))).rejects.toThrow();

		// Cookie path override is honoured on save.
		await sm.cookieStore.save({ cookiesJson: '[{"k":"v"}]' });
		const customCookieStat = await stat(customCookie);
		expect(customCookieStat.isFile()).toBe(true);
	});

	it("partial paths override (only cookiePath) leaves keyPath at default", async () => {
		const customCookie = join(dataDir, "elsewhere", "c.json");
		const sm = new StorageManager({
			serviceCtx: makeFakeServiceCtx(),
			dataDir,
			paths: { cookiePath: customCookie },
		});
		await sm.init();

		// Default key path was used.
		const defaultKey = join(dataDir, "bilibili-notify", "master.key");
		const keyContent = await readFile(defaultKey, "utf8");
		expect(keyContent).toMatch(/^[0-9a-f]{64}$/i);

		// Custom cookie path is used on save.
		await sm.cookieStore.save({ cookiesJson: "[]" });
		const stats = await stat(customCookie);
		expect(stats.isFile()).toBe(true);
	});
});
