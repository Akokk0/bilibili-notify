/**
 * 技能库存储:`<dir>/<name>/SKILL.md`,一条一目录。
 *
 * 两条纪律钉在这里:
 * 1. **盘是唯一权威** —— 主人可以手放一份进去(ADR 决策 3),所以每次读都要能
 *    发现盘上的新东西,不能只认我们自己写过的。
 * 2. **读不进来的要说出来** —— 手放的文件写错了很正常,而「静默不出现」在界面上
 *    跟「我没放对地方」长得一模一样,主人无从查起。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BUILTIN_SKILLS } from "../builtin.js";
import { formatSkillFile } from "../parse.js";
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
		await expect(store.update(name, { ...BUILTIN, body: "篡改" })).rejects.toThrow();
		await expect(store.remove(name)).rejects.toThrow();
		expect(store.get(name)?.body).toBe(BUILTIN.body);
	});

	it("建同名内置 → 直接拒,并说清是被内置占用了", async () => {
		await expect(store.create({ ...sample, name: BUILTIN.name })).rejects.toThrow(/内置/);
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
		await store.create(sample);
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
		await expect(store.create(sample)).rejects.toThrow();
	});

	it("改 → 内容换掉;改不存在的 → 拒", async () => {
		await store.create(sample);
		await store.update("my-skill", { ...sample, body: "换了个说法" });
		expect(store.get("my-skill")?.body).toBe("换了个说法");
		await expect(store.update("nope", sample)).rejects.toThrow();
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
		await expect(store.update("other", { ...sample, name: "my-skill" })).rejects.toThrow();
	});

	it("删 → 盘上目录一起没", async () => {
		await store.create(sample);
		await store.remove("my-skill");
		expect(store.get("my-skill")).toBeUndefined();
		const reopened = new MaidSkillStore({ dir });
		await reopened.ensureReady();
		expect(reopened.get("my-skill")).toBeUndefined();
	});

	it("名字不合法 → 一律拒,连磁盘都不碰", async () => {
		// 名字要拼进路径,这是那道闸的最后一站。
		for (const bad of ["../evil", "a/b", "周报", "A"]) {
			await expect(store.create({ ...sample, name: bad })).rejects.toThrow();
			await expect(store.remove(bad)).rejects.toThrow();
		}
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
