// @vitest-environment jsdom

/**
 * IconButton —— 只装一枚图标的方钮/圆钮。
 *
 * 收编前站内 23 处手写,尺寸漂成 h-4 / 4.5 / 5 / 5.5 / 6 / 7 / 7.5 / 8.5 / 9 /
 * [34px] **十档**,而语义只有五档;hover 也漂成六种写法,语义只有四种。挂点更是
 * 各挂各的。这里钉的是那份共同骨架:居中、不被压扁、有名字、带皮肤挂点。
 *
 * `size` 走命名档而不是像 `Avatar` 那样收数字 —— 收数字只是把漂移换个地方放。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Icon, IconButton } from "../index";

afterEach(cleanup);

const btn = () => screen.getByRole("button");

describe("IconButton", () => {
	it("图标居中、不被 flex 压扁,并且挂着皮肤挂点", () => {
		render(<IconButton icon={<Icon.close size={13} />} label="关闭" onClick={() => {}} />);
		const cls = btn().className.split(/\s+/);
		for (const c of ["grid", "place-items-center", "shrink-0"]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
		expect(btn().getAttribute("data-bn")).toBe("btn");
	});

	/** ⠿ 那种裸字形按钮之所以不能用它,就是因为这层壳自带外观。 */
	it("label 是读屏器唯一的抓手 —— 图标本身没有文字", () => {
		render(
			<IconButton icon={<Icon.close size={13} />} label="移除该推送目标" onClick={() => {}} />,
		);
		expect(screen.getByRole("button", { name: "移除该推送目标" })).toBeTruthy();
		expect(btn().getAttribute("title")).toBe("移除该推送目标");
	});

	/**
	 * 两处调用点的 tooltip 与读屏器名字**刻意不同**:侧栏的删除钮 tooltip 只写
	 * 「删除这个对话」,读屏器要念出是哪个对话。合成一个就把后者砍没了。
	 */
	it("title 可与 label 分开,不给就跟着 label", () => {
		render(
			<IconButton
				icon={<Icon.close size={13} />}
				label="删除对话「昨天的皮肤」"
				title="删除这个对话"
				onClick={() => {}}
			/>,
		);
		expect(btn().getAttribute("title")).toBe("删除这个对话");
		expect(btn().getAttribute("aria-label")).toBe("删除对话「昨天的皮肤」");
	});

	it("下拉触发器的 aria 状态照直透传", () => {
		render(
			<IconButton
				icon={<Icon.plus size={13} />}
				label="添加"
				ariaHasPopup
				ariaExpanded
				onClick={() => {}}
			/>,
		);
		expect(btn().getAttribute("aria-haspopup")).toBe("true");
		expect(btn().getAttribute("aria-expanded")).toBe("true");
	});

	it("五档尺寸各自是一对相等的宽高", () => {
		const want: Record<string, string> = {
			xs: "h-4 w-4",
			sm: "h-5 w-5",
			md: "h-6 w-6",
			lg: "h-7 w-7",
			xl: "h-9 w-9",
		};
		for (const [size, pair] of Object.entries(want)) {
			const { unmount } = render(
				<IconButton
					icon={<Icon.close size={13} />}
					label="x"
					size={size as "xs"}
					onClick={() => {}}
				/>,
			);
			const cls = btn().className.split(/\s+/);
			for (const c of pair.split(" ")) {
				expect([size, c, cls.includes(c)]).toEqual([size, c, true]);
			}
			unmount();
		}
	});

	it("默认 sm —— 站内最常见的那一档", () => {
		render(<IconButton icon={<Icon.close size={13} />} label="x" onClick={() => {}} />);
		expect(btn().className).toContain("h-5");
	});

	it("tone 只管 hover 语义,静态字色统一走 tertiary", () => {
		const { unmount } = render(
			<IconButton icon={<Icon.close size={13} />} label="x" onClick={() => {}} />,
		);
		expect(btn().className).toContain("text-bn-text-tertiary");
		expect(btn().className).toContain("hover:bg-bn-hover-muted");
		unmount();

		render(
			<IconButton icon={<Icon.close size={13} />} label="x" tone="danger" onClick={() => {}} />,
		);
		expect(btn().className).toContain("hover:bg-bn-danger-soft");
		expect(btn().className).toContain("hover:text-bn-danger-text");
	});

	it("shape=pill 换成药丸圆角,默认是小方角", () => {
		const { unmount } = render(
			<IconButton icon={<Icon.close size={13} />} label="x" onClick={() => {}} />,
		);
		expect(btn().className).toContain("rounded-bn-xs");
		unmount();
		render(
			<IconButton icon={<Icon.close size={13} />} label="x" shape="pill" onClick={() => {}} />,
		);
		expect(btn().className).toContain("rounded-bn-pill");
	});

	/** 描边+底色那一档:section-nav 的滚动箭头、附件的移除角标都是这个样子。 */
	it("filled 加一圈描边与面底色", () => {
		render(<IconButton icon={<Icon.close size={13} />} label="x" filled onClick={() => {}} />);
		const cls = btn().className;
		expect(cls).toContain("border");
		expect(cls).toContain("bg-bn-surface");
	});

	it("className 只追加定位这类不冲突的工具类,接在本体之后", () => {
		render(
			<IconButton
				icon={<Icon.close size={13} />}
				label="x"
				className="absolute right-1 top-1"
				onClick={() => {}}
			/>,
		);
		expect(btn().className.endsWith("absolute right-1 top-1")).toBe(true);
	});

	it("点得动,禁用时点不动", () => {
		const onClick = vi.fn();
		const { unmount } = render(
			<IconButton icon={<Icon.close size={13} />} label="x" onClick={onClick} />,
		);
		fireEvent.click(btn());
		expect(onClick).toHaveBeenCalledTimes(1);
		unmount();

		render(<IconButton icon={<Icon.close size={13} />} label="x" disabled onClick={onClick} />);
		fireEvent.click(btn());
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
