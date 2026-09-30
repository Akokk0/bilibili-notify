import { MIGRATION_REVISION } from "../../migration/zero-generation.js";
import { createGeneration, FORMAT_VERSION, selectGeneration } from "../../runtime/generations.js";

/**
 * 在 `dataDir` 下开好一代空的、回它的目录(ADR-0022 数据代)。测试要在开机前摆数据、装拓展,就摆进
 * 这一代(照代的布局:`config/`、`runtime/`、`extensions/`……),开机直接用它,不走迁移。已经有合用的
 * 一代就回那一代。
 *
 * 只有专门测「0.x → 1.0 迁移」的测试才往 `dataDir` 根上摆 0.x 的文件(第 0 代),而且不能先调这个 ——
 * 有了合用的一代,开机就不迁了。
 */
export async function openTestGeneration(dataDir: string): Promise<string> {
	const selection = await selectGeneration({
		hostRoot: dataDir,
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		zeroGenerationExists: false,
	});
	if (selection.kind === "use") return selection.dir;
	await createGeneration(selection, {
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		createdBy: "test",
		fill: async () => {},
	});
	return selection.dir;
}

/** 开机之后在用的那一代的目录(开机时迁出来的,或 {@link openTestGeneration} 开的)。 */
export async function activeGeneration(dataDir: string): Promise<string> {
	const selection = await selectGeneration({
		hostRoot: dataDir,
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		zeroGenerationExists: false,
	});
	if (selection.kind !== "use") throw new Error(`${dataDir} 里还没有一代`);
	return selection.dir;
}
