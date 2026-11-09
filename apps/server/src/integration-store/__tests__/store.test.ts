import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
/**
 * 集成存储宿主:按集成键开 / 关 / 删,备份的导出与恢复,整个宿主一条写道、关停时关门。
 * 用真的 `FileKeyProvider` 与临时数据根,盘上的东西真读出来看。
 */

import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, Logger } from "@bilibili-notify/internal";
import { createKeyProvider, gcmDecrypt } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { logMessage } from "../../__tests__/support/log-message.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { i18n } from "../../i18n/index.js";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { dataPath } from "../../runtime/roots.js";
import { integrationSecretsFile, integrationStateFile } from "../files.js";
import { createIntegrationStore, disposeThenClose } from "../store.js";

let dataRoot: string;
let lines: string[];

function setup(reservedIntegrationKeys: readonly string[] = BUILTIN_INTEGRATION_KEYS) {
	lines = [];
	const logger: Logger = {
		info: () => {},
		warn: (m, ...args) => lines.push(`warn ${logMessage(m, args)}`),
		error: (m, ...args) => lines.push(`error ${logMessage(m, args)}`),
		debug: () => {},
	};
	const keyProvider = createKeyProvider({
		keyPath: dataPath(dataRoot, "secrets", "master.key"),
		saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
		logger,
	});
	return {
		store: createIntegrationStore({
			reservedIntegrationKeys,
			dataRoot,
			keyProvider,
			logger,
			redactor: createValueRedactor(),
		}),
		keyProvider,
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/** 数据根下每个文件的相对路径 → 内容。 */
async function snapshot(dir = dataRoot, prefix = ""): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) Object.assign(out, await snapshot(join(dir, entry.name), rel));
		else out[rel] = (await readFile(join(dir, entry.name))).toString("base64");
	}
	return out;
}

beforeEach(async () => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	dataRoot = await mkdtemp(join(tmpdir(), "bn-integration-store-"));
});

afterEach(async () => {
	await rm(dataRoot, { recursive: true, force: true });
});

describe("文件落在哪", () => {
	it("四个保留键与一个拓展 id 各落在自己的路径", async () => {
		const { store } = setup();
		for (const key of ["bilibili", "onebot", "qq-official", "webhook", "douyin"]) {
			const handle = await store.open(key);
			expect(await handle.state.set("s", key)).toEqual({ ok: true });
			expect(await handle.secrets.set("k", key)).toEqual({ ok: true });
		}
		for (const key of ["bilibili", "onebot", "qq-official", "webhook"]) {
			expect(await exists(join(dataRoot, "runtime", key, "state.json"))).toBe(true);
			expect(await exists(join(dataRoot, "secrets", key, "secrets.enc"))).toBe(true);
		}
		expect(await exists(join(dataRoot, "runtime", "extensions", "douyin", "state.json"))).toBe(
			true,
		);
		expect(await exists(join(dataRoot, "secrets", "extensions", "douyin", "secrets.enc"))).toBe(
			true,
		);
	});

	it("键不合法(既不是保留键、也不是拓展 id)→ 开不了", async () => {
		const { store } = setup();
		await expect(store.open("../escape")).rejects.toThrow(/不合法/);
		await expect(store.open("Bad Id")).rejects.toThrow(/不合法/);
	});

	it("两个集成写同名的键互不相干", async () => {
		const { store } = setup();
		const a = await store.open("onebot");
		const b = await store.open("webhook");
		await a.state.set("k", "from-onebot");
		await b.state.set("k", "from-webhook");
		expect(a.state.get("k")).toBe("from-onebot");
		expect(b.state.get("k")).toBe("from-webhook");
	});
});

