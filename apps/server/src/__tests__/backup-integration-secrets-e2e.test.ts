/**
 * 备份与恢复的密钥这一条链,两头都是真的:真的 `createIntegrationStore`(临时数据根、真 `FileKeyProvider`)
 * + 真的备份服务。往一个数据根的 `bilibili` 与 `onebot` 各写几个键 → 导出完整档 → 换一个**空的、另一把主密钥**的
 * 数据根开同样两个集成 → 恢复 → 两边 `get` 读到、盘上两个文件用新数据根自己的密钥解得开;
 * `onSecretsReplaced` 登记的回调被等到。
 *
 * 备份服务单测里的存储是桩(`support/backup-integration-secrets.ts`),桩证明不了「换内存」「落盘」「等回调」
 * 这几件事真发生了 —— 这里证明。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { createKeyProvider, gcmDecrypt } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type BackupStore, createBackupService } from "../backup/service.js";
import { integrationSecretsFile } from "../integration-store/files.js";
import { createIntegrationStore } from "../integration-store/store.js";
import { createValueRedactor } from "../logs/value-redactor.js";
import { dataPath } from "../runtime/roots.js";
import { silentLogger } from "./support/silent-logger.js";

let roots: string[];

beforeEach(() => {
	roots = [];
});

afterEach(async () => {
	await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function world() {
	const dataRoot = await mkdtemp(join(tmpdir(), "bn-backup-secrets-e2e-"));
	roots.push(dataRoot);
	const keyProvider = createKeyProvider({
		keyPath: dataPath(dataRoot, "secrets", "master.key"),
		saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
		logger: silentLogger,
	});
	const store = createIntegrationStore({
		dataRoot,
		keyProvider,
		logger: silentLogger,
		redactor: createValueRedactor(),
	});
	return { dataRoot, keyProvider, store };
}

/** 备份服务的配置那一半:这条测试只关心密钥,配置给一份空的、替换时什么都不做。 */
function emptyConfigStore(): BackupStore {
	const globals = makeDefaultGlobalConfig();
	return {
		getInvalidSettingsPaths: () => [],
		getGlobals: () => globals,
		getAllIntegrationSettings: () => ({}),
		getAllExtensionSettings: () => ({}),
		getSubscriptions: () => [],
		getSubscriptionTags: () => [],
		getConnections: () => [],
		getTargets: () => [],
		replaceSections: async () => [],
	};
}

async function plainEntries(w: Awaited<ReturnType<typeof world>>, key: string) {
	const raw = await readFile(dataPath(w.dataRoot, ...integrationSecretsFile(key)), "utf8");
	return JSON.parse(gcmDecrypt(await w.keyProvider.getKey(), JSON.parse(raw))).entries;
}

