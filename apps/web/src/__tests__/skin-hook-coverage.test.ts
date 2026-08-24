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
import { blankComments } from "./source-text.js";
import { listSources } from "./walk.js";

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

/**
 * 左栏那颗指示点必须分选中态。
 *
 * `RailDot` 未选中态是粉的 —— 粉正是它「一眼看得见」的全部本钱。可它落在选中项上
 * 时,底是皮肤说了算的实心块;主人把那块画成粉之后粉点就没了,而它偏偏要说的是
 * 「女仆用的就是这份」(AI 页两栏都这样)。所以选中态得让位,改跟随文字色。
 *
 * 组件那头已经有测试钉住两个分支各长什么样,但**调用点漏传 `active` 是静默的**:
 * 默认值是 `false`,于是它安静地一路画粉点 —— 构建绿、测试绿、默认装下一切正常,
 * 只有装了实心块皮肤的真机才露馅。跟这份文件里其余几条是同一类漏洞,所以放一起。
 */
describe("RailDot 的调用点", () => {
	const railDotTags = () => {
		const out: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of listTsx(root)) {
				const src = blankComments(readFileSync(file, "utf8"));
				// 一个文件里可能有好几处(AI 页就是两处),逐个开标签查。
				for (const m of src.matchAll(/<RailDot\b[^>]*>/g)) {
					out.push(`${relative(REPO, file).split(sep).join("/")}: ${m[0].trim()}`);
				}
			}
		}
		return out;
	};

	it("每一处都传了 active —— 漏传不会红,只会在真机上又消失一次", () => {
		expect(railDotTags().filter((t) => !/\bactive[=\s}]/.test(t))).toEqual([]);
	});

	it("确实扫到了东西 —— 别让这条退化成「一个都没找着所以全过」", () => {
		// 组件自己的定义不算(它在 packages/ui 里是 `export function RailDot`,不是标签)。
		expect(railDotTags().length).toBeGreaterThanOrEqual(3);
	});
});

/**
 * 数据展示的数字不许写 `font-mono`。
 *
 * 皮肤的字体只有一个入口 —— `--font-cjk`(见 `services/skin.ts` 拼字体栈那段)。
 * `--font-mono` 不在词表里,也不该在:那一档服务的是**代码与标识符**(日志控制台、
 * API key 输入框、openid、endpoint),等宽在那里是功能,换成主人上传的像素字体反而
 * 会散架。
 *
 * 可数据可视化那些数字要的从来不是等宽**字体**,而是**数字等宽** —— 几张 KPI 卡
 * 并排,位数一变宽度就跳。`font-variant-numeric: tabular-nums` 正是干这个的,而且
 * 字体照走 `--font-cjk`。写成 `font-mono` 的代价真机上很显眼:装了自带字体的皮肤
 * 只换掉周围的字,数字还是系统等宽体,一张卡上两种字体(2026-08-25 主人指出,统计页
 * 五张卡、UP 主对比表、概览四张卡全中)。
 *
 * 所以这几个文件按「里头的等宽需求全是数字」整份划过来。别处不在此列 —— 见下面
 * 那条反面对照。
 */
describe("数据展示不吃 --font-mono", () => {
	const DATA_FILES = [
		"apps/web/src/pages/Stats.tsx",
		"apps/web/src/pages/Dashboard.tsx",
		"apps/web/src/pages/stats/charts.tsx",
		"apps/web/src/pages/stats/RoastCard.tsx",
		"apps/web/src/pages/stats/SoloRoastCard.tsx",
		"packages/ui/src/glass.tsx",
	];

	it("统计与概览那几份里没有 font-mono —— 数字对齐走 tabular-nums", () => {
		const offenders = DATA_FILES.filter((rel) =>
			blankComments(readFileSync(join(REPO, rel), "utf8")).includes("font-mono"),
		);
		expect(offenders).toEqual([]);
	});

	it("别处照旧用得上 —— 这条不是「全站禁等宽字体」", () => {
		// 日志控制台是**代码**,等宽在那里是功能;真被一刀切掉的话这条会红,
		// 而那正是把上面那条读成「见 font-mono 就删」的后果。
		const logs = readFileSync(join(REPO, "apps/web/src/pages/Logs.tsx"), "utf8");
		expect(logs).toContain("font-mono");
	});
});

/**
 * UID 按**数据**处理,不按标识符。
 *
 * 它长得像标识符(可复制、可比对),站里一度也这么待它 —— 三处写着等宽字体,第四处
 * (`scope-tabs`)却是正文字体,本来就没统一过。但它归根到底是一串数字,而等宽**字体**
 * 那一档够不到皮肤(见上面那条),于是装了自带字体的皮肤只换掉周围的字,UID 还是系统
 * 等宽体。2026-08-25 主人拍板:统一当数据,跟数字一样走 `tabular-nums`。
 *
 * 只认**单行**写法 —— 站里四处都是 `UID {x}` 连着 className 写在一行。拆成多行的
 * 话这条扫不到,那是它的射程,不是它默许。
 */
describe("UID 走 tabular-nums", () => {
	it("没有哪处 UID 还写着等宽字体", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of listTsx(root)) {
				blankComments(readFileSync(file, "utf8"))
					.split("\n")
					.forEach((line, i) => {
						// 兜底名字(`?? \`UID ${uid}\``)不带 className,不会误伤。
						if (/\bUID\s+\{/.test(line) && /\bfont-mono\b/.test(line)) {
							offenders.push(`${relative(REPO, file).split(sep).join("/")}:${i + 1}`);
						}
					});
			}
		}
		expect(offenders).toEqual([]);
	});

	it("确实扫到了 UID 展示位 —— 别让这条空过", () => {
		let seen = 0;
		for (const root of SCAN_ROOTS) {
			for (const file of listTsx(root)) {
				seen += [...blankComments(readFileSync(file, "utf8")).matchAll(/\bUID\s+\{/g)].length;
			}
		}
		expect(seen).toBeGreaterThanOrEqual(4);
	});
});
