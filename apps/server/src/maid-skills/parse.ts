/**
 * `SKILL.md` 的解析与回写 —— 一条女仆技能在盘上的全部形状。
 *
 * 形状照 Claude Code 的 Agent Skill 标准:YAML frontmatter + Markdown 正文,
 * 单文件、不带附件、**不跑脚本**(ADR-0001「明确不做」第一条:这台 server 攥着
 * B站 cookie 与 AI key,而 skill 正是「从网上抄一份贴进来」的东西)。
 *
 * 这份文件**主人可以手写手放**,所以解析器面对的从来不是我们自己序列化出来的
 * 东西。纪律只有一条:**读不懂就说清楚哪儿读不懂**,别默默吞掉半份 —— 一条
 * 静默残缺的 skill,表现是女仆莫名其妙地少干一半活,而主人无从查起。
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * 名字规则:kebab-case ASCII(主人 2026-08-20 拍板走 Claude Code 标准)。
 *
 * 它**同时是磁盘目录名与斜杠命令**,所以白名单里一个 `.` `/` `\` 都没有 ——
 * `..` 在构造上就拼不出来。皮肤库那次审计的教训摆在这儿:`SkinStore.remove`
 * 少了这道闸,被 `DELETE /%2e%2e%2fconversations` 删掉了整个会话目录。
 *
 * 只收小写还有第二重理由:macOS 的文件系统大小写不敏感、且会把文件名归一化成
 * NFD。这两件事在纯 ASCII 小写这一档上都没有意外。
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 名字长度上限。目录名 + 斜杠命令都要打,长了两头都难受。 */
const MAX_NAME_CHARS = 32;

/**
 * description 长度上限(ADR 决策 13)。
 *
 * 常驻成本全压在这一句上:**每一条**参与模型自选的 skill,每轮请求都带着它的
 * description。不封顶就等于让一条 skill 悄悄吃掉整个上下文预算,而症状是「女仆
 * 最近好像变笨了」—— 最难查的那种。
 */
export const MAX_SKILL_DESC_CHARS = 200;

/** 正文长度上限。正文只在 skill 被用上那一轮进上下文,可以宽得多,但不能没有底。 */
export const MAX_SKILL_BODY_CHARS = 20_000;

/** frontmatter 整块的字节上限 —— 手放的文件可能是任意东西,别让 YAML 解析器啃一整个视频。 */
const MAX_FRONTMATTER_CHARS = 4_000;

/** 一条技能的全部内容。`builtin` 之类的身份由 store 另行标注,不属于文件本身。 */
export interface ParsedSkill {
	/** kebab-case,既是目录名也是斜杠命令。 */
	name: string;
	/** 一句话说清它干什么 —— 模型靠它决定要不要自选这条。 */
	description: string;
	/**
	 * 允许用的工具名**子集**;`undefined` = 不限(用这场对话本来的工具面)。
	 *
	 * **只减不加**(ADR 决策 11):用户可写的数据永远不能扩大工具面。所以这里给出
	 * 的名字只用来做交集,写一个不存在的工具名不会凭空长出一把工具来。
	 */
	allowedTools?: string[];
	/** 退出模型自选,只留斜杠命令这条路。 */
	disableModelInvocation: boolean;
	/** frontmatter 之后的正文,首尾空白已剥。 */
	body: string;
}

export type ParseSkillResult = { ok: true; skill: ParsedSkill } | { ok: false; reason: string };

/** 名字能不能用。见 {@link SKILL_NAME_RE} —— 这是一道安全闸,不只是口味。 */
export function isValidSkillName(name: unknown): boolean {
	if (typeof name !== "string") return false;
	if (name.length === 0 || name.length > MAX_NAME_CHARS) return false;
	return SKILL_NAME_RE.test(name);
}

/**
 * `allowed-tools` 归一。收两种写法 —— 逗号串(Claude Code 的写法)与 YAML 列表,
 * 手写的人两种都会写,为形状挑剔一条读得懂的声明没有意义。
 */
