/**
 * 女仆技能库:`<dir>/<name>/SKILL.md`,一条一目录,目录名即技能名。
 *
 * **盘是唯一权威。** 主人可以直接往 dataDir 里手放一份(ADR-0001 决策 3:真文件、
 * 可手放、可导出),所以内存里这份索引只是读缓存,{@link MaidSkillStore.reload}
 * 随时能从盘上重建。
 *
 * **读不进来的要说出来。** 手放的文件写错很正常,而「静默不出现」在界面上跟
 * 「我大概没放对地方」长得一模一样 —— 主人无从查起。所以每次读盘都攒一份
 * {@link MaidSkillStore.problems},交给界面显示。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_SKILL_NAMES, BUILTIN_SKILLS } from "./builtin.js";
import { formatSkillFile, isValidSkillName, type ParsedSkill, parseSkillFile } from "./parse.js";

/** 技能文件在目录里的固定名字,与 Claude Code 的 Agent Skill 一致。 */
const SKILL_FILE = "SKILL.md";

/** 一条读不进来的东西 —— 目录名 + 为什么。 */
export interface SkillProblem {
	dir: string;
	reason: string;
}

/** 库里的一条技能。`builtin` 决定它改不改得动。 */
export interface MaidSkillEntry extends ParsedSkill {
	/** 内置的只读、跟版本走(决策 15);改 / 删一律拒。 */
	builtin: boolean;
}

/** 单份 SKILL.md 的大小上限 —— 手放的目录里可能是任何东西,别把一整个视频读进内存。 */
const MAX_FILE_BYTES = 256 * 1024;

export class MaidSkillStore {
	private readonly dir: string;
	/** 主人自己那些(不含内置),name → 条目。 */
	private user = new Map<string, ParsedSkill>();
	private issues: SkillProblem[] = [];
	private ready?: Promise<void>;

	constructor(opts: { dir: string }) {
		this.dir = opts.dir;
	}

	/** 确保读过一次盘,幂等。 */
	async ensureReady(): Promise<void> {
		this.ready ??= this.reload();
		await this.ready;
	}

