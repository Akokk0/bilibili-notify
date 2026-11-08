/**
 * 女仆技能 API —— `/api/ai/skills` 的增删改查。
 *
 * 这一层要钉住的东西只有三件:
 *
 * ① **名字进不了路径。** 技能名就是目录名,而它从 URL 来。皮肤库那次审计
 *    (2026-08-19)就是栽在这儿 —— `DELETE /%2e%2e%2fconversations` 删掉了整个
 *    会话目录。这一条不是回归测试,是**闸本身**。
 * ② **内置动不了。** 只读、跟版本走(ADR 决策 15)。
 * ③ **盘上读不进来的要报出来。** 主人手放的文件写错了,得让他在界面上看得见,
 *    否则跟「我大概没放对地方」分不开。
 *
 * 失败只有一种形状(ADR-0026):`{ code, message }`。名字不合法 / 内容不合规 `invalid`(400),
 * 没这条 `not_found`(404),内置只读 / 重名 `conflict`(409)—— 码由技能库的错误自带,
 * 路由不再把它们一把抓成 400。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { complainAboutSkill, MAID_SKILL_LIMITS } from "@bilibili-notify/contract";
import { type AiTool, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	type AiToolProviderRegistry,
	createAiToolProviderRegistry,
} from "../../ai/tool-provider-registry.js";
import { i18n } from "../../i18n/index.js";
import { BUILTIN_SKILLS } from "../../maid-skills/builtin.js";
import { parseSkillFile } from "../../maid-skills/parse.js";
import { createMaidSkillReader } from "../../maid-skills/reader.js";
import { MaidSkillStore } from "../../maid-skills/store.js";
import { createAiSkillsRoute } from "../ai-skills.js";

let dir: string;
let store: MaidSkillStore;
let aiToolProviders: AiToolProviderRegistry;
let app: ReturnType<typeof createAiSkillsRoute>;

const sample = {
	name: "my-skill",
	description: "主人自己写的一条",
	disableModelInvocation: false,
	body: "先做这个,再做那个。",
};

const BUILTIN = BUILTIN_SKILLS[0];
if (!BUILTIN) throw new Error("内置技能表是空的");

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
	execute: async () => ok({ text: name }),
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-skill-route-"));
	aiToolProviders = createAiToolProviderRegistry();
	store = new MaidSkillStore({
		dir,
		reservedNames: () => aiToolProviders.skills().map((skill) => skill.name),
	});
	const skillReader = createMaidSkillReader({
		store,
		providers: aiToolProviders,
		logger: { warn() {} },
		nouns: () => ({ creatorNoun: "创作者", postNoun: "作品", sources: "各平台" }),
	});
	aiToolProviders.register("bilibili", {
		readOnly: [tool("get_up_totals"), tool("get_up_videos")],
	});
	app = createAiSkillsRoute({ skillStore: store, skillReader, aiToolProviders });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
	app.request("/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const put = (name: string, body: unknown) =>
	app.request(`/${name}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const previewFile = (text: string) => {
	const form = new FormData();
	form.set("file", new File([text], "SKILL.md", { type: "text/markdown" }));
	return app.request("/import-preview", { method: "POST", body: form });
};

it("导入只解析预览，确认新建后可导出为同一格式再次预览", async () => {
	const text =
		"---\nname: trip-note\ndescription: '旅行: 清单'\nallowed-tools:\n  - web_search\ndisable-model-invocation: true\n---\n\n先整理清单。\n\n---\n保留正文分割线。\n";
	const preview = await previewFile(text);
	expect(preview.status).toBe(200);
	const data = (await preview.json()) as any;
	expect(data).toEqual({
		ok: true,
		skill: {
			name: "trip-note",
			description: "旅行: 清单",
			allowedTools: ["web_search"],
			disableModelInvocation: true,
			body: "先整理清单。\n\n---\n保留正文分割线。",
		},
	});
	expect(
		((await (await app.request("/")).json()) as any).list.some((s: any) => s.name === "trip-note"),
	).toBe(false);
	expect((await post(data.skill)).status).toBe(200);
	const exported = await app.request("/trip-note/export");
	expect(exported.status).toBe(200);
	expect(exported.headers.get("content-type")).toContain("text/markdown");
	expect(exported.headers.get("content-disposition")).toContain("trip-note.SKILL.md");
	const exportedText = await exported.text();
	expect(parseSkillFile(exportedText)).toEqual(data);
	expect(await (await previewFile(exportedText)).json()).toEqual(data);
});

it("同名导入预览后确认仍拒绝覆盖，改用新名字可保存副本", async () => {
	await post(sample);
	const preview = (await (
		await previewFile("---\nname: my-skill\ndescription: 新的用途\n---\n\n新的正文\n")
	).json()) as any;
	expect(preview.ok).toBe(true);
	const conflict = await post(preview.skill);
	expect(conflict.status).toBe(409);
	expect(((await conflict.json()) as any).code).toBe("conflict");
	const original = parseSkillFile(await (await app.request("/my-skill/export")).text());
	expect(original).toEqual({ ok: true, skill: sample });
	expect((await post({ ...preview.skill, name: "my-skill-copy" })).status).toBe(200);
	expect(parseSkillFile(await (await app.request("/my-skill/export")).text())).toEqual(original);
});

it("内置技能导出当前可见内容，不携带只读标志或别名；原名不可导入覆盖", async () => {
	const list = (await (await app.request("/")).json()) as any;
	const visible = list.list.find((s: any) => s.builtin);
	expect(visible).toBeDefined();
	const res = await app.request(`/${visible.name}/export`);
	expect(res.status).toBe(200);
	const text = await res.text();
	expect(text).not.toContain("builtin:");
	expect(text).not.toContain("aliases:");
	const parsed = parseSkillFile(text);
	expect(parsed.ok && parsed.skill.body).toBe(visible.body);
	if (!parsed.ok) throw new Error(parsed.message);
	expect((await post(parsed.skill)).status).toBe(409);
});

it("文件缺失、格式不对、超限或导出不存在时回标准错误，未创建技能", async () => {
	expect(
		(await app.request("/import-preview", { method: "POST", body: new FormData() })).status,
	).toBe(400);
	const invalid = await previewFile("没有frontmatter");
	expect(invalid.status).toBe(400);
	expect(((await invalid.json()) as any).code).toBe("invalid");
	for (const size of [MAID_SKILL_LIMITS.fileBytes + 1, MAID_SKILL_LIMITS.fileBytes + 100_000]) {
		const large = await previewFile("x".repeat(size));
		expect(large.status).toBe(413);
		expect(await large.json()).toEqual({
			code: "invalid",
			message: "技能文件超过 256 KB，请缩小后重试。",
		});
	}
	expect((await app.request("/not-here/export")).status).toBe(404);
	expect((await app.request("/bad_name/export")).status).toBe(400);
	expect(((await (await app.request("/")).json()) as any).list.every((s: any) => s.builtin)).toBe(
		true,
	);
});

/** 主人绕过界面、直接往库里手放的一份 —— 从没进过内存索引。 */
const HAND_MADE = "---\nname: hand-made\ndescription: 手放的\n---\n\n主人亲手写的正文\n";

