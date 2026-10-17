import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	assertChangelogHasVersion,
	cautionOf,
	isDevBuild,
	releaseNotesOf,
	SUMMARY_MAX_CHARS,
	sectionOf,
	summaryOf,
} from "../changelog-section.mjs";
import { repoRoot } from "../desktop-layout.mjs";

/**
 * 从 `apps/CHANGELOG.md` 抽一个版本段:`summaryOf` 是标题下第一段(进更新清单的
 * `notes`,右下角通知卡念的那句),`sectionOf` 是整段(贴到 GitHub Release 正文)。
 * 两者都在发版 workflow 里跑,抽错了要么签出一份空 notes 静默过关,要么发布页贴错版本
 * —— 所以找不到 / 为空 / 超长一律抛,不给默认值。
 */

// 照 apps/CHANGELOG.md 的真实版式:文件头 → 分隔线 → 各版本段,段与段之间 `---`,
// 正式版 0.9.0 排在它自己的 alpha 前面(时间倒序)。
const MD = `# Changelog · 独立端

文件头的说明,不属于任何版本。

---

## [0.9.1] — 2026-09-04

链接解析学会了认群:只在你点名的群里出卡。**有一条要动手的**:文案里的 \`{url}\` 请删掉(详见 [Changed](#changed))。

### Added

- **链接解析生效范围**:「所有群」照旧 (4b1d36b1)

### Changed

- ⚠️ 文案模板不再替你抹掉 \`{url}\` (7a62f023)

---

## [0.9.0] — 2026-09-03

从 alpha 系列毕业的正式版。

⚠️ **从 0.8.0 直接升上来的请先看这段。**

- 这一次仍得拉镜像

---

## [0.9.0-alpha.2] — 2026-09-03

### Added

- 没写概述、直接开列表的段

---

## [0.8.0] — 2026-08-31

最后一段,后面没有分隔线。

### Fixed

- 收尾
`;

describe("sectionOf:该版本整段", () => {
	it("从标题下一行起到分隔线前止,不含标题、不含下一版", () => {
		const s = sectionOf(MD, "0.9.1");
		expect(s.startsWith("链接解析学会了认群")).toBe(true);
		expect(s).toContain("### Changed");
		expect(s.endsWith("(7a62f023)")).toBe(true);
		expect(s).not.toContain("## [0.9.1]");
		expect(s).not.toContain("0.9.0");
	});

	it("正式版与它的 alpha 各取各的,不会串段", () => {
		expect(sectionOf(MD, "0.9.0")).toContain("从 alpha 系列毕业");
		expect(sectionOf(MD, "0.9.0")).not.toContain("没写概述");
		expect(sectionOf(MD, "0.9.0-alpha.2")).toContain("没写概述");
	});

	it("文件末尾那段没有分隔线也能取到", () => {
		const s = sectionOf(MD, "0.8.0");
		expect(s.startsWith("最后一段")).toBe(true);
		expect(s.endsWith("- 收尾")).toBe(true);
	});

	it("找不到该版本 → 抛,消息里带版本号", () => {
		expect(() => sectionOf(MD, "0.7.0")).toThrow("0.7.0");
	});
});

describe("summaryOf:标题下第一段,去 markdown", () => {
	it("只取第一段,加粗 / 反引号 / 链接都剥成纯文字", () => {
		expect(summaryOf(MD, "0.9.1")).toBe(
			"链接解析学会了认群:只在你点名的群里出卡。有一条要动手的:文案里的 {url} 请删掉(详见 Changed)。",
		);
	});

	it("第二段(⚠️ 那段)不进概述", () => {
		expect(summaryOf(MD, "0.9.0")).toBe("从 alpha 系列毕业的正式版。");
	});

	it("标题下直接是 ### 小节或列表 → 概述为空,抛", () => {
		expect(() => summaryOf(MD, "0.9.0-alpha.2")).toThrow("概述");
	});

	it("超过上限抛,消息里写实际字数;刚好到上限放行", () => {
		const section = (text) => `## [1.0.0] — 2026-01-01\n\n${text}\n\n### Added\n\n- x\n`;
		const atLimit = "字".repeat(SUMMARY_MAX_CHARS);
		expect(summaryOf(section(atLimit), "1.0.0")).toBe(atLimit);
		const over = "字".repeat(SUMMARY_MAX_CHARS + 1);
		expect(() => summaryOf(section(over), "1.0.0")).toThrow(String(SUMMARY_MAX_CHARS + 1));
	});

	it("找不到该版本 → 抛", () => {
		expect(() => summaryOf(MD, "0.7.0")).toThrow("0.7.0");
	});
});

