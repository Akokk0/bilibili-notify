/**
 * 加密袋里 0.x 单把的 `aiApiKey` → 分桶的 `aiApiKeys.custom`。原先是配置仓开机时做,「上一版加密袋里的单把
 * aiApiKey 也迁进 custom 槽」那一条抄到这里,期望值不变。接缝是「第 0 代 → 迁移器 → 拿新代那把密钥开袋子」:
 * 第 0 代的袋子用第 0 代的主密钥(或口令)加密,迁移器解袋要的正是同一把。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { describe, expect, it } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { type ConfigSecrets, createSecretStore } from "../../config/secret-store.js";
import { migrateSecretBag } from "../secrets.js";
import { migrateZeroGeneration, readZeroGenerationKey } from "../zero-generation.js";
import { useZeroSandbox } from "./support.js";

const BAG = ["secrets", "config-secrets.enc"] as const;

function keyProviderAt(root: string, passphrase?: string): KeyProvider {
	return createKeyProvider({
		passphrase,
		keyPath: join(root, "secrets", "master.key"),
		saltPath: join(root, "secrets", "kdf.salt"),
		logger: silentLogger,
	});
}

/** 一个根上的袋子(用那个根上的密钥开)。 */
function bagAt(root: string, passphrase?: string) {
	return createSecretStore({
		filePath: join(root, ...BAG),
		keyProvider: keyProviderAt(root, passphrase),
		logger: silentLogger,
	});
}

/** 0.x 的袋子比现在多一格单把的 `aiApiKey`。 */
const zeroBag = (bag: { aiApiKey?: string; aiApiKeys?: Record<string, string> }) =>
	bag as ConfigSecrets;

describe("0.x 加密袋里单把的 aiApiKey → 分桶的 custom", () => {
	const sandbox = useZeroSandbox("bn-zero-secrets-");

	it("上一版加密袋里的单把 aiApiKey 也迁进 custom 槽", async () => {
		// 已经启用过加密的老用户:明文早就不在盘上了,那把 key 在袋子里叫 aiApiKey。
		await bagAt(sandbox.zero).save(zeroBag({ aiApiKey: "sk-in-old-bag" }));

		const report = await sandbox.migrate();

		const bag = (await bagAt(sandbox.target).load()) as ConfigSecrets & { aiApiKey?: string };
		expect(bag.aiApiKeys).toEqual({ custom: "sk-in-old-bag" });
		expect(bag.aiApiKey).toBeUndefined();
		expect(report.rewritten).toContain(BAG.join("/"));
	});

	it("分桶里已经有 custom:分桶那把优先,别家的原样留着", async () => {
		await bagAt(sandbox.zero).save(
			zeroBag({ aiApiKey: "sk-single", aiApiKeys: { custom: "sk-bucket", deepseek: "sk-d" } }),
		);

		await sandbox.migrate();

		expect(await bagAt(sandbox.target).load()).toEqual({
			aiApiKeys: { custom: "sk-bucket", deepseek: "sk-d" },
		});
	});

	it("没有单把那格:袋子原样留着,不进改写名单", async () => {
		await bagAt(sandbox.zero).save({ aiApiKeys: { deepseek: "sk-d" } });
		const before = await readFile(join(sandbox.zero, ...BAG), "utf8");

		const report = await sandbox.migrate();

		expect(await readFile(join(sandbox.target, ...BAG), "utf8")).toBe(before);
		expect(report.rewritten).not.toContain(BAG.join("/"));
	});

	it("解不开(袋子是用口令加密的、迁移时没给口令):原样留着,配置仓开机时照旧当空袋", async () => {
		await bagAt(sandbox.zero, "the-passphrase").save(zeroBag({ aiApiKey: "sk-locked" }));
		const before = await readFile(join(sandbox.zero, ...BAG), "utf8");

		const report = await sandbox.migrate();

		expect(await readFile(join(sandbox.target, ...BAG), "utf8")).toBe(before);
		expect(report.rewritten).not.toContain(BAG.join("/"));
	});

	it("给了口令就用口令派生的那把解袋", async () => {
		await bagAt(sandbox.zero, "the-passphrase").save(zeroBag({ aiApiKey: "sk-locked" }));

		await migrateZeroGeneration({
			zeroRoot: sandbox.zero,
			targetDir: sandbox.target,
			passphrase: "the-passphrase",
		});

		expect((await bagAt(sandbox.target, "the-passphrase").load()).aiApiKeys).toEqual({
			custom: "sk-locked",
		});
	});

	it("迁两遍和迁一遍一样", async () => {
		await bagAt(sandbox.zero).save(zeroBag({ aiApiKey: "sk-in-old-bag" }));
		await sandbox.migrate();
		const path = join(sandbox.target, ...BAG);
		const before = await readFile(path, "utf8");

		const again = await migrateSecretBag(
			path,
			await readZeroGenerationKey(sandbox.zero, undefined),
		);

		expect(again).toEqual([]);
		expect(await readFile(path, "utf8")).toBe(before);
	});
});
