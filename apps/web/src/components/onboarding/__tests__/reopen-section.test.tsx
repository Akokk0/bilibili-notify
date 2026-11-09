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
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { useOnboardingReopen } from "../../../store/onboarding";

const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));
vi.mock("../../../services/api", () => ({
	api: { patch: apiPatch, get: vi.fn(async () => null) },
}));

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

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
			expect(apiPatch).toHaveBeenCalledWith("/api/settings", {
				core: { onboarding: { skipped: false } },
			}),
		);
		// 信号在 PATCH 成功后才发 —— 配置没写上就展开卡,导览会因 skipped=true 渲染不出来
		await waitFor(() => expect(useOnboardingReopen.getState().seq).toBe(before + 1));
	});
});

it.each([
	{
		locale: "en",
		title: "Getting started · onboarding",
		subtitle:
			"Sign in, connect, choose a target, test delivery, then subscribe. Reopen the guide here after skipping or finishing.",
		body: "When reopened, the guide appears at the lower left and continues from your current setup. You can skip it again at any time.",
		button: "Reopen guide",
	},
	{
		locale: "ja",
		title: "はじめに · onboarding",
		subtitle:
			"ログイン、接続、送信先、配信テスト、購読の順に設定します。スキップや完了後はここから再開できます。",
		body: "再開すると左下にガイドが表示され、現在の設定状況に合わせて続きから案内します。いつでも再びスキップできます。",
		button: "ガイドを再開",
	},
	{
		locale: "zh-TW",
		title: "新手指引 · onboarding",
		subtitle: "依序設定登入、連線、目標、測試與訂閱。略過或完成後可從這裡重新開啟。",
		body: "重新開啟後，左下角會出現指引卡片，依目前的設定進度繼續引導，隨時可再次略過。",
		button: "重新開啟指引",
	},
] as const)(
	"$locale explains reopening and preserves the persisted setting and reopen signal",
	async (expected) => {
		i18n.set({ locale: expected.locale, voice: "plain" });
		await mount();
		expect(screen.getByText(expected.title)).toBeTruthy();
		expect(screen.getByText(expected.subtitle)).toBeTruthy();
		expect(screen.getByText(expected.body)).toBeTruthy();
		const before = useOnboardingReopen.getState().seq;
		fireEvent.click(screen.getByRole("button", { name: expected.button }));
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledExactlyOnceWith("/api/settings", {
				core: { onboarding: { skipped: false } },
			}),
		);
		await waitFor(() => expect(useOnboardingReopen.getState().seq).toBe(before + 1));
	},
);
