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
 * - `cautionOf` / `releaseNotesOf` —— 装配 server bundle 时把 1.0 起各版的概述与 ⚠️ 段抽成
 *   载荷里的 `release-notes.json`,升级之后的「本次更新」弹窗读它。注意和 `summaryOf` 不同:
 *   通知卡的 `notes` 是**纯文字**,这里交的概述与 ⚠️ 段是 **markdown 原文**,面板用受限渲染画;
 *   概述的 {@link SUMMARY_MAX_CHARS} 上限照旧,按剥掉 markdown 之后的字数算。
 *   标题下到第一个 `###` 之前只许有概述和 ⚠️ 段(⚠️ 段可以连着后面的要点列表),别的话会被
 *   静默丢掉,所以 `cautionOf` 遇到就抛。
 * - `assertChangelogHasVersion` —— 装配时当前版本(开发版除外)在 CHANGELOG 里必须有段。
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

/**
 * 标题下第一段:`markdown` 是原文(多行按空格拼),`text` 是剥掉 markdown 之后的纯文字,
 * 长度判法只看后者。
 * @param {string} md @param {string} version
 */
function summaryBlockOf(md, version) {
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
	const markdown = lines.join(" ");
	const text = stripMarkdown(markdown).trim();
	const length = [...text].length;
	if (length > SUMMARY_MAX_CHARS) {
		throw new Error(`[${version}] 概述 ${length} 字,超过 ${SUMMARY_MAX_CHARS} 字上限`);
	}
	return { markdown, text };
}

/** @param {string} md @param {string} version */
export function summaryOf(md, version) {
	return summaryBlockOf(md, version).text;
}

/**
 * 标题后、第一个 `###` 之前的 ⚠️ 段(要动手的事),连它后面跟着的要点列表一起原样交出;
 * 没有就 `undefined`。概述之后出现不以 ⚠️ 开头的话 → 抛:它既进不了概述也进不了弹窗,
 * 不抛就是静默丢。
 *
 * @param {string} md @param {string} version
 * @returns {string | undefined}
 */
export function cautionOf(md, version) {
	const section = sectionOf(md, version);
	const sub = section.search(/^### /m);
	const head = (sub === -1 ? section : section.slice(0, sub)).trim();
	const [, ...rest] = head.split(/\n[ \t]*\n/);
	const caution = rest.join("\n\n").trim();
	if (!caution) return undefined;
	if (!caution.startsWith("⚠️")) {
		throw new Error(
			`[${version}] 概述后面跟着一段不以 ⚠️ 开头的话「${caution.slice(0, 24)}」,要动手的事请以 ⚠️ 另起一段`,
		);
	}
	return caution;
}

/**
 * 载荷里的一版更新说明:`summary` 与 `caution` 都是 markdown 原文。
 *
 * @typedef {{ version: string, date?: string, summary: string, caution?: string }} ReleaseNoteEntry
 */

/**
 * 整份 CHANGELOG 里 1.0 起的各版(预发布也收),顺序照文件 —— 文件本身新的在前。0.x 不收:
 * 提示清单是 1.0 才有的,而 0.9.1 那类老段的概述超长,收进来会卡住严格的判法。
 * 1.x 段的概述为空 / 超长或有不合规矩的话一律抛,所以以后写坏任何一个 1.x 段,发版装配那步就红。
 * `[Unreleased]` 这类版本号不成形的标题跳过。
 *
 * @param {string} md
 * @returns {ReleaseNoteEntry[]}
 */
export function releaseNotesOf(md) {
	/** @type {ReleaseNoteEntry[]} */
	const entries = [];
	for (const m of md.matchAll(/^## \[([^\]]+)\](?:[ \t]*—[ \t]*(\d{4}-\d{2}-\d{2}))?/gm)) {
		const [, version, date] = m;
		if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || Number(version.split(".")[0]) < 1) {
			continue;
		}
		const caution = cautionOf(md, version);
		entries.push({
			version,
			...(date ? { date } : {}),
			summary: summaryBlockOf(md, version).markdown,
			...(caution ? { caution } : {}),
		});
	}
	return entries;
}

/**
 * 开发版的判法。**抄自** `apps/server/src/update/version-order.ts` 的 `isDevBuild`(.mjs 引不了
 * TS),两处判据由 changelog-section.test.mjs 钉着,别只改一边。
 *
 * @param {string} version
 */
export function isDevBuild(version) {
	return version === "dev" || version.startsWith("0.0.0-dev");
}

/**
 * 装配时核对:不是开发版,CHANGELOG 里就必须有当前版本这一段。缺了弹窗只剩标题、发行说明
 * 里少一版,而这类错发出去才有人发现,所以和 `summaryOf` 一样不给默认值。
 *
 * @param {string} md @param {string} version
 */
export function assertChangelogHasVersion(md, version) {
	if (isDevBuild(version)) return;
	sectionOf(md, version);
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
