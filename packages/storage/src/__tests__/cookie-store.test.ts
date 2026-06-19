/**
 * 单元测试 — `CookieStore`(AES-256-GCM + KeyProvider,经 StorageManager 装配)。
 *
 * 守护契约:
 *   - save→load round-trip(含/不含 refreshToken);缺文件→null
 *   - 旧 CBC 文件({iv,data} 无 v/tag)→ load() 返回 null + warn(不迁移)
 *   - 注入 encryptionKey:跨实例同 key 可解;不同 key → null(GCM 认证失败)
 *   - resetKey:文件模式轮换 key(旧 cookie 失效);注入模式清 cookie、key 不变
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { StorageManager } from "../index";

function makeCtx(): { ctx: ServiceContext; logger: Logger } {
	const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return {
		logger,
		ctx: {
			logger,
			setInterval: () => ({ dispose: vi.fn() }),
			setTimeout: () => ({ dispose: vi.fn() }),
			onDispose: () => undefined,
		},
	};
}

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-ck-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function mkStore(encryptionKey?: string) {
	const { ctx, logger } = makeCtx();
	const sm = new StorageManager({ serviceCtx: ctx, dataDir, encryptionKey });
	await sm.init();
	return { sm, logger };
}

const cookiePath = () => join(dataDir, "bilibili-notify", "cookies.json");

describe("CookieStore — GCM round-trip (file key mode)", () => {
	it("save→load 还原 cookiesJson + refreshToken", async () => {
		const { sm } = await mkStore();
		await sm.cookieStore.save({ cookiesJson: '[{"k":"bili_jct"}]', refreshToken: "rt-1" });
		const loaded = await sm.cookieStore.load();
		expect(loaded).toEqual({ cookiesJson: '[{"k":"bili_jct"}]', refreshToken: "rt-1" });
	});

	it("无 refreshToken 时 load 不带该字段;缺文件 → null", async () => {
		const { sm } = await mkStore();
		expect(await sm.cookieStore.load()).toBeNull();
		await sm.cookieStore.save({ cookiesJson: "[]" });
		expect(await sm.cookieStore.load()).toEqual({ cookiesJson: "[]", refreshToken: undefined });
	});

	it("磁盘文件是 v2 GCM blob(非明文、非 legacy CBC)", async () => {
		const { sm } = await mkStore();
		await sm.cookieStore.save({ cookiesJson: "secret-payload" });
		const raw = JSON.parse(await readFile(cookiePath(), "utf8"));
		expect(raw.cookiesJson.v).toBe(2);
		expect(raw.cookiesJson).toHaveProperty("tag");
		expect(JSON.stringify(raw)).not.toContain("secret-payload");
	});
});

describe("CookieStore — legacy CBC 不迁移", () => {
	it("旧 {iv,data} 文件 → load() 返回 null + warn", async () => {
		const { sm, logger } = await mkStore();
		await sm.cookieStore.save({ cookiesJson: "[]" }); // 先建目录
		// 覆盖成 legacy CBC 形状(无 v / tag)。
		await writeFile(
			cookiePath(),
			JSON.stringify({ cookiesJson: { iv: "00", data: "deadbeef" } }),
			"utf8",
		);
		expect(await sm.cookieStore.load()).toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("无法解密"));
	});
});

describe("CookieStore — IO 错误策略 (P1)", () => {
	it("文件存在但读不了(EISDIR,非 ENOENT)→ load() 抛而非伪装未登录", async () => {
		const { sm, logger } = await mkStore();
		await mkdir(cookiePath(), { recursive: true }); // 占位成目录 → readFile EISDIR
		await expect(sm.cookieStore.load()).rejects.toMatchObject({ code: "EISDIR" });
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("读取失败（非缺失）"));
		// 关键不变量:绝不返回 null —— 否则上层会判"未登录",后续 refresh→save()
		// 用新 cookie 静默覆盖盘上仍有效的密文。
	});

	it("缺文件(ENOENT)仍走静默 null(首次运行不受策略收紧影响)", async () => {
		const { sm, logger } = await mkStore();
		expect(await sm.cookieStore.load()).toBeNull();
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("首次运行"));
	});
});

describe("CookieStore — 注入 encryptionKey", () => {
	it("同 key 跨实例可解;不同 key → null(认证失败)", async () => {
		const { sm } = await mkStore("strong-pass-A");
		await sm.cookieStore.save({ cookiesJson: "payload-A" });
		// salt 落盘。
		await expect(stat(join(dataDir, "bilibili-notify", "kdf.salt"))).resolves.toBeDefined();

		const again = await mkStore("strong-pass-A");
		expect((await again.sm.cookieStore.load())?.cookiesJson).toBe("payload-A");

		const wrong = await mkStore("different-pass-B");
		expect(await wrong.sm.cookieStore.load()).toBeNull();
	});
});

describe("CookieStore — resetKey", () => {
	it("文件模式:轮换 key,旧 cookie 失效", async () => {
		const { sm } = await mkStore();
		await sm.cookieStore.save({ cookiesJson: "old" });
		await sm.cookieStore.resetKey(); // clear + 轮换 master.key
		expect(await sm.cookieStore.load()).toBeNull();
		// 新 key 下仍可正常 save/load。
		await sm.cookieStore.save({ cookiesJson: "new" });
		expect((await sm.cookieStore.load())?.cookiesJson).toBe("new");
	});

	it("注入模式:清 cookie 但 key 不变(同 passphrase 后续 save/load 正常)", async () => {
		const { sm } = await mkStore("pass-X");
		await sm.cookieStore.save({ cookiesJson: "before" });
		await sm.cookieStore.resetKey();
		expect(await sm.cookieStore.load()).toBeNull(); // 已清
		await sm.cookieStore.save({ cookiesJson: "after" });
		const reopened = await mkStore("pass-X"); // 同 passphrase + 磁盘 salt
		expect((await reopened.sm.cookieStore.load())?.cookiesJson).toBe("after");
	});
});
