import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArg, requireArg } from "./cli-args.mjs";
import { repoRoot } from "./desktop-layout.mjs";

/**
 * 从 `apps/CHANGELOG.md` 抽一个版本段,发版 workflow 用:
 *
 * - `summaryOf` —— 标题下第一段去掉 markdown,进更新清单的 `notes`,右下角「有新版」
 *   通知卡念的就是这句。所以它必须短(上限 {@link SUMMARY_MAX_CHARS} 字)、平实;
 *   要动手的事项(⚠️)另起一段写,不进这里。规矩见 `.claude/skills/release/changelog.md`。
 * - `sectionOf` —— 整段(不含 `## [x.y.z]` 标题行),贴到 GitHub Release 正文。
 *
 * 找不到该版 / 概述为空 / 超长一律抛,不给默认值:签出一份空 notes 或贴错版本都是
 * 静默过关、发出去才有人发现的那种错。CHANGELOG 的概述段写成一行,多行会按空格拼。
 */

export const SUMMARY_MAX_CHARS = 120;

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {string} md @param {string} version */
export function sectionOf(md, version) {
	const start = md.search(new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m"));
	if (start === -1) throw new Error(`CHANGELOG 里没有 [${version}] 这一段`);
	const headingEnd = md.indexOf("\n", start);
	const rest = headingEnd === -1 ? "" : md.slice(headingEnd + 1);
	const next = rest.search(/^## /m);
	const section = next === -1 ? rest : rest.slice(0, next);
	// 段尾的 `---` 是段与段之间的分隔线,不属于这一段。
	return section.replace(/\n-{3,}\s*$/, "").trim();
}

/** 只剥通知卡上显示不了的三样:链接、加粗、行内代码。 @param {string} s */
function stripMarkdown(s) {
	return s
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}

/** @param {string} md @param {string} version */
export function summaryOf(md, version) {
	const section = sectionOf(md, version);
	const firstBlock = section.split(/\n[ \t]*\n/, 1)[0] ?? "";
	const lines = firstBlock
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const first = lines[0] ?? "";
	if (!first || first.startsWith("#") || /^[-*] /.test(first)) {
		throw new Error(`[${version}] 标题下没有概述段,第一块是「${first.slice(0, 24)}」`);
	}
	const text = stripMarkdown(lines.join(" ")).trim();
	const length = [...text].length;
	if (length > SUMMARY_MAX_CHARS) {
		throw new Error(`[${version}] 概述 ${length} 字,超过 ${SUMMARY_MAX_CHARS} 字上限`);
	}
	return text;
}

// CLI:`--version <v> [--part summary|section] [--file <path>]`,结果打到 stdout。
// 抽不出来退 1,stderr 打 `::error::` 让 GitHub 在 job 页上标红。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const parts = { summary: summaryOf, section: sectionOf };
	try {
		const version = requireArg("version");
		const part = readArg("part", "summary");
		const pick = parts[part];
		if (!pick) throw new Error(`--part 只认 summary / section,给的是 ${part}`);
		const md = readFileSync(resolve(readArg("file", join(repoRoot, "apps/CHANGELOG.md"))), "utf8");
		process.stdout.write(`${pick(md, version)}\n`);
	} catch (e) {
		process.stderr.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
}