async function handPlace(): Promise<string> {
	const file = join(dir, "hand-made", "SKILL.md");
	await mkdir(join(dir, "hand-made"), { recursive: true });
	await writeFile(file, HAND_MADE, "utf-8");
	return file;
}

describe("GET / —— 工具名单带给人看的标签", () => {
	it("tools 里的每一个名字在 toolLabels 里都有非空的标签(编辑器勾选框以后显示它)", async () => {
		const body = (await (await app.request("/")).json()) as any;
		expect(body.tools.length).toBeGreaterThan(0);
		for (const name of body.tools as string[]) {
			expect(body.toolLabels[name], name).toEqual(expect.any(String));
			expect(body.toolLabels[name].trim(), name).not.toBe("");
		}
		expect(body.toolLabels.get_creator_profile).toBe("查看 创作者资料");
		expect(body.toolLabels.web_search).toBe("联网搜索");
	});

	it("登记表里的提供方工具按全名和它自己的标签出现,每次 GET 现取", async () => {
		const echo: AiTool = { ...tool("echo"), label: "回一句" };
		aiToolProviders.register("acme.inprocess", { readOnly: [echo] });
		const body = (await (await app.request("/")).json()) as any;
		expect(body.tools).toContain("acme_inprocess__echo");
		expect(body.toolLabels.acme_inprocess__echo).toBe("回一句");
	});

	it("提供方技能经读口列出，缺工具的不列", async () => {
		aiToolProviders.register("acme.inprocess", {
			readOnly: [],
			skills: [
				{
					name: "available",
					description: "能用的",
					disableModelInvocation: false,
					body: "正文",
				},
				{
					name: "missing",
					description: "缺工具的",
					allowedTools: ["not_available"],
					disableModelInvocation: false,
					body: "正文",
				},
			],
		});

		const body = (await (await app.request("/")).json()) as any;
		expect(body.list).toContainEqual(
			expect.objectContaining({ name: "acme-inprocess-available", builtin: true }),
		);
		expect(body.list.some((skill: any) => skill.name === "acme-inprocess-missing")).toBe(false);
	});
});

