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
import { complainAboutSkill } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BUILTIN_SKILLS } from "../../maid-skills/builtin.js";
import { MaidSkillStore } from "../../maid-skills/store.js";
import { createAiSkillsRoute } from "../ai-skills.js";

let dir: string;
let store: MaidSkillStore;
let app: ReturnType<typeof createAiSkillsRoute>;

const sample = {
	name: "my-skill",
	description: "主人自己写的一条",
	disableModelInvocation: false,
	body: "先做这个,再做那个。",
};

const BUILTIN = BUILTIN_SKILLS[0];
if (!BUILTIN) throw new Error("内置技能表是空的");

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-skill-route-"));
	store = new MaidSkillStore({ dir });
	app = createAiSkillsRoute({ skillStore: store });
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
		expect(body.toolLabels.get_creator_profile).toBe("查看 UP 主资料");
		expect(body.toolLabels.web_search).toBe("联网搜索");
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
		expect((await post(sample)).status).toBe(200);
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
		expect((await put("my-skill", { ...sample, body: "换了个说法" })).status).toBe(200);
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.find((s: any) => s.name === "my-skill").body).toBe("换了个说法");
	});

	it("改内置 → conflict(409),一个字都动不了", async () => {
		const res = await put(BUILTIN.name, { ...BUILTIN, body: "篡改" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).code).toBe("conflict");
		const body = (await (await app.request("/")).json()) as any;
		expect(body.list.find((s: any) => s.name === BUILTIN.name).body).toBe(BUILTIN.body);
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
		expect(((await res.json()) as any).code).toBe("invalid");
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
		expect((await app.request("/my-skill", { method: "DELETE" })).status).toBe(200);
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
		expect(((await res.json()) as any).code).toBe("not_found");
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
