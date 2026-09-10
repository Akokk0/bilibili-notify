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

import type { Connection } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { BridgeConnections } from "../bridge-panel";

const TOKEN = "0123456789abcdef0123456789abcdef";

const LINK = {
	id: "c1",
	name: "koishi 那台",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: TOKEN, bridgeKind: "koishi" },
} as unknown as Connection;

function renderPanel() {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/connections") return [LINK];
		throw new Error("拓展没跑起来");
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BridgeConnections extensionId="bridge" />
		</QueryClientProvider>,
	);
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
		renderPanel();
		const masked = await screen.findByText(/^0123.*cdef$/);
		expect(masked.textContent).not.toContain(TOKEN);
		expect(document.body.textContent).not.toContain(TOKEN);
	});

	it("「重新生成」就在 token 这一行 —— 它讲的是 token,不该散在卡片标题栏", async () => {
		renderPanel();
		const masked = await screen.findByText(/^0123.*cdef$/);
		const row = masked.closest("[data-token-row]");
		expect(row).toBeTruthy();
		expect(row?.querySelector("button[aria-label*='重新生成']")).toBeTruthy();
	});
});

describe("非安全上下文里的复制", () => {
	/**
	 * 🔴 这条就是那个 bug:`http://<内网 IP>:8787` 下 `navigator.clipboard` 是 undefined,
	 * 裸写法按下去静默无事 —— 而这一页正是最常从内网 IP 打开的一页。
	 */
	it("没有 navigator.clipboard 时,复制 token 也要真的复制到", async () => {
		const execCommand = pretendInsecureContext();
		renderPanel();
		await userEvent.click(await screen.findByRole("button", { name: /复制.*token/ }));
		expect(execCommand).toHaveBeenCalledWith("copy");
	});

	it("BN 地址同理 —— 抄错地址与抄错 token 一样连不上", async () => {
		const execCommand = pretendInsecureContext();
		renderPanel();
		await userEvent.click(await screen.findByRole("button", { name: /复制 BN 地址/ }));
		expect(execCommand).toHaveBeenCalledWith("copy");
	});
});
