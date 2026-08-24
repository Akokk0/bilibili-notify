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

import { complainAboutSkill, isValidSkillName } from "@bilibili-notify/contract";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

// 名字闸与五条收/拒规则都住在 contract(见那边 complainAboutSkill 的注释)。
// 这里原样再导出,免得动这个模块现有的调用点。
export { isValidSkillName };

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

	const description = typeof rec.description === "string" ? rec.description.trim() : "";
	const body = (lineBreak === -1 ? "" : afterDelim.slice(lineBreak + 1)).trim();
	// 名字 / description / 正文这五条与网页端的预检**是同一份**(contract)。
	const complaint = complainAboutSkill({ name: rec.name, description, body });
	if (complaint) return { ok: false, reason: complaint };

	const skill: ParsedSkill = {
		name: rec.name as string,
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