describe("开与关", () => {
	it.each([
		[
			"en",
			{
				invalidOpen: "Invalid integration key; cannot open storage: ../escape",
				duplicate:
					"Storage for integration original is already open; an integration cannot have two open handles.",
				closed: "Integration original has stopped; its storage no longer accepts writes.",
				builtin: "onebot is a built-in integration and cannot be uninstalled.",
				invalidRemove: "Invalid integration key: ../escape",
				inUse:
					"Storage for integration original is still open. Stop the integration before deleting it.",
				missing: "Integration absent is not running; its secrets cannot be restored.",
				unreadable: "Cannot read state.json for broken (",
				cleanup: "Could not clear stored state and secrets for integration doomed:",
			},
		],
		[
			"ja",
			{
				invalidOpen: "連携機能キーが無効なため、ストレージを開けません：../escape",
				duplicate:
					"連携機能originalのストレージはすでに開いています。同じ連携機能で同時に2つ開くことはできません。",
				closed: "連携機能originalは停止済みのため、ストレージへの書き込みは受け付けません。",
				builtin: "onebotは組み込みの連携機能のため、アンインストールできません。",
				invalidRemove: "連携機能キーが無効です：../escape",
				inUse:
					"連携機能originalのストレージがまだ開いています。削除する前に連携機能を停止してください。",
				missing: "連携機能absentは実行中でないため、秘密情報を復元できません。",
				unreadable: "brokenのstate.jsonを読み取れません（",
				cleanup: "連携機能doomedの保存済み状態と秘密情報を消去できませんでした：",
			},
		],
		[
			"zh-TW",
			{
				invalidOpen: "整合功能鍵無效，無法開啟儲存空間：../escape",
				duplicate: "整合功能 original 的儲存空間已開啟，同一整合功能不可同時開啟兩份。",
				closed: "整合功能 original 已停止，儲存空間不再接受寫入。",
				builtin: "onebot 是內建整合功能，無法解除安裝。",
				invalidRemove: "整合功能鍵無效：../escape",
				inUse: "整合功能 original 的儲存空間仍開啟，請先停止整合功能再刪除。",
				missing: "整合功能 absent 未執行，無法還原機密資料。",
				unreadable: "無法讀取 broken 的 state.json（",
				cleanup: "無法清除整合功能 doomed 已儲存的狀態與機密資料：",
			},
		],
	] as const)(
		"%s localizes storage lifecycle refusals and retains unreadable data and filesystem diagnostics",
		async (locale, text) => {
			const { store, keyProvider } = setup();
			const handle = await store.open("original");
			await handle.state.set("original", "Original value 原文");
			i18n.set({ locale, voice: "plain" });
			try {
				await expect(store.open("../escape")).rejects.toThrow(text.invalidOpen);
				await expect(store.open("original")).rejects.toThrow(text.duplicate);
				expect(await store.remove("onebot")).toEqual({
					ok: false,
					code: "invalid",
					message: text.builtin,
				});
				expect(await store.remove("../escape")).toEqual({
					ok: false,
					code: "invalid",
					message: text.invalidRemove,
				});
				expect(await store.remove("original")).toEqual({
					ok: false,
					code: "conflict",
					message: text.inUse,
				});
				expect(handle.state.get("original")).toBe("Original value 原文");
				handle.close();
				expect(await handle.state.set("new", 1)).toEqual({
					ok: false,
					code: "unavailable",
					message: text.closed,
				});
				expect(handle.state.get("new")).toBeUndefined();
				expect(await store.restoreSecrets("absent", {})).toEqual({
					ok: false,
					code: "unavailable",
					message: text.missing,
				});
				const unreadablePath = dataPath(
					dataRoot,
					...integrationStateFile("broken", BUILTIN_INTEGRATION_KEYS),
				);
				await mkdir(unreadablePath, { recursive: true });
				const unreadable = await store.open("broken");
				try {
					expect(await unreadable.state.set("new", 1)).toMatchObject({
						ok: false,
						code: "unavailable",
						message: expect.stringContaining(text.unreadable),
					});
					expect(await unreadable.state.set("new", 1)).toMatchObject({
						message: expect.stringContaining("EISDIR"),
					});
					expect((await stat(unreadablePath)).isDirectory()).toBe(true);
				} finally {
					unreadable.close();
				}
				const blockedRoot = join(dataRoot, "Original blocked root");
				await writeFile(blockedRoot, "Original file 原文");
				const denied = createIntegrationStore({
					dataRoot: blockedRoot,
					reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
					keyProvider,
					logger: silentLogger,
					redactor: createValueRedactor(),
				});
				try {
					const removed = await denied.remove("doomed");
					expect(removed).toMatchObject({
						ok: false,
						code: "unavailable",
						message: expect.stringContaining(text.cleanup),
					});
					expect(removed).toMatchObject({ message: expect.stringContaining("ENOTDIR") });
					expect(removed).toMatchObject({
						message: expect.stringContaining("Original blocked root"),
					});
					expect(await readFile(blockedRoot, "utf8")).toBe("Original file 原文");
				} finally {
					await denied.close();
				}
			} finally {
				handle.close();
				await store.close();
			}
		},
	);

	it("同一个键开着再开 → 抛(装配的 bug);并发开同一个也抛", async () => {
		const { store } = setup();
		const first = store.open("onebot");
		await expect(store.open("onebot")).rejects.toThrow(/已经开着/);
		await first;
		await expect(store.open("onebot")).rejects.toThrow(/已经开着/);
		expect(store.isOpen("onebot")).toBe(true);
	});

	it("关了的把手写回 unavailable,文件原样;关了能再开,读到上次写的", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		await handle.state.set("cursor", 7);
		await handle.secrets.set("token", "t");
		handle.close();
		handle.close(); // 幂等
		expect(store.isOpen("douyin")).toBe(false);
		const before = await snapshot();
		for (const result of [
			await handle.state.set("cursor", 8),
			await handle.secrets.delete("token"),
			await handle.hostSecrets.set("http.cookies", "x"),
			await handle.hostState.set("http.identity", "x"),
		]) {
			expect(result).toMatchObject({ ok: false, code: "unavailable" });
		}
		expect(await snapshot()).toEqual(before);
		// 关了之后读还在(内存里那份)。
		expect(handle.state.get("cursor")).toBe(7);

		const again = await store.open("douyin");
		expect(again.state.get("cursor")).toBe(7);
		expect(again.secrets.get("token")).toBe("t");
	});

	it("关之前已经排上的写照常落完(关把手不丢在途的写)", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		const pending = handle.state.set("k", "late");
		handle.close();
		expect(await pending).toEqual({ ok: true });
		const again = await store.open("douyin");
		expect(again.state.get("k")).toBe("late");
	});

	it("重新开的时候读到的是上一份把手最后一笔在途写之后的盘面", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		void handle.state.set("k", "v1");
		void handle.state.set("k", "v2");
		handle.close();
		const again = await store.open("douyin");
		expect(again.state.get("k")).toBe("v2");
	});

	it("disposeThenClose:先收上下文,再关把手;收上下文抛了把手也关", async () => {
		const { store } = setup();
		const order: string[] = [];
		const handle = await store.open("douyin");
		const real = handle.close.bind(handle);
		handle.close = () => {
			order.push("close");
			real();
		};
		await disposeThenClose({ dispose: async () => void order.push("dispose") }, handle);
		expect(order).toEqual(["dispose", "close"]);
		expect(store.isOpen("douyin")).toBe(false);

		const second = await store.open("douyin");
		await expect(
			disposeThenClose({ dispose: () => Promise.reject(new Error("炸了")) }, second),
		).rejects.toThrow("炸了");
		expect(store.isOpen("douyin")).toBe(false);
	});
});

