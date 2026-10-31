/**
 * 「AI 工具与技能约束」守卫（docs/1.0/architecture.md 守卫表里的一行）。
 *
 * 四条判据各自防这些无声越界：
 * 1. 核心工具又按平台 id 收人，`uid` 这类平台专有参数从入口漏回核心；
 * 2. 聊天工具漏配给人看的标签，或标签引用了自己的参数表里不存在的格子；
 * 3. 中立技能偷偷依赖 B 站工具，或提供方技能引用了自己命名空间以外的能力；
 * 4. 声明依赖的工具不在场时，技能仍出现在列表与按名读取里。
 *
 * 这些都是「工具或技能只对 B 站成立」的影子。守卫开张时全部满足，所以不带棘轮；
 * 以后任何一条退化都直接红。缺工具隐藏的完整行为组见
 * `apps/server/src/maid-skills/__tests__/reader.test.ts`，这里只留一条读口直断言。
 */

import {
	type AiTool,
	coreToolLabelOf,
	type PromptNouns,
	TOOL_DEFINITIONS,
	WEB_SEARCH_TOOL_NAME,
} from "@bilibili-notify/ai";
import type { Logger, MaidSkill } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createBiliAiToolProvider } from "../../bilibili/ai-tools.js";
import { createCardWorkshopTools } from "../../card-skins/chat-tools.js";
import { BUILTIN_SKILLS } from "../../maid-skills/builtin.js";
import { createSkillChatTool } from "../../maid-skills/chat-tool.js";
import { createMaidSkillReader, skillToolNames } from "../../maid-skills/reader.js";
import type { MaidSkillEntry, MaidSkillStore } from "../../maid-skills/store.js";
import { createSkinChatTools } from "../../skins/chat-tool.js";
import { createAiToolProviderRegistry } from "../tool-provider-registry.js";

const NOUNS: PromptNouns = {
	creatorNoun: "创作者",
	postNoun: "作品",
	sources: "各平台",
};

/** 工具 JSON Schema 里声明过的全部参数名，包括嵌套对象里的参数。 */
function parameterNames(parameters: Record<string, unknown> | undefined): string[] {
	const names = new Set<string>();

	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;

		const record = value as Record<string, unknown>;
		const properties = record.properties;
		if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
			for (const [name, schema] of Object.entries(properties)) {
				names.add(name);
				visit(schema);
			}
		}
		for (const [key, child] of Object.entries(record)) {
			if (key !== "properties") visit(child);
		}
	};

	visit(parameters);
	return [...names];
}

function injectedTools(): AiTool[] {
	const skill = createSkillChatTool([
		{
			name: "weekly-report",
			description: "周报",
			disableModelInvocation: false,
			body: "正文",
			builtin: true,
		},
	]);
	if (!skill) throw new Error("load_skill 没有建出来");

	const skins = createSkinChatTools({ skinStore: {} as never, generator: () => null });
	const cards = createCardWorkshopTools({
		store: {} as never,
		ledger: { owned: [], forks: {} },
		record: async () => {},
		activeId: () => "default",
	}).tools;
	return [skill, ...skins, ...cards];
}

function builtinEntries(): MaidSkillEntry[] {
	return BUILTIN_SKILLS.map(({ aliases, ...skill }) => ({
		...skill,
		allowedTools: skill.allowedTools ? [...skill.allowedTools] : undefined,
		...(aliases ? { aliases: [...aliases] } : {}),
		builtin: true,
	}));
}

