/**
 * 0.x 的界面皮肤经迁移器进新代(`migration/skins.ts`,⑥c)。0.x 各个版本留下的两样形状:
 *
 *   - `skins/active.json` 的旧单指针 `{id}`:按那套皮肤 `skin.json` 里有的模式落成深浅两个槽;
 *   - 每套皮肤的 `skin.json` 与出厂快照 `default.json`:v0.7.0 及之前清洗层烙进 css 的
 *     `pointer-events:none` / `z-index:-1`。
 *
 * 两样都在搬家那一次由迁移器改好,皮肤库开机只认最新的形状、读时不再翻译(也不再摘烙印)。
 *
 * 前两组用例原先钉在皮肤库的读时翻译上(`skins/__tests__/store.test.ts` 的「旧单指针 active.json({id}) → init
 * 迁移」与「读盘时摘掉旧版烙印」),读时翻译删掉时抄到这里,**期望值一个没改**:只是摆数据的位置从「皮肤目录里
 * 直接写一份老文件」换成「第 0 代(`skins/<id>/…`、`skins/active.json`)→ 迁移器 → 在新代上开真的皮肤库读回来」。
 * **前提被迁移器推翻、不得不换读法的一处**(「磁盘不主动回写」:现在迁移器就是那个回写的人)在用例旁边写明。
 *
 * 末一组是迁移器自己的钉:新代里不留老形状(直接读新代的文件,不经皮肤库);迁两遍和迁一遍一样。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkinManifest } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { DASHBOARD_SKINS_DIR, SkinStore } from "../../skins/store.js";
import { migrateDashboardSkins } from "../skins.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-skins-");

/** 在新代上开一次真的皮肤库(和 `app.ts` 同一个位置)。 */
async function openStore(): Promise<SkinStore> {
	const store = new SkinStore({ skinsDir: join(sandbox.target, ...DASHBOARD_SKINS_DIR) });
	await store.init();
	return store;
}

/** 迁一代,再在新代上开皮肤库。 */
async function migrateAndOpen(): Promise<SkinStore> {
	await sandbox.migrate();
	return openStore();
}

function makeManifest(overrides?: Partial<SkinManifest>): SkinManifest {
	return {
		schemaVersion: 1,
		name: "樱花夜",
		author: "测试",
		modes: { light: { colors: { accent: "#fb7299" } } },
		...overrides,
	};
}

describe("旧单指针 active.json({id}) → 深浅两个槽", () => {
	it("旧单指针 active.json({id}) → 迁移:按皮肤具备的模式落槽", async () => {
		const manifest = makeManifest({ name: "双装", modes: { light: {}, dark: {} } });
		await sandbox.placeZero("skins/dual/skin.json", manifest);
		await sandbox.placeZero("skins/active.json", { id: "dual" });

		const reborn = await migrateAndOpen();
		expect(reborn.getActive()).toEqual({ light: "dual", dark: "dual" });
	});
});

/**
 * 存量烙印。v0.7.0 及之前清洗层把 `pointer-events:none` / `z-index:-1` 烙进存盘的 css 字段;硬规矩挪去注入层
 * 之后,盘里那批要在搬家时摘掉 —— 否则编辑器展示、导出 zip、下一次保存全都带着旧烙印,保存还会对它刷警告。
 */
describe("搬家时摘掉旧版烙印", () => {
	const RESIDUE = '[data-bn="page"]::before{content:"";inset:0;pointer-events:none;z-index:-1}';

	it("进索引的 manifest 三个 css 字段都干净;第 0 代不动", async () => {
		const m = makeManifest({
			css: RESIDUE,
			modes: {
				light: { colors: { accent: "#fb7299" }, css: RESIDUE },
				dark: { colors: { accent: "#8ab4ff" }, css: RESIDUE },
			},
		});
		await sandbox.placeZero("skins/legacy-1/skin.json", m);

		const reborn = await migrateAndOpen();
		const got = await reborn.get("legacy-1");

		expect(got?.css).not.toContain("pointer-events");
		expect(got?.modes.light?.css).not.toContain("pointer-events");
		expect(got?.modes.dark?.css).not.toContain("z-index");
		expect(got?.css).toContain("inset:0");
		// 原件里这一句是「磁盘不主动回写」(皮肤库读时摘、不回写):现在摘的人是迁移器,新代里的文件被它改写了,
		// 所以「没被回写」的那一份换成第 0 代 —— 它是只读的原件,一个字节都不许动。
		expect(await readFile(join(sandbox.zero, "skins", "legacy-1", "skin.json"), "utf8")).toContain(
			"pointer-events",
		);
	});

	it("出厂快照(default.json)同样摘 —— 恢复默认值不该把烙印灌回草稿", async () => {
		const m = makeManifest({ css: RESIDUE });
		await sandbox.placeZero("skins/legacy-2/skin.json", makeManifest());
		await sandbox.placeZero("skins/legacy-2/default.json", m);

		const reborn = await migrateAndOpen();
		const snap = await reborn.getDefault("legacy-2");

		expect(snap?.css).not.toContain("pointer-events");
		expect(snap?.css).toContain("inset:0");
	});
});