describe("读不了的文件(在但读不了)", () => {
	it("state 读不了:get 一律空,写一律 unavailable,盘上原样,记 error;别的集成不受影响", async () => {
		const { store } = setup();
		const statePath = dataPath(
			dataRoot,
			...integrationStateFile("douyin", BUILTIN_INTEGRATION_KEYS),
		);
		await mkdir(statePath, { recursive: true });
		const handle = await store.open("douyin");
		expect(handle.state.get("anything")).toBeUndefined();
		expect(await handle.state.set("k", 1)).toMatchObject({ ok: false, code: "unavailable" });
		expect((await stat(statePath)).isDirectory()).toBe(true);
		expect(lines.some((l) => l.startsWith("error") && l.includes("state.json"))).toBe(true);
		// 这一份读不了不连累 secrets 与别的集成。
		expect(await handle.secrets.set("t", "x")).toEqual({ ok: true });
		const other = await store.open("onebot");
		expect(await other.state.set("k", 1)).toEqual({ ok: true });
	});

	it("secrets 读不了(拿一个目录冒充文件):写一律拒,目录原样、里面没多出文件", async () => {
		const { store } = setup();
		const secretsPath = dataPath(
			dataRoot,
			...integrationSecretsFile("bilibili", BUILTIN_INTEGRATION_KEYS),
		);
		await mkdir(secretsPath, { recursive: true });
		const handle = await store.open("bilibili");
		expect(handle.secrets.get("refreshToken")).toBeUndefined();
		expect(await handle.secrets.set("refreshToken", "x")).toMatchObject({
			ok: false,
			code: "unavailable",
		});
		expect(await handle.hostSecrets.set("http.cookies", "x")).toMatchObject({
			ok: false,
			code: "unavailable",
		});
		expect((await stat(secretsPath)).isDirectory()).toBe(true);
		expect(await readdir(secretsPath)).toEqual([]);
		expect(await readdir(join(secretsPath, ".."))).toEqual(["secrets.enc"]);
	});

	// root 读得了 0o000 的文件,这条在 root 下跑会假红;上一条的目录冒充对 root 同样有效。
	it.skipIf(process.getuid?.() === 0)(
		"secrets 读不了(权限):写一律拒,盘上密文一个字节不变",
		async () => {
			const first = setup();
			const handle = await first.store.open("bilibili");
			await handle.secrets.set("refreshToken", "precious");
			handle.close();
			const secretsPath = dataPath(
				dataRoot,
				...integrationSecretsFile("bilibili", BUILTIN_INTEGRATION_KEYS),
			);
			const before = await readFile(secretsPath);
			await chmod(secretsPath, 0o000);
			try {
				const { store } = setup();
				const reopened = await store.open("bilibili");
				expect(reopened.secrets.get("refreshToken")).toBeUndefined();
				expect(await reopened.secrets.set("refreshToken", "overwrite")).toMatchObject({
					ok: false,
					code: "unavailable",
				});
				expect(await reopened.hostSecrets.set("http.cookies", "x")).toMatchObject({
					ok: false,
					code: "unavailable",
				});
				expect(lines.some((l) => l.startsWith("error") && l.includes("secrets.enc"))).toBe(true);
			} finally {
				await chmod(secretsPath, 0o600);
			}
			expect((await readFile(secretsPath)).equals(before)).toBe(true);
		},
	);
});

