// @vitest-environment jsdom

/**
 * `QrPanel` —— 扫码那一块:二维码(或等图时的占位)+ 底下的说明。
 *
 * 收编前三份手写:系统页的 B 站登录、拓展交来的 `qr` 积木、QQ 机器人的扫码绑定。积木那份
 * 的注释写着「任何拓展的扫码都该与 BN 自己的长一样」,而这句话当时是靠复制粘贴兑现的。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { QrPanel } from "../qr-panel";

afterEach(cleanup);

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** 尺寸与圆角那几样 —— 占位方块与图得是同一个方块,来图时才不跳。 */
function squareOf(el: Element): string[] {
	return (el as HTMLElement).className
		.split(/\s+/)
		.filter((t) => /^(h-|w-|rounded-)/.test(t))
		.sort();
}

describe("QrPanel", () => {
	it("有图就画图,alt 说的是这是什么的二维码;说明摆在图下面", () => {
		render(
			<QrPanel src={PNG} alt="登录二维码" loading="二维码加载中">
				<div>用手机扫</div>
			</QrPanel>,
		);
		const img = screen.getByAltText("登录二维码") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe(PNG);
		// 有图就不再占位。
		expect(screen.queryByRole("status")).toBeNull();
		const note = screen.getByText("用手机扫");
		expect(img.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("图还没到、给了 loading:占一个与图同尺寸的方块,里面转圈说那句话", () => {
		const { container, rerender } = render(
			<QrPanel src={null} alt="登录二维码" loading="二维码加载中" />,
		);
		const status = screen.getByRole("status");
		expect(status.textContent).toContain("二维码加载中");
		const placeholder = status.parentElement as HTMLElement;
		expect(container.querySelector("img")).toBeNull();

		rerender(<QrPanel src={PNG} alt="登录二维码" loading="二维码加载中" />);
		expect(squareOf(placeholder)).toEqual(squareOf(screen.getByAltText("登录二维码")));
	});

	it("图没有、也没给 loading:不画方块,只剩说明", () => {
		const { container } = render(
			<QrPanel src={undefined} alt="二维码">
				<div>说明</div>
			</QrPanel>,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByText("说明")).toBeTruthy();
	});

	/** 弹窗自己就是底:卡里再套一张描边卡、占位方块再垫一层底,都是多出来的。 */
	it("bare:除了图本身,什么底和边都不画", () => {
		const painted = (root: Element) =>
			[root, ...root.querySelectorAll("*")].filter(
				(el) =>
					el.tagName !== "IMG" &&
					(el as HTMLElement).className
						.split(/\s+/)
						.some((t) => t.startsWith("bg-") || t === "border"),
			);
		const { container, rerender } = render(
			<QrPanel variant="bare" src={null} alt="二维码" loading="等" />,
		);
		expect(painted(container.firstElementChild as Element)).toEqual([]);
		rerender(<QrPanel variant="bare" src={PNG} alt="二维码" />);
		expect(painted(container.firstElementChild as Element)).toEqual([]);
		// 默认那档是有卡的 —— 不然上面那条是空跑。
		rerender(<QrPanel src={PNG} alt="二维码" />);
		expect(painted(container.firstElementChild as Element).length).toBeGreaterThan(0);
	});

	it("外层的属性原样透传(导览的锚点挂在这儿)", () => {
		const { container } = render(<QrPanel data-tour="bili-login-qr" src={PNG} alt="二维码" />);
		expect(container.firstElementChild?.getAttribute("data-tour")).toBe("bili-login-qr");
	});
});
