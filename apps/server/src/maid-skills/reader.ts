import { TOOL_DEFINITIONS, WEB_SEARCH_TOOL_NAME } from "@bilibili-notify/ai";
import type { Logger, MaidSkill } from "@bilibili-notify/internal";
import type { AiToolProviderRegistry } from "../ai/tool-provider-registry.js";
import type { MaidSkillEntry, MaidSkillStore, SkillProblem } from "./store.js";

/** 技能声明得着的工具名，与编辑器勾选框共用这一份。 */
export function skillToolNames(providers: Pick<AiToolProviderRegistry, "tools">): string[] {
	return [
		...TOOL_DEFINITIONS.map((tool) => tool.function.name),
		WEB_SEARCH_TOOL_NAME,
		...providers.tools().map((tool) => tool.definition.function.name),
	];
}

/**
 * 技能的读口:内置、提供方带来的、主人盘上的合成一张表。列表路由、`load_skill` 的目录、斜杠点名
 * 三处都读它,「缺工具就隐藏」只在这里判一次。写(建、改、删)照旧走技能库。
 */
export interface MaidSkillReader {
	/** 重读盘上主人那几条(技能库的 `reload`)。 */
	reload(): Promise<void>;
	list(): MaidSkillEntry[];
	get(name: string): MaidSkillEntry | undefined;
	problems(): SkillProblem[];
}

function missingTools(skill: MaidSkill, available: ReadonlySet<string>): string[] {
	return (skill.allowedTools ?? []).filter((name) => !available.has(name));
}

/**
 * 内置与提供方带来的技能,`allowedTools` 里有一把现在不在就不列、点名也拿不到(提供方撤了,它带来的技能
 * 跟着走)。主人自己的照列、照交集收窄,只记一条 warn —— 一个手误或一个暂时没起来的拓展就让技能从斜杠
 * 菜单里消失,比「女仆说这把工具没有」更难查(主人 2026-10-23 定)。同一条技能的同一个名字只在第一次
 * 查不到时记,那把工具回来后再丢再记。
 */
export function createMaidSkillReader(opts: {
	store: MaidSkillStore;
	providers: Pick<AiToolProviderRegistry, "skills" | "tools">;
	logger: Pick<Logger, "warn">;
}): MaidSkillReader {
	const { store, providers, logger } = opts;
	const warnedMissing = new Set<string>();

	function availableTools(): Set<string> {
		return new Set(skillToolNames(providers));
	}

	function warnMissingFromMine(skill: MaidSkillEntry, available: ReadonlySet<string>): void {
		for (const toolName of skill.allowedTools ?? []) {
			const key = `${skill.name}\0${toolName}`;
			if (available.has(toolName)) {
				warnedMissing.delete(key);
				continue;
			}
			if (warnedMissing.has(key)) continue;
			warnedMissing.add(key);
			logger.warn(`[maid-skills] 技能「${skill.name}」声明的工具「${toolName}」当前不存在`);
		}
	}

	function list(): MaidSkillEntry[] {
		const available = availableTools();
		const stored = store.list();
		const builtins = stored.filter((skill) => skill.builtin);
		const mine = stored.filter((skill) => !skill.builtin);
		for (const skill of mine) warnMissingFromMine(skill, available);

		const offered = providers.skills().map(
			(skill): MaidSkillEntry => ({
				...skill,
				...(skill.allowedTools === undefined ? {} : { allowedTools: [...skill.allowedTools] }),
				builtin: true,
			}),
		);
		// 提供方比技能库读盘晚登记时,盘上同名那份还在库里:提供方的占名,主人那份不列(下次读盘进 problems)。
		const offeredNames = new Set(offered.map((skill) => skill.name));
		return [
			...builtins.filter((skill) => missingTools(skill, available).length === 0),
			...offered.filter((skill) => missingTools(skill, available).length === 0),
			...mine.filter((skill) => !offeredNames.has(skill.name)),
		];
	}

	return {
		reload: () => store.reload(),
		list,
		get(name) {
			const skills = list();
			return (
				skills.find((skill) => skill.name === name) ??
				skills.find((skill) => skill.aliases?.includes(name))
			);
		},
		problems() {
			return store.problems();
		},
	};
}
