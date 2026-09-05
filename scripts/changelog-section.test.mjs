import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SUMMARY_MAX_CHARS, sectionOf, summaryOf } from "./changelog-section.mjs";
import { repoRoot } from "./desktop-layout.mjs";

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
describe("update-payload.yml 把概述喂进清单", () => {
	const wf = readFileSync(join(repoRoot, ".github/workflows/update-payload.yml"), "utf8");

	it("从 CHANGELOG 抽概述,再传给 sign-update-manifest 的 --notes", () => {
		expect(wf).toContain('node scripts/changelog-section.mjs --version "$VERSION" --part summary');
		expect(wf).toMatch(/sign-update-manifest\.mjs[\s\S]*--notes "\$NOTES"/);
	});
});
