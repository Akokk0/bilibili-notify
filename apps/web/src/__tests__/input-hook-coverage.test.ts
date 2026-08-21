/**
 * 输入框的两条静态守卫 —— 和隔壁 `skin-hook-coverage.test.ts`(管按钮)同一路子。
 *
 * 这两条都**在开发机上完全看不出来**,所以只能靠扫源码拦:
 *
 * ① 挂点。皮肤写 `[data-bn="input"]{…}` 只能改到挂了的那些。漏挂的框在默认装下
 *    和挂了的一模一样,构建绿、测试绿、页面一致 —— 只有装了皮肤的真机才露馅。
 *
 * ② 底色 token。`theme.css` 把暗色 elevation 阶梯写成
 *    「muted(次级/凹陷) < **field(输入)** < surface(卡片) < strong(弹窗)」。
 *    亮色下 field 与 surface **都是 `#ffffff`**,肉眼零差别;暗色下才分开
 *    (`#161d2b` / `#1e2738`)。写成 surface 的输入框在暗色下丢掉凹陷层次,
 *    而且皮肤契约里 `field` 是独立一键 —— 写错 token 等于那一键够不着它。
 *
 * 白名单按**文件计数 + written reason** 记,不记行号:行号天天漂,计数只有在
 * 谁新加了一个没挂的框时才动。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const ROOTS = ["apps/web/src", "packages/ui/src"];

/** 注释整段抹成等长空白 —— 保住行号,同时不让注释里的示例代码算数。 */
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

function walk(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name !== "__tests__" && name !== "node_modules") walk(full, acc);
		} else if (name.endsWith(".tsx")) {
			acc.push(full);
		}
	}
	return acc;
}

interface Field {
	file: string;
	line: number;
	tag: string;
	attrs: string;
}

/** 抠出每个原生输入控件的**开标签**(属性里含 `{}` 表达式,得配对着数)。 */
function fields(): Field[] {
	const found: Field[] = [];
	for (const root of ROOTS) {
		for (const file of walk(root)) {
			const src = blankComments(readFileSync(file, "utf8"));
			for (const m of src.matchAll(/<(input|select|textarea)[\s\n]/g)) {
				const start = m.index as number;
				let depth = 0;
				let k = start + m[0].length - 1;
				for (; k < src.length; k += 1) {
					const c = src[k];
					if (c === "{") depth += 1;
					else if (c === "}") depth -= 1;
					else if (c === ">" && depth === 0) break;
				}
				found.push({
					file,
					line: src.slice(0, start).split("\n").length,
					tag: m[1] as string,
					attrs: src.slice(start, k + 1),
				});
			}
		}
	}
	return found;
}

/** 非文字输入:原生长相自成一套,套上「输入面」的边框底色只会画坏。 */
const SPECIAL_TYPE = /type="(file|checkbox|radio|range|color)"/;

/** 看不见的控件(文件选择器 / sr-only 的原生 checkbox):挂了也没有面可画。 */
function invisible(a: string): boolean {
	return a.includes("sr-only") || a.includes('type="file"') || a.includes('className="hidden"');
}

/**
 * 刻意不挂的,连**为什么**一起记。改这张表 = 明确宣称「这个框皮肤够不着是对的」。
 * 数字是该文件里刻意不挂的**个数**。
 */
