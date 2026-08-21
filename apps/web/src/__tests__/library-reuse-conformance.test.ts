/// <reference types="node" />
/**
 * 「组件库里有的不许重写」的静态守卫。
 *
 * `packages/ui/README.md` 开头就写着「写任何 UI 之前先扫一遍清单」,但清单是**给人看的**
 * —— 没有任何东西拦下一次手搓。而手搓件在默认装下和库件长得几乎一样,构建绿、类型绿、
 * 渲染测试也绿:它只在**换肤**或**改库件**的时候露馅 —— 库里改了一版圆角/字号/间距,
 * 手搓的那几份原地不动,同一个意思散成四五种长相。
 *
 * `EmptyNote` 的注释里记着这件事已经发生过一次:收编前站内手写了九份,在四种圆角三种
 * 字号之间漂。收编之后没有护栏,于是又漂出了第二波。这个文件就是那道护栏。
 *
 * 每条规则都带**写明理由**的豁免表:表里写了却已经改完的文件也要报,否则豁免条目会
 * 一直挂着骗人。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..");
const UI_SRC_DIR = join(SRC_DIR, "../../../packages/ui/src");

function listTsxRecursive(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) acc.push(...listTsxRecursive(full));
		else if (full.endsWith(".tsx") && !full.includes("__tests__")) acc.push(full);
	}
	return acc;
}

/** 注释行不算数 —— 讲的往往正是「以前手搓成什么样」。 */
function codeOf(line: string): string {
	return line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

function rel(file: string): string {
	return file.replace(/^.*?((apps|packages)\/)/, "$1");
}

/**
 * 去掉变体前缀的类名集合 —— `hover:bg-bn-danger-soft` 不算「这个元素是红底」,
 * 它只是**悬停时**变红。不剥的话红字小按钮会被当成手搓的红盒子(实测误报过)。
 */
function staticClasses(code: string): string {
	return code
		.split(/[\s"'`{}]+/)
		.filter((t) => t.length > 0 && !t.includes(":"))
		.join(" ");
}

/** 扫 web + ui 全部产品 .tsx,逐行套 `hit`,命中的报 `文件:行`。 */
function scan(hit: (code: string) => boolean, skipFiles: string[] = []): string[] {
	const found: string[] = [];
	for (const root of [join(SRC_DIR, "pages"), join(SRC_DIR, "components"), UI_SRC_DIR]) {
		for (const file of listTsxRecursive(root)) {
			if (skipFiles.some((s) => file.endsWith(s))) continue;
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (hit(codeOf(line))) found.push(`${rel(file)}:${i + 1}`);
				});
		}
	}
	return found;
}

/**
 * 刻意留着的,连**为什么**一起记(≥20 字,下面有条测试钉着)。写了却已经改完的
 * 也要报 —— 否则豁免条目会一直挂着骗人。
 */
function checkKept(found: string[], kept: Record<string, string>): string[] {
	const fileOf = (hit: string) => hit.slice(0, hit.lastIndexOf(":"));
	const offenders = found.filter((hit) => !kept[fileOf(hit)]);
	const hitFiles = new Set(found.map(fileOf));
	for (const file of Object.keys(kept)) {
		if (!hitFiles.has(file)) offenders.push(`${file}: 已经改完了,请从豁免表删掉`);
	}
	return offenders;
}

describe("空态盒只有 EmptyNote 那一份", () => {
	/**
	 * 判据:中性虚线框 + 居中文字。虚线本身不够 —— `AddButton` / `AddCard` 那套
	 * 「这里还能再加一个」也是虚线,拖拽落点、上传区同理,它们都不是空态。
	 */
	function isEmptyBox(code: string): boolean {
		const cls = staticClasses(code);
		return (
			cls.includes("border-dashed") &&
			cls.includes("border-bn-border") &&
			cls.includes("text-center")
		);
	}

	it("没有哪个页面自己拼中性虚线框 + 居中文字", () => {
		// EmptyNote 的注释里记着收编前手写过九份、在四种圆角三种字号之间漂。
		// 没有护栏,于是又漂出了第二波 —— 这条就是补上的护栏。
		expect(scan(isEmptyBox, ["atoms.tsx"]).join("\n")).toBe("");
	});
});

describe("红字提示盒只有 ErrorNote 那一份", () => {
	/**
	 * 判据是**红三件套同时出现在一个 class 串里** —— 边 + 底 + 字。单独一个不算:
	 * 只写 `text-bn-danger-text` 的红字行、只写 `border-bn-danger-border` 的红框输入,
	 * 那都是别的东西。三个凑齐了就是在手搓这个盒子。
	 */
	function isDangerBox(code: string): boolean {
		const cls = staticClasses(code);
		return (
			cls.includes("border-bn-danger-border") &&
			cls.includes("bg-bn-danger-soft") &&
			cls.includes("text-bn-danger-text")
		);
	}

	const KEPT: Record<string, string> = {
		"apps/web/src/components/alert-shell.tsx":
			"组件告警条不是内联提示盒:portal 到 body、fixed 在右上角、带 aria-live=assertive 与「全部清除」钮。它是 Toast 那一族的东西(只是语义为红),塞进 ErrorNote 要给库件加 fixed 定位与关闭钮两个它不该有的能力。",
		"apps/web/src/pages/cards/FontPicker.tsx":
			"局部的 Notice 是 danger / warning **双色同形**的一对,靠的就是两种 tone 除颜色外一模一样。而库里 ErrorNote(12px / rounded-md)与 WarnNote(11.5px / rounded-lg)本身尺寸就不齐 —— 换过去这一对当场一大一小。把 note 三兄弟的尺寸对齐是设计决定,不在这一刀范围里。",
	};

	it("没有哪个页面自己拼红边 + 红底 + 红字", () => {
		// 收编前四份手写在三种圆角(xl / lg / md)三种字号(13 / 12 / 10.5px)之间漂,
		// 其中 AI 聊天那两份逐字符一致。库件的 icon 槽与 sm/md/lg 三档就是为它们补的。
		expect(checkKept(scan(isDangerBox, ["atoms.tsx"]), KEPT).join("\n")).toBe("");
	});

	it("豁免表每一条都写了理由 —— 只填文件名等于没说清", () => {
		expect(Object.entries(KEPT).filter(([, why]) => why.trim().length < 20)).toEqual([]);
	});
});

describe("转圈只有库里那一份", () => {
	it("没有哪个页面自己拿 animate-spin 画转圈", () => {
		// `Spinner`(atoms.tsx)是唯一的实现,`LoadingBlock` 是唯一的「转圈 + 文案」组合。
		// 手搓一个的代价:Stats 的 AI 锐评卡曾自己画了个 8px 环并把顶弧涂成固定的 AI 紫
		// —— 那抹紫**刻意不跟皮肤**(config/colors.ts),于是整站换装后只有它原地不动。
		expect(scan((c) => /\banimate-spin\b/.test(c), ["atoms.tsx"]).join("\n")).toBe("");
	});
});