function parseAllowedTools(raw: unknown): string[] | undefined {
	// 键缺席 / 写了个空值 → 不限。**不**当成「一把都不给」:那是个静默的大收紧,
	// 而它最可能的来源是主人写了个 `allowed-tools:` 就去想下一行了。
	if (raw === undefined || raw === null) return undefined;
	const parts =
		typeof raw === "string"
			? raw.split(",")
			: Array.isArray(raw)
				? raw.map((v) => String(v))
				: null;
	if (parts === null) return undefined;
	const out: string[] = [];
	for (const p of parts) {
		const name = p.trim();
		if (name !== "" && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * 一份 `SKILL.md` → 结构体,或一句「哪儿读不懂」。
 *
 * 分隔符只找**第一段**:正文里的 Markdown 分割线再多也不影响(那是常见写法)。
 */
export function parseSkillFile(text: string): ParseSkillResult {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { ok: false, reason: "缺少 frontmatter:文件要以 `---` 单独一行开头" };
	}
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) {
		return { ok: false, reason: "frontmatter 没有收尾:缺少第二行 `---`" };
	}
	const rawFm = normalized.slice(4, end);
	if (rawFm.length > MAX_FRONTMATTER_CHARS) {
		return { ok: false, reason: `frontmatter 过长(上限 ${MAX_FRONTMATTER_CHARS} 字)` };
	}
	// `\n---` 之后到行尾的残字(`---abc`)不算收尾,那多半是主人写岔了。
	const afterDelim = normalized.slice(end + 4);
	const lineBreak = afterDelim.indexOf("\n");
	const tail = lineBreak === -1 ? afterDelim : afterDelim.slice(0, lineBreak);
	if (tail.trim() !== "") {
		return { ok: false, reason: "frontmatter 的收尾 `---` 那一行不能再有别的字" };
	}

	let fm: unknown;
	try {
		fm = parseYaml(rawFm);
	} catch (err) {
		return { ok: false, reason: `frontmatter 不是合法 YAML:${(err as Error).message}` };
	}
	if (typeof fm !== "object" || fm === null || Array.isArray(fm)) {
		return { ok: false, reason: "frontmatter 要是一组 `键: 值`" };
	}
	const rec = fm as Record<string, unknown>;

	const name = rec.name;
	if (!isValidSkillName(name)) {
		return {
			ok: false,
			reason: `name 不合法:只收小写字母 / 数字 / 单个连字符(如 weekly-report),最长 ${MAX_NAME_CHARS} 字符`,
		};
	}

	const description = typeof rec.description === "string" ? rec.description.trim() : "";
	if (description === "")
		return { ok: false, reason: "description 不能为空 —— 模型靠它决定要不要用这条技能" };
	if (description.length > MAX_SKILL_DESC_CHARS) {
		return { ok: false, reason: `description 超长(上限 ${MAX_SKILL_DESC_CHARS} 字)` };
	}

	const body = (lineBreak === -1 ? "" : afterDelim.slice(lineBreak + 1)).trim();
	if (body === "") return { ok: false, reason: "正文是空的 —— 一条什么都不说的技能等于没有" };
	if (body.length > MAX_SKILL_BODY_CHARS) {
		return { ok: false, reason: `正文超长(上限 ${MAX_SKILL_BODY_CHARS} 字)` };
	}

	const skill: ParsedSkill = {
		name: name as string,
		description,
		disableModelInvocation: rec["disable-model-invocation"] === true,
		body,
	};
	const allowedTools = parseAllowedTools(rec["allowed-tools"]);
	if (allowedTools !== undefined) skill.allowedTools = allowedTools;
	return { ok: true, skill };
}

/**
 * 结构体 → `SKILL.md`。frontmatter 交给 yaml 序列化,不手拼 ——
 * description 里一个冒号就能让手拼的那份读不回来。
 */
export function formatSkillFile(skill: ParsedSkill): string {
	const fm: Record<string, unknown> = { name: skill.name, description: skill.description };
	if (skill.allowedTools !== undefined) fm["allowed-tools"] = skill.allowedTools;
	// 只在为真时写:缺省值不落盘,手放的文件才不会因为「少了一行」看起来不完整。
	if (skill.disableModelInvocation) fm["disable-model-invocation"] = true;
	return `---\n${stringifyYaml(fm)}---\n\n${skill.body}\n`;
}