describe("迁移器自己的钉", () => {
	const RESIDUE = '[data-bn="page"]::before{content:"";inset:0;pointer-events:none;z-index:-1}';
	const TARGET_SKINS = () => join(sandbox.target, ...DASHBOARD_SKINS_DIR);

	/** 摆一份 0.x 的皮肤库:一套带烙印的双模式皮肤(清单与快照都带)、一套干净的纯暗皮肤、一份旧单指针。 */
	async function placeLegacyLibrary(): Promise<void> {
		const dirty = makeManifest({
			name: "双装",
			css: RESIDUE,
			modes: {
				light: { colors: { accent: "#fb7299" }, css: RESIDUE },
				dark: { colors: { accent: "#8ab4ff" }, css: RESIDUE },
			},
		});
		await sandbox.placeZero("skins/dual/skin.json", dirty);
		await sandbox.placeZero("skins/dual/default.json", dirty);
		await sandbox.placeZero(
			"skins/night/skin.json",
			makeManifest({ name: "夜装", modes: { dark: {} } }),
		);
		await sandbox.placeZero("skins/active.json", { id: "dual" });
	}

	/** 新代皮肤库根下的每个文件(相对路径 → 原文),按路径排好。 */
	async function snapshot(): Promise<[string, string][]> {
		const out: [string, string][] = [];
		for (const entry of (await readdir(TARGET_SKINS(), { recursive: true })).sort()) {
			try {
				out.push([entry, await readFile(join(TARGET_SKINS(), entry), "utf8")]);
			} catch (err) {
				// 目录本身读不了文本,跳过;别的错照抛。
				if ((err as NodeJS.ErrnoException).code !== "EISDIR") throw err;
			}
		}
		return out;
	}

	it("新代里不留老形状:active.json 没有 id 键、清单与快照的 css 里没有烙印", async () => {
		await placeLegacyLibrary();
		const report = await sandbox.migrate();
		expect(report.rewritten).toEqual(
			expect.arrayContaining([
				"skins/dashboard/dual/skin.json",
				"skins/dashboard/dual/default.json",
				"skins/dashboard/active.json",
			]),
		);

		const active = JSON.parse(
			await readFile(join(TARGET_SKINS(), "active.json"), "utf8"),
		) as Record<string, unknown>;
		expect(active).not.toHaveProperty("id");
		expect(active).toEqual({ light: "dual", dark: "dual" });

		for (const name of ["skin.json", "default.json"]) {
			const text = await readFile(join(TARGET_SKINS(), "dual", name), "utf8");
			expect(text).not.toContain("pointer-events");
			expect(text).not.toContain("z-index");
			const manifest = JSON.parse(text) as SkinManifest;
			// 摘的只是那两句:别的字照旧在。
			expect(manifest.css).toContain("inset:0");
			expect(manifest.modes.light?.css).toContain("inset:0");
			expect(manifest.modes.dark?.css).toContain("inset:0");
			expect(manifest.modes.light?.colors).toEqual({ accent: "#fb7299" });
		}
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],文件字节不变", async () => {
		await placeLegacyLibrary();
		const report = await sandbox.migrate();
		expect(report.rewritten).toContain("skins/dashboard/active.json");

		const before = await snapshot();
		expect(before.map(([name]) => name)).toEqual(
			expect.arrayContaining([
				"active.json",
				"dual/skin.json",
				"dual/default.json",
				"night/skin.json",
			]),
		);

		expect(await migrateDashboardSkins(sandbox.target)).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});
});
