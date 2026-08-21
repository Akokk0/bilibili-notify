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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

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
		count: 1,
		why: "Toggle 轨道:皮肤实底会盖掉轨道底,开/关当场看不出来",
	},
	"apps/web/src/components/drag-handle.tsx": {
		count: 1,
		why: "裸 ⠿ 字形,挂上会被皮肤画成一个方块",
	},
	"apps/web/src/components/header.tsx": { count: 1, why: "顶栏下拉的菜单行" },
	"apps/web/src/components/scope-tabs.tsx": { count: 3, why: "无外观的触发器 + 两条下拉菜单行" },
	"apps/web/src/components/draft-island.tsx": { count: 1, why: "岛内草稿列表的行" },
	"apps/web/src/components/ai-chat/composer.tsx": { count: 3, why: "命令面板行 + 两条附件菜单行" },
	"apps/web/src/components/ai-chat/index.tsx": {
		count: 2,
		why: "两颗浮钮已是玻璃件,走 glass 挂点",
	},
	"apps/web/src/components/ai-chat/messages.tsx": {
		count: 2,
		why: "玻璃展开条走 glass 挂点 + 一个无样式包裹",
	},
	"apps/web/src/components/ai-chat/sidebar.tsx": { count: 3, why: "会话列表的行,不是按钮" },
	"apps/web/src/pages/Stats.tsx": { count: 3, why: "两条下拉菜单行 + 一个无样式包裹" },
	"apps/web/src/pages/cards/FontPicker.tsx": { count: 1, why: "字体行的主体" },
	"apps/web/src/pages/cards/GalleryPicker.tsx": { count: 1, why: "盖在图片上的透明选取层" },
	"apps/web/src/pages/skins/SkinEditor.tsx": { count: 2, why: "折叠小节的表头行 + 一条纯文字链接" },
	"apps/web/src/pages/rules/PerUpEditor.tsx": { count: 1, why: "纯文字链接(带下划线的那种)" },
	"apps/web/src/pages/up/UpCard.tsx": { count: 1, why: "多选勾选方块:二元开关,同 Toggle 那条" },
	"apps/web/src/pages/up/UpCardMenu.tsx": { count: 1, why: "右键菜单行" },
	"apps/web/src/pages/up/UpDialog.tsx": { count: 1, why: "纯文字链接" },
};

/** 注释里出现的 `<button>` 不算数,但行号要保住 —— 用等长空白填掉注释。 */
function blankComments(src: string): string {
	const pad = (m: string) => m.replace(/[^\n]/g, " ");
	return src.replace(/\/\*[\s\S]*?\*\//g, pad).replace(/\/\/[^\n]*/g, pad);
}

const BUTTON_RE = /<button\b(?:(?!<\/button>)[\s\S])*?<\/button>/g;

function listTsx(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry !== "__tests__") acc.push(...listTsx(full));
		} else if (full.endsWith(".tsx")) acc.push(full);
	}
	return acc;
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