const UNHOOKED: Record<string, { count: number; why: string }> = {
	"apps/web/src/components/ai-chat/composer.tsx": {
		count: 1,
		why: "聊天输入区是无边无底(bg-transparent)、直接画在 composer 那层玻璃上的。挂上等于允许皮肤在玻璃里再画一个框 —— 正是全站在躲的玻璃叠玻璃。",
	},
	"apps/web/src/components/header.tsx": {
		count: 1,
		why: "导航显隐菜单里的原生 checkbox。input 挂点是给「有边框的文字输入面」的,拿它去改一个原生勾选框(圆角 / 底色 / 内边距)只会画坏。CheckRow 也同样不挂。",
	},
	"apps/web/src/pages/Cards.tsx": {
		count: 1,
		why: "玻璃透明度滑杆(type=range)。同上 —— 滑轨不是输入面,套上边框底色就散架。",
	},
	"packages/ui/src/atoms.tsx": {
		count: 1,
		why: "Input 原语的内层 <input>。边框与底色在外层那个 div 上,挂点也在那儿;内层再挂一次,皮肤的边框底色会套两层。",
	},
	// ── 以下待主人拍板:皮肤编辑器自己要不要能被皮肤改 ──
	// 挂上 = 皮肤能改皮肤编辑器自己;不挂 = 写坏了的皮肤还留着一个改得回来的逃生舱。
	// 翻过 git log -S 'data-bn' -- apps/web/src/pages/skins/,两个提交里都没记过理由,
	// 所以这是「一直没挂」而不是「决定不挂」。定了再动。
	"apps/web/src/pages/skins/SkinEditor.tsx": {
		count: 11,
		why: "待定 —— 皮肤编辑器的逃生舱问题,见上方注释。",
	},
	"apps/web/src/pages/skins/SkinSection.tsx": {
		count: 1,
		why: "皮肤页自带的自定义 CSS 输入框,与 SkinEditor 同属一块 —— 逃生舱问题一起定,别一半挂一半不挂。",
	},
};

describe("输入框都挂上 input 挂点", () => {
	it("没有哪个可见输入控件在白名单外还漏挂", () => {
		const missing = fields().filter((f) => !invisible(f.attrs) && !/\sdata-bn=/.test(f.attrs));

		const perFile = new Map<string, number>();
		for (const f of missing) perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1);

		const unexpected: string[] = [];
		for (const [file, n] of perFile) {
			const allow = UNHOOKED[file];
			if (!allow) {
				unexpected.push(`${file}: ${n} 个漏挂(白名单里没有这个文件)`);
			} else if (n !== allow.count) {
				unexpected.push(`${file}: 实际 ${n} 个漏挂,白名单写的是 ${allow.count}`);
			}
		}
		// 白名单里写了、实际却已经挂全的文件也要报 —— 否则它会一直挂着骗人。
		for (const file of Object.keys(UNHOOKED)) {
			if (!perFile.has(file)) unexpected.push(`${file}: 已经挂全了,请从白名单删掉`);
		}

		expect(unexpected.join("\n")).toBe("");
	});

	it("白名单每一条都写了理由 —— 只填数字等于没说清", () => {
		const naked = Object.entries(UNHOOKED)
			.filter(([, v]) => v.why.trim().length < 20)
			.map(([k]) => k);
		expect(naked).toEqual([]);
	});
});

describe("输入框的底色走 field,不走 surface", () => {
	it("没有哪个输入控件把底画成 bg-bn-surface", () => {
		// 阶梯见 theme.css:「muted < field(输入) < surface(卡片) < strong(弹窗)」。
		// 亮色下两者都是 #ffffff,所以这条只能静态扫,肉眼和截图都验不出来。
		const wrong = fields()
			// 只管**文字输入面**。file / checkbox / range / color 各有各的原生长相,
			// 底色阶梯对它们不成立(文件选择器那颗按钮走的还是 `file:` 变体)。
			.filter((f) => !invisible(f.attrs) && !SPECIAL_TYPE.test(f.attrs))
			// 边界得卡死:`bg-bn-surface-muted` / `-strong` 是**另外两个 token**,
			// 子串匹配会把它们一起算进来(实测在 SkinEditor 的 file: 变体上误报过)。
			.filter((f) => /(?<![\w-])bg-bn-surface(?![\w-])/.test(f.attrs))
			.map((f) => `${f.file}:${f.line} <${f.tag}> 用了 bg-bn-surface,应为 bg-bn-field`);
		expect(wrong.join("\n")).toBe("");
	});
});