describe("GET /", () => {
	it("列出内置那几条,problems 是空的", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.list.length).toBe(BUILTIN_SKILLS.length);
		expect(body.list.every((s: any) => s.builtin)).toBe(true);
		expect(body.problems).toEqual([]);
	});

	it("每次都重新读盘 —— 主人手放的那份不用重启就认得", async () => {
		// 「真文件、可手放」是这个特性的一半意义(ADR 决策 3)。要是得重启才生效,
		// 主人放完刷新一下看不见,只会以为自己放错了地方。
		await mkdir(join(dir, "hand-made"), { recursive: true });
		await writeFile(
			join(dir, "hand-made", "SKILL.md"),
			"---\nname: hand-made\ndescription: 手放的\n---\n\n正文\n",
			"utf-8",
		);
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.some((s: any) => s.name === "hand-made")).toBe(true);
	});

	it("读不进来的那份进 problems,带上目录名与理由", async () => {
		await mkdir(join(dir, "broken"), { recursive: true });
		await writeFile(join(dir, "broken", "SKILL.md"), "根本没有 frontmatter", "utf-8");
		const body = (await (await app.request("/")).json()) as any;
		expect(body.problems).toEqual([
			expect.objectContaining({ dir: "broken", reason: expect.stringContaining("frontmatter") }),
		]);
	});
});

describe("POST /", () => {
	it("建一条 → 列表里就有了", async () => {
		const created = await post(sample);
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({ ok: true });
		const body = (await (await app.request("/")).json()) as any;
		const mine = body.list.find((s: any) => s.name === "my-skill");
		expect(mine).toBeDefined();
		expect(mine.builtin).toBe(false);
		expect(mine.body).toBe(sample.body);
	});

	it("名字不合法 → invalid(400),并把理由原样交给主人", async () => {
		const bad = { ...sample, name: "我的技能" };
		const res = await post(bad);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid");
		// **原样**:比对的是共用规则集那句本身,不是某几个字。此前钉的是「含 name」,
		// 那把措辞焊死在了英文上 —— 规则收进 contract、两端统一说中文之后它就红了,
		// 而红的是断言的写法,不是这条路径的行为。
		expect(body.message).toBe(complainAboutSkill(bad));
	});

	it("与内置同名 → conflict(409),并说清是被内置占了", async () => {
		const res = await post({ ...sample, name: BUILTIN.name });
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("conflict");
		expect(body.message).toContain("内置");
	});

	it("body 不是那个形状 → invalid(400)而不是 500,逐格原因进 issues", async () => {
		for (const bad of [{}, { name: "a" }, { ...sample, body: 42 }, "不是 JSON 对象"]) {
			const res = await post(bad);
			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.code).toBe("invalid");
			expect(body.message).toBe("请求体不是一条技能的形状");
			expect(body.issues.length).toBeGreaterThan(0);
		}
	});

	it("与盘上手放的同名 → conflict(409),那份文件一个字都不动", async () => {
		// **一次 GET 都没发过** —— 这正是要钉的场景:内存索引还是空的。界面正常
		// 流程会先拉列表把它热上,可陈旧标签页、脚本、以及先挂后拉的页面不会。
		// 索引空 → 占用检查查了个寂寞 → 主人手写的那份被 200 OK 悄悄盖掉。
		const file = await handPlace();
		const res = await post({ ...sample, name: "hand-made" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("conflict");
		expect(body.message).toContain("已经有了");
		expect(await readFile(file, "utf-8")).toBe(HAND_MADE);
	});
});

describe("PUT /:name", () => {
	it("改 → 内容换掉", async () => {
		await post(sample);
		const updated = await put("my-skill", { ...sample, body: "换了个说法" });
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual({ ok: true });
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.find((s: any) => s.name === "my-skill").body).toBe("换了个说法");
	});

	it("改内置 → conflict(409),一个字都动不了", async () => {
		const before = (await (await app.request("/")).json()) as any;
		const original = before.list.find((s: any) => s.name === BUILTIN.name).body;
		const res = await put(BUILTIN.name, { ...BUILTIN, body: "篡改" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).code).toBe("conflict");
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.find((s: any) => s.name === BUILTIN.name).body).toBe(original);
	});

	it("改不存在的 → not_found(404)", async () => {
		const res = await put("nope", sample);
		expect(res.status).toBe(404);
		expect(((await res.json()) as any).code).toBe("not_found");
	});

	it("改的内容不合规矩 → invalid(400),不是 conflict", async () => {
		await post(sample);
		const res = await put("my-skill", { ...sample, body: "   " });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: expect.stringContaining("正文是空的"),
		});
		expect(store.get("my-skill")?.body).toBe(sample.body);
	});

	it("改名撞上盘上手放的那份 → conflict(409),那份文件一个字都不动", async () => {
		// 与 POST 那条同源:改名走的也是「这个名字空着吗」那道闸。索引热过之后
		// 手放的那份就再没进过它 —— 闸看不见,改名等于覆盖。
		//
		// 中间这次 PUT 不是凑数:`ensureReady` 只读一次盘,得先有人把它触发掉,
		// 后面那次才是真正跑在陈旧索引上。**别删。**
		await post(sample);
		await put("my-skill", { ...sample, body: "先改一次,把索引热上" });
		const file = await handPlace();
		const res = await put("my-skill", { ...sample, name: "hand-made" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).code).toBe("conflict");
		expect(await readFile(file, "utf-8")).toBe(HAND_MADE);
	});
});