	/** 从盘上全量重建索引与问题清单。 */
	async reload(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const user = new Map<string, ParsedSkill>();
		const issues: SkillProblem[] = [];
		for (const entry of await readdir(this.dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dirName = entry.name;
			// 点开头的是系统 / 编辑器留下的东西,报出来只会刷屏。`.tmp` 是我们自己
			// 写盘写到一半的残留。
			if (dirName.startsWith(".") || dirName.endsWith(".tmp")) continue;
			if (!isValidSkillName(dirName)) {
				issues.push({
					dir: dirName,
					reason: "目录名不是合法技能名(只收小写字母 / 数字 / 单个连字符)",
				});
				continue;
			}
			let text: string;
			try {
				const buf = await readFile(join(this.dir, dirName, SKILL_FILE));
				if (buf.byteLength > MAX_FILE_BYTES) {
					issues.push({ dir: dirName, reason: `SKILL.md 过大(上限 ${MAX_FILE_BYTES / 1024} KB)` });
					continue;
				}
				text = buf.toString("utf-8");
			} catch {
				issues.push({ dir: dirName, reason: `目录里没有 ${SKILL_FILE}` });
				continue;
			}
			const res = parseSkillFile(text);
			if (!res.ok) {
				issues.push({ dir: dirName, reason: res.reason });
				continue;
			}
			if (res.skill.name !== dirName) {
				// 名字就是目录名,这条不变式一破,「按名字找目录」这件事就不成立了。
				issues.push({
					dir: dirName,
					reason: `frontmatter 里的 name 是「${res.skill.name}」,与目录名对不上`,
				});
				continue;
			}
			if (BUILTIN_SKILL_NAMES.has(dirName)) {
				// 内置照旧赢。让盘上一份悄悄顶掉它,主人升级之后会发现某条内置技能
				// 永远停在旧版本,而界面上看不出任何异样。
				issues.push({ dir: dirName, reason: "这个名字已被内置技能占用,盘上这一份不会生效" });
				continue;
			}
			user.set(dirName, res.skill);
		}
		this.user = user;
		this.issues = issues;
	}

	/** 全部技能:内置在前(按声明顺序),主人自己的在后(按名字排)。 */
	list(): MaidSkillEntry[] {
		const mine = [...this.user.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((s) => ({ ...s, builtin: false }));
		return [...BUILTIN_SKILLS.map((s) => ({ ...s, builtin: true })), ...mine];
	}

	get(name: string): MaidSkillEntry | undefined {
		const builtin = BUILTIN_SKILLS.find((s) => s.name === name);
		if (builtin) return { ...builtin, builtin: true };
		const mine = this.user.get(name);
		return mine ? { ...mine, builtin: false } : undefined;
	}

	/** 这一轮读盘里读不进来的那些。界面拿它提醒主人「你放的那份没生效」。 */
	problems(): SkillProblem[] {
		return [...this.issues];
	}

	async create(skill: ParsedSkill): Promise<void> {
		const clean = this.validate(skill);
		await this.assertFree(clean.name);
		await this.writeSkill(clean);
		this.user.set(clean.name, clean);
	}

	async update(name: string, next: ParsedSkill): Promise<void> {
		this.assertEditable(name);
		if (!this.user.has(name)) throw new Error(`技能不存在:${name}`);
		const clean = this.validate(next);
		if (clean.name !== name) await this.assertFree(clean.name);
		await this.writeSkill(clean);
		if (clean.name !== name) {
			// 改名 = 换目录。旧的不留在盘上,否则下次读盘会冒出一条僵尸。
			await rm(join(this.dir, name), { recursive: true, force: true });
			this.user.delete(name);
		}
		this.user.set(clean.name, clean);
	}

	async remove(name: string): Promise<void> {
		this.assertEditable(name);
		if (!this.user.has(name)) throw new Error(`技能不存在:${name}`);
		await rm(join(this.dir, name), { recursive: true, force: true });
		this.user.delete(name);
	}

	/**
	 * 入库前过一遍尺子 —— 手法是**写出去再读回来**:序列化一次再解析一次,
	 * 名字、长度、正文非空全部由 {@link parseSkillFile} 那一处判,不在这儿抄第二遍。
	 * 两处各判各的,迟早会出现「存得进去、读不回来」的东西。
	 */
	private validate(skill: ParsedSkill): ParsedSkill {
		const res = parseSkillFile(formatSkillFile(skill));
		if (!res.ok) throw new Error(res.reason);
		return res.skill;
	}

	/**
	 * 这个名字还空着吗 —— 内置、索引里、**以及盘上**都算占用。
	 *
	 * 盘那一问不能省。索引只是读缓存,主人手放的那份在下一次读盘之前从没进过它
	 * (ADR-0001 决策 3:真文件、可手放),而 {@link writeSkill} 是照着名字直接盖的。
	 * 只问索引会漏成两种真事故:冷启动第一发就是写请求(陈旧标签页、脚本、先挂后
	 * 拉列表的页面),以及索引热过之后才放进来的那份 —— 两种都是 200 OK 把主人手写
	 * 的正文抹掉,界面上连个响都没有。缓存怎么调都堵不住,只能问盘。
	 */
	private async assertFree(name: string): Promise<void> {
		if (BUILTIN_SKILL_NAMES.has(name)) throw new Error(`「${name}」已被内置技能占用,换个名字吧`);
		if (this.user.has(name)) throw new Error(`「${name}」已经有了`);
		if (await this.fileExists(name)) throw new Error(`「${name}」已经有了`);
	}

	/** 盘上有没有这个名字的 SKILL.md。空目录 / `.tmp` 残留不算占用 —— 那儿没有主人的东西可丢。 */
	private async fileExists(name: string): Promise<boolean> {
		return await stat(join(this.dir, name, SKILL_FILE)).then(
			() => true,
			() => false,
		);
	}

	/** 改 / 删的前置:名字合法(它要拼进路径)且不是内置。 */
	private assertEditable(name: string): void {
		if (!isValidSkillName(name)) throw new Error(`技能名不合法:${name}`);
		if (BUILTIN_SKILL_NAMES.has(name)) throw new Error(`「${name}」是内置技能,改不动也删不掉`);
	}

	/** 落盘。先写同目录下的 `.tmp` 再 rename —— 半份 SKILL.md 下次读盘就是一条问题。 */
	private async writeSkill(skill: ParsedSkill): Promise<void> {
		const dir = join(this.dir, skill.name);
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `${SKILL_FILE}.tmp`);
		await writeFile(tmp, formatSkillFile(skill), "utf-8");
		await rename(tmp, join(dir, SKILL_FILE));
	}
}
