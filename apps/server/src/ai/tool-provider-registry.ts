import type { AiTool, AiToolProvider, Disposable } from "@bilibili-notify/internal";
import { createRegistry } from "../integrations/registry.js";

/**
 * 来源登记的 AI 工具提供方:一个来源键一个主人。提供方给的是工具本名,
 * 宿主在这里统一加命名空间,模型和技能里看到的都是全名。
 */
export interface AiToolProviderRegistry {
	/** 认领键并登记整组工具;键被占了就抛。把手只撤自己这一行,撤了可以重登。 */
	register(key: string, provider: AiToolProvider): Disposable;
	/** 全表工具,按提供方登记先后摊平;每把的名称已经带好命名空间。 */
	tools(): AiTool[];
}

const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_FULL_NAME_LENGTH = 64;

function namespaceOf(key: string): string {
	return key.replace(/[^A-Za-z0-9_-]/g, "_");
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

			const wrapped: AiToolProvider = { readOnly };
			return table.claim(key, wrapped);
		},
		tools() {
			return Array.from(table.entries()).flatMap(([, provider]) => [...provider.readOnly]);
		},
	};
}
