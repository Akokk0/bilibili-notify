/**
 * 0.x 的 B 站登录 `secrets/cookies.json` → 集成的密钥文件 `secrets/bilibili/secrets.enc`。
 * 0.x 那份是 `{ cookiesJson: GcmBlob, refreshToken?: GcmBlob }`(各自 GCM 加密、同一把主密钥);新代里是
 * 一个 GCM 块,明文是 `{ version: 1, entries: { "http.cookies": <整段字符串>, "refreshToken"?: <字符串> } }`。
 * 解不开、读不懂的不带过来,只在「没带过来的」里记一条、写明需要重新扫码,不挡迁移。
 *
 * 期望值里的键名与路径一律写字面量:以后谁改了活代码里的键名,迁移的产出不许跟着悄悄变。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gcmDecrypt, gcmEncrypt } from "@bilibili-notify/storage";
import { describe, expect, it } from "vite-plus/test";
import {
	migrateZeroGeneration,
	readZeroGenerationKey,
	type ZeroMigrationResult,
} from "../zero-generation.js";
import { useZeroSandbox } from "./support.js";

const COOKIES_FILE = "secrets/cookies.json";
const NEW_FILE = ["secrets", "bilibili", "secrets.enc"] as const;
const MASTER_HEX = "ab".repeat(32);
const SALT_HEX = "cd".repeat(16);
const PASSPHRASE = "the-passphrase";

/** 罐子那一格:整段字符串(里面是 cookie 数组的 JSON)。 */
const COOKIES_JSON = JSON.stringify([
	{ name: "SESSDATA", value: "sess", domain: "bilibili.com" },
	{ name: "bili_jct", value: "jct", domain: "bilibili.com" },
]);
const REFRESH_TOKEN = "refresh-token-0";

