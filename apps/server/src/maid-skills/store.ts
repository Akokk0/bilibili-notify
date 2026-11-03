import { t as serverText } from "../i18n/index.js";
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

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Failure, type FailureCode, fail, type MaidSkill } from "@bilibili-notify/internal";
import { atomicWriteFile, isLeftoverName } from "@bilibili-notify/storage";
import { BUILTIN_SKILL_NAMES, BUILTIN_SKILLS } from "./builtin.js";
import { formatSkillFile, isValidSkillName, parseSkillFile } from "./parse.js";

/** 技能文件在目录里的固定名字,与 Claude Code 的 Agent Skill 一致。 */
const SKILL_FILE = "SKILL.md";

/** 一条读不进来的东西 —— 目录名 + 为什么。 */
export interface SkillProblem {
	dir: string;
	reason: string;
}

/** 库里的一条技能。`builtin` 决定它改不改得动。 */
export interface MaidSkillEntry extends MaidSkill {
	/** 内置的只读、跟版本走(决策 15);改 / 删一律拒。 */
	builtin: boolean;
	/** 只在内置技能上出现:旧斜杠名,敲对了照认。不占名:主人照样能建同名技能,建了就指主人那条。 */
	aliases?: string[];
}

function entryOfBuiltin({ aliases, ...skill }: (typeof BUILTIN_SKILLS)[number]): MaidSkillEntry {
	return {
		...skill,
		...(aliases === undefined ? {} : { aliases: [...aliases] }),
		builtin: true,
	};
}

/**
 * 技能库拒收一件事的原因,只有这三种(标准码表的子集,规矩见 docs/agents/conventions/failure-results.md):
 * `invalid` 内容或名字不合规矩,`not_found` 要动的技能不存在,`conflict` 与当前状态冲突(内置只读、重名)。
 */
export type SkillStoreFailureCode = Extract<FailureCode, "invalid" | "not_found" | "conflict">;

/**
 * 技能库拒收:**自带码**,路由靠 `toFailure()` 回给面板。从前名字不合法、重名、没这条都是同一种裸
 * `Error`,路由只能一把抓成 400;磁盘写失败也混在里头,原话(带路径)照样外泄。现在路由只接这个类,
 * 别的抛错交给全局出错处理。
 */
export class SkillStoreError extends Error {
	readonly code: SkillStoreFailureCode;
	constructor(code: SkillStoreFailureCode, message: string) {
		super(message);
		this.name = "SkillStoreError";
		this.code = code;
	}

	toFailure(): Failure {
		return fail(this.code, this.message);
	}
}

/** 单份 SKILL.md 的大小上限 —— 手放的目录里可能是任何东西,别把一整个视频读进内存。 */
const MAX_FILE_BYTES = 256 * 1024;

export class MaidSkillStore {
	private readonly dir: string;
	/** 主人自己那些(不含内置),name → 条目。 */
	private user = new Map<string, MaidSkill>();
	private issues: SkillProblem[] = [];
	private ready?: Promise<void>;
	private readonly reservedNames: () => Iterable<string>;

	constructor(opts: { dir: string; reservedNames?: () => Iterable<string> }) {
		this.dir = opts.dir;
		this.reservedNames = opts.reservedNames ?? (() => []);
	}

	/** 确保读过一次盘,幂等。 */
	async ensureReady(): Promise<void> {
		this.ready ??= this.reload();
		await this.ready;
	}