// 1.0 起的各版本段:新的在前。1.1.0 照 0.9.0 的版式(⚠️ 段后直接跟要点、没有 ###),
// 1.1.0-alpha.1 的 ⚠️ 段后面才是 ###,1.0.0 没有 ⚠️ 段,0.9.1 那段概述超 120 字。
const MD1 = `# Changelog · 独立端

---

## [Unreleased]

还没发的,版本号不成形。

---

## [1.1.0] — 2026-11-01

这一版把**推送历史**做成了可搜索的 [列表](https://example.com),\`/history\` 里能用。

⚠️ **从 1.0.0 直接升上来的请先看这段。**

- 先停掉旧的定时任务
- 再升级

---

## [1.1.0-alpha.1]

alpha 的概述。

⚠️ alpha 里要动手的事。

### Added

- 某一条

---

## [1.0.0] — 2026-10-20

第一个 1.0 正式版。

### Added

- 某一条

---

## [0.9.1] — 2026-09-04

${"字".repeat(130)}

---

## [0.9.0] — 2026-09-03

从 alpha 系列毕业的正式版。
`;

describe("cautionOf:标题后到第一个 ### 之间的 ⚠️ 段", () => {
	it("⚠️ 段原样交出,连后面跟着的要点列表(没有 ### 的版式)", () => {
		expect(cautionOf(MD1, "1.1.0")).toBe(
			"⚠️ **从 1.0.0 直接升上来的请先看这段。**\n\n- 先停掉旧的定时任务\n- 再升级",
		);
	});

	it("⚠️ 段后面紧跟 ### 时只取到 ### 之前", () => {
		expect(cautionOf(MD1, "1.1.0-alpha.1")).toBe("⚠️ alpha 里要动手的事。");
	});

	it("没有 ⚠️ 段 → undefined", () => {
		expect(cautionOf(MD1, "1.0.0")).toBeUndefined();
	});

	it("概述后面跟着一段不以 ⚠️ 开头的话 → 抛,点名是哪一版", () => {
		const md = "## [1.2.0]\n\n概述。\n\n小心这个,不是 ⚠️ 开头。\n\n### Added\n\n- x\n";
		expect(() => cautionOf(md, "1.2.0")).toThrow("1.2.0");
	});

	it("找不到该版本 → 抛", () => {
		expect(() => cautionOf(MD1, "9.9.9")).toThrow("9.9.9");
	});
});

describe("releaseNotesOf:1.0 起各版的概述与 ⚠️ 段", () => {
	it("只收 1.0 起的段,顺序照文件(新的在前);0.x 不碰,含概述超长的 0.9.1", () => {
		expect(releaseNotesOf(MD1).map((r) => r.version)).toEqual(["1.1.0", "1.1.0-alpha.1", "1.0.0"]);
	});

	it("概述交 markdown 原文(链接、加粗、行内代码都留着),⚠️ 段原样带上", () => {
		const [latest] = releaseNotesOf(MD1);
		expect(latest.summary).toBe(
			"这一版把**推送历史**做成了可搜索的 [列表](https://example.com),`/history` 里能用。",
		);
		expect(latest.caution).toBe(cautionOf(MD1, "1.1.0"));
	});

	it("日期取标题「— YYYY-MM-DD」,没有就缺这一格;没有 ⚠️ 段就缺 caution", () => {
		const entries = releaseNotesOf(MD1);
		expect(entries[0].date).toBe("2026-11-01");
		expect("date" in entries[1]).toBe(false);
		expect("caution" in entries[2]).toBe(false);
		expect(entries[2]).toEqual({
			version: "1.0.0",
			date: "2026-10-20",
			summary: "第一个 1.0 正式版。",
		});
	});

	it("版本号不成形的标题([Unreleased])跳过", () => {
		expect(releaseNotesOf(MD1).some((r) => r.version === "Unreleased")).toBe(false);
	});

	it("概述为空或超 120 字 → 抛,点名是哪一版", () => {
		const long = `## [1.0.0] — 2026-01-01\n\n${"字".repeat(SUMMARY_MAX_CHARS + 1)}\n`;
		expect(() => releaseNotesOf(long)).toThrow("1.0.0");
		const empty = "## [1.0.0] — 2026-01-01\n\n### Added\n\n- x\n";
		expect(() => releaseNotesOf(empty)).toThrow("1.0.0");
	});

	it("120 字的上限按剥掉 markdown 之后的字数算", () => {
		const atLimit = `**${"字".repeat(SUMMARY_MAX_CHARS)}**`;
		const [entry] = releaseNotesOf(`## [1.0.0] — 2026-01-01\n\n${atLimit}\n`);
		expect(entry.summary).toBe(atLimit);
	});

	it("读真仓库的 apps/CHANGELOG.md 不抛(以后写坏了 1.x 段在这里红)", () => {
		const md = readFileSync(join(repoRoot, "apps/CHANGELOG.md"), "utf8");
		expect(() => releaseNotesOf(md)).not.toThrow();
	});
});

