/**
 * 技能库存储:`<dir>/<name>/SKILL.md`,一条一目录。
 *
 * 两条纪律钉在这里:
 * 1. **盘是唯一权威** —— 主人可以手放一份进去(ADR 决策 3),所以每次读都要能
 *    发现盘上的新东西,不能只认我们自己写过的。
 * 2. **读不进来的要说出来** —— 手放的文件写错了很正常,而「静默不出现」在界面上
 *    跟「我没放对地方」长得一模一样,主人无从查起。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BUILTIN_SKILLS } from "../builtin.js";
import { formatSkillFile, parseSkillFile } from "../parse.js";
import { MaidSkillStore } from "../store.js";

let dir: string;
let store: MaidSkillStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-maid-skills-"));
	store = new MaidSkillStore({ dir });
	await store.ensureReady();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 手放一份进去 —— 模拟主人自己往 dataDir 里塞文件。 */
async function handPlace(dirName: string, content: string): Promise<void> {
	await mkdir(join(dir, dirName), { recursive: true });
	await writeFile(join(dir, dirName, "SKILL.md"), content, "utf-8");
}

const sample = {
	name: "my-skill",
	description: "主人自己写的一条",
	disableModelInvocation: false,
	body: "先做这个,再做那个。",
};

it("并发确认同名新技能只成功一次，后来的请求不覆盖已入库正文", async () => {
	const results = await Promise.all([
		store.create({ ...sample, body: "第一份正文" }),
		store.create({ ...sample, body: "第二份正文" }),
	]);
	expect(results.filter((result) => result.ok)).toHaveLength(1);
	expect(results.filter((result) => !result.ok && result.code === "conflict")).toHaveLength(1);
	expect(store.get(sample.name)?.body).toBe("第一份正文");
	await store.reload();
	expect(store.get(sample.name)?.body).toBe("第一份正文");
});

/** 拿第一条内置当样本。表空了这几条测试本来也不成立,当场炸掉比一路 optional 好读。 */
const BUILTIN = BUILTIN_SKILLS[0];
if (!BUILTIN) throw new Error("内置技能表是空的");

describe("内置", () => {
	it("空目录也列得出内置那几条,且标着 builtin", () => {
		const list = store.list();
		expect(list.length).toBe(BUILTIN_SKILLS.length);
		expect(list.every((s) => s.builtin)).toBe(true);
	});

	it("内置改不动、删不掉 —— 只读跟版本走(ADR 决策 15)", async () => {
		const name = BUILTIN.name;
		await expect(store.update(name, { ...BUILTIN, body: "篡改" })).resolves.toMatchObject({
			ok: false,
			code: "conflict",
		});
		await expect(store.remove(name)).resolves.toMatchObject({ ok: false, code: "conflict" });
		expect(store.get(name)?.body).toBe(BUILTIN.body);
	});

	it("建同名内置 → 直接拒,并说清是被内置占用了", async () => {
		await expect(store.create({ ...sample, name: BUILTIN.name })).resolves.toMatchObject({
			ok: false,
			code: "conflict",
			message: expect.stringContaining("内置"),
		});
	});

	it("盘上有个跟内置同名的目录 → 内置照旧赢,并报成一条问题", async () => {
		// 不是「谁后写谁赢」:内置跟版本走,让盘上一份悄悄顶掉它,主人升级之后
		// 会发现某条内置技能永远停在旧版本,而界面上看不出任何异样。
		await handPlace(BUILTIN.name, formatSkillFile({ ...sample, name: BUILTIN.name }));
		await store.reload();
		expect(store.get(BUILTIN.name)?.builtin).toBe(true);
		expect(store.problems().some((p) => /内置/.test(p.reason))).toBe(true);
	});
});

