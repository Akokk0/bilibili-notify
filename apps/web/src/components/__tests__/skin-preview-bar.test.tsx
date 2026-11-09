// @vitest-environment jsdom

/**
 * 试穿浮条:preview 非空才出现;「应用」PUT 落盘并把 preview 转正为 active;
 * 「取消」清 preview 回真实状态。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { api } from "../../services/api";
import { EMPTY_SLOTS, useSkinStore } from "../../store/skin";
import { SkinPreviewBar } from "../skin-preview-bar";

const H = vi.hoisted(() => ({
	putCalls: [] as unknown[],
	activeResponse: { active: { light: null, dark: null } } as unknown,
}));

vi.mock("../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/dashboard/skins/active") return H.activeResponse;
			throw new Error(`unexpected GET ${path}`);
		}),
		put: vi.fn(async (_path: string, body: unknown) => {
			H.putCalls.push(body);
			return { ok: true };
		}),
	},
}));

const manifest: SkinManifest = { schemaVersion: 1, name: "樱花夜", modes: { light: {} } };

function renderBar() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SkinPreviewBar />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	H.putCalls = [];
	H.activeResponse = { active: { light: null, dark: null } };
	useSkinStore.setState({
		active: EMPTY_SLOTS,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SkinPreviewBar", () => {
	it.each([
		[
			"en",
			"Previewing “Original skin 原文”",
			"This is a temporary preview; refreshing restores the saved skin.",
			"Applying…",
			"Apply",
			"Cancel",
		],
		[
			"ja",
			"「Original skin 原文」をプレビュー中",
			"一時的なプレビューです。再読み込みすると保存済みのスキンに戻ります。",
			"適用中…",
			"適用",
			"キャンセル",
		],
		[
			"zh-TW",
			"正在預覽「Original skin 原文」",
			"目前為暫時預覽，重新整理後會回復已儲存的佈景主題。",
			"套用中…",
			"套用",
			"取消",
		],
	] as const)(
		"%s localizes preview actions while preserving the original skin name, identity and failed-apply diagnostic",
		async (locale, caption, hint, pending, apply, cancel) => {
			i18n.set({ locale, voice: "plain" });
			const original = { ...manifest, name: "Original skin 原文" };
			const preview = { id: "original-id", manifest: original };
			useSkinStore.getState().setPreview(preview);
			renderBar();
			expect(screen.getByText(caption)).toBeTruthy();
			expect(screen.getByText(hint)).toBeTruthy();
			const put = vi.spyOn(api, "put");
			fireEvent.click(screen.getByRole("button", { name: cancel }));
			expect(put).not.toHaveBeenCalled();
			expect(useSkinStore.getState().preview).toBeNull();
			act(() => useSkinStore.getState().setPreview(preview));
			let finish: (value: { ok: true }) => void = () => {
				throw new Error("apply not started");
			};
			put.mockImplementationOnce(
				() =>
					new Promise<{ ok: true }>((resolve) => {
						finish = resolve;
					}),
			);
			H.activeResponse = { active: { light: preview, dark: null } };
			fireEvent.click(screen.getByRole("button", { name: apply }));
			await screen.findByRole("button", { name: pending });
			expect(screen.getByRole("button", { name: cancel })).toHaveProperty("disabled", true);
			expect(put).toHaveBeenCalledExactlyOnceWith("/api/dashboard/skins/active", {
				id: "original-id",
			});
			finish({ ok: true });
			await waitFor(() => expect(useSkinStore.getState().preview).toBeNull());
			expect(useSkinStore.getState().active.light).toEqual(preview);
			expect(useSkinStore.getState().active.dark).toBeNull();
			act(() => useSkinStore.getState().setPreview({ id: "another-id", manifest: original }));
			put.mockRejectedValueOnce(new Error("Original diagnostic 原文"));
			fireEvent.click(screen.getByRole("button", { name: apply }));
			await screen.findByText("Original diagnostic 原文");
			expect(screen.getByText(caption)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: cancel }));
			expect(useSkinStore.getState().preview).toBeNull();
			expect(useSkinStore.getState().active.light?.id).toBe("original-id");
		},
	);

	it("没有 preview → 什么都不渲染", () => {
		const { container } = renderBar();
		expect(container.firstChild).toBeNull();
	});

	it("preview 非空 → 显示皮肤名;点「取消」清 preview", async () => {
		renderBar();
		useSkinStore.getState().setPreview({ id: "p1", manifest });
		await waitFor(() => expect(screen.getByText(/樱花夜/)).toBeTruthy());
		fireEvent.click(screen.getByText("取消"));
		expect(useSkinStore.getState().preview).toBeNull();
		expect(H.putCalls).toEqual([]);
	});

	it("编辑器占用 preview 通道时(editing)→ 浮条让位不渲染", () => {
		const { container } = renderBar();
		useSkinStore.getState().setEditing(true);
		useSkinStore.getState().setPreview({ id: "p1", manifest });
		expect(container.firstChild).toBeNull();
	});

	it("点「应用」→ PUT {id};以服务端双槽回灌 active 并清空 preview", async () => {
		renderBar();
		useSkinStore.getState().setPreview({ id: "p1", manifest });
		H.activeResponse = { active: { light: { id: "p1", manifest }, dark: null } };
		await waitFor(() => expect(screen.getByText("应用")).toBeTruthy());
		fireEvent.click(screen.getByText("应用"));
		await waitFor(() => expect(H.putCalls).toEqual([{ id: "p1" }]));
		await waitFor(() => expect(useSkinStore.getState().active.light?.id).toBe("p1"));
		expect(useSkinStore.getState().active.dark).toBeNull();
		expect(useSkinStore.getState().preview).toBeNull();
	});
});
