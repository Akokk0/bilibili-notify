/// <reference types="node" />
/**
 * 皮肤按钮挂点覆盖 —— 扫 `apps/web/src` 与 `packages/ui/src` 全 .tsx,断言每个
 * 手写 `<button>` 要么背着 `data-bn`,要么在下面的豁免名单里写明理由。
 *
 * 为什么要静态护栏:挂点是**只在别人的皮肤下才看得见**的东西 —— 漏挂不会红、
 * 不会白屏、开发时长得一模一样,只有装了皮肤的用户看到半页按钮换了样、半页没
 * 换。这条路径已经复发三回(tab 条那排、Subs/History 的筛选胶囊、Toggle),
 * `packages/ui` 的 `skin-hooks.test.tsx` 只管库里那几个组件,页面在它射程之外。
 *
 * 豁免名单按**文件计数**而不是行号:行号一改就漂,计数只在有人**新增**一个
 * 不挂点的按钮时才动,那时正该停下来想一想。名单里没有的文件必须挂满。
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listSources } from "./walk.js";

/** 只看会发出去的源码 —— 测试里手写的 `<button>` 用户看不到。 */
const listTsx = (dir: string) => listSources(dir, { skipTestDirs: true });

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(TEST_DIR, "../../../..");
const SCAN_ROOTS = [join(REPO, "apps/web/src"), join(REPO, "packages/ui/src")];

/**
 * 刻意不挂 `data-bn="btn"` 的 `<button>`,按文件计数 + 理由。
 *
 * 三类:
 * 1. **挂上会毁掉它本身的语义** —— 皮肤给按钮写的实底会盖掉轨道/选中态,
 *    开关当场看不出开关(README 里 Toggle 那条写过)。
 * 2. **它不是按钮** —— 下拉菜单行、列表行、图片上的透明覆盖层、纯文字链接,
 *    长按钮的样子才该吃按钮的皮。
 * 3. **它已经走别的挂点** —— `.bn-glass` 本身就是 glass 挂点,再挂 btn 会被
 *    两套皮肤规则同时画。
 */
