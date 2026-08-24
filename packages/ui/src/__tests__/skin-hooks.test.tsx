// @vitest-environment jsdom

/**
 * 皮肤 CSS hook 挂点:SKIN_CSS_HOOK_MAP 里映射到 `[data-bn~=…]` 的 hook,
 * 相应组件必须真的挂着 data-bn 属性 —— 名单是公开 API,挂点掉了皮肤就静默失效。
 * (page/glass/glass-strong 映射到 body/类名,无需挂点。)
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Avatar, Btn, EmptyNote, ErrorNote, Input, MenuItem, Pill, WarnNote } from "../atoms";
import { ModalShell } from "../dialog";
import { SectionNav } from "../section-nav";
import { TabBarShell, TabButton } from "../tab-bar";

afterEach(cleanup);

function hooksOf(el: Element | null): string[] {
	return (el?.getAttribute("data-bn") ?? "").split(/\s+/).filter(Boolean);
}

describe("skin css hooks", () => {
	it("Btn 挂 btn;primary 变体额外挂 btn-primary", () => {
		render(
			<>
				<Btn>主</Btn>
				<Btn variant="outline">次</Btn>
			</>,
		);
		expect(hooksOf(screen.getByText("主"))).toEqual(["btn", "btn-primary"]);
		expect(hooksOf(screen.getByText("次"))).toEqual(["btn"]);
	});

	/**
	 * tab 上那排按钮此前一个挂点都没有,而选中态的粉色渐变还是写在 **inline style**
	 * 上的 —— inline 优先级压过一切 author 样式,皮肤连覆盖的机会都没有。于是整站
	 * 换皮之后,tab 条上的选中块仍是原来那个粉(2026-08-20 主人真机指出同一处)。
	 * 2026-08-23 起挂点从 btn/btn-primary 换成 tab/tab-active:皮肤的按钮实底曾把
	 * 整排 tab 画成一排按钮,tab 有自己的词。
	 */
	it("TabButton 挂 tab(不再挂 btn);选中态额外挂 tab-active", () => {
		render(
			<TabBarShell>
				<TabButton active onClick={() => {}}>
					选中
				</TabButton>
				<TabButton active={false} onClick={() => {}}>
					未选
				</TabButton>
			</TabBarShell>,
		);
		expect(hooksOf(screen.getByText("选中").closest("button"))).toEqual(["tab", "tab-active"]);
		expect(hooksOf(screen.getByText("未选").closest("button"))).toEqual(["tab"]);
	});

	it("Input 外框挂 input(视觉盒是包壳 div)", () => {
		const { container } = render(<Input value="" onChange={() => {}} />);
		expect(container.querySelector('[data-bn~="input"]')).toBeTruthy();
	});

	it("Avatar 的挂点在圆形元素上(挂方形定位容器会让皮肤 border 画成方框)", () => {
		const { container } = render(<Avatar name="兔" color="#fb7299" />);
		const el = container.querySelector('[data-bn~="avatar"]');
		expect(el).toBeTruthy();
		expect(el?.className).toContain("rounded-full");
	});

	it("ModalShell 弹窗卡挂 modal", () => {
		render(
			<ModalShell onCancel={() => {}} width={300}>
				<div>内容</div>
			</ModalShell>,
		);
		expect(hooksOf(screen.getByRole("dialog"))).toContain("modal");
	});

	it("TabBarShell 根挂 nav,且带圆角(皮肤描边不许画出直角框)", () => {
		const { container } = render(<TabBarShell>x</TabBarShell>);
		const el = container.querySelector('[data-bn~="nav"]');
		expect(el).toBeTruthy();
		expect(el?.className).toMatch(/rounded/);
	});

	// 主人在真机上撞到的:皮肤给 nav 画了底色,连「卡片样式」这行小标题一起被罩进去,
	// 看着像标题掉进了 tab 卡里。挂点要只裹 tab 列表本身,标题留在外面。
	it("竖栏挂点只裹 tab 列表,heading 不在里面", () => {
		const { container } = render(
			<SectionNav
				heading="卡片样式"
				items={[{ id: "a", label: "全局" }]}
				activeId="a"
				onPick={() => {}}
			/>,
		);
		const host = container.querySelector('[data-section-nav="rail"] [data-bn~="nav"]');
		expect(host).toBeTruthy();
		expect(host?.textContent).toContain("全局");
		expect(host?.textContent).not.toContain("卡片样式");
	});

	it("SectionNav 竖栏与横条都挂 nav,挂点元素都带圆角", () => {
		const { container } = render(
			<SectionNav heading="H" items={[{ id: "a", label: "A" }]} activeId="a" onPick={() => {}} />,
		);
		const hosts = [...container.querySelectorAll('[data-bn~="nav"]')];
		expect(hosts).toHaveLength(2);
		for (const el of hosts) expect(el.className).toMatch(/rounded/);
	});

	/**
	 * 导航行不是按钮:挂 btn 的年代,皮肤的按钮实底把竖栏每一行都画成一颗按钮
	 * (2026-08-23 主人真机指出)。选中态走多挂点(同 TabButton 的 btn-primary)——
	 * 清洗层不放行属性选择器,皮肤够不到 aria-current。
	 */
	it("SectionNav 项挂 nav-item(不再挂 btn),选中项额外挂 nav-item-active", () => {
		const { container } = render(
			<SectionNav
				heading="H"
				items={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]}
				activeId="a"
				onPick={() => {}}
			/>,
		);
		// 竖栏 + 横条各渲染一份,每份 2 项。
		const items = [...container.querySelectorAll('[data-bn~="nav-item"]')];
		expect(items).toHaveLength(4);
		for (const el of items) expect(hooksOf(el)).not.toContain("btn");
		const actives = [...container.querySelectorAll('[data-bn~="nav-item-active"]')];
		expect(actives).toHaveLength(2);
		for (const el of actives) expect(el.getAttribute("aria-current")).toBe("true");
	});

	/**
	 * 挂点在场还不够 —— 皮肤只够得到**挂着 data-bn 的那一层**:清洗层要求复合选择器
	 * 每一段都带 hook,`[data-bn~="nav-item-active"] span` 压根进不来。
	 *
	 * 所以选中态的前景色必须写在挂点元素上、由子元素继承。写死在子 span 上时,皮肤
	 * 把选中项画成实底就得到粉底粉字,一个字都看不见(2026-08-24 主人要「选中项变成
	 * 粉色按钮」时撞的)。这条盯着它别漂回去 —— 漂回去构建全绿,只有真机上看得出。
	 */
	it("SectionNav 选中项的前景色写在挂点元素上,子元素不写死", () => {
		const { container } = render(
			<SectionNav
				heading="H"
				items={[{ id: "a", label: "标题甲", desc: "说明甲", icon: <i data-testid="ic" /> }]}
				activeId="a"
				onPick={() => {}}
			/>,
		);
		for (const el of container.querySelectorAll('[data-bn~="nav-item-active"]')) {
			expect(el.className, "挂点元素得自己带上选中色").toContain("text-bn-pink");
			// 图标与标题不许自带颜色类 —— 带了就盖掉皮肤给挂点的那一份。
			for (const child of el.querySelectorAll("span")) {
				const cls = child.className;
				if (typeof cls !== "string") continue;
				// 描述行是另一档(默认装里它选中态也是 tertiary),不在这条管辖内。
				if (cls.includes("text-bn-2xs")) continue;
				expect(cls, `子元素写死了颜色: ${cls}`).not.toMatch(/text-bn-(pink|text-primary)\b/);
			}
		}
	});
});

