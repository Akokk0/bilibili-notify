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

/**
 * 注释整段抹成等长空白 —— 保住行号,同时不让注释里举的例子算数。
 *
 * **必须整段扫,不能逐行 `codeOf`**:逐行的话 JSDoc 的收尾行(星号加斜杠)会被
 * 「以星号开头」那条先抹掉,于是块注释的开头再也找不到自己的结尾,一路向前吃到
 * 下一个收尾符,把中间的真代码整段吞掉。守卫就此安静地漏检 —— 变异测试抓出来的
 * 正是这个。
 */
function blankComments(src: string): string {
	const out: string[] = [];
	for (let i = 0; i < src.length; ) {
		if (src.startsWith("/*", i)) {
			const end = src.indexOf("*/", i);
			const stop = end === -1 ? src.length : end + 2;
			out.push(src.slice(i, stop).replace(/[^\n]/g, " "));
			i = stop;
		} else if (src.startsWith("//", i)) {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			out.push(" ".repeat(stop - i));
			i = stop;
		} else {
			out.push(src[i] as string);
			i += 1;
		}
	}
	return out.join("");
}

/**
 * 抠出每个元素的**开标签**。属性里嵌着 `{}` 表达式,得配对着数才知道 `>` 是标签
 * 收尾还是箭头函数的一半。
 */
function openTags(raw: string): Array<{ line: number; attrs: string }> {
	const src = blankComments(raw);
	const out: Array<{ line: number; attrs: string }> = [];
	for (const m of src.matchAll(/<[a-zA-Z][\w.]*[\s\n]/g)) {
		const start = m.index;
		let depth = 0;
		let k = start + m[0].length - 1;
		for (; k < src.length; k += 1) {
			const c = src[k];
			if (c === "{") depth += 1;
			else if (c === "}") depth -= 1;
			else if (c === ">" && depth === 0) break;
		}
		out.push({ line: src.slice(0, start).split("\n").length, attrs: src.slice(start, k + 1) });
	}
	return out;
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

/**
 * 画了边框就得给边框颜色。
 *
 * Tailwind v4 的 `.border` **只出宽度与线型**(产物就是 `border-style` +
 * `border-width`,自己去 `apps/web/dist/assets/*.css` 里查),颜色留给 CSS 的初始值
 * —— 也就是 `currentColor`。于是 `border border-dashed` 不是「默认灰边」而是
 * **「跟着字色走的边」**:在 `text-bn-text-tertiary` 的盒子上它是灰的,看着像对的;
 * 在 `text-bn-success-text` 的盒子上它就是一圈绿虚线,和全站 `border-bn-*` 那套
 * 完全脱钩,而且皮肤一改字色边框跟着变。Cards 页三处正是这么长出来的。
 *
 * 只查**静态字符串** className:那里没有分支,「有没有给颜色」是确定的。
 * 模板字面量里颜色常在三元的某一支上,跨行判断会误报(试过)。
 */
describe("画了边框就给边框颜色", () => {
	it("没有哪个静态 className 只写了 border 而不给颜色", () => {
		const offenders: string[] = [];
		for (const root of [join(SRC_DIR, "pages"), join(SRC_DIR, "components"), UI_SRC_DIR]) {
			for (const file of listTsxRecursive(root)) {
				for (const tag of openTags(readFileSync(file, "utf8"))) {
					const m = /className="([^"]*)"/.exec(tag.attrs);
					if (!m) continue;
					const tokens = (m[1] as string).split(/\s+/).filter((t) => !t.includes(":"));
					// `border-0` 是**零宽度**,压根没有边可上色 —— 那是「明确不要边框」的写法。
					const hasWidth = tokens.some((t) => t === "border" || /^border-[1-9][\d.]*$/.test(t));
					// `border-dashed` / `border-solid` 是线型不是颜色,不算数。
					const hasColor = tokens.some((t) => /^border-(bn-|transparent$|current$|\[)/.test(t));
					// 颜色也可以落在 inline style 上:要么就写在这个标签里,要么 style 是个
					// 在上面算好的变量(`style={style}`)—— 后者查不到,但它是刻意算出来的,
					// 不是忘了给色。真正要抓的是「只有 className、里头没有颜色」那一种。
					const styled =
						/border(Color|Top|Right|Bottom|Left)?\s*:/.test(tag.attrs) ||
						/style=\{[a-zA-Z_$][\w$]*\}/.test(tag.attrs);
					if (hasWidth && !hasColor && !styled) offenders.push(`${rel(file)}:${tag.line}`);
				}
			}
		}
		expect(offenders.join("\n")).toBe("");
	});
});

/**
 * 条状物的圆角走 `rounded-bn-pill`,不写死 `rounded-full`。
 *
 * 清单的「圆角走轴」那条:`rounded-full` 是**写死的 999px**,皮肤把 `radius.pill`
 * 调到 0 求一身硬直角也掰不直它。真正必须是**正圆**的(头像、状态点、光斑)照写
 * `rounded-full` —— 那是设计要求不是疏忽。
 *
 * 判据用**横向内边距**分开两者:正圆物件靠 `h-N w-N` 定尺寸,不会有 `px-*`;
 * 一有 `px-*` 就说明它的宽度跟着内容走,那就是条状物、就该跟着皮肤的胶囊轴。
 */
describe("胶囊圆角走轴,不写死 rounded-full", () => {
	function isHardcodedPill(code: string): boolean {
		const cls = staticClasses(code);
		return cls.includes("rounded-full") && /(^|\s)px-[\d.]/.test(cls);
	}

	it("没有哪个带横向内边距的元素还写死 rounded-full", () => {
		expect(scan(isHardcodedPill).join("\n")).toBe("");
	});
});

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
	 * 判据是**红边 + 红底**同时出现在一个 class 串里。
	 *
	 * 曾经还要求第三样(红字),结果漏了两处:「红边红底在外层 div、红字在里面的
	 * 子元素上」的写法,逐个元素看时外层没有红字、内层没有红底,两层都不满足。
	 * 边与底凑齐就已经是「在画一个红盒子」了 —— 字色在哪层不影响这个判断。
	 *
	 * 单独一样不算:只写 `text-bn-danger-text` 的红字行、只写
	 * `border-bn-danger-border` 的红框输入,那都是别的东西。
	 */
	function isDangerBox(code: string): boolean {
		const cls = staticClasses(code);
		return cls.includes("border-bn-danger-border") && cls.includes("bg-bn-danger-soft");
	}

	const KEPT: Record<string, string> = {
		"apps/web/src/components/alert-shell.tsx":
			"组件告警条不是内联提示盒:portal 到 body、fixed 在右上角、带 aria-live=assertive 与「全部清除」钮。它是 Toast 那一族的东西(只是语义为红),塞进 ErrorNote 要给库件加 fixed 定位与关闭钮两个它不该有的能力。",
		"apps/web/src/pages/up/UpDialog.tsx":
			"「已失效的引用」那块是个**红色容器**,里面装着一行说明加一排可点的移除 chip。ErrorNote 是纯文字盒,装不下可交互子元素;硬塞的话得给库件开一个「任意 children + 不管排版」的口子,那等于没有组件。",
		"apps/web/src/pages/cards/FontPicker.tsx":
			"「选中的字体已不在库里」那行同上 —— 红底容器里并排放着说明文字与「清除」钮。它下方的 err / warn 两条提示已经收编成 ErrorNote / WarnNote 的 sm 档了,留下的只有这个带按钮的容器。",
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
