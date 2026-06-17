/**
 * 单元测试 — `createKeyProvider` / Passphrase / File 两实现(真实 tmpdir)。
 *
 * 守护契约:
 *   - 有 passphrase → PassphraseKeyProvider(protected=true, resettable=false);
 *     getKey 确定、缓存;salt 文件落盘;同 salt+passphrase 跨实例一致;换 passphrase 变;
 *     resetKey 不轮换(返回原 key)
 *   - 无 passphrase → FileKeyProvider(protected=false, resettable=true);
 *     getKey 生成 master.key 并缓存;resetKey 轮换出不同 key
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

	it("回退 File 时在选择点打高可见告警(端中立,不提 BN_COOKIE_KEY)", () => {
		const logger = makeLogger();
		createKeyProvider({ logger, ...paths() });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("未提供注入密钥"));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("仅为混淆"));
		// 端中立:不得在共享选择点出现 standalone 专属变量名。
		const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		expect(msg).not.toContain("BN_COOKIE_KEY");
	});

	it("有 passphrase 时不打回退告警", () => {
		const logger = makeLogger();
		createKeyProvider({ passphrase: "pw", logger, ...paths() });
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("PassphraseKeyProvider — kdf.salt 策略 (P1)", () => {
	async function seedSalt(content: string) {
		const { saltPath } = paths();
		await mkdir(join(dir, "secrets"), { recursive: true });
		await writeFile(saltPath, content, "utf8");
	}

	it("非法 salt 内容 → warn + 重生成为精确 32 hex(消除无声重登)", async () => {
		await seedSalt("not-a-valid-hex-salt");
		const logger = makeLogger();
		const p = createKeyProvider({ passphrase: "pw", logger, ...paths() });
		const k = await p.getKey();
		expect(k.length).toBe(32);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("kdf.salt 格式非法"));
		await expect(readFile(paths().saltPath, "utf8")).resolves.toMatch(/^[0-9a-f]{32}$/i);
	});

	it("过长 salt(64 hex,旧 {32,} 会误收)→ 现收紧为精确 {32},warn + 重生成", async () => {
		await seedSalt("a".repeat(64));
		const logger = makeLogger();
		const p = createKeyProvider({ passphrase: "pw", logger, ...paths() });
		await p.getKey();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("kdf.salt 格式非法"));
		await expect(readFile(paths().saltPath, "utf8")).resolves.toMatch(/^[0-9a-f]{32}$/i);
	});

	it("合法 32 hex salt 原样复用,不 warn 不重写", async () => {
		const valid = "0123456789abcdef0123456789abcdef"; // 32 hex = 16 bytes
		await seedSalt(valid);
		const logger = makeLogger();
		const p = createKeyProvider({ passphrase: "pw", logger, ...paths() });
		await p.getKey();
		expect(logger.warn).not.toHaveBeenCalled();
		await expect(readFile(paths().saltPath, "utf8")).resolves.toBe(valid);
	});

	it("salt 文件存在但读不了(EISDIR,非 ENOENT)→ getKey 抛,不静默换 key", async () => {
		const { saltPath } = paths();
		await mkdir(saltPath, { recursive: true }); // 占位成目录 → readFile EISDIR
		const logger = makeLogger();
		const p = createKeyProvider({ passphrase: "pw", logger, ...paths() });
		await expect(p.getKey()).rejects.toMatchObject({ code: "EISDIR" });
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("读取失败（非缺失）"));
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
	it("getKey 生成 master.key 并缓存;resetKey 轮换出不同 key", async () => {
		const { keyPath } = paths();
		const p = createKeyProvider({ logger: makeLogger(), keyPath, saltPath: join(dir, "x.salt") });
		const k1 = await p.getKey();
		const k1b = await p.getKey();
		expect(k1b).toBe(k1); // 同实例缓存(同一 Buffer 引用),避免保存配置时重复读盘/刷日志
		expect(k1.length).toBe(32);
		await expect(readFile(keyPath, "utf8")).resolves.toMatch(/^[0-9a-f]{64}$/);
		const k2 = await p.resetKey();
		expect(k2.equals(k1)).toBe(false);
		// 轮换后 getKey 命中缓存的新 key
		expect(await p.getKey()).toBe(k2);
	});

	it("启动预加载后保存配置复用同一 key,不再次打印主密钥加载日志", async () => {
		const { keyPath } = paths();
		await mkdir(join(dir, "secrets"), { recursive: true });
		await writeFile(keyPath, "a".repeat(64), "utf8");
		const logger = makeLogger();
		const p = createKeyProvider({ logger, keyPath, saltPath: join(dir, "x.salt") });
		await p.getKey(); // standalone 启动预加载
		await p.getKey(); // 后续 SecretStore.save / CookieStore.init 复用缓存
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("主密钥加载成功"));
	});
});
