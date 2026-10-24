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
	return createMaidSkillReader({
		store,
		providers,
		logger,
		nouns: () => ({ creatorNoun: "创作者", postNoun: "作品", sources: "各平台" }),
	});
}

function registerBiliTools(): void {
	providers.register("bilibili", {
		readOnly: [tool("get_up_totals"), tool("get_up_videos")],
	});
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
	it("旧斜杠名经别名找到改名后的内置技能，列表仍只列正名", async () => {
		registerBiliTools();
		const current = await reader();

		expect(current.get("find-up")).toMatchObject({
			name: "find-creator",
			aliases: ["find-up"],
			builtin: true,
		});
		expect(current.list().find((candidate) => candidate.name === "find-creator")).toMatchObject({
			aliases: ["find-up"],
		});
		expect(current.list().some((candidate) => candidate.name === "find-up")).toBe(false);
		expect(current.list().some((candidate) => candidate.name === "up-pk")).toBe(false);
	});

	it("主人建了旧斜杠名时，正名精确匹配优先于内置别名", async () => {
		registerBiliTools();
		await store.create(skill("find-up"));
		const current = await reader();

		expect(current.get("find-up")).toMatchObject({ name: "find-up", builtin: false });
		expect(current.get("find-creator")).toMatchObject({ name: "find-creator", builtin: true });
	});

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

	it("B 站工具不在时，只用中立工具的内置技能照常可见", async () => {
		const current = await reader();
		expect(current.list().some((candidate) => candidate.name === "weekly-report")).toBe(true);
		expect(current.get("weekly-report")).toBeDefined();
		expect(current.get("find-up")).toMatchObject({ name: "find-creator", builtin: true });
	});

	it("内置技能按调用时给的叫法渲染", async () => {
		let nouns = { creatorNoun: "UP主", postNoun: "动态", sources: "B 站" };
		const current = createMaidSkillReader({ store, providers, logger, nouns: () => nouns });

		expect(current.get("weekly-report")).toMatchObject({
			description: expect.stringContaining("UP主"),
			body: expect.stringContaining("UP主"),
		});

		nouns = { creatorNoun: "创作者", postNoun: "作品", sources: "各平台" };
		expect(current.get("weekly-report")).toMatchObject({
			description: expect.stringContaining("创作者"),
			body: expect.stringContaining("创作者"),
		});
	});

	it("主人技能里的叫法占位符原样保留", async () => {
		await store.create({
			...skill("mine"),
			description: "给 {creatorNoun} 使用",
			body: "处理 {postNoun}，来源是 {sources}",
		});

		expect((await reader()).get("mine")).toMatchObject({
			description: "给 {creatorNoun} 使用",
			body: "处理 {postNoun}，来源是 {sources}",
		});
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
