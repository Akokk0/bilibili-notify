// @vitest-environment jsdom

/**
 * `NoticeStack` / `NoticeCard` —— 角落通知栈与富通知卡。
 *
 * 收编前推送 toast 与组件告警各抄一份:卡骨架、图标片壳、标题行、关闭钮逐字符
 * 相同。这里钉住收编后不许再漂的部分:皮肤挂点、portal 栈的 aria-live、关闭钮的
 * 读屏名、时间的等宽小字。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NoticeCard, NoticeStack } from "../notice";

afterEach(cleanup);

describe("NoticeStack", () => {
	it("portal 到 body,栈壳带 aria-live 与 pointer-events-none", () => {
		const { baseElement } = render(
			<NoticeStack corner="bottom-right" ariaLive="polite" className="w-80">
				<div>x</div>
			</NoticeStack>,
		);
		const stack = baseElement.querySelector("[aria-live]") as HTMLElement;
		expect(stack.getAttribute("aria-live")).toBe("polite");
		expect(stack.className).toContain("pointer-events-none");
		expect(stack.className).toContain("bottom-4 right-4");
		expect(stack.className).toContain("w-80");
	});

	it("两个角落各是一档 —— 告警在右上", () => {
		const { baseElement } = render(
			<NoticeStack corner="top-right" ariaLive="assertive">
				<div>x</div>
			</NoticeStack>,
		);
		const stack = baseElement.querySelector("[aria-live]") as HTMLElement;
		expect(stack.className).toContain("right-4 top-4");
	});
});

describe("NoticeCard", () => {
	it("卡本体挂 glass-strong 皮肤挂点,恢复指针事件", () => {
		const { container } = render(<NoticeCard icon="!" title="t" onClose={() => {}} />);
		const card = container.querySelector('[data-bn="glass-strong"]') as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.className).toContain("pointer-events-auto");
	});

	it("关闭钮有读屏名,默认「关闭」", () => {
		render(<NoticeCard icon="!" title="t" onClose={() => {}} />);
		expect(screen.getByRole("button", { name: "关闭" })).not.toBeNull();
	});

	it("时间是等宽小字;不给就不渲染右槽", () => {
		const { container } = render(<NoticeCard icon="!" title="t" time="12:34" onClose={() => {}} />);
		const time = [...container.querySelectorAll("span")].find((s) => s.textContent === "12:34");
		expect(time?.className).toContain("font-mono");
		cleanup();
		const { container: bare } = render(<NoticeCard icon="!" title="t" onClose={() => {}} />);
		expect(bare.querySelector(".font-mono")).toBeNull();
	});

	it("图标片对读屏器隐身 —— 图标语义由标题承担", () => {
		const { container } = render(<NoticeCard icon="!" title="t" onClose={() => {}} />);
		expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
	});
});