describe("增删改", () => {
	it("建 → 列得出、读得回,且不是内置", async () => {
		await expect(store.create(sample)).resolves.toEqual({ ok: true });
		const got = store.get("my-skill");
		expect(got).toBeDefined();
		expect(got?.builtin).toBe(false);
		expect(got?.body).toBe(sample.body);
	});

	it("落的是真文件,重开一家店照样读得到", async () => {
		await store.create(sample);
		const reopened = new MaidSkillStore({ dir });
		await reopened.ensureReady();
		expect(reopened.get("my-skill")?.description).toBe(sample.description);
	});

	it("建重名 → 拒", async () => {
		await store.create(sample);
		await expect(store.create(sample)).resolves.toMatchObject({ ok: false, code: "conflict" });
	});

	it("改 → 内容换掉;改不存在的 → 拒", async () => {
		await store.create(sample);
		await expect(store.update("my-skill", { ...sample, body: "换了个说法" })).resolves.toEqual({
			ok: true,
		});
		expect(store.get("my-skill")?.body).toBe("换了个说法");
		await expect(store.update("nope", sample)).resolves.toMatchObject({
			ok: false,
			code: "not_found",
		});
	});

	it("改名 = 换目录,旧的不留在盘上", async () => {
		await store.create(sample);
		await store.update("my-skill", { ...sample, name: "renamed" });
		expect(store.get("my-skill")).toBeUndefined();
		expect(store.get("renamed")?.body).toBe(sample.body);
		const reopened = new MaidSkillStore({ dir });
		await reopened.ensureReady();
		expect(reopened.get("my-skill")).toBeUndefined();
		expect(reopened.get("renamed")).toBeDefined();
	});

	it("改名撞上已有的名字 → 拒,别把人家覆盖掉", async () => {
		await store.create(sample);
		await store.create({ ...sample, name: "other" });
		await expect(store.update("other", { ...sample, name: "my-skill" })).resolves.toMatchObject({
			ok: false,
			code: "conflict",
		});
	});

	it("删 → 盘上目录一起没", async () => {
		await store.create(sample);
		await expect(store.remove("my-skill")).resolves.toEqual({ ok: true });
		expect(store.get("my-skill")).toBeUndefined();
		const reopened = new MaidSkillStore({ dir });
		await reopened.ensureReady();
		expect(reopened.get("my-skill")).toBeUndefined();
	});

	it("名字不合法 → 一律拒,连磁盘都不碰", async () => {
		// 名字要拼进路径,这是那道闸的最后一站。
		for (const bad of ["../evil", "a/b", "周报", "A"]) {
			await expect(store.create({ ...sample, name: bad })).resolves.toMatchObject({
				ok: false,
				code: "invalid",
			});
			await expect(store.remove(bad)).resolves.toMatchObject({ ok: false, code: "invalid" });
		}
	});
});

describe("落盘", () => {
	/**
	 * SKILL.md 是给人看、给人手改的 markdown,不是状态 JSON:落的就是 `formatSkillFile` 的那份字节,
	 * 不加缩进、不加换行。目录里只有它自己 —— 写到一半的临时文件不许留在技能目录里。
	 */
	it("写的就是 formatSkillFile 那份字节,技能目录里只有 SKILL.md", async () => {
		await store.create(sample);
		expect(await readFile(join(dir, "my-skill", "SKILL.md"), "utf-8")).toBe(
			formatSkillFile(sample),
		);
		expect(await readdir(join(dir, "my-skill"))).toEqual(["SKILL.md"]);
	});

	/**
	 * 🔴 两个标签页(或一个陈旧标签页 + 一次自动保存)同时存同一条技能:写盘各用各的临时名,
	 * 谁也不该踩到谁 —— 以前共用一个固定名的临时文件,后改名的那次撞上「文件已经被先改名的
	 * 那次拿走了」直接抛 ENOENT。
	 */
	it("同一条技能并发存几次 → 都成功,盘上是完整的一份,不留临时文件", async () => {
		await store.create(sample);
		const bodies = Array.from({ length: 8 }, (_, i) => `第 ${i} 版的正文`);
		const results = await Promise.all(
			bodies.map((body) => store.update("my-skill", { ...sample, body })),
		);
		expect(results).toEqual(bodies.map(() => ({ ok: true })));

		expect(await readdir(join(dir, "my-skill"))).toEqual(["SKILL.md"]);
		const onDisk = parseSkillFile(await readFile(join(dir, "my-skill", "SKILL.md"), "utf-8"));
		expect(onDisk.ok).toBe(true);
		if (onDisk.ok) expect(bodies).toContain(onDisk.skill.body);
	});
});

