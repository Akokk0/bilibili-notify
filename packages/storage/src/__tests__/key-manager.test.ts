/**
 * 回归守护 — P0-A:KeyManager.loadOrCreate() 必须 ENOENT-discriminate。
 *
 * 关键不变量:盘上存在 master.key 但读失败(EACCES/EIO/EBUSY/EISDIR…非 ENOENT)
 * 时,**绝不能**静默 createNew() —— 那会以原子 rename 覆盖旧 key,使所有已 GCM
 * 加密的 cookie / AI apiKey 永久不可解密(数据销毁)。与 key-provider.ts 的
 * salt loader 同策略。
 *
 * 复发点:任何人把 loadOrCreate 的错误处理改回裸 `catch { createNew() }`,
 * 「非缺失读错 → rethrow 不重生成」这条立刻挂。
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyManager } from "../key-manager";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-keymgr-"));
});
const keyPath = () => join(dir, "secrets", "master.key");

describe("KeyManager.loadOrCreate — ENOENT-discriminate (P0-A)", () => {
	it("ENOENT(首次运行,无文件)→ 生成新 key 并落盘 64 hex", async () => {
		const logger = makeLogger();
		const km = new KeyManager(keyPath(), logger);
		const k = await km.loadOrCreate();
		expect(k.length).toBe(32);
		await expect(readFile(keyPath(), "utf8")).resolves.toMatch(/^[0-9a-f]{64}$/i);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("已有合法 64 hex → 原样加载,不 warn 不 error 不重写", async () => {
		const valid = "a".repeat(64);
		await mkdir(join(dir, "secrets"), { recursive: true });
		await writeFile(keyPath(), valid, "utf8");
		const logger = makeLogger();
		const km = new KeyManager(keyPath(), logger);
		const k = await km.loadOrCreate();
		expect(k.equals(Buffer.from(valid, "hex"))).toBe(true);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
		await expect(readFile(keyPath(), "utf8")).resolves.toBe(valid);
	});

	it("已有但格式非法 → warn + 重生成(损坏 key 本就不可解密,重生成是唯一恢复)", async () => {
		await mkdir(join(dir, "secrets"), { recursive: true });
		await writeFile(keyPath(), "not-a-valid-hex-key", "utf8");
		const logger = makeLogger();
		const km = new KeyManager(keyPath(), logger);
		const k = await km.loadOrCreate();
		expect(k.length).toBe(32);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("主密钥文件格式非法"));
		await expect(readFile(keyPath(), "utf8")).resolves.toMatch(/^[0-9a-f]{64}$/i);
	});

	it("文件存在但读不了(EISDIR,非 ENOENT)→ rethrow + error,绝不重生成覆盖 key", async () => {
		// 把 keyPath 占位成目录 → readFile 抛 EISDIR(模拟有 key 但 IO 读不了)
		await mkdir(keyPath(), { recursive: true });
		const logger = makeLogger();
		const km = new KeyManager(keyPath(), logger);
		await expect(km.loadOrCreate()).rejects.toMatchObject({ code: "EISDIR" });
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("读取失败（非缺失）"));
		// 关键:keyPath 仍是目录(没有被 createNew 的原子 rename 覆盖成新 key 文件)
		const { stat } = await import("node:fs/promises");
		expect((await stat(keyPath())).isDirectory()).toBe(true);
	});
});