const UNHOOKED: Record<string, { count: number; why: string }> = {
	"packages/ui/src/atoms.tsx": {
		count: 2,
		why: "AddButton/AddCard(虚线=空位是语义本体,皮肤实底会把空位画成真按钮 —— 2026-08-23 主人真机指出后定案)。**MenuItem 与 Toggle 都已经不在这儿了**:各自挂上了 `option`(候选行)与 `switch`/`switch-on`(开关轨道),两条豁免理由说的都是「挂 btn 会毁掉它」,而它们现在有自己的词",
	},
	"apps/web/src/components/drag-handle.tsx": {
		count: 1,
		why: "裸 ⠿ 字形,挂上会被皮肤画成一个方块",
	},
	"apps/web/src/components/scope-tabs.tsx": {
		count: 3,
		why: "无外观的触发器 + 弹层底部的「取消」条(它是一条分隔线下的收尾,不是按钮)+ 「添加 UP」虚线 chip(虚线=空位,同 AddButton 那条)",
	},
	"packages/ui/src/form-controls.tsx": {
		count: 1,
		why: "AddRowButton 列表末尾的虚线添加行(虚线=空位,同 AddButton 那条;随 T 系列升库从 forms.tsx 搬来)",
	},
	"apps/web/src/components/ai-chat/index.tsx": {
		count: 1,
		why: "浮钮已是玻璃件,走 glass 挂点(两颗收编进 FloatGlassButton 后只剩一处 <button>)",
	},
	"apps/web/src/components/ai-chat/messages.tsx": {
		count: 2,
		why: "玻璃展开条走 glass 挂点 + 一个无样式包裹",
	},
	"apps/web/src/components/ai-chat/sidebar.tsx": {
		count: 3,
		why: "两颗入口钮(「开启新对话」「新建皮肤工坊」,走聊天区自己的 bn-chat-accent 语汇)+ 会话行的可点区 —— **会话行挂了 option,挂在外层那个 div 上**:底色与选中态都在那一层,挂到里面这个 button 上等于让皮肤去改一片没有样式的地方",
	},
	"apps/web/src/pages/Stats.tsx": { count: 1, why: "一个无样式包裹" },
	"apps/web/src/pages/cards/FontPicker.tsx": {
		count: 1,
		why: "字体行的可点区 —— **行本身挂了 option**,挂在外层那个 div 上(描边与底色都在那一层,同 sidebar 会话行)",
	},
	"apps/web/src/pages/cards/GalleryPicker.tsx": {
		count: 1,
		why: "盖在图片上的透明选取层",
	},
	"apps/web/src/pages/skins/SkinEditor.tsx": {
		count: 2,
		why: "折叠小节的表头行 + 一条纯文字链接",
	},
	"apps/web/src/pages/rules/PerUpEditor.tsx": { count: 1, why: "纯文字链接(带下划线的那种)" },
	"apps/web/src/pages/up/UpCard.tsx": {
		count: 1,
		why: "多选勾选方块 —— 它是**指示物**而不是控件外壳(同 Toggle 那颗滑块、CheckRow 那个勾选方块的分工)。也不该套 `switch`:那一档在词表里写明了是「滑动开关的轨道」,皮肤会按一条长胶囊的形状去写它,落到一个 22px 方块上必然走样",
	},
	"apps/web/src/pages/up/UpDialog.tsx": { count: 1, why: "纯文字链接" },
};
/** 注释里出现的 `<button>` 不算数,但行号要保住 —— 用等长空白填掉注释。 */
function blankComments(src: string): string {
	const pad = (m: string) => m.replace(/[^\n]/g, " ");
	return src.replace(/\/\*[\s\S]*?\*\//g, pad).replace(/\/\/[^\n]*/g, pad);
}

const BUTTON_RE = /<button\b(?:(?!<\/button>)[\s\S])*?<\/button>/g;

/**
 * 抠出每个 `<button>` / `<a>` 的**开标签**。属性里含 `{}` 表达式,得配对着数,
 * 不能见到第一个 `>` 就停。
 */
function openTags(src: string): { tag: string; line: number; attrs: string }[] {
	const out: { tag: string; line: number; attrs: string }[] = [];
	for (const m of src.matchAll(/<(button|a)[\s\n]/g)) {
		const start = m.index as number;
		let depth = 0;
		let k = start + m[0].length - 1;
		for (; k < src.length; k += 1) {
			const c = src[k];
			if (c === "{") depth += 1;
			else if (c === "}") depth -= 1;
			else if (c === ">" && depth === 0) break;
		}
		out.push({
			tag: m[1] as string,
			line: src.slice(0, start).split("\n").length,
			attrs: src.slice(start, k + 1),
		});
	}
	return out;
}

function countUnhooked(): Record<string, number> {
	const acc: Record<string, number> = {};
	for (const root of SCAN_ROOTS) {
		for (const file of listTsx(root)) {
			const src = blankComments(readFileSync(file, "utf8"));
			const n = (src.match(BUTTON_RE) ?? []).filter((b) => !b.includes("data-bn")).length;
			if (n > 0) acc[relative(REPO, file).split(sep).join("/")] = n;
		}
	}
	return acc;
}

describe("皮肤按钮挂点覆盖", () => {
	it("没在豁免名单里的文件,手写 <button> 必须挂 data-bn", () => {
		const found = countUnhooked();
		const strays = Object.keys(found).filter((f) => !(f in UNHOOKED));
		expect(strays).toEqual([]);
	});

	it("豁免名单的计数与实际一致 —— 多出一个就得说明白它为什么不挂", () => {
		const found = countUnhooked();
		const expected = Object.fromEntries(Object.entries(UNHOOKED).map(([f, v]) => [f, v.count]));
		const actual = Object.fromEntries(Object.keys(UNHOOKED).map((f) => [f, found[f] ?? 0]));
		expect(actual).toEqual(expected);
	});

	it("每条豁免都写了理由", () => {
		for (const [file, { why }] of Object.entries(UNHOOKED)) {
			expect([file, why.length > 4]).toEqual([file, true]);
		}
	});
});

/**
 * 实心语义底的按钮,`btn` 与 `btn-primary` **两个挂点都得挂**。
 *
 * 少挂 `btn-primary` 不是「少一档可调」,是**隐形**:皮肤给 `btn` 档刷的是中性底,
 * 只有 `btn-primary` 档会把强调实底盖回来。单挂 `btn` 的实心钮在皮肤下变成
 * 「中性浅底 + 实底前景」—— 写死的 `text-white` 皮肤根本改不动,`text-bn-on-solid`
 * 虽是 token 但皮肤给它配的是**自家实底**的对色,浮到中性浅底上一样看不清。
 * 而这在默认装下完全看不出来。
 *
 * 2026-08-21 真机上就是这么翻的车:About 的爱发电按钮(当时还是写死白字)。
 * 2026-08-23 主人拍板 Btn 补 danger-solid 档后,网扩到 danger 底与 on-solid 前景。
 */
describe("主按钮的挂点写全", () => {
	it("实心语义底 + 实底前景的按钮不能只挂通用 btn", () => {
		const bad: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of listTsx(root)) {
				const src = blankComments(readFileSync(file, "utf8"));
				for (const t of openTags(src)) {
					if (!/\sdata-bn=/.test(t.attrs)) continue;
					// 只管 btn 家族。tab / chip / nav-item 各有自己的选中档(tab-active…)
					// 承载实心态,硬塞 btn-primary 反而会招来皮肤的主按钮实底 —— tab 当年
					// 正是因此迁出 btn 家族的。(`(?!-)` 挡住 btn-primary 自己算作 btn 词)
					if (!/\bbtn(?!-)/.test(t.attrs)) continue;
					const solid =
						/bg-bn-(pink|blue|danger)(?![\w/-])/.test(t.attrs) &&
						(t.attrs.includes("text-white") || t.attrs.includes("text-bn-on-solid"));
					if (!solid) continue;
					if (t.attrs.includes("btn-primary")) continue;
					bad.push(
						`${relative(REPO, file).split(sep).join("/")}:${t.line} <${t.tag}> 是实心主按钮,` +
							`却没挂 btn-primary —— 皮肤刷了底,白字会消失`,
					);
				}
			}
		}
		expect(bad.join("\n")).toBe("");
	});
});
