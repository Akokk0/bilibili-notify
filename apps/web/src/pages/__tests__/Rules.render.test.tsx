// @vitest-environment jsdom

/**
 * 高级规则页 tab 关闭确认。点 per-UP tab 的 x 关闭一个「已有覆盖项」的 UP 属于
 * 销毁性操作(清空 overrides + specialViewers),回归前会直接 PATCH 清空、静默回到
 * 全局;现在必须先弹 ConfirmDialog,取消则不动 backend,确认才真正清空。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalSettings } from "../../types/globals";
import Rules from "../Rules";
import { makeAi, makeDefaults, makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const CUSTOMIZED: Subscription = {
	...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
	overrides: { imageGroup: { enabled: true, mergeForward: false } },
};

const GLOBALS = {
	logging: {},
	master: {},
	defaults: makeDefaults(),
	ai: makeAi(),
} as unknown as GlobalSettings;

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function renderRules() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Rules />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) =>
		Promise.resolve(
			url === "/api/sources"
				? { sources: [makeSource()] }
				: url.includes("/api/subscriptions")
					? [CUSTOMIZED]
					: { core: GLOBALS },
		),
	);
	vi.mocked(api.patch).mockResolvedValue(CUSTOMIZED);
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("高级规则 tab 关闭确认", () => {
	it("点已定制 UP 的 x → 弹确认 dialog,且不立即 PATCH 清空", async () => {
		renderRules();
		const closeBtn = await screen.findByTitle(/移除 .* 的个性化配置/);
		fireEvent.click(closeBtn);

		expect(await screen.findByText("移除该订阅的个性化配置?")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("只配了特别关注、没有任何覆盖项的 UP 也算已定制:有 tab 可关", async () => {
		const onlySpecial: Subscription = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "654321" }),
			specialViewers: [{ id: "7", features: ["viewerEnter"] }],
		};
		vi.mocked(api.get).mockImplementation((url: string) =>
			Promise.resolve(
				url === "/api/sources"
					? { sources: [makeSource()] }
					: url.includes("/api/subscriptions")
						? [onlySpecial]
						: { core: GLOBALS },
			),
		);
		renderRules();
		expect(await screen.findByTitle(/移除 .* 的个性化配置/)).toBeTruthy();
	});

	it("B 站订阅的确认文案说「所有覆盖项与特别关注」", async () => {
		renderRules();
		fireEvent.click(await screen.findByTitle(/移除 .* 的个性化配置/));
		await screen.findByText("移除该订阅的个性化配置?");
		expect(
			screen.getByText(/的所有覆盖项与特别关注,该订阅之后跟随全局规则。此操作不可撤销。/),
		).toBeTruthy();
	});

	it("确认 dialog 点『取消』→ 关闭弹窗,不动 backend", async () => {
		renderRules();
		fireEvent.click(await screen.findByTitle(/移除 .* 的个性化配置/));
		fireEvent.click(await screen.findByText("移除该订阅的个性化配置?"));
		fireEvent.click(screen.getByRole("button", { name: "取消" }));

		await waitFor(() => expect(screen.queryByText("移除该订阅的个性化配置?")).toBeNull());
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("确认 dialog 点『移除』→ PATCH 清空 overrides + specialViewers", async () => {
		renderRules();
		fireEvent.click(await screen.findByTitle(/移除 .* 的个性化配置/));
		await screen.findByText("移除该订阅的个性化配置?");
		fireEvent.click(screen.getByRole("button", { name: "移除" }));

		// overrides 须以清除哨兵下发(现存 slice 显式 null),否则空对象 merge 不删任何键。
		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${CUSTOMIZED.id}`, {
				overrides: { imageGroup: null },
				specialViewers: [],
			}),
		);
	});
});

it("rule removal confirmation translates in place and preserves the original subscription name", async () => {
	const get = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation(async (url) =>
		url.includes("/api/subscriptions")
			? [{ ...CUSTOMIZED, cachedProfile: { name: "主人原昵称", followers: 0, refreshedAt: "t" } }]
			: get?.(url),
	);
	renderRules();
	fireEvent.click(await screen.findByTitle(/移除 主人原昵称 的个性化配置/));
	const dialog = screen.getByRole("dialog");
	for (const [locale, title, warning] of [
		["en", "Remove this subscription’s custom settings?", "This cannot be undone."],
		["ja", "この購読の個別設定を削除しますか？", "この操作は取り消せません。"],
		["zh-TW", "移除此訂閱的個別設定？", "此操作無法復原。"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(screen.getByText(title)).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: locale === "en" ? "Remove" : locale === "ja" ? "削除" : "移除",
			}),
		).toBeTruthy();
		expect(dialog.textContent).toContain("主人原昵称");
		expect(dialog.textContent).toContain(warning);
		expect(api.patch).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	expect(api.patch).not.toHaveBeenCalled();
});

it("rule navigation translates in global and subscription scopes without replacing the active editor", async () => {
	const get = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation(async (url) =>
		url.includes("/api/subscriptions")
			? [{ ...CUSTOMIZED, cachedProfile: { name: "规则作者", followers: 0, refreshedAt: "t" } }]
			: get?.(url),
	);
	renderRules();
	fireEvent.click(await screen.findByRole("button", { name: "作品图集" }));
	const editor = document.querySelector('[data-code="imageGroup.enabled"]');
	for (const [locale, gallery, live, membership] of [
		["en", "Post image galleries", "Live thresholds", "Membership notifications"],
		["ja", "作品の画像一覧", "配信の通知条件", "会員通知"],
		["zh-TW", "作品圖集", "直播門檻", "會員提示"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("button", { name: gallery }).getAttribute("aria-current")).toBe("true");
		expect(screen.getByRole("button", { name: live })).toBeTruthy();
		expect(screen.getByRole("button", { name: membership })).toBeTruthy();
		expect(document.querySelector('[data-code="imageGroup.enabled"]')).toBe(editor);
		expect(api.patch).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByText("规则作者", { selector: "span" }));
	for (const [locale, personality, viewers] of [
		["en", "AI personality", "Special viewer messages"],
		["ja", "AI の性格", "注目する視聴者のコメント"],
		["zh-TW", "AI 性格", "特別關注彈幕"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("button", { name: personality })).toBeTruthy();
		expect(screen.getByRole("button", { name: viewers })).toBeTruthy();
		expect(screen.getByText("规则作者", { selector: "span" })).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	}
});
