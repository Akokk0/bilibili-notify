// @vitest-environment jsdom

/**
 * `useTextSettings`:登录后从 `/api/settings` 读语言与口吻,接到面板自己的字典 store,并记进浏览器。
 * 设置里缺语言那一格 → 把登录页正在用的语言 PATCH 进去,只写一次;失败不写,下次登录(重新挂载)再试。
 * 请求失败(拿不到设置)≠ 设置里缺这一格:前者不动 store。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import { i18n } from "../index";
import { useTextSettings } from "../use-text-settings";

const get = vi.mocked(api.get);
const patch = vi.mocked(api.patch);

function Harness() {
	useTextSettings();
	return null;
}

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	render(
		<StrictMode>
			<QueryClientProvider client={client}>
				<Harness />
			</QueryClientProvider>
		</StrictMode>,
	);
	return client;
}

beforeEach(() => {
	localStorage.clear();
	i18n.set({ locale: "zh-CN", voice: "maid" });
	get.mockReset();
	patch.mockReset();
	patch.mockResolvedValue({} as never);
});

afterEach(() => {
	cleanup();
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

describe("useTextSettings", () => {
	it("设置里写了 → store 跟着,浏览器记下语言与口吻,不 PATCH", async () => {
		get.mockResolvedValue({ locale: "en", voice: "plain" } as never);
		mount();
		await waitFor(() => expect(i18n.state().locale).toBe("en"));
		expect(i18n.state().voice).toBe("plain");
		expect(localStorage.getItem("bn.locale")).toBe("en");
		expect(localStorage.getItem("bn.voice")).toBe("plain");
		expect(patch).not.toHaveBeenCalled();
	});

	it("缺口吻 → 规则默认女仆", async () => {
		// 日文今天没有女仆层,实际口吻看不出来;换到简中才能看到「要的是女仆」
		i18n.set({ locale: "en", voice: "plain" });
		get.mockResolvedValue({ locale: "zh-CN" } as never);
		mount();
		await waitFor(() => expect(i18n.state().locale).toBe("zh-CN"));
		expect(i18n.state().voice).toBe("maid");
	});

	it("缺语言 → 保持登录页在用的语言,把它 PATCH 进设置,只写一次", async () => {
		i18n.set({ locale: "ja" });
		get.mockResolvedValue({} as never);
		const client = mount();
		await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
		expect(patch).toHaveBeenCalledWith("/api/settings", { locale: "ja" });
		expect(i18n.state().locale).toBe("ja");

		// 设置又失效重读一次(模拟 WS config-changed;内容要变,否则 react-query 沿用旧引用、副作用不会再跑),仍缺也不再写
		get.mockResolvedValue({ mutedUntil: 5 } as never);
		await act(() => client.invalidateQueries({ queryKey: ["settings"] }));
		await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(patch).toHaveBeenCalledTimes(1);
	});

	it("PATCH 失败 → 不写、不抛;重新挂载(下次登录)再试", async () => {
		i18n.set({ locale: "en" });
		get.mockResolvedValue({} as never);
		patch.mockRejectedValueOnce(new Error("offline"));
		mount();
		await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
		cleanup();
		mount();
		await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
		expect(patch).toHaveBeenLastCalledWith("/api/settings", { locale: "en" });
	});

	it("拿不到设置(请求失败)→ store 不动、不 PATCH", async () => {
		i18n.set({ locale: "en", voice: "plain" });
		get.mockRejectedValue(new Error("down"));
		mount();
		await waitFor(() => expect(get).toHaveBeenCalled());
		await Promise.resolve();
		expect(i18n.state().locale).toBe("en");
		expect(i18n.state().voice).toBe("plain");
		expect(patch).not.toHaveBeenCalled();
	});

	it("设置失效重读后新值生效", async () => {
		get.mockResolvedValue({ locale: "en", voice: "plain" } as never);
		const client = mount();
		await waitFor(() => expect(i18n.state().locale).toBe("en"));
		get.mockResolvedValue({ locale: "zh-CN", voice: "maid" } as never);
		await act(() => client.invalidateQueries({ queryKey: ["settings"] }));
		await waitFor(() => expect(i18n.state().locale).toBe("zh-CN"));
		expect(i18n.state().voice).toBe("maid");
		expect(localStorage.getItem("bn.locale")).toBe("zh-CN");
	});
});
