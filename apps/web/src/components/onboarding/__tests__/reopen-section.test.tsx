// @vitest-environment jsdom

/**
 * 系统页「新手指引」一节 —— 三态 skipped 的回头路。
 *
 * 选过「老用户跳过」(或点过卡上的「跳过指引」/毕业)之后整个导览不渲染,
 * 这里是唯一的重开入口:写回 `skipped=false` + 发 reopen 信号(信号那半负责
 * 把这台浏览器上收着的卡展开,见 store/onboarding.ts)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useOnboardingReopen } from "../../../store/onboarding";

const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));
vi.mock("../../../services/api", () => ({
	api: { patch: apiPatch, get: vi.fn(async () => null) },
}));

afterEach(() => {
	cleanup();
	apiPatch.mockClear();
});

async function mount() {
	const { OnboardingReopenSection } = await import("../reopen-section");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<OnboardingReopenSection />
		</QueryClientProvider>,
	);
}

describe("OnboardingReopenSection", () => {
	it("点「重新开启指引」→ 写回 skipped=false 并发 reopen 信号", async () => {
		await mount();
		const before = useOnboardingReopen.getState().seq;
		fireEvent.click(screen.getByRole("button", { name: /重新开启指引/ }));
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: false } }),
		);
		// 信号在 PATCH 成功后才发 —— 配置没写上就展开卡,导览会因 skipped=true 渲染不出来
		await waitFor(() => expect(useOnboardingReopen.getState().seq).toBe(before + 1));
	});
});
