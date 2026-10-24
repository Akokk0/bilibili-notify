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

function skill(
	name: string,
	allowedTools?: string[],
): {
	name: string;
	description: string;
	allowedTools?: string[];
	disableModelInvocation: boolean;
	body: string;
} {
	return {
		name,
		description: `使用 ${name}`,
		...(allowedTools === undefined ? {} : { allowedTools }),
		disableModelInvocation: false,
		body: `执行 ${name}`,
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

	it("提供方的技能带上宿主命名空间，撤销后不再列出，且不改原对象", () => {
		const registry = createAiToolProviderRegistry();
		const original = skill("echo-check", ["acme_inprocess__echo"]);
		const claim = registry.register("acme.inprocess", {
			readOnly: [tool("echo")],
			skills: [original],
		});

		expect(registry.skills()).toEqual([
			{
				name: "acme-inprocess-echo-check",
				description: "使用 echo-check",
				allowedTools: ["acme_inprocess__echo"],
				disableModelInvocation: false,
				body: "执行 echo-check",
			},
		]);
		expect(registry.skills()[0]).not.toBe(original);
		expect(original.name).toBe("echo-check");

		claim.dispose();
		expect(registry.skills()).toEqual([]);
	});

	it("技能命名空间把首尾连续的非法字符一并去掉", () => {
		const registry = createAiToolProviderRegistry();
		registry.register("..ACME..", { readOnly: [], skills: [skill("echo-check")] });
		expect(registry.skills().map((candidate) => candidate.name)).toEqual(["acme-echo-check"]);
	});

	it("技能本名、全名、组内重名、跨提供方相撞、内置占名或引用别家工具时整次登记抛", () => {
		const cases: Array<{
			key: string;
			skills: ReturnType<typeof skill>[];
			message: string;
			before?: (registry: ReturnType<typeof createAiToolProviderRegistry>) => void;
		}> = [
			{
				key: "acme",
				skills: [skill("Bad.Name")],
				message: 'AI skill name "Bad.Name" from provider key "acme" is invalid',
			},
			{
				key: "acme",
				skills: [skill("x".repeat(28))],
				message: `AI skill name "acme-${"x".repeat(28)}" from provider key "acme" exceeds 32 characters`,
			},
			{
				key: "acme",
				skills: [skill("echo-check"), skill("echo-check")],
				message: 'AI skill name "echo-check" from provider key "acme" is registered more than once',
			},
			{
				key: "a-b",
				skills: [skill("echo-check")],
				message:
					'AI skill name "a-b-echo-check" from provider key "a-b" is already registered by provider key "a.b"',
				before: (registry) => {
					registry.register("a.b", { readOnly: [], skills: [skill("echo-check")] });
				},
			},
			{
				key: "unsub",
				skills: [skill("cleanup")],
				message:
					'AI skill name "unsub-cleanup" from provider key "unsub" conflicts with a built-in skill',
			},
			{
				key: "acme",
				skills: [skill("echo-check", ["other__tool"])],
				message:
					'AI skill "acme-echo-check" from provider key "acme" references tool "other__tool" from another namespace',
			},
		];

		for (const testCase of cases) {
			const registry = createAiToolProviderRegistry();
			testCase.before?.(registry);
			expect(() =>
				registry.register(testCase.key, {
					readOnly: [tool("echo")],
					skills: testCase.skills,
				}),
			).toThrow(testCase.message);
		}
	});

	it("技能 description / body 超限时整次登记抛，失败的那次没有占住键", () => {
		const oversized = [
			{ ...skill("echo-check"), description: "x".repeat(201) },
			{ ...skill("echo-check", undefined), body: "x".repeat(20_001) },
		];

		for (const bad of oversized) {
			const registry = createAiToolProviderRegistry();
			expect(() => registry.register("acme", { readOnly: [tool("echo")], skills: [bad] })).toThrow(
				/"acme-echo-check" from provider key "acme" is invalid:/,
			);
			expect(() => registry.register("acme", { readOnly: [] })).not.toThrow();
		}
	});
});
