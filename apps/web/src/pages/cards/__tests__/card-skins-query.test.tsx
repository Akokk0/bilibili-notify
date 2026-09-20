// @vitest-environment jsdom

/**
 * 「换上这套」那个动作(`useActivateCardSkin`)。
 *
 * 钉的是**它到底作废了哪几个 key**:皮肤库列表自己那份(「使用中」徽标读的是它),
 * 以及 `["globals"]` —— **启用指针住在 `globals.defaults.cardSkin`,不在店里**。
 *
 * 这条守卫的理由是这个动作在站里有两处入口(皮肤库那一节、卡片工坊回复末尾的预览块),
 * 从前是逐行同构的两份。漏掉 globals 那一份的症状是「换了皮肤,聊天里的预览还是旧的」,
 * 不报错、不红,只能靠有人去点一次才发现。删掉 hook 里任意一个 invalidate,这条就红。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CARD_SKINS_KEY, useActivateCardSkin } from "../card-skins-query";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

/** 这一轮被作废掉的那些 key(按 `invalidateQueries` 的调用顺序)。 */
function setup() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidated: unknown[] = [];
	vi.spyOn(qc, "invalidateQueries").mockImplementation((filters) => {
		invalidated.push(filters?.queryKey);
		return Promise.resolve();
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return { invalidated, wrapper };
}

beforeEach(() => {
	vi.mocked(api.put).mockResolvedValue({ ok: true });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useActivateCardSkin", () => {
	it("打的是 PUT /api/card-skins/active,带上那套皮肤的 id", async () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useActivateCardSkin(), { wrapper });
		result.current.mutate("aurora");
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(api.put).toHaveBeenCalledWith("/api/card-skins/active", { id: "aurora" });
	});

	it("🔴 换完之后,列表与 globals **两个** key 都作废", async () => {
		const { invalidated, wrapper } = setup();
		const { result } = renderHook(() => useActivateCardSkin(), { wrapper });
		result.current.mutate("aurora");
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(invalidated).toContainEqual(CARD_SKINS_KEY);
		// 启用指针住在 globals 里 —— 少了这一发,预览与灵动岛基线还攥着上一套。
		expect(invalidated).toContainEqual(["globals"]);
	});

	it("失败时一个 key 都不作废,理由原样交给调用方", async () => {
		const { invalidated, wrapper } = setup();
		const onError = vi.fn();
		vi.mocked(api.put).mockRejectedValue(new Error("这套皮肤已经不在库里了"));
		const { result } = renderHook(() => useActivateCardSkin({ onError }), { wrapper });
		result.current.mutate("gone");
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(invalidated).toEqual([]);
		expect(onError).toHaveBeenCalledWith("这套皮肤已经不在库里了");
	});
});