describe("手放的文件", () => {
	it("手放一份合规的 → 下次读盘就认", async () => {
		await handPlace("hand-made", formatSkillFile({ ...sample, name: "hand-made" }));
		await store.reload();
		expect(store.get("hand-made")?.body).toBe(sample.body);
	});

	it("目录名与 frontmatter 的 name 对不上 → 不收,并报成一条问题", async () => {
		// 名字是目录名,这条不变式一破,「按名字找目录」这件事就不成立了。
		await handPlace("dir-name", formatSkillFile({ ...sample, name: "other-name" }));
		await store.reload();
		expect(store.get("other-name")).toBeUndefined();
		expect(store.get("dir-name")).toBeUndefined();
		expect(store.problems().some((p) => p.dir === "dir-name")).toBe(true);
	});

	it("读不懂的文件 → 不收,但把理由留给主人看", async () => {
		await handPlace("broken", "根本没有 frontmatter");
		await store.reload();
		expect(store.problems()).toEqual([
			expect.objectContaining({ dir: "broken", reason: expect.stringContaining("frontmatter") }),
		]);
	});

	it("坏掉的那份不影响别的 —— 一条读不进来不该拖垮整个库", async () => {
		await handPlace("broken", "坏的");
		await handPlace("good-one", formatSkillFile({ ...sample, name: "good-one" }));
		await store.reload();
		expect(store.get("good-one")).toBeDefined();
	});

	it("目录名本身不合法 → 跳过,不去读里面的文件", async () => {
		await handPlace("Bad Name", formatSkillFile({ ...sample, name: "bad-name" }));
		await store.reload();
		expect(store.get("bad-name")).toBeUndefined();
	});
});

/**
 * 拒收**自带码**(ADR-0026):路由按标准结果回给面板,不再把名字不合法、重名、
 * 没这条一把抓成 400。这里钉每一处拒收各是哪个码。
 */
describe("标准结果:拒收各带各的码", () => {
	const codeOf = async (run: () => Promise<Result>): Promise<unknown> => {
		const result = await run();
		return result.ok ? "没有拒收" : result.code;
	};

	it("内容或名字不合规矩 → invalid", async () => {
		expect(await codeOf(() => store.create({ ...sample, name: "我的技能" }))).toBe("invalid");
		await expect(store.create({ ...sample, body: "  " })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("正文是空的"),
		});
		expect(await codeOf(() => store.remove("../evil"))).toBe("invalid");
	});

	it("没有这条 → not_found", async () => {
		expect(await codeOf(() => store.update("nope", sample))).toBe("not_found");
		expect(await codeOf(() => store.remove("nope"))).toBe("not_found");
	});

	it("与当前状态冲突 → conflict(内置只读、重名、盘上手放的同名)", async () => {
		expect(await codeOf(() => store.create({ ...sample, name: BUILTIN.name }))).toBe("conflict");
		expect(await codeOf(() => store.update(BUILTIN.name, sample))).toBe("conflict");
		expect(await codeOf(() => store.remove(BUILTIN.name))).toBe("conflict");

		await store.create(sample);
		expect(await codeOf(() => store.create(sample))).toBe("conflict");

		await handPlace("hand-made", "---\nname: hand-made\ndescription: 手放的\n---\n\n正文\n");
		expect(await codeOf(() => store.create({ ...sample, name: "hand-made" }))).toBe("conflict");
	});

	it("预期拒收直接返回标准失败,不带别的格", async () => {
		await expect(store.remove("nope")).resolves.toEqual({
			ok: false,
			code: "not_found",
			message: "技能不存在:nope",
		});
	});
});

describe("提供方技能占名", () => {
	it("主人不能建或改名成它，也不能改删它；盘上同名目录进 problems", async () => {
		const reserved = new Set(["acme-inprocess-echo-check"]);
		const guarded = new MaidSkillStore({ dir, reservedNames: () => reserved });
		await guarded.ensureReady();

		await expect(
			guarded.create({ ...sample, name: "acme-inprocess-echo-check" }),
		).resolves.toMatchObject({ ok: false, code: "conflict" });

		await guarded.create(sample);
		await expect(
			guarded.update("my-skill", { ...sample, name: "acme-inprocess-echo-check" }),
		).resolves.toMatchObject({ ok: false, code: "conflict" });
		await expect(guarded.update("acme-inprocess-echo-check", sample)).resolves.toMatchObject({
			ok: false,
			code: "conflict",
		});
		await expect(guarded.remove("acme-inprocess-echo-check")).resolves.toMatchObject({
			ok: false,
			code: "conflict",
		});

		await handPlace(
			"acme-inprocess-echo-check",
			formatSkillFile({ ...sample, name: "acme-inprocess-echo-check" }),
		);
		await guarded.reload();
		expect(guarded.get("acme-inprocess-echo-check")).toBeUndefined();
		expect(guarded.problems()).toContainEqual(
			expect.objectContaining({ dir: "acme-inprocess-echo-check" }),
		);
	});
});