describe("remove(卸载)", () => {
	it("拓展:state 与 secrets 两个目录连目录一起删", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		await handle.state.set("s", 1);
		await handle.secrets.set("k", 1);
		handle.close();
		expect(await store.remove("douyin")).toEqual({ ok: true });
		expect(await exists(join(dataRoot, "runtime", "extensions", "douyin"))).toBe(false);
		expect(await exists(join(dataRoot, "secrets", "extensions", "douyin"))).toBe(false);
	});

	it("还开着的拒 conflict,文件不动", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		await handle.state.set("s", 1);
		expect(await store.remove("douyin")).toMatchObject({ ok: false, code: "conflict" });
		expect(await exists(join(dataRoot, "runtime", "extensions", "douyin", "state.json"))).toBe(
			true,
		);
	});

	it("保留键(内置集成)拒 invalid;从没存过东西的拓展删了也算成功", async () => {
		const { store } = setup();
		for (const key of ["bilibili", "onebot", "qq-official", "webhook"]) {
			expect(await store.remove(key)).toMatchObject({ ok: false, code: "invalid" });
		}
		expect(await store.remove("never-stored")).toEqual({ ok: true });
	});

	it("排在在途的写之后:删完目录里不会又冒出一份", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		const pending = handle.state.set("k", 1);
		handle.close();
		const removed = store.remove("douyin");
		expect(await pending).toEqual({ ok: true });
		expect(await removed).toEqual({ ok: true });
		expect(await exists(join(dataRoot, "runtime", "extensions", "douyin"))).toBe(false);
	});
});

