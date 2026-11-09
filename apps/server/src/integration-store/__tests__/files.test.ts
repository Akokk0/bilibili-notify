import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
/**
 * 两种文件的路径与读写:`state.json`(明文)与 `secrets.enc`(GCM)各自的三态 ——
 * 文件不在 / 读得出但内容不认 / 在但读不了。落盘只经原子写,密钥文件 0o600。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, Logger } from "@bilibili-notify/internal";
import { createKeyProvider, gcmDecrypt, gcmEncrypt } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { logMessage } from "../../__tests__/support/log-message.js";
import { i18n } from "../../i18n/index.js";
import { dataPath } from "../../runtime/roots.js";
import {
	integrationSecretsFile,
	integrationStateFile,
	readIntegrationSecretsFile,
	readIntegrationStateFile,
	writeIntegrationSecretsFile,
	writeIntegrationStateFile,
} from "../files.js";

let dataRoot: string;

function recordingLogger() {
	const lines: string[] = [];
	const logger: Logger = {
		info: () => {},
		warn: (m, ...args) => lines.push(`warn ${logMessage(m, args)}`),
		error: (m, ...args) => lines.push(`error ${logMessage(m, args)}`),
		debug: () => {},
	};
	return { logger, lines };
}

function providerAt(root: string) {
	return createKeyProvider({
		keyPath: dataPath(root, "secrets", "master.key"),
		saltPath: dataPath(root, "secrets", "kdf.salt"),
		logger: recordingLogger().logger,
	});
}

beforeEach(async () => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	dataRoot = await mkdtemp(join(tmpdir(), "bn-integration-files-"));
});

afterEach(async () => {
	await rm(dataRoot, { recursive: true, force: true });
});

describe("路径", () => {
	it("四个保留键落在 runtime/<键> 与 secrets/<键>,拓展 id 落在 extensions/ 底下", () => {
		for (const key of ["bilibili", "onebot", "qq-official", "webhook"]) {
			expect(integrationStateFile(key, BUILTIN_INTEGRATION_KEYS)).toEqual([
				"runtime",
				key,
				"state.json",
			]);
			expect(integrationSecretsFile(key, BUILTIN_INTEGRATION_KEYS)).toEqual([
				"secrets",
				key,
				"secrets.enc",
			]);
		}
		expect(integrationStateFile("douyin", BUILTIN_INTEGRATION_KEYS)).toEqual([
			"runtime",
			"extensions",
			"douyin",
			"state.json",
		]);
		expect(integrationSecretsFile("douyin", BUILTIN_INTEGRATION_KEYS)).toEqual([
			"secrets",
			"extensions",
			"douyin",
			"secrets.enc",
		]);
	});
});

describe("state.json", () => {
	const read = (logger: Logger) =>
		readIntegrationStateFile({
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			dataRoot,
			key: "onebot",
			logger,
		});
	const path = () =>
		dataPath(dataRoot, ...integrationStateFile("onebot", BUILTIN_INTEGRATION_KEYS));

	it("文件不在 → 空袋", async () => {
		const { logger, lines } = recordingLogger();
		expect(await read(logger)).toEqual({ kind: "ok", entries: new Map() });
		expect(lines).toEqual([]);
	});

	it("写了再读得回来,盘上是 { version: 1, entries }", async () => {
		const entries = new Map<string, Json>([["cursor", { page: 3 }]]);
		expect(
			await writeIntegrationStateFile(dataRoot, "onebot", entries, BUILTIN_INTEGRATION_KEYS),
		).toEqual({ ok: true });
		expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({
			version: 1,
			entries: { cursor: { page: 3 } },
		});
		expect(await read(recordingLogger().logger)).toEqual({ kind: "ok", entries });
	});

	it("不是合法 JSON → 空袋 + warn,坏文件改名隔离、原内容一字不丢", async () => {
		await mkdir(join(path(), ".."), { recursive: true });
		await writeFile(path(), "{not json");
		const { logger, lines } = recordingLogger();
		expect(await read(logger)).toEqual({ kind: "ok", entries: new Map() });
		expect(lines.some((l) => l.startsWith("warn") && l.includes("隔离"))).toBe(true);
		const names = await readdir(join(path(), ".."));
		const quarantined = names.find((n) => n.startsWith("state.json.corrupt-"));
		expect(quarantined).toBeDefined();
		expect(await readFile(join(path(), "..", quarantined ?? ""), "utf8")).toBe("{not json");
		expect(names).not.toContain("state.json");
	});

	for (const [label, body] of [
		["不是对象", "[1,2]"],
		["版本不认", JSON.stringify({ version: 2, entries: {} })],
		["缺 entries", JSON.stringify({ version: 1 })],
		["entries 是数组", JSON.stringify({ version: 1, entries: [] })],
	] as const) {
		it(`合法 JSON 但形状不认(${label})→ 隔离、当空袋、warn`, async () => {
			await mkdir(join(path(), ".."), { recursive: true });
			await writeFile(path(), body);
			const { logger, lines } = recordingLogger();
			expect(await read(logger)).toEqual({ kind: "ok", entries: new Map() });
			expect(lines.some((l) => l.startsWith("warn") && l.includes("格式无效"))).toBe(true);
			const names = await readdir(join(path(), ".."));
			expect(names.some((n) => n.startsWith("state.json.corrupt-"))).toBe(true);
		});
	}

	it("在但读不了(拿一个目录冒充文件)→ unreadable,不抛、不隔离、原样留着", async () => {
		await mkdir(path(), { recursive: true });
		const result = await read(recordingLogger().logger);
		expect(result.kind).toBe("unreadable");
		expect((await stat(path())).isDirectory()).toBe(true);
		expect(await readdir(join(path(), ".."))).toEqual(["state.json"]);
	});
});

describe("secrets.enc", () => {
	const path = () =>
		dataPath(dataRoot, ...integrationSecretsFile("bilibili", BUILTIN_INTEGRATION_KEYS));
	const entries = new Map<string, Json>([
		["refreshToken", "tok-abc"],
		["http.cookies", "[]"],
	]);

	async function readWith(root: string, logger: Logger) {
		return readIntegrationSecretsFile({
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			dataRoot,
			key: "bilibili",
			logger,
			keyProvider: providerAt(root),
		});
	}
	it.each([
		[
			"en",
			{
				state: "Could not write state.json:",
				key: "Could not obtain the master key: Original master key diagnostic 原文",
				secrets: "Could not write secrets.enc: Original master key diagnostic 原文",
			},
		],
		[
			"ja",
			{
				state: "state.jsonを書き込めませんでした：",
				key: "マスターキーを取得できませんでした：Original master key diagnostic 原文",
				secrets: "secrets.encを書き込めませんでした：Original master key diagnostic 原文",
			},
		],
		[
			"zh-TW",
			{
				state: "無法寫入 state.json：",
				key: "無法取得主金鑰：Original master key diagnostic 原文",
				secrets: "無法寫入 secrets.enc：Original master key diagnostic 原文",
			},
		],
	] as const)(
		"%s preserves state and encrypted bytes when writes or master-key access fail",
		async (locale, text) => {
			const keyProvider = providerAt(dataRoot);
			await writeIntegrationSecretsFile(
				{
					dataRoot,
					key: "bilibili",
					keyProvider,
					reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				},
				entries,
			);
			const original = await readFile(path());
			const broken = {
				...keyProvider,
				getKey: async () => {
					throw new Error("Original master key diagnostic 原文");
				},
			};
			const statePath = dataPath(
				dataRoot,
				...integrationStateFile("onebot", BUILTIN_INTEGRATION_KEYS),
			);
			await mkdir(statePath, { recursive: true });
			await writeFile(join(statePath, "original.txt"), "Original sentinel 原文");
			i18n.set({ locale, voice: "plain" });
			const state = await writeIntegrationStateFile(
				dataRoot,
				"onebot",
				new Map([["original", "Private value"]]),
				BUILTIN_INTEGRATION_KEYS,
			);
			expect(state).toMatchObject({
				ok: false,
				code: "unavailable",
				message: expect.stringContaining(text.state),
			});
			expect(state).toMatchObject({ message: expect.stringContaining(statePath) });
			expect(JSON.stringify(state)).not.toContain("Private value");
			expect(await readFile(join(statePath, "original.txt"), "utf8")).toBe(
				"Original sentinel 原文",
			);
			expect(await readdir(join(statePath, ".."))).toEqual(["state.json"]);
			expect(
				await readIntegrationSecretsFile({
					dataRoot,
					key: "bilibili",
					keyProvider: broken,
					reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
					logger: recordingLogger().logger,
				}),
			).toEqual({ kind: "unreadable", message: text.key });
			expect(
				await writeIntegrationSecretsFile(
					{
						dataRoot,
						key: "bilibili",
						keyProvider: broken,
						reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
					},
					entries,
				),
			).toEqual({ ok: false, code: "unavailable", message: text.secrets });
			expect(await readFile(path())).toEqual(original);
			expect(await readFile(path(), "utf8")).not.toContain("tok-abc");
		},
	);

	it("文件不在 → 空袋", async () => {
		expect(await readWith(dataRoot, recordingLogger().logger)).toEqual({
			kind: "ok",
			entries: new Map(),
		});
	});

	it("写了再读得回来;盘上没有明文;权限 0o600", async () => {
		const keyProvider = providerAt(dataRoot);
		expect(
			await writeIntegrationSecretsFile(
				{
					reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
					dataRoot,
					key: "bilibili",
					keyProvider,
				},
				entries,
			),
		).toEqual({ ok: true });
		const raw = await readFile(path(), "utf8");
		expect(raw).not.toContain("tok-abc");
		expect((await stat(path())).mode & 0o777).toBe(0o600);
		// 同一把主密钥解得开,明文就是 { version, entries }。
		const plain = JSON.parse(gcmDecrypt(await keyProvider.getKey(), JSON.parse(raw)));
		expect(plain).toEqual({
			version: 1,
			entries: { refreshToken: "tok-abc", "http.cookies": "[]" },
		});
		expect(await readWith(dataRoot, recordingLogger().logger)).toEqual({ kind: "ok", entries });
	});

	it("换一把密钥解不开 → 空袋 + warn,文件原地留着一个字节不变", async () => {
		await writeIntegrationSecretsFile(
			{
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				dataRoot,
				key: "bilibili",
				keyProvider: providerAt(dataRoot),
			},
			entries,
		);
		const before = await readFile(path());
		const otherRoot = await mkdtemp(join(tmpdir(), "bn-integration-files-other-"));
		try {
			const { logger, lines } = recordingLogger();
			expect(await readWith(otherRoot, logger)).toEqual({ kind: "ok", entries: new Map() });
			expect(lines.some((l) => l.startsWith("warn") && l.includes("无法解密"))).toBe(true);
			expect((await readFile(path())).equals(before)).toBe(true);
		} finally {
			await rm(otherRoot, { recursive: true, force: true });
		}
	});

	it("不是 JSON / 不是 GCM 块 → 空袋 + warn,文件留着", async () => {
		await mkdir(join(path(), ".."), { recursive: true });
		await writeFile(path(), "garbage");
		const { logger, lines } = recordingLogger();
		expect(await readWith(dataRoot, logger)).toEqual({ kind: "ok", entries: new Map() });
		expect(lines.some((l) => l.startsWith("warn"))).toBe(true);
		expect(await readFile(path(), "utf8")).toBe("garbage");
	});

	it("解开了但形状不认 → 空袋 + warn,文件留着(下次写盖掉)", async () => {
		const keyProvider = providerAt(dataRoot);
		await mkdir(join(path(), ".."), { recursive: true });
		await writeFile(path(), JSON.stringify(gcmEncrypt(await keyProvider.getKey(), '{"a":1}')));
		const { logger, lines } = recordingLogger();
		expect(await readWith(dataRoot, logger)).toEqual({ kind: "ok", entries: new Map() });
		expect(lines.some((l) => l.startsWith("warn") && l.includes("格式无效"))).toBe(true);
	});

	it("在但读不了(拿一个目录冒充文件)→ unreadable,不抛,原样留着", async () => {
		await mkdir(path(), { recursive: true });
		const result = await readWith(dataRoot, recordingLogger().logger);
		expect(result.kind).toBe("unreadable");
		expect((await stat(path())).isDirectory()).toBe(true);
	});
});
