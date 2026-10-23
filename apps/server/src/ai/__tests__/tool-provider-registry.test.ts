import { TOOL_DEFINITIONS, WEB_SEARCH_TOOL_NAME } from "@bilibili-notify/ai";
import { type AiTool, ok } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createAiToolProviderRegistry } from "../tool-provider-registry.js";

function tool(
	name: string,
	label = `查看 ${name}`,
	labelArg: AiTool["labelArg"] = { keys: ["creator"] },
): AiTool {
	return {
		definition: {
			type: "function",
			function: {
				name,
				description: `调用 ${name}`,
				parameters: { type: "object", properties: { creator: { type: "string" } } },
			},
		},
		label,
		labelArg,
		execute: async (args) => ok({ text: `${name}:${args.creator ?? ""}` }),
	};
}

describe("createAiToolProviderRegistry", () => {
	it("按登记先后摊平工具,宿主加命名空间;撤销后可以重新登记", () => {
		const registry = createAiToolProviderRegistry();
		const echo = tool("echo");
		const totals = tool("get_up_totals");
		const first = registry.register("acme.inprocess", { readOnly: [echo] });
		registry.register("bilibili", { readOnly: [totals] });

		expect(registry.tools().map((t) => t.definition.function.name)).toEqual([
			"acme_inprocess__echo",
			"bilibili__get_up_totals",
		]);
		expect(registry.tools()[0]).not.toBe(echo);
		expect(echo.definition.function.name).toBe("echo");

		first.dispose();
		expect(registry.tools().map((t) => t.definition.function.name)).toEqual([
			"bilibili__get_up_totals",
		]);
		registry.register("acme.inprocess", { readOnly: [echo] });
		expect(registry.tools().map((t) => t.definition.function.name)).toEqual([
			"bilibili__get_up_totals",
			"acme_inprocess__echo",
		]);
	});

	it("包出来的工具转发 execute,label / labelArg 用 getter 现读原工具", async () => {
		const registry = createAiToolProviderRegistry();
		let label = "第一版";
		let labelArg: AiTool["labelArg"] = { keys: ["creator"] };
		const original: AiTool = {
			...tool("echo"),
			get label() {
				return label;
			},
			get labelArg() {
				return labelArg;
			},
		};
		registry.register("acme.inprocess", { readOnly: [original] });
		const wrapped = registry.tools()[0];
		expect(wrapped).toBeDefined();
		if (!wrapped) throw new Error("登记的工具有没有出现");

		label = "第二版";
		labelArg = { keys: ["query"] };
		expect(wrapped.label).toBe("第二版");
		expect(wrapped.labelArg).toEqual({ keys: ["query"] });
		await expect(wrapped.execute({ creator: "alice" })).resolves.toEqual(
			ok({ text: "echo:alice" }),
		);
	});

	it("同一个键登第二个抛", () => {
		const registry = createAiToolProviderRegistry();
		registry.register("acme", { readOnly: [tool("first")] });
		expect(() => registry.register("acme", { readOnly: [tool("second")] })).toThrow(
			'AI tool provider for key "acme" is already registered',
		);
	});

	it("本名只允许 ASCII 字母、数字、下划线与连字符", () => {
		const registry = createAiToolProviderRegistry();
		expect(() => registry.register("acme", { readOnly: [tool("bad.name")] })).toThrow(
			'AI tool name "bad.name" from provider key "acme" is invalid',
		);
	});

	it("全名超过 64 个字符抛", () => {
		const registry = createAiToolProviderRegistry();
		const localName = "x".repeat(59);
		expect(() => registry.register("acme", { readOnly: [tool(localName)] })).toThrow(
			`AI tool name "acme__${localName}" from provider key "acme" exceeds 64 characters`,
		);
	});

	it("同一个提供方里本名重复抛", () => {
		const registry = createAiToolProviderRegistry();
		expect(() => registry.register("acme", { readOnly: [tool("echo"), tool("echo")] })).toThrow(
			'AI tool name "echo" from provider key "acme" is registered more than once',
		);
	});

	it("两个键换成命名空间后相撞抛", () => {
		const registry = createAiToolProviderRegistry();
		registry.register("a.b", { readOnly: [tool("first")] });
		expect(() => registry.register("a_b", { readOnly: [tool("second")] })).toThrow(
			'AI tool provider keys "a_b" and "a.b" share namespace "a_b"',
		);
	});

	it("核心工具名不含命名空间分隔符", () => {
		for (const name of [...TOOL_DEFINITIONS.map((t) => t.function.name), WEB_SEARCH_TOOL_NAME]) {
			expect(name).not.toContain("__");
		}
	});
});