describe("DELETE /:name", () => {
	it("删 → 没了", async () => {
		await post(sample);
		const removed = await app.request("/my-skill", { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true });
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.some((s: any) => s.name === "my-skill")).toBe(false);
	});

	it("删内置 → conflict(409)", async () => {
		const res = await app.request(`/${BUILTIN.name}`, { method: "DELETE" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).code).toBe("conflict");
	});

	it("删没有的 → not_found(404)", async () => {
		const res = await app.request("/nope", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "技能不存在:nope" });
	});

	it("名字带路径穿越 → 一律拒,库外的东西一根汗毛都不能少", async () => {
		// 皮肤库那次审计的重演:`DELETE /%2e%2e%2fconversations`。名字白名单里
		// 没有 `.` `/`,所以这些形状在第一道闸就该被挡下 —— 这条测试是那道闸的
		// **在场证明**,不是回归。
		const victim = join(dirname(dir), "victim-dir");
		await mkdir(victim, { recursive: true });
		try {
			for (const evil of ["%2e%2e%2fvictim-dir", "..%2Fvictim-dir", "%2E%2E%2F%2E%2E%2Fetc"]) {
				const res = await app.request(`/${evil}`, { method: "DELETE" });
				expect(res.status).toBe(400);
				// **挡下来的必须是名字白名单,不是路由表。** `%2e%2e%2f` 是真的会被
				// 解码成 `../` 一路送到处理器的(实测),所以「404 也算过」这种断言
				// 会让这条测试在闸被拆掉之后照样绿。认准这句话。
				const body = (await res.json()) as any;
				expect(body.code).toBe("invalid");
				expect(body.message).toContain("不合法");
			}
			// 目录还在 —— 这才是真正要证明的事。
			expect(await readdir(dirname(dir))).toContain("victim-dir");
		} finally {
			await rm(victim, { recursive: true, force: true });
		}
	});
});

it.each([
	["en", "Missing frontmatter: the file must start with a line containing only `---`."],
	["ja", "frontmatterがありません。ファイルの先頭行には`---`のみを書いてください。"],
	["zh-TW", "缺少 frontmatter：檔案必須以單獨一行的 `---` 開頭。"],
] as const)(
	"localizes skill import diagnostics in %s without creating resources",
	async (locale, message) => {
		const previous = i18n.state();
		const before = await readdir(dir);
		try {
			i18n.set({ locale, voice: "plain" });
			const response = await previewFile("Original skill content without frontmatter / 原稿");
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ code: "invalid", message });
			expect(await readdir(dir)).toEqual(before);
		} finally {
			i18n.set(previous);
		}
	},
);