describe("assertChangelogHasVersion:装配时当前版本必须有段", () => {
	it("不是开发版而 CHANGELOG 里没有它 → 抛,点名版本号", () => {
		expect(() => assertChangelogHasVersion(MD1, "1.5.0")).toThrow("1.5.0");
	});

	it("有段 → 放行;开发版不查", () => {
		expect(() => assertChangelogHasVersion(MD1, "1.1.0")).not.toThrow();
		expect(() => assertChangelogHasVersion(MD1, "0.0.0-dev")).not.toThrow();
		expect(() => assertChangelogHasVersion(MD1, "dev")).not.toThrow();
	});

	// 服务端的 isDevBuild(update/version-order.ts)是开发版判法的唯一源头,这里抄了一份
	// 因为 .mjs 引不了 TS。两处判据分叉 = 装配时把开发版当成正式版红了、或反过来放过正式版。
	it("开发版的判据与服务端 isDevBuild 的两条一致", () => {
		const src = readFileSync(join(repoRoot, "apps/server/src/update/version-order.ts"), "utf8");
		expect(src).toContain('return version === "dev" || version.startsWith("0.0.0-dev");');
		for (const v of ["dev", "0.0.0-dev", "0.0.0-dev.3"]) expect(isDevBuild(v)).toBe(true);
		for (const v of ["0.12.0", "1.0.0-alpha.1", "0.0.1"]) expect(isDevBuild(v)).toBe(false);
	});
});

describe("CLI:workflow 用的入口", () => {
	const temps = [];
	afterEach(() => {
		for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
	});

	function run(args) {
		const dir = mkdtempSync(join(tmpdir(), "bn-changelog-"));
		temps.push(dir);
		const file = join(dir, "CHANGELOG.md");
		writeFileSync(file, MD);
		return spawnSync(
			process.execPath,
			[join(repoRoot, "scripts/changelog-section.mjs"), "--file", file, ...args],
			{ encoding: "utf8" },
		);
	}

	it("默认打印概述;--part section 打印整段", () => {
		const summary = run(["--version", "0.9.0"]);
		expect(summary.status, summary.stderr).toBe(0);
		expect(summary.stdout).toBe("从 alpha 系列毕业的正式版。\n");
		const section = run(["--version", "0.9.0", "--part", "section"]);
		expect(section.status, section.stderr).toBe(0);
		expect(section.stdout).toContain("⚠️ **从 0.8.0 直接升上来的请先看这段。**");
	});

	it("抽不出来 → 退 1,stderr 是 GitHub 能标红的 ::error::", () => {
		const r = run(["--version", "0.9.0-alpha.2"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("::error::");
		expect(r.stdout).toBe("");
	});
});

// 发版链两端隔着一次发版才各跑一次:这里核对 workflow 真的把概述喂进了签名脚本 ——
// 抽概述那步被删、或 `--notes` 被漏掉,清单会带着空 notes 静默过关,只有下一版的
// 通知卡上少了那句话才有人发现。
// 抽概述与签清单都在 `.github/scripts/` 的脚本里,workflow 只剩调用与 env 接线,
// 所以三处都要看:workflow 调了它们、NOTES 从抽概述那步的输出接进签清单那步、脚本里真的用上。
describe("update-payload.yml 把概述喂进清单", () => {
	const read = (p) => readFileSync(join(repoRoot, p), "utf8");
	const wf = read(".github/workflows/update-payload.yml");
	/** 按 `id:` 取 workflow 里的一整个 step(从 `- name:` 到下一个 `- name:` 前)。 */
	const stepOf = (id) => {
		const found = wf
			.split(/\n(?= {6}- name: )/)
			.find((step) => new RegExp(`^ {8}id: ${id}$`, "m").test(step));
		if (!found) throw new Error(`update-payload.yml 里找不到 id 为 ${id} 的 step`);
		return found;
	};

	it("从 CHANGELOG 抽概述,再传给 sign-update-manifest 的 --notes", () => {
		expect(stepOf("notes")).toContain("run: bash .github/scripts/shared/read-release-summary.sh");
		const readSummary = read(".github/scripts/shared/read-release-summary.sh");
		expect(readSummary).toContain("node scripts/changelog-section.mjs");
		expect(readSummary).toContain('--version "$VERSION"');
		expect(readSummary).toContain("--part summary");

		const sign = stepOf("sign");
		expect(sign).toContain("run: bash .github/scripts/update-payload/sign-payload-manifest.sh");
		expect(sign).toMatch(/NOTES: \$\{\{ steps\.notes\.outputs\.value \}\}/);
		expect(read(".github/scripts/update-payload/sign-payload-manifest.sh")).toMatch(
			/sign-update-manifest\.mjs[\s\S]*--notes "\$NOTES"/,
		);
	});
});