describe("备份导出 → 另一个数据根恢复(真存储)", () => {
	it("两个集成的密钥整袋回来:内存 get 读到、盘上解得开、被换了的回调被等到", async () => {
		// 源:bilibili(集成自己的键 + 宿主那一面的罐子键)与 onebot 各有内容。
		const src = await world();
		const srcBili = await src.store.open("bilibili");
		const srcOnebot = await src.store.open("onebot");
		await srcBili.secrets.set("refreshToken", "RT-1");
		await srcBili.hostSecrets.set("http.cookies", '[{"name":"SESSDATA"}]');
		await srcOnebot.secrets.set("accessToken", "tok-1");
		const exporter = createBackupService({
			configStore: emptyConfigStore(),
			integrationSecrets: src.store,
		});
		const env = await exporter.exportBackup({ kind: "full", pin: "123456" });

		// 目标:另一个空数据根(另一把主密钥),同样两个集成开着,各带一个旧键(整袋换,旧的不该留)。
		const dst = await world();
		const dstBili = await dst.store.open("bilibili");
		const dstOnebot = await dst.store.open("onebot");
		await dstBili.secrets.set("stale", "old");
		await dstOnebot.secrets.set("accessToken", "tok-OLD");
		let hookSaw: unknown;
		let hookFinished = false;
		dstBili.onSecretsReplaced(async () => {
			// 回调里读到的已经是新值,而且 importBackup 要等它走完才返回。
			hookSaw = dstBili.secrets.get("refreshToken");
			await new Promise((resolve) => setTimeout(resolve, 20));
			hookFinished = true;
		});
		const importer = createBackupService({
			configStore: emptyConfigStore(),
			integrationSecrets: dst.store,
		});

		const result = await importer.importBackup({
			envelope: env,
			pin: "123456",
			mode: "overwrite",
		});

		expect(result.restoredIntegrations.sort()).toEqual(["bilibili", "onebot"]);
		expect(result.unrestoredIntegrations).toEqual([]);
		expect(hookFinished).toBe(true);
		expect(hookSaw).toBe("RT-1");
		// 内存:新值读得到,整袋换,旧键没了。
		expect(dstBili.secrets.get("refreshToken")).toBe("RT-1");
		expect(dstBili.hostSecrets.get("http.cookies")).toBe('[{"name":"SESSDATA"}]');
		expect(dstBili.secrets.get("stale")).toBeUndefined();
		expect(dstOnebot.secrets.get("accessToken")).toBe("tok-1");
		// 盘上:用目标数据根自己的主密钥解得开,内容与内存一致。
		expect(await plainEntries(dst, "bilibili")).toEqual({
			"http.cookies": '[{"name":"SESSDATA"}]',
			refreshToken: "RT-1",
		});
		expect(await plainEntries(dst, "onebot")).toEqual({ accessToken: "tok-1" });
	});

	it("备份里有、目标没开着的集成:点名「没在运行」,别的照常恢复", async () => {
		const src = await world();
		const srcBili = await src.store.open("bilibili");
		const srcOnebot = await src.store.open("onebot");
		await srcBili.secrets.set("refreshToken", "RT-1");
		await srcOnebot.secrets.set("accessToken", "tok-1");
		const env = await createBackupService({
			configStore: emptyConfigStore(),
			integrationSecrets: src.store,
		}).exportBackup({ kind: "full", pin: "123456" });

		const dst = await world();
		const dstBili = await dst.store.open("bilibili");
		const importer = createBackupService({
			configStore: emptyConfigStore(),
			integrationSecrets: dst.store,
		});

		const result = await importer.importBackup({ envelope: env, pin: "123456", mode: "overwrite" });

		expect(result.restoredIntegrations).toEqual(["bilibili"]);
		expect(result.unrestoredIntegrations).toEqual([
			{ key: "onebot", message: "主人，这个集成现在没在运行。" },
		]);
		expect(dstBili.secrets.get("refreshToken")).toBe("RT-1");
	});

	it("演练:分得出两堆,但目标的内存与盘一个字都不动", async () => {
		const src = await world();
		const srcBili = await src.store.open("bilibili");
		await srcBili.secrets.set("refreshToken", "RT-1");
		const env = await createBackupService({
			configStore: emptyConfigStore(),
			integrationSecrets: src.store,
		}).exportBackup({ kind: "full", pin: "123456" });

		const dst = await world();
		const dstBili = await dst.store.open("bilibili");
		await dstBili.secrets.set("refreshToken", "RT-OLD");
		const importer = createBackupService({
			configStore: emptyConfigStore(),
			integrationSecrets: dst.store,
		});

		const planned = await importer.importBackup({
			envelope: env,
			pin: "123456",
			mode: "overwrite",
			dryRun: true,
		});

		expect(planned.restoredIntegrations).toEqual(["bilibili"]);
		expect(dstBili.secrets.get("refreshToken")).toBe("RT-OLD");
		expect(await plainEntries(dst, "bilibili")).toEqual({ refreshToken: "RT-OLD" });
	});
});
