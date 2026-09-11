// @vitest-environment jsdom
/**
 * token 那一行,以及两处「复制」。
 *
 * 🔴 **复制在这一页比在别处更要紧**:token 与 BN 地址是插件那头**必须原样填进去**的两样,
 * 手抄一个 32 位十六进制串是最容易出错的操作,而抄错的症状是「连不上」——最难查的那种。
 *
 * 而这一页恰恰是最容易落进**非安全上下文**的一页:BN 常经 `http://<内网 IP>:8787` 访问,
 * 那里 `navigator.clipboard` 根本不存在。仓里早有带兜底的 `copyToClipboard`,这两处却
 * 各写了一份裸 `navigator.clipboard?.writeText` —— 按下去什么都不发生,也不报错。
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { maskToken } from "../bridge-panel";
import { LINK as HOME, renderPanel, savedLinks, TOKEN } from "./bridge-harness";

/** 这一页的接入叫 koishi 那台 —— 掩码那几条讲的是「两条接入分得出谁是谁」。 */
const LINK = { ...HOME, name: "koishi 那台" };

// 地址行住在详情页的头卡上,token 行在接入卡上 —— 两处的「复制」走的是同一件事
function renderTokenRow(links: unknown[] = [LINK]) {
	return renderPanel({ links, withAddressRow: true });
}

/** 装一个非安全上下文:没有 `navigator.clipboard`,只有老式 `execCommand`。 */
function pretendInsecureContext(): ReturnType<typeof vi.fn> {
	vi.stubGlobal("navigator", {
		...navigator,
		clipboard: undefined,
		// userEvent 要它才点得动
		userAgent: navigator.userAgent,
	});
	const execCommand = vi.fn().mockReturnValue(true);
	Object.defineProperty(document, "execCommand", {
		value: execCommand,
		configurable: true,
		writable: true,
	});
	return execCommand;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	Reflect.deleteProperty(document, "execCommand");
});

describe("token 那一行", () => {
	it("掩码留头尾各四位 —— 两条接入才分得出谁是谁,而全文不上屏", async () => {
		renderTokenRow();
		const masked = await screen.findByText(/^0123.*cdef$/);
		expect(masked.textContent).not.toContain(TOKEN);
		expect(document.body.textContent).not.toContain(TOKEN);
	});

	it("「重新生成」就在 token 这一行 —— 它讲的是 token,不该散在卡片标题栏", async () => {
		renderTokenRow();
		const masked = await screen.findByText(/^0123.*cdef$/);
		const row = masked.closest("[data-token-row]");
		expect(row).toBeTruthy();
		expect(row?.querySelector("button[aria-label*='重新生成']")).toBeTruthy();
	});

	/**
	 * 🔴 **脱敏备份恢复回来的接入必然是空 token**:那条路把它抹掉了。此前这一格只画一句
	 * 「重新生成一把」却没有那颗钮 —— 请人做一件他在这一页上做不到的事,而 `onRegenerate`
	 * 就挂在旁边没人用。
	 */
	it("空 token 也给得出「重新生成」那颗钮 —— 一句话请人做的事得真的按得到", async () => {
		renderTokenRow([{ ...LINK, token: "" }]);
		expect(await screen.findByText(/还没有 token/)).toBeTruthy();
		const regenerate = screen.getByRole("button", { name: /重新生成/ });
		await userEvent.click(regenerate);
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		expect(savedLinks()[0]?.token).toMatch(/^[0-9a-f]{32}$/);
	});
});

/**
 * 掩码的活是「屏幕上认得出是哪一把,但拿不到它」。头四尾四对**够长**的 token 成立,
 * 对短的就是把全文原样印出来 —— 32 位是我们自己生成的长度,而手填 / 别处迁移来的不是。
 */
describe("maskToken", () => {
	it("短 token 整段打点 —— 留下的明文必须比原文短", () => {
		for (const token of ["a", "abcd", "ab12cd34"]) {
			const masked = maskToken(token);
			expect(masked.replace(/•/g, ""), token).toHaveLength(0);
			expect(masked, token).not.toContain(token);
		}
	});

	it("够长的仍留头尾各四位 —— 两条接入才分得出谁是谁", () => {
		expect(maskToken(TOKEN)).toBe(`0123${"•".repeat(24)}cdef`);
		expect(maskToken("abcd12345")).toBe(`abcd${"•".repeat(4)}2345`);
	});
});

describe("非安全上下文里的复制", () => {
	/**
	 * 🔴 这条就是那个 bug:`http://<内网 IP>:8787` 下 `navigator.clipboard` 是 undefined,
	 * 裸写法按下去静默无事 —— 而这一页正是最常从内网 IP 打开的一页。
	 */
	it("没有 navigator.clipboard 时,复制 token 也要真的复制到", async () => {
		const execCommand = pretendInsecureContext();
		renderTokenRow();
		await userEvent.click(await screen.findByRole("button", { name: /复制.*token/ }));
		expect(execCommand).toHaveBeenCalledWith("copy");
	});

	it("BN 地址同理 —— 抄错地址与抄错 token 一样连不上", async () => {
		const execCommand = pretendInsecureContext();
		renderTokenRow();
		await userEvent.click(await screen.findByRole("button", { name: /复制 BN 地址/ }));
		expect(execCommand).toHaveBeenCalledWith("copy");
	});
});
