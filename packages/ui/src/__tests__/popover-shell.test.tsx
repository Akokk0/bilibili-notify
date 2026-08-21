// @vitest-environment jsdom

/**
 * `PopoverShell` —— 贴着触发器弹出的浮层面板。
 *
 * 库里一直有 `MenuItem`(弹层里的一整行),唯独没有装它的壳,于是四处各写各的:
 *
 * | 处 | 圆角 | 底 | 边 | 阴影 | 内边距 | 挂点 |
 * | -- | ---- | -- | -- | ---- | ------ | ---- |
 * | `scope-tabs` | `rounded-bn-sm` | surface | border-subtle | elev | 无 | `data-bn` |
 * | `header` 标签面板 | `rounded-bn-card` | 玻璃 | 无 | card | `p-2` | class |
 * | `header` 主题菜单 | `rounded-lg` | surface-strong | border | elev | `p-1.5` | `data-bn` |
 * | `Stats` 分区下拉 | `rounded-bn-card` | surface | border | card | 无 | `data-bn` |
 *
 * 四种圆角、三种底、三种边、两种阴影、两种挂点写法,**没有两个是一样的**。连「里面
 * 装的全是 `MenuItem`」的那两处(主题菜单 / 分区下拉)都一个有内边距一个没有。
 *
 * 壳子把这些定死,和 `ModalShell` 当初收编十一个弹窗是同一件事。开口只留三样:贴左还是
 * 贴右、内容要不要留呼吸位、压在第几层 —— 每一样都有真实的调用方分歧。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PopoverShell } from "../popover";

afterEach(cleanup);

/** 文本直接写在壳上,所以 `getByText` 拿到的就是壳本身。 */
const shellOf = (t: string) => screen.getByText(t) as HTMLElement;

describe("PopoverShell", () => {
	it("外观由壳子定死 —— 圆角/底/边/阴影四样不由调用方决定", () => {
		render(
			<>
				<PopoverShell>左</PopoverShell>
				<PopoverShell align="right" variant="flush" layer="overlay">
					右
				</PopoverShell>
			</>,
		);
		const a = shellOf("左").className.split(/\s+/);
		const b = shellOf("右").className.split(/\s+/);
		for (const c of ["rounded-bn-card", "bg-bn-surface", "border-bn-border", "shadow-bn-elev"]) {
			expect(a, `左侧档缺 ${c}`).toContain(c);
			expect(b, `右侧档缺 ${c}`).toContain(c);
		}
	});

	it("挂 glass-strong —— 弹层归强玻璃档,不是轻玻璃卡片", () => {
		render(<PopoverShell>内容</PopoverShell>);
		expect(shellOf("内容").getAttribute("data-bn")).toBe("glass-strong");
	});

	it("align 决定贴哪边,两档不能相同", () => {
		render(
			<>
				<PopoverShell align="left">L</PopoverShell>
				<PopoverShell align="right">R</PopoverShell>
			</>,
		);
		expect(shellOf("L").className).toContain("left-0");
		expect(shellOf("R").className).toContain("right-0");
		expect(shellOf("L").className).not.toContain("right-0");
	});

	it("variant 只管内边距 —— inset 给 MenuItem 留呼吸位,flush 让内容贴边", () => {
		render(
			<>
				<PopoverShell variant="inset">I</PopoverShell>
				<PopoverShell variant="flush">F</PopoverShell>
				<PopoverShell variant="panel">P</PopoverShell>
			</>,
		);
		const pad = (t: string) =>
			shellOf(t)
				.className.split(/\s+/)
				.filter((c) => /^p-/.test(c));
		expect(pad("I")).not.toEqual([]);
		expect(pad("F")).toEqual([]);
		expect(pad("P")).not.toEqual(pad("I"));
	});

	it("layer 走分层表,三档互不相同", () => {
		render(
			<>
				<PopoverShell layer="local">a</PopoverShell>
				<PopoverShell layer="nav">b</PopoverShell>
				<PopoverShell layer="overlay">c</PopoverShell>
			</>,
		);
		const z = (t: string) =>
			shellOf(t)
				.className.split(/\s+/)
				.find((c) => c.startsWith("z-bn-"));
		expect(new Set([z("a"), z("b"), z("c")]).size).toBe(3);
		for (const t of ["a", "b", "c"]) expect(z(t)).toBeTruthy();
	});

	it("className 收定位以外的调用方差异(宽度、最大高度),不覆盖本体", () => {
		render(<PopoverShell className="max-h-80 min-w-56 overflow-y-auto">宽</PopoverShell>);
		const c = shellOf("宽").className;
		for (const t of ["max-h-80", "min-w-56", "overflow-y-auto"]) expect(c).toContain(t);
	});
});

describe("PopoverShell 的底", () => {
	it("玻璃档换的是底本身,不是只换挂点", () => {
		render(
			<>
				<PopoverShell surface="solid">实</PopoverShell>
				<PopoverShell surface="glass">玻</PopoverShell>
			</>,
		);
		const solid = shellOf("实").className;
		const glass = shellOf("玻").className;
		expect(solid).toContain("bg-bn-surface");
		expect(glass).toContain("bn-glass-strong");
		// 实底那档的描边由自己出;玻璃档的底与边都在 `.bn-glass-strong` 里,再叠一层
		// border 会画出双边。
		expect(solid).toContain("border-bn-border");
		expect(glass).not.toContain("border-bn-border");
	});

	it("两档都挂 glass-strong 皮肤点 —— 底换了,挂点不换", () => {
		render(
			<>
				<PopoverShell surface="solid">a</PopoverShell>
				<PopoverShell surface="glass">b</PopoverShell>
			</>,
		);
		for (const t of ["a", "b"]) {
			expect(shellOf(t).getAttribute("data-bn")).toBe("glass-strong");
		}
	});
});