	/** 从盘上全量重建索引与问题清单。 */
	async reload(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const user = new Map<string, MaidSkill>();
		const issues: SkillProblem[] = [];
		const reserved = new Set([...BUILTIN_SKILL_NAMES, ...this.reservedNames()]);
		for (const entry of await readdir(this.dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dirName = entry.name;
			// 点开头的是系统 / 编辑器留下的东西,报出来只会刷屏。带存储层暂存 / 旧目录标记的是
			// 我们自己写盘、换目录写到一半的残留。
			if (dirName.startsWith(".") || isLeftoverName(dirName)) continue;
			if (!isValidSkillName(dirName)) {
				issues.push({
					dir: dirName,
					reason: serverText("service.maid-skills.store.text.1"),
				});
				continue;
			}
			let text: string;
			try {
				const buf = await readFile(join(this.dir, dirName, SKILL_FILE));
				if (buf.byteLength > MAX_FILE_BYTES) {
					issues.push({
						dir: dirName,
						reason: serverText("service.maid-skills.store.text.2", {
							value0: MAX_FILE_BYTES / 1024,
						}),
					});
					continue;
				}
				text = buf.toString("utf-8");
			} catch {
				issues.push({
					dir: dirName,
					reason: serverText("service.maid-skills.store.text.3", { value0: SKILL_FILE }),
				});
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
					reason: serverText("service.maid-skills.store.text.4", { value0: res.skill.name }),
				});
				continue;
			}
			if (reserved.has(dirName)) {
				// 内置照旧赢。让盘上一份悄悄顶掉它,主人升级之后会发现某条内置技能
				// 永远停在旧版本,而界面上看不出任何异样。
				issues.push({ dir: dirName, reason: serverText("service.maid-skills.store.text.5") });
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
			.map((s): MaidSkillEntry => ({ ...s, builtin: false }));
		return [...BUILTIN_SKILLS.map(entryOfBuiltin), ...mine];
	}

	get(name: string): MaidSkillEntry | undefined {
		const builtin = BUILTIN_SKILLS.find((s) => s.name === name);
		if (builtin) return entryOfBuiltin(builtin);
		const mine = this.user.get(name);
		return mine ? { ...mine, builtin: false } : undefined;
	}

	/** 这一轮读盘里读不进来的那些。界面拿它提醒主人「你放的那份没生效」。 */
	problems(): SkillProblem[] {
		return [...this.issues];
	}

	async create(skill: MaidSkill): Promise<void> {
		const clean = this.validate(skill);
		await this.assertFree(clean.name);
		await this.writeSkill(clean);
		this.user.set(clean.name, clean);
	}

	async update(name: string, next: MaidSkill): Promise<void> {
		this.assertEditable(name);
		if (!this.user.has(name))
			throw new SkillStoreError(
				"not_found",
				serverText("service.maid-skills.store.text.6", { value0: name }),
			);
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
		if (!this.user.has(name))
			throw new SkillStoreError(
				"not_found",
				serverText("service.maid-skills.store.text.7", { value0: name }),
			);
		await rm(join(this.dir, name), { recursive: true, force: true });
		this.user.delete(name);
	}

	/**
	 * 入库前过一遍尺子 —— 手法是**写出去再读回来**:序列化一次再解析一次,
	 * 名字、长度、正文非空全部由 {@link parseSkillFile} 那一处判,不在这儿抄第二遍。
	 * 两处各判各的,迟早会出现「存得进去、读不回来」的东西。
	 */
	private validate(skill: MaidSkill): MaidSkill {
		const res = parseSkillFile(formatSkillFile(skill));
		if (!res.ok) throw new SkillStoreError("invalid", res.reason);
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
		if (this.isReserved(name)) {
			throw new SkillStoreError(
				"conflict",
				serverText("service.maid-skills.store.text.8", { value0: name }),
			);
		}
		if (this.user.has(name))
			throw new SkillStoreError(
				"conflict",
				serverText("service.maid-skills.store.text.9", { value0: name }),
			);
		if (await this.fileExists(name))
			throw new SkillStoreError(
				"conflict",
				serverText("service.maid-skills.store.text.10", { value0: name }),
			);
	}

	/** 盘上有没有这个名字的 SKILL.md。空目录 / 临时文件残留不算占用 —— 那儿没有主人的东西可丢。 */
	private async fileExists(name: string): Promise<boolean> {
		return await stat(join(this.dir, name, SKILL_FILE)).then(
			() => true,
			() => false,
		);
	}

	/** 改 / 删的前置:名字合法(它要拼进路径)且不是内置。 */
	private assertEditable(name: string): void {
		if (!isValidSkillName(name))
			throw new SkillStoreError(
				"invalid",
				serverText("service.maid-skills.store.text.11", { value0: name }),
			);
		if (this.isReserved(name)) {
			throw new SkillStoreError(
				"conflict",
				serverText("service.maid-skills.store.text.12", { value0: name }),
			);
		}
	}

	/** 内置与当前在册的提供方技能共同占名；所有读写入口都只问这一处。 */
	private isReserved(name: string): boolean {
		if (BUILTIN_SKILL_NAMES.has(name)) return true;
		for (const reserved of this.reservedNames()) {
			if (reserved === name) return true;
		}
		return false;
	}

	/**
	 * 落盘。走存储层的原子写(同目录临时文件 + 改名)—— 半份 SKILL.md 下次读盘就是一条问题;
	 * 临时名各写各的,同一条技能并发存也不会互相踩。它是给人看、给人手改的 markdown,
	 * 所以写的就是 `formatSkillFile` 那份字节,不是状态 JSON。
	 */
	private async writeSkill(skill: MaidSkill): Promise<void> {
		await atomicWriteFile(join(this.dir, skill.name, SKILL_FILE), formatSkillFile(skill));
	}
}
