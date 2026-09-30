/**
 * 选代与开代(ADR-0022 决策 1–3 与它们下面的 🔗)。
 *
 * 代目录按递增序号放在 `<dataDir>/generations/<序号>/`,写到一半的叫 `<序号>.partial/`。开新代一律拿
 * 下一个号,旧代原地不动;选代在「格式版本 ≤ 我」的代里取序号最大的。开发期还有一条:当前代的迁移
 * 修订号和代码对不上,就照它当初的来源重开一代(第 0 代迁来的从第 0 代重迁,空代就再开空代)。
 *
 * 全部对真目录测:摆好几代,看选中谁、开出来的长什么样。
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	createGeneration,
	GENERATION_FILE,
	type GenerationFile,
	type GenerationSource,
	selectGeneration,
} from "../generations.js";

let hostRoot: string;
let generations: string;

beforeEach(async () => {
	hostRoot = await mkdtemp(join(tmpdir(), "bn-generations-"));
	generations = join(hostRoot, "generations");
});

afterEach(async () => {
	await rm(hostRoot, { recursive: true, force: true });
});

/** 摆一代完整的:目录 + generation.json。 */
async function placeGeneration(
	seq: number,
	over: { formatVersion?: number; migrationRevision?: number; source?: GenerationSource } = {},
) {
	const dir = join(generations, String(seq));
	await mkdir(dir, { recursive: true });
	const file: GenerationFile = {
		formatVersion: over.formatVersion ?? 1,
		migrationRevision: over.migrationRevision ?? 7,
		createdAt: "2026-10-01T00:00:00.000Z",
		createdBy: "1.0.0-dev",
		lastActiveAt: "2026-10-01T00:00:00.000Z",
		source: over.source ?? { kind: "zero" },
	};
	await writeFile(join(dir, GENERATION_FILE), JSON.stringify(file));
	return dir;
}

const select = (zeroGenerationExists: boolean) =>
	selectGeneration({ hostRoot, formatVersion: 1, migrationRevision: 7, zeroGenerationExists });

describe("selectGeneration", () => {
	it("一代都没有、也没有 0.x 的数据 → 开第 1 代,空的", async () => {
		expect(await select(false)).toEqual({
			kind: "create",
			seq: 1,
			dir: join(generations, "1"),
			partialDir: join(generations, "1.partial"),
			source: { kind: "empty" },
			leftovers: [],
		});
	});

	it("一代都没有、宿主根上有 0.x 的数据 → 开第 1 代,从第 0 代迁", async () => {
		expect(await select(true)).toMatchObject({ kind: "create", seq: 1, source: { kind: "zero" } });
	});

	it("有合用的代 → 用序号最大的那一代", async () => {
		await placeGeneration(1);
		await placeGeneration(2);

		expect(await select(true)).toEqual({ kind: "use", seq: 2, dir: join(generations, "2") });
	});

	it("格式版本比我新的代不选(回退到旧版时)", async () => {
		await placeGeneration(1);
		await placeGeneration(2, { formatVersion: 2 });

		expect(await select(true)).toEqual({ kind: "use", seq: 1, dir: join(generations, "1") });
	});

	it("只有格式比我新的代 → 开新的一代,号接着往后排", async () => {
		await placeGeneration(1, { formatVersion: 2 });

		expect(await select(true)).toMatchObject({ kind: "create", seq: 2, source: { kind: "zero" } });
	});

	it("修订号对不上、它是从第 0 代迁来的 → 从第 0 代重迁,开下一个号,旧的原地不动", async () => {
		const old = await placeGeneration(1, { migrationRevision: 6 });

		expect(await select(true)).toMatchObject({ kind: "create", seq: 2, source: { kind: "zero" } });
		expect(existsSync(old)).toBe(true);
	});

	it("修订号对不上、它当初是空代 → 再开一代空的", async () => {
		await placeGeneration(1, { migrationRevision: 6, source: { kind: "empty" } });

		expect(await select(true)).toMatchObject({ kind: "create", seq: 2, source: { kind: "empty" } });
	});

	it("写到一半的 .partial 不算一代,号也不重用,交出来等着清", async () => {
		await placeGeneration(1, { migrationRevision: 6 });
		await mkdir(join(generations, "2.partial"), { recursive: true });

		expect(await select(true)).toMatchObject({
			kind: "create",
			seq: 3,
			leftovers: [join(generations, "2.partial")],
		});
	});

	it("没有 generation.json 或读不懂的目录不算一代,号也不重用", async () => {
		await mkdir(join(generations, "1"), { recursive: true });
		await mkdir(join(generations, "2"), { recursive: true });
		await writeFile(join(generations, "2", GENERATION_FILE), "{ not json");

		expect(await select(true)).toMatchObject({ kind: "create", seq: 3 });
	});

	it("generations/ 里别的名字不理", async () => {
		await placeGeneration(1);
		await mkdir(join(generations, "notes"), { recursive: true });
		await writeFile(join(generations, ".DS_Store"), "");

		expect(await select(true)).toEqual({ kind: "use", seq: 1, dir: join(generations, "1") });
	});
});

describe("createGeneration", () => {
	it("在 .partial 里搭好,写上 generation.json,再改名成正式的一代;搭的时候正式的还不存在", async () => {
		const selection = await select(true);
		if (selection.kind !== "create") throw new Error("expected create");
		let finalExistedDuringFill = true;

		await createGeneration(selection, {
			formatVersion: 1,
			migrationRevision: 7,
			createdBy: "1.0.0-dev",
			fill: async (partialDir) => {
				expect(partialDir).toBe(selection.partialDir);
				finalExistedDuringFill = existsSync(selection.dir);
				await writeFile(join(partialDir, "marker"), "x");
			},
		});

		expect(finalExistedDuringFill).toBe(false);
		expect(existsSync(selection.partialDir)).toBe(false);
		expect(await readFile(join(selection.dir, "marker"), "utf8")).toBe("x");
		const file = JSON.parse(
			await readFile(join(selection.dir, GENERATION_FILE), "utf8"),
		) as GenerationFile;
		expect(file).toMatchObject({
			formatVersion: 1,
			migrationRevision: 7,
			createdBy: "1.0.0-dev",
			source: { kind: "zero" },
		});
		expect(file.lastActiveAt).toBe(file.createdAt);
		expect(Number.isNaN(Date.parse(file.createdAt))).toBe(false);
		expect(await select(true)).toEqual({ kind: "use", seq: 1, dir: selection.dir });
	});

	it("搭的时候抛了 → 没有新的一代,.partial 也不留", async () => {
		const selection = await select(true);
		if (selection.kind !== "create") throw new Error("expected create");

		await expect(
			createGeneration(selection, {
				formatVersion: 1,
				migrationRevision: 7,
				createdBy: "1.0.0-dev",
				fill: async () => {
					throw new Error("disk full");
				},
			}),
		).rejects.toThrow("disk full");

		expect(await readdir(generations).catch(() => [])).toEqual([]);
	});

	it("先清掉上次留下的半截", async () => {
		await placeGeneration(1, { migrationRevision: 6 });
		await mkdir(join(generations, "2.partial", "state"), { recursive: true });
		const selection = await select(true);
		if (selection.kind !== "create") throw new Error("expected create");

		await createGeneration(selection, {
			formatVersion: 1,
			migrationRevision: 7,
			createdBy: "1.0.0-dev",
			fill: async () => {},
		});

		expect((await readdir(generations)).sort()).toEqual(["1", "3"]);
	});
});
