import {
	complainAboutSkill,
	isValidSkillName,
	MAID_SKILL_LIMITS,
	MAID_SKILL_NAME_RE,
} from "@bilibili-notify/contract";
import type { AiTool, AiToolProvider, Disposable, MaidSkill } from "@bilibili-notify/internal";
import { createRegistry } from "../integrations/registry.js";
import { BUILTIN_SKILL_NAMES } from "../maid-skills/builtin.js";

/**
 * 来源登记的 AI 工具提供方:一个来源键一个主人。提供方给的是工具本名,
 * 宿主在这里统一加命名空间,模型和技能里看到的都是全名。
 */
export interface AiToolProviderRegistry {
	/** 认领键并登记整组工具;键被占了就抛。把手只撤自己这一行,撤了可以重登。 */
	register(key: string, provider: AiToolProvider): Disposable;
	/** 全表工具,按提供方登记先后摊平;每把的名称已经带好命名空间。 */
	tools(): AiTool[];
	/** 全表技能,按提供方登记先后摊平;每条的名称已经带好技能命名空间。 */
	skills(): MaidSkill[];
}

const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_FULL_NAME_LENGTH = 64;

function namespaceOf(key: string): string {
	return key.replace(/[^A-Za-z0-9_-]/g, "_");
}

function skillNamespaceOf(key: string): string {
	return key
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** 只改定义里的函数名;标签可能是 getter,必须继续往原工具现读。 */
function namespaced(tool: AiTool, fullName: string): AiTool {
	return {
		definition: {
			...tool.definition,
			function: { ...tool.definition.function, name: fullName },
		},
		get label() {
			return tool.label;
		},
		get labelArg() {
			return tool.labelArg;
		},
		execute: (args, onProgress) => tool.execute(args, onProgress),
	};
}

export function createAiToolProviderRegistry(): AiToolProviderRegistry {
	const table = createRegistry<AiToolProvider>(
		(key) => `AI tool provider for key "${key}" is already registered`,
	);
	return {
		register(key, provider) {
			const namespace = namespaceOf(key);
			for (const [otherKey] of table.entries()) {
				if (otherKey !== key && namespaceOf(otherKey) === namespace) {
					throw new Error(
						`AI tool provider keys "${key}" and "${otherKey}" share namespace "${namespace}"`,
					);
				}
			}

			const seen = new Set<string>();
			const readOnly = provider.readOnly.map((tool) => {
				const localName = tool.definition.function.name;
				if (!TOOL_NAME.test(localName)) {
					throw new Error(`AI tool name "${localName}" from provider key "${key}" is invalid`);
				}
				if (seen.has(localName)) {
					throw new Error(
						`AI tool name "${localName}" from provider key "${key}" is registered more than once`,
					);
				}
				seen.add(localName);
				const fullName = `${namespace}__${localName}`;
				if (fullName.length > MAX_FULL_NAME_LENGTH) {
					throw new Error(
						`AI tool name "${fullName}" from provider key "${key}" exceeds 64 characters`,
					);
				}
				return namespaced(tool, fullName);
			});

			const skillNamespace = skillNamespaceOf(key);
			const seenSkills = new Set<string>();
			const registeredSkills = Array.from(table.entries()).flatMap(
				([, other]) => other.skills ?? [],
			);
			const skills = provider.skills?.map((skill) => {
				const localName = skill.name;
				if (!MAID_SKILL_NAME_RE.test(localName)) {
					throw new Error(`AI skill name "${localName}" from provider key "${key}" is invalid`);
				}
				if (seenSkills.has(localName)) {
					throw new Error(
						`AI skill name "${localName}" from provider key "${key}" is registered more than once`,
					);
				}
				seenSkills.add(localName);
				const fullName = `${skillNamespace}-${localName}`;
				if (!isValidSkillName(fullName)) {
					if (fullName.length > MAID_SKILL_LIMITS.nameChars) {
						throw new Error(
							`AI skill name "${fullName}" from provider key "${key}" exceeds ${MAID_SKILL_LIMITS.nameChars} characters`,
						);
					}
					throw new Error(`AI skill name "${fullName}" from provider key "${key}" is invalid`);
				}
				const complaint = complainAboutSkill({ ...skill, name: fullName });
				if (complaint !== null) {
					throw new Error(
						`AI skill "${fullName}" from provider key "${key}" is invalid: ${complaint}`,
					);
				}
				if (BUILTIN_SKILL_NAMES.has(fullName)) {
					throw new Error(
						`AI skill name "${fullName}" from provider key "${key}" conflicts with a built-in skill`,
					);
				}
				const collision = registeredSkills.find((other) => other.name === fullName);
				if (collision) {
					const owner = Array.from(table.entries()).find(([, other]) =>
						other.skills?.some((candidate) => candidate === collision),
					)?.[0];
					throw new Error(
						`AI skill name "${fullName}" from provider key "${key}" is already registered by provider key "${owner}"`,
					);
				}
				for (const toolName of skill.allowedTools ?? []) {
					if (toolName.includes("__") && !toolName.startsWith(`${namespace}__`)) {
						throw new Error(
							`AI skill "${fullName}" from provider key "${key}" references tool "${toolName}" from another namespace`,
						);
					}
				}
				return {
					...skill,
					name: fullName,
					...(skill.allowedTools === undefined ? {} : { allowedTools: [...skill.allowedTools] }),
				};
			});
			const wrapped: AiToolProvider = {
				readOnly,
				...(skills === undefined ? {} : { skills }),
			};
			return table.claim(key, wrapped);
		},
		tools() {
			return Array.from(table.entries()).flatMap(([, provider]) => [...provider.readOnly]);
		},
		skills() {
			return Array.from(table.entries()).flatMap(([, provider]) => [...(provider.skills ?? [])]);
		},
	};
}
