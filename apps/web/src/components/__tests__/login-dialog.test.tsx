// @vitest-environment jsdom

/**
 * 登录卡的皮肤挂点。此前这个组件一条测试都没有,而它是主人见到的第一屏。
 *
 * 登录页照样吃皮肤 —— `SkinRoot` 在 `main.tsx` 里,包着 `AuthGate`。所以这张卡
 * 该跟 `ModalShell` 那 9 个弹窗一样挂 `modal`:否则皮肤给弹窗定的圆角 / 描边 /
 * 阴影落到那 9 个身上,独独绕过登录卡。
 *
 * 不为「怕皮肤写坏了登不进去」而留一块不挂:真的逃生口是 `?skin=off`
 * (`services/skin.ts` 的 `skinKillSwitchActive`),不是某个碰巧没挂的元素。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { LoginDialog } from "../LoginDialog";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("登录卡的挂点", () => {
	for (const variant of ["cold", "overlay"] as const) {
		it(`${variant} 变体的卡片本体挂 modal,且玻璃档走 strong`, () => {
			const { container } = render(<LoginDialog variant={variant} />);
			const card = container.querySelector("form") as HTMLFormElement;
			// 挂点必须落在**卡片本体**上,挂在外层覆盖层等于皮肤改的是那层黑纱。
			expect(card.getAttribute("data-bn")).toBe("modal");
			// 玻璃那一半走类名(`.bn-glass-strong` 也是挂点的一条路);弹窗档是 strong,
			// 用轻档的话暗色皮肤下会透出底下的页面。
			expect(card.className).toContain("bn-glass-strong");
		});
	}

	it("卡里的用户名 / 密码框走库里的 Input 原语 —— 跟着 input 挂点走", () => {
		const { container } = render(<LoginDialog variant="cold" />);
		const hooked = container.querySelectorAll('[data-bn="input"]');
		expect(hooked.length).toBe(2);
		expect(screen.getByPlaceholderText("用户名")).toBeTruthy();
		expect(screen.getByPlaceholderText("密码")).toBeTruthy();
	});
});

describe("登录限流提示随语言切换", () => {
	it.each([
		["ja", "ご主人様、ログインを試す回数が多すぎます。42秒待ってから、もう一度お試しくださいね。"],
		["zh-TW", "主人，登入嘗試次數太多了，請等 42 秒後再試喔。"],
	] as const)("%s 重画倒计时，不丢输入、不重发登录", async (locale, message) => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ code: "rate_limited", message: "raw diagnostic" }), {
					status: 429,
					headers: { "content-type": "application/json", "Retry-After": "42" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { container } = render(<LoginDialog variant="cold" />);
		fireEvent.change(screen.getByPlaceholderText("用户名"), {
			target: { value: "original-owner" },
		});
		fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "local-password" } });
		await act(async () => {
			fireEvent.submit(container.querySelector("form") as HTMLFormElement);
		});
		expect(screen.getByText("登录尝试过多,请 42 秒后再试")).toBeTruthy();
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(message)).toBeTruthy();
		expect(screen.getByDisplayValue("original-owner")).toBeTruthy();
		expect(screen.getByDisplayValue("local-password")).toBeTruthy();
		expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
		await act(async () => {
			fireEvent.submit(container.querySelector("form") as HTMLFormElement);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			username: "original-owner",
			password: "local-password",
		});
	});
});
