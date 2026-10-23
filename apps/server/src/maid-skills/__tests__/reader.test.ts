import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiTool, Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { formatSkillFile } from "../parse.js";
import { createMaidSkillReader } from "../reader.js";
import { MaidSkillStore } from "../store.js";

let dir: string;
let providers: ReturnType<typeof createAiToolProviderRegistry>;
let warn: ReturnType<typeof vi.fn>;
let logger: Pick<Logger, "warn">;
let store: MaidSkillStore;

const tool = (name: string): AiTool => ({
	definition: {
		type: "function",
		function: {
			name,
			description: `调用 ${name}`,
			parameters: { type: "object", properties: {} },
		},
	},
	label: `查看 ${name}`,
	execute: async () => ({ ok: true, text: name }),
});

const skill = (name: string, allowedTools?: string[]) => ({
	name,
	description: `使用 ${name}`,
	...(allowedTools === undefined ? {} : { allowedTools }),
	disableModelInvocation: false,
	body: `执行 ${name}`,
});

async function reader() {
	await store.reload();
	return createMaidSkillReader({ store, providers, logger });
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-skill-reader-"));
	providers = createAiToolProviderRegistry();
	warn = vi.fn();
	logger = { warn: warn as Logger["warn"] };
	store = new MaidSkillStore({
		dir,
		reservedNames: () => providers.skills().map((candidate) => candidate.name),
	});
	await store.ensureReady();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("MaidSkillReader", () => {
	it("内置、提供方与主人技能合成一张表，提供方技能按只读项出现", async () => {
		providers.register("acme.inprocess", {
			readOnly: [tool("echo")],
			skills: [skill("echo-check", ["acme_inprocess__echo"])],
		});
		await store.create(skill("mine"));

		const list = (await reader()).list();
		expect(list.find((candidate) => candidate.name === "acme-inprocess-echo-check")).toMatchObject({
			builtin: true,
			body: "执行 echo-check",
		});
		expect(list.find((candidate) => candidate.name === "mine")).toMatchObject({ builtin: false });
	});

	it("提供方技能缺少声明的工具时不列、get 也拿不到", async () => {
		providers.register("acme", {
			readOnly: [tool("echo")],
			skills: [skill("echo-check", ["not_available"])],
		});

		const current = await reader();
		expect(current.list().some((candidate) => candidate.name === "acme-echo-check")).toBe(false);
		expect(current.get("acme-echo-check")).toBeUndefined();
	});

	it("内置技能缺少声明的工具时不列、get 也拿不到", async () => {
		const current = await reader();
		expect(current.list().some((candidate) => candidate.name === "weekly-report")).toBe(false);
		expect(current.get("weekly-report")).toBeUndefined();
	});

	it("主人技能缺工具照常列出，同一对技能与工具只在第一次缺时 warn，恢复后再缺会再 warn", async () => {
		await store.create(skill("mine", ["acme_inprocess__late"]));
		const current = await reader();

		expect(current.list().some((candidate) => candidate.name === "mine")).toBe(true);
		expect(current.get("mine")).toBeDefined();
		expect(current.list().some((candidate) => candidate.name === "mine")).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("mine");
		expect(warn.mock.calls[0]?.[0]).toContain("acme_inprocess__late");

		const claim = providers.register("acme.inprocess", {
			readOnly: [tool("late")],
			skills: [],
		});
		expect(current.list().some((candidate) => candidate.name === "mine")).toBe(true);
		claim.dispose();
		expect(current.list().some((candidate) => candidate.name === "mine")).toBe(true);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("盘上目录与提供方技能同名时不列、get 拿不到，并进 problems", async () => {
		providers.register("acme.inprocess", {
			readOnly: [tool("echo")],
			skills: [skill("echo-check", ["acme_inprocess__echo"])],
		});
		await mkdir(join(dir, "acme-inprocess-echo-check"), { recursive: true });
		await writeFile(
			join(dir, "acme-inprocess-echo-check", "SKILL.md"),
			formatSkillFile(skill("acme-inprocess-echo-check")),
			"utf-8",
		);

		const current = await reader();
		expect(
			current.list().filter((candidate) => candidate.name === "acme-inprocess-echo-check"),
		).toHaveLength(1);
		expect(current.get("acme-inprocess-echo-check")?.builtin).toBe(true);
		expect(current.problems()).toContainEqual(
			expect.objectContaining({ dir: "acme-inprocess-echo-check" }),
		);
	});
});