describe("AI 工具与技能约束", () => {
	it("核心工具的参数不按平台 uid 收人，收人的参数统一叫 creator", () => {
		const byName = new Map(
			TOOL_DEFINITIONS.map((tool) => [
				tool.function.name,
				{
					parameters: tool.function.parameters as Record<string, unknown>,
				},
			]),
		);

		for (const [name, tool] of byName) {
			const names = parameterNames(tool.parameters);
			expect(
				names.filter((key) => /uid/i.test(key)),
				name,
			).toEqual([]);
		}

		for (const name of ["get_creator_posts", "get_creator_profile", "get_creator_stats"]) {
			const parameters = byName.get(name)?.parameters;
			expect(parameterNames(parameters), name).toContain("creator");
			const properties = parameters?.properties as
				| Record<string, { description?: string }>
				| undefined;
			expect(properties?.creator?.description ?? "", name).toContain("creator");
		}
	});

	it("聊天里挂得出的每把工具都有非空标签，labelArg 只引用自己的参数", () => {
		const core = [
			...TOOL_DEFINITIONS.map((tool) => {
				const name = tool.function.name;
				const fields = coreToolLabelOf(name);
				return {
					name,
					label: fields?.label ?? "",
					...(fields?.labelArg ? { labelArg: fields.labelArg } : {}),
					parameterNames: parameterNames(tool.function.parameters as Record<string, unknown>),
				};
			}),
			// 联网搜索与看图的定义不从 `@bilibili-notify/ai` 入口导出,参数名照定义手写;它们的标签入参由
			// `coreToolLabelOf` 按定义的 `required` 算,`packages/ai` 的标签测试另有一道管着。
			...[WEB_SEARCH_TOOL_NAME, "describe_image"].map((name) => {
				const fields = coreToolLabelOf(name);
				return {
					name,
					label: fields?.label ?? "",
					...(fields?.labelArg ? { labelArg: fields.labelArg } : {}),
					parameterNames:
						name === WEB_SEARCH_TOOL_NAME ? ["query"] : name === "describe_image" ? ["index"] : [],
				};
			}),
		];

		const offered = injectedTools().map((tool) => ({
			name: tool.definition.function.name,
			label: tool.label,
			...(tool.labelArg ? { labelArg: tool.labelArg } : {}),
			parameterNames: Object.keys(
				(tool.definition.function.parameters?.properties ?? {}) as Record<string, unknown>,
			),
		}));
		const bili = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: {} as never,
		}).readOnly.map((tool) => ({
			name: tool.definition.function.name,
			label: tool.label,
			...(tool.labelArg ? { labelArg: tool.labelArg } : {}),
			parameterNames: Object.keys(
				(tool.definition.function.parameters?.properties ?? {}) as Record<string, unknown>,
			),
		}));
		const chatTools = [...core, ...offered, ...bili];

		// 每一家都真挂出了工具(防哪个工厂悄悄交空表、让这条判据空转)。
		for (const [family, tools] of Object.entries({ core, offered, bili })) {
			expect(tools.length, family).toBeGreaterThan(0);
		}
		expect(new Set(chatTools.map((tool) => tool.name)).size).toBe(chatTools.length);
		for (const tool of chatTools) {
			expect(tool.label.trim(), tool.name).not.toBe("");
			if (!tool.labelArg) continue;
			expect(tool.labelArg.keys.length, tool.name).toBeGreaterThan(0);
			for (const key of tool.labelArg.keys) {
				expect(tool.parameterNames, `${tool.name} 的 labelArg.${key}`).toContain(key);
			}
		}
	});

	it("内置技能只用核心中立工具，提供方技能只用自己的或核心工具", () => {
		const providers = createAiToolProviderRegistry();
		const coreToolNames = new Set(skillToolNames(providers));
		expect([...coreToolNames].filter((name) => name.includes("__"))).toEqual([]);

		for (const skill of BUILTIN_SKILLS) {
			for (const name of skill.allowedTools ?? []) {
				expect(coreToolNames, `${skill.name} 声明了 ${name}`).toContain(name);
			}
		}

		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: {} as never,
		});
		providers.register("bilibili", provider);
		const ownToolNames = providers.tools().map((tool) => tool.definition.function.name);
		expect(ownToolNames).toEqual(["bilibili__get_up_totals", "bilibili__get_up_videos"]);
		const allowed = new Set([...coreToolNames, ...ownToolNames]);
		const weekly = providers.skills().find((skill) => skill.name === "bilibili-weekly-report");
		expect(weekly).toBeDefined();
		for (const name of weekly?.allowedTools ?? []) {
			expect(allowed, `bilibili-weekly-report 声明了 ${name}`).toContain(name);
		}
	});

	it("提供方或内置技能缺了声明的工具，列表不列、按名也拿不到", () => {
		const builtins = builtinEntries();
		const hiddenBuiltin = builtins[0];
		if (!hiddenBuiltin) throw new Error("内置技能表不能为空");
		hiddenBuiltin.allowedTools = [...(hiddenBuiltin.allowedTools ?? []), "missing_core_tool"];

		const store = {
			list: () => builtins,
			reload: async () => {},
			problems: () => [],
		} as unknown as MaidSkillStore;
		const providers = createAiToolProviderRegistry();
		const providerSkill: MaidSkill = {
			name: "incomplete",
			description: "声明了一把不在场的工具",
			allowedTools: ["acme__missing"],
			disableModelInvocation: false,
			body: "正文",
		};
		providers.register("acme", { readOnly: [], skills: [providerSkill] });

		const reader = createMaidSkillReader({
			store,
			providers,
			logger: { warn: () => {} } satisfies Pick<Logger, "warn">,
			nouns: () => NOUNS,
		});
		const names = reader.list().map((skill) => skill.name);
		expect(names).not.toContain(hiddenBuiltin.name);
		expect(names).not.toContain("acme-incomplete");
		expect(reader.get(hiddenBuiltin.name)).toBeUndefined();
		expect(reader.get("acme-incomplete")).toBeUndefined();
		expect(reader.get(BUILTIN_SKILLS[1]?.name ?? "")).toBeDefined();
	});
});
