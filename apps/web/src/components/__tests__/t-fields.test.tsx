// @vitest-environment jsdom

/**
 * T 系列输入件新开的三个口子。
 *
 * 这三个都不是装饰,各自堵一个具体的坑:
 * - `ariaLabel` —— 调用方把控件包进带整段提示文字的 `<label>` 时,读屏器念的是
 *   **整段拼接**;没有它,「正文」这个框叫「正文 · 做事的步骤 Markdown。这段会……」。
 * - `width` —— 走 inline style 的数字而非 `w-*` 类名。本仓没装 tailwind-merge,
 *   `w-40` 压不掉基线的 `w-full`,胜负由样式表先后决定 —— 是个随构建漂移的结果。
 * - `TSelect.disabled` —— 四件 T 里只有它此前漏了这个态。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TArea, TInput, TSelect } from "../forms";

afterEach(cleanup);

const noop = () => {};

describe("ariaLabel —— 无障碍名落在控件本身", () => {
	it("TInput 给了 ariaLabel 就用它当无障碍名,不被外层 label 的整段文字盖过", () => {
		render(
			// biome-ignore lint/a11y/noLabelWithoutControl: 控件由 TInput 渲染在内部
			<label>
				<span>手填字体名</span>
				<TInput ariaLabel="手填字体名" value="" onChange={noop} />
				<span>容器里没装的字体填了不生效</span>
			</label>,
		);
		// 用无障碍名精确取到 —— 取得到就说明属性落在 <input> 上而不是包装层。
		expect(screen.getByLabelText("手填字体名").tagName).toBe("INPUT");
	});

	it("TArea 同理", () => {
		render(<TArea ariaLabel="技能正文" value="" onChange={noop} />);
		expect(screen.getByLabelText("技能正文").tagName).toBe("TEXTAREA");
	});

	it("不给 ariaLabel 就不留空属性 —— 空的 aria-label 会把无障碍名清成空串", () => {
		const { container } = render(<TInput value="" onChange={noop} />);
		expect(container.querySelector("input")?.hasAttribute("aria-label")).toBe(false);
	});
});

describe("width —— 定宽走 inline style,不走类名", () => {
	it("给了 width 就写进 style,且不再挂 w-full / w-auto(否则两条宽度规则打架)", () => {
		const { container } = render(<TInput width={160} value="" onChange={noop} />);
		const el = container.querySelector("input") as HTMLInputElement;
		expect(el.style.width).toBe("160px");
		expect([el.className.includes("w-full"), el.className.includes("w-auto")]).toEqual([
			false,
			false,
		]);
	});

	it("不给 width 时维持原样:full 默认满宽,full={false} 收成 w-auto", () => {
		const { container } = render(
			<>
				<TInput value="" onChange={noop} />
				<TInput full={false} value="" onChange={noop} />
			</>,
		);
		const [a, b] = Array.from(container.querySelectorAll("input"));
		expect([a.className.includes("w-full"), a.style.width]).toEqual([true, ""]);
		expect([b.className.includes("w-auto"), b.style.width]).toEqual([true, ""]);
	});
});

describe("TSelect.disabled —— 补齐四件 T 里唯一缺的那个态", () => {
	const OPTS = [{ value: "a", label: "A" }];

	it("disabled 落到 <select> 本体,并带上与兄弟件同一套压暗语汇", () => {
		const { container } = render(<TSelect disabled value="a" onChange={noop} options={OPTS} />);
		const el = container.querySelector("select") as HTMLSelectElement;
		expect(el.disabled).toBe(true);
		expect(el.className).toContain("disabled:opacity-60");
	});

	it("不给就是可用态", () => {
		const { container } = render(<TSelect value="a" onChange={noop} options={OPTS} />);
		expect(container.querySelector("select")?.disabled).toBe(false);
	});
});
