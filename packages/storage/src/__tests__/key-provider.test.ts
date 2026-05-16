/**
 * 单元测试 — `createKeyProvider` / Passphrase / File 两实现(真实 tmpdir)。
 *
 * 守护契约:
 *   - 有 passphrase → PassphraseKeyProvider(protected=true, resettable=false);
 *     getKey 确定、缓存;salt 文件落盘;同 salt+passphrase 跨实例一致;换 passphrase 变;
 *     resetKey 不轮换(返回原 key)
 *   - 无 passphrase → FileKeyProvider(protected=false, resettable=true);
 *     getKey 生成 master.key;resetKey 轮换出不同 key
 */

import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyProvider, FileKeyProvider, PassphraseKeyProvider } from "../key-provider";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-keyprov-"));
});

const paths = () => ({
	keyPath: join(dir, "secrets", "master.key"),
	saltPath: join(dir, "secrets", "kdf.salt"),
});

describe("createKeyProvider — 选型", () => {
	it("有 passphrase → Passphrase(protected, 不可 reset)", () => {
		const p = createKeyProvider({ passphrase: "pw", logger: makeLogger(), ...paths() });
		expect(p).toBeInstanceOf(PassphraseKeyProvider);
		expect(p.protected).toBe(true);
		expect(p.resettable).toBe(false);
	});

	it("空白 passphrase 视为未提供 → File(回退, 可 reset)", () => {
		const p = createKeyProvider({ passphrase: "   ", logger: makeLogger(), ...paths() });
		expect(p).toBeInstanceOf(FileKeyProvider);
		expect(p.protected).toBe(false);
		expect(p.resettable).toBe(true);
	});

	it("无 passphrase → File", () => {
		const p = createKeyProvider({ logger: makeLogger(), ...paths() });
		expect(p).toBeInstanceOf(FileKeyProvider);
	});
});

describe("PassphraseKeyProvider", () => {
	it("getKey 确定 + 缓存;salt 落盘;跨实例同 salt+passphrase 一致", async () => {
		const { saltPath, keyPath } = paths();
		const logger = makeLogger();
		const p1 = createKeyProvider({ passphrase: "secret-pass", saltPath, keyPath, logger });
		const k1 = await p1.getKey();
		const k1b = await p1.getKey();
		expect(k1b).toBe(k1); // 同实例缓存(同一 Buffer 引用)
		expect(k1.length).toBe(32);
		await expect(readFile(saltPath, "utf8")).resolves.toMatch(/^[0-9a-f]+$/i); // salt 落盘

		// 新实例复用磁盘上的 salt → 同 key
		const p2 = createKeyProvider({ passphrase: "secret-pass", saltPath, keyPath, logger });
		expect((await p2.getKey()).equals(k1)).toBe(true);
	});

	it("换 passphrase(同 salt)→ 不同 key", async () => {
		const { saltPath, keyPath } = paths();
		const logger = makeLogger();
		const a = await createKeyProvider({ passphrase: "pw-a", saltPath, keyPath, logger }).getKey();
		const b = await createKeyProvider({ passphrase: "pw-b", saltPath, keyPath, logger }).getKey();
		expect(a.equals(b)).toBe(false);
	});

	it("resetKey 不轮换:返回原 key(注入密钥无法旋转)", async () => {
		const p = createKeyProvider({ passphrase: "pw", logger: makeLogger(), ...paths() });
		const before = await p.getKey();
		const after = await p.resetKey();
		expect(after.equals(before)).toBe(true);
	});
});

describe("FileKeyProvider", () => {
	it("getKey 生成 master.key;resetKey 轮换出不同 key", async () => {
		const { keyPath } = paths();
		const p = createKeyProvider({ logger: makeLogger(), keyPath, saltPath: join(dir, "x.salt") });
		const k1 = await p.getKey();
		expect(k1.length).toBe(32);
		await expect(readFile(keyPath, "utf8")).resolves.toMatch(/^[0-9a-f]{64}$/);
		const k2 = await p.resetKey();
		expect(k2.equals(k1)).toBe(false);
		// 轮换后 loadOrCreate 读到的是新 key
		expect((await p.getKey()).equals(k2)).toBe(true);
	});
});