describe("close(关停的 flush 段)", () => {
	it("在路上的写落完,之后的写被拒,而且数据目录不再变", async () => {
		const { store } = setup();
		const handle = await store.open("douyin");
		await handle.state.set("seed", 0);
		// 发一笔写、不等它,马上关门。
		const inFlight = handle.state.set("in-flight", 1);
		const inFlightSecret = handle.secrets.set("in-flight", "s");
		await store.close();
		expect(await inFlight).toEqual({ ok: true });
		expect(await inFlightSecret).toEqual({ ok: true });
		const afterClose = await snapshot();
		const state = JSON.parse(
			await readFile(join(dataRoot, "runtime", "extensions", "douyin", "state.json"), "utf8"),
		);
		expect(state.entries).toEqual({ seed: 0, "in-flight": 1 });

		// 关门之后的写一律 unavailable、不落盘 —— 各种写口都一样。
		for (const result of [
			await handle.state.set("late", 1),
			await handle.secrets.set("late", 1),
			await handle.state.batch([{ kind: "delete", key: "seed" }]),
			await handle.hostSecrets.set("http.cookies", "x"),
		]) {
			expect(result).toMatchObject({ ok: false, code: "unavailable" });
		}
		// 关门之后才开的存储也写不进去。
		const late = await store.open("onebot");
		expect(await late.state.set("k", 1)).toMatchObject({ ok: false, code: "unavailable" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await snapshot()).toEqual(afterClose);
	});
});

describe("exportSecrets / restoreSecrets", () => {
	async function plainOf(key: string, keyProvider: { getKey(): Promise<Buffer> }) {
		const raw = await readFile(
			dataPath(dataRoot, ...integrationSecretsFile(key, BUILTIN_INTEGRATION_KEYS)),
			"utf8",
		);
		return JSON.parse(gcmDecrypt(await keyProvider.getKey(), JSON.parse(raw))).entries;
	}

	it("开着的读内存、没开的读盘,一格都没有的不列;宿主那一面的键也在里面", async () => {
		const { store } = setup();
		const live = await store.open("bilibili");
		await live.secrets.set("refreshToken", "t");
		await live.hostSecrets.set("http.cookies", "[]");
		const parked = await store.open("douyin");
		await parked.secrets.set("token", "x");
		parked.close();
		const empty = await store.open("onebot");
		await empty.state.set("only-state", 1);

		expect(await store.exportSecrets()).toEqual({
			bilibili: { refreshToken: "t", "http.cookies": "[]" },
			douyin: { token: "x" },
		});
	});

	it("读不了的那一份跳过、记 warn(带原因),别的照常", async () => {
		const first = setup();
		const bad = await first.store.open("douyin");
		await bad.secrets.set("token", "x");
		bad.close();
		const good = await first.store.open("webhook");
		await good.secrets.set("k", 1);
		// 把 douyin 的密文换成一个目录:读不了。
		const path = dataPath(dataRoot, ...integrationSecretsFile("douyin", BUILTIN_INTEGRATION_KEYS));
		await rm(path);
		await mkdir(path);
		expect(await first.store.exportSecrets()).toEqual({ webhook: { k: 1 } });
		expect(lines.some((l) => l.startsWith("warn") && l.includes("douyin"))).toBe(true);
	});

	it("盘上 secrets/extensions/ 里装载器不认的残留目录不当集成", async () => {
		const { store } = setup();
		await mkdir(join(dataRoot, "secrets", "extensions", ".old-1234"), { recursive: true });
		await writeFile(join(dataRoot, "secrets", "extensions", ".old-1234", "secrets.enc"), "x");
		expect(await store.exportSecrets()).toEqual({});
	});

	it("restoreSecrets:整袋换(内存与盘一起),备份里没有的键没了;回调按登记的先后被等到", async () => {
		const { store, keyProvider } = setup();
		const handle = await store.open("bilibili");
		await handle.secrets.set("stale", 1);
		await handle.hostSecrets.set("http.cookies", "old");
		const order: string[] = [];
		handle.onSecretsReplaced(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push(`first:${handle.hostSecrets.get("http.cookies")}`);
		});
		handle.onSecretsReplaced(() => void order.push("second"));

		const restored = await store.restoreSecrets("bilibili", {
			refreshToken: "restored",
			"http.cookies": "new",
		});
		expect(restored).toEqual({ ok: true });
		expect(handle.secrets.get("stale")).toBeUndefined();
		expect(handle.secrets.get("refreshToken")).toBe("restored");
		// 回调被叫的时候内存已经是新的,而且是等它跑完才返回。
		expect(order).toEqual(["first:new", "second"]);
		expect(await plainOf("bilibili", keyProvider)).toEqual({
			refreshToken: "restored",
			"http.cookies": "new",
		});
	});

	it("摘掉的回调不再叫;回调抛了不影响结果", async () => {
		const { store } = setup();
		const handle = await store.open("bilibili");
		const called: string[] = [];
		const gone = handle.onSecretsReplaced(() => void called.push("gone"));
		gone.dispose();
		handle.onSecretsReplaced(() => {
			throw new Error("回调炸了");
		});
		handle.onSecretsReplaced(() => void called.push("after-throw"));
		expect(await store.restoreSecrets("bilibili", { k: 1 })).toEqual({ ok: true });
		expect(called).toEqual(["after-throw"]);
		expect(lines.some((l) => l.startsWith("error") && l.includes("回调炸了"))).toBe(true);
	});

	it("没开着 → unavailable;超 256KB → invalid,内存与盘都不变", async () => {
		const { store } = setup();
		expect(await store.restoreSecrets("douyin", { k: 1 })).toMatchObject({
			ok: false,
			code: "unavailable",
		});
		const handle = await store.open("bilibili");
		await handle.secrets.set("keep", 1);
		const huge: Record<string, Json> = { big: "a".repeat(300 * 1024) };
		expect(await store.restoreSecrets("bilibili", huge)).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(handle.secrets.get("keep")).toBe(1);
	});
});

it("装配新增的内置键沿用根目录存储、关后备份与不可卸载边界", async () => {
	const { store } = setup(["sample-source"]);
	const handle = await store.open("sample-source");
	expect(await handle.state.set("cursor", 3)).toEqual({ ok: true });
	expect(await handle.secrets.set("token", "sample-token")).toEqual({ ok: true });
	handle.close();
	expect(await exists(join(dataRoot, "runtime", "sample-source", "state.json"))).toBe(true);
	expect(await exists(join(dataRoot, "secrets", "sample-source", "secrets.enc"))).toBe(true);
	expect(await store.exportSecrets()).toEqual({ "sample-source": { token: "sample-token" } });
	expect(await store.remove("sample-source")).toMatchObject({ ok: false, code: "invalid" });
	await store.close();
});