/**
 * 提示盒三件套 —— 「XX 失败」红盒、「做完了但有几处没照办」黄盒、「这里还什么都
 * 没有」中性虚线框,站里共 66 处。
 *
 * **加的是造型不是颜色**:三者的底/边/字本来就走 `danger*` / `warning*` / border
 * 那几个色板 token,皮肤改 `colors` 段一直改得到。够不到的是**盒子长什么样** ——
 * 圆角、描边宽度与样式、阴影、装饰伪元素。像素风皮肤里整站都是硬边加 3px 硬影,
 * 只有这些盒子还是圆角软边(2026-08-24 主人点名)。
 *
 * 基底 + 分档的双挂点,同 `btn`/`btn-primary`:`note` 一次给三种定造型,
 * `note-danger` / `note-warn` / `note-empty` 各自调色。
 *
 * 这三个是 `<div>`,**web 那份 coverage 守卫扫不到**(它只认 `<button>` / `<a>`),
 * 所以挂点掉了只有这里会红。
 */
describe("提示盒挂点", () => {
	/**
	 * 从那句文字往上找到挂点所在的盒子 —— 带图标时文字被包进内层 span,直接对
	 * `getByText` 的结果断言会拿到那个 span。挂点没挂时 `closest` 回 null,
	 * 断言照样红。
	 */
	function boxOf(text: string): Element | null {
		return screen.getByText(text).closest("[data-bn]");
	}

	it("ErrorNote 挂 note note-danger", () => {
		render(<ErrorNote>崩了</ErrorNote>);
		expect(hooksOf(boxOf("崩了"))).toEqual(["note", "note-danger"]);
	});

	it("WarnNote 挂 note note-warn", () => {
		render(<WarnNote>有几处没照办</WarnNote>);
		expect(hooksOf(boxOf("有几处没照办"))).toEqual(["note", "note-warn"]);
	});

	it("EmptyNote 挂 note note-empty", () => {
		render(<EmptyNote>还什么都没有</EmptyNote>);
		expect(hooksOf(boxOf("还什么都没有"))).toEqual(["note", "note-empty"]);
	});

	it("带图标的 ErrorNote 也挂在盒子本身上,不是挂到图标那一格", () => {
		// 有 icon 时组件走的是**另一条渲染分支** —— 两条都得挂,否则一半调用点换得了
		// 装、一半换不了,而这正是挂点类缺陷最难被发现的形态。
		render(<ErrorNote icon={<i />}>带图标也崩了</ErrorNote>);
		const box = boxOf("带图标也崩了");
		expect(hooksOf(box)).toEqual(["note", "note-danger"]);
		// 挂在报警的那个盒子上,不是套在图标或文字外面的某一层
		expect(box?.getAttribute("role")).toBe("alert");
	});
});