describe("0.x 的 B 站登录转成集成的密钥文件", () => {
	const sandbox = useZeroSandbox("bn-zero-bili-login-");
	const masterKey = Buffer.from(MASTER_HEX, "hex");

	/** 第 0 代放主密钥(或口令盐)。 */
	async function placeKeyMaterial(): Promise<void> {
		await sandbox.placeZeroText("secrets/master.key", MASTER_HEX);
		await sandbox.placeZeroText("secrets/kdf.salt", SALT_HEX);
	}

	/** 第 0 代放一份真加密的 `cookies.json`。 */
	async function placeLogin(
		key: Buffer,
		cookiesJson: string,
		refreshToken?: string,
	): Promise<void> {
		await sandbox.placeZero("secrets/cookies.json", {
			cookiesJson: gcmEncrypt(key, cookiesJson),
			...(refreshToken === undefined ? {} : { refreshToken: gcmEncrypt(key, refreshToken) }),
		});
	}

	/** 解开新代里的密钥文件,回里面的整个明文对象。 */
	async function readNewEntries(root: string, key: Buffer): Promise<unknown> {
		const blob = JSON.parse(await readFile(join(root, ...NEW_FILE), "utf8")) as unknown;
		return JSON.parse(gcmDecrypt(key, blob));
	}

	const cookiesSkips = (report: ZeroMigrationResult) =>
		report.skipped.filter((s) => s.path === COOKIES_FILE);

	function expectConverted(report: ZeroMigrationResult): void {
		expect(cookiesSkips(report)).toEqual([]);
		expect(report.transfers.filter((t) => t.from === COOKIES_FILE)).toEqual([
			{ from: COOKIES_FILE, to: "secrets/bilibili/secrets.enc", method: "convert" },
		]);
	}

	function expectNotCarried(report: ZeroMigrationResult, root: string): void {
		expect(existsSync(join(root, ...NEW_FILE))).toBe(false);
		expect(report.transfers.filter((t) => t.from === COOKIES_FILE)).toEqual([]);
		const skips = cookiesSkips(report);
		expect(skips).toHaveLength(1);
		expect(skips[0]?.reason).toContain("重新扫码");
	}

	it("① cookie 与续期令牌:新文件用同一把密钥解得开,恰好两个键、值逐字相等;新代里没有 cookies.json", async () => {
		await placeKeyMaterial();
		await placeLogin(masterKey, COOKIES_JSON, REFRESH_TOKEN);

		const report = await sandbox.migrate();

		expect(await readNewEntries(sandbox.target, masterKey)).toEqual({
			version: 1,
			entries: { "http.cookies": COOKIES_JSON, refreshToken: REFRESH_TOKEN },
		});
		expect(existsSync(join(sandbox.target, "secrets", "cookies.json"))).toBe(false);
		expectConverted(report);
		expect(report.rewritten).not.toContain("secrets/bilibili/secrets.enc");
	});

	it("② 只有 cookie 没有令牌:只有一个键", async () => {
		await placeKeyMaterial();
		await placeLogin(masterKey, COOKIES_JSON);

		const report = await sandbox.migrate();

		expect(await readNewEntries(sandbox.target, masterKey)).toEqual({
			version: 1,
			entries: { "http.cookies": COOKIES_JSON },
		});
		expectConverted(report);
	});

	it("③ 口令派生的密钥:迁移时给了口令同 ①;没给口令没有新文件、记一条重新扫码、迁移照常完成", async () => {
		// 只用口令的那种部署:有盐、没有 master.key。
		await sandbox.placeZeroText("secrets/kdf.salt", SALT_HEX);
		const derived = await readZeroGenerationKey(sandbox.zero, PASSPHRASE);
		if (derived.kind !== "ok") throw new Error("夹具:口令派生的密钥应当拿得到");
		await placeLogin(derived.key, COOKIES_JSON, REFRESH_TOKEN);

		const withPass = await migrateZeroGeneration({
			zeroRoot: sandbox.zero,
			targetDir: sandbox.target,
			passphrase: PASSPHRASE,
		});
		expect(await readNewEntries(sandbox.target, derived.key)).toEqual({
			version: 1,
			entries: { "http.cookies": COOKIES_JSON, refreshToken: REFRESH_TOKEN },
		});
		expectConverted(withPass);

		const without = join(dirname(sandbox.target), "generation-no-pass");
		const report = await migrateZeroGeneration({ zeroRoot: sandbox.zero, targetDir: without });
		expectNotCarried(report, without);
		// 迁移照常完成:别的东西(这里是主密钥与盐)照搬。
		expect(existsSync(join(without, "secrets", "kdf.salt"))).toBe(true);
	});

	const unreadable: Array<[string, () => Promise<void>]> = [];
	function unreadableCase(name: string, place: (key: Buffer) => Promise<void>): void {
		unreadable.push([name, () => place(masterKey)]);
	}
	unreadableCase("内容是 {}", () => sandbox.placeZeroText(COOKIES_FILE, "{}"));
	unreadableCase("不是 JSON", () => sandbox.placeZeroText(COOKIES_FILE, "not json"));
	unreadableCase("旧的 CBC 形状", () =>
		sandbox.placeZeroText(COOKIES_FILE, JSON.stringify({ iv: "aa", data: "bb" })),
	);
	unreadableCase("密文被改过", async (key) => {
		const blob = gcmEncrypt(key, COOKIES_JSON);
		const data = Buffer.from(blob.data, "base64");
		data[0] = (data[0] ?? 0) ^ 0xff;
		await sandbox.placeZero(COOKIES_FILE, {
			cookiesJson: { ...blob, data: data.toString("base64") },
		});
	});
	unreadableCase("令牌那一格不是 GCM 块", (key) =>
		sandbox.placeZero(COOKIES_FILE, {
			cookiesJson: gcmEncrypt(key, COOKIES_JSON),
			refreshToken: "plain",
		}),
	);
	unreadableCase("解开的 cookie 不是 JSON 数组", (key) =>
		sandbox.placeZero(COOKIES_FILE, { cookiesJson: gcmEncrypt(key, '{"a":1}') }),
	);
	unreadableCase("解开的 cookie 根本不是 JSON", (key) =>
		sandbox.placeZero(COOKIES_FILE, { cookiesJson: gcmEncrypt(key, "oops") }),
	);

	it.each(unreadable)(
		"④ 解不开 / 读不懂(%s):没有新文件、记一条重新扫码、迁移照常完成",
		async (_name, place) => {
			await placeKeyMaterial();
			await place();

			const report = await sandbox.migrate();

			expectNotCarried(report, sandbox.target);
			expect(existsSync(join(sandbox.target, "secrets", "master.key"))).toBe(true);
		},
	);

	it("④ 缺主密钥:没有新文件、记一条重新扫码", async () => {
		await placeLogin(masterKey, COOKIES_JSON, REFRESH_TOKEN);

		const report = await sandbox.migrate();

		expectNotCarried(report, sandbox.target);
		expect(cookiesSkips(report)[0]?.reason).toContain("缺主密钥");
	});

	it("⑤ 没有 cookies.json:没有新文件,也没有那条「没带过来」", async () => {
		await placeKeyMaterial();

		const report = await sandbox.migrate();

		expect(existsSync(join(sandbox.target, ...NEW_FILE))).toBe(false);
		expect(cookiesSkips(report)).toEqual([]);
		expect(report.transfers.filter((t) => t.from === COOKIES_FILE)).toEqual([]);
	});

	it("⑥ 跑两遍(各自一个空目录):解开后的内容相同,第 0 代的 cookies.json 一个字节不动", async () => {
		await placeKeyMaterial();
		await placeLogin(masterKey, COOKIES_JSON, REFRESH_TOKEN);
		const before = await readFile(join(sandbox.zero, "secrets", "cookies.json"), "utf8");

		await sandbox.migrate();
		const second = join(dirname(sandbox.target), "generation-2");
		await migrateZeroGeneration({ zeroRoot: sandbox.zero, targetDir: second });

		expect(await readNewEntries(second, masterKey)).toEqual(
			await readNewEntries(sandbox.target, masterKey),
		);
		expect(await readFile(join(sandbox.zero, "secrets", "cookies.json"), "utf8")).toBe(before);
	});
});