/**
 * Pill —— 不可点的小徽章(`<span>`),站里 23 处。与顶栏那个状态胶囊同族,
 * 所以**共用 `badge`,不新造词**。
 *
 * 挂点只买到造型:Pill 的底色与字色是**行内样式**(`color` 由调用方传的语义色 ——
 * 平台色、推送类型色),皮肤盖不动。那正好是对的,改掉等于让徽章说谎,同 StatsBar
 * 那条。
 *
 * 同一挂点**两种形态**:顶栏那个有 `px-2.5 py-1` 撑着,Pill 靠 line-height 定高、
 * 没有 py —— 皮肤写 border 会把它上下撑高 2px 顶开整行。NOTES 里嘱咐走 outline。
 */
describe("Pill 挂 badge(与顶栏状态胶囊同族)", () => {
	it("Pill 挂 badge", () => {
		render(<Pill>3</Pill>);
		expect(hooksOf(screen.getByText("3"))).toEqual(["badge"]);
	});

	it("subtle 档也挂 —— 两档是同一个徽章的深浅,不是两种东西", () => {
		render(<Pill subtle>已暂停</Pill>);
		expect(hooksOf(screen.getByText("已暂停"))).toEqual(["badge"]);
	});
});

/**
 * 候选行 —— 「从一列里挑一个」的那种行:下拉菜单的每一行、命令面板的候选、
 * 会话/草稿列表的行、字体列表、搜索结果。站里这一族此前**一个挂点都没有**,
 * 豁免名单里 8 个文件写的是同一条理由:「同 MenuItem:皮肤实底会抹平选中/未选中」。
 *
 * 那条理由针对的是**挂 `btn`** —— 给它自己的词就不成立了,同当初 `nav-item`
 * 从 btn 里拆出来。它是 `<button>` 元素,但不是按钮:一行候选吃上按钮的实底,
 * 一屏菜单就成了一摞按钮。
 */
describe("候选行挂 option", () => {
	it("MenuItem 挂 option(不再是零挂点),选中项额外挂 option-active", () => {
		render(
			<>
				<MenuItem onClick={() => {}}>普通一行</MenuItem>
				<MenuItem active onClick={() => {}}>
					选中这行
				</MenuItem>
			</>,
		);
		expect(hooksOf(screen.getByText("普通一行"))).toEqual(["option"]);
		expect(hooksOf(screen.getByText("选中这行"))).toEqual(["option", "option-active"]);
	});

	it("danger 行也挂 option —— 它是「删除」那一行,不是一颗红按钮", () => {
		render(
			<MenuItem danger onClick={() => {}}>
				删掉
			</MenuItem>,
		);
		expect(hooksOf(screen.getByText("删掉"))).toEqual(["option"]);
	});

	it("不挂 btn —— 挂了皮肤的按钮实底会把整屏菜单画成一摞按钮", () => {
		render(<MenuItem onClick={() => {}}>某一行</MenuItem>);
		expect(hooksOf(screen.getByText("某一行"))).not.toContain("btn");
	});
});
