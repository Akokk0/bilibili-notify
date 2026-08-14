// @vitest-environment jsdom

/**
 * 试穿浮条:preview 非空才出现;「应用」PUT 落盘并把 preview 转正为 active;
 * 「取消」清 preview 回真实状态。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSkinStore } from "../../store/skin";
import { SkinPreviewBar } from "../skin-preview-bar";

const H = vi.hoisted(() => ({ putCalls: [] as unknown[] }));

vi.mock("../../services/api", () => ({
	api: {
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
	H.putCalls = [];
	useSkinStore.setState({ active: null, preview: null, killSwitch: false, lockedTheme: null });
});

afterEach(cleanup);

describe("SkinPreviewBar", () => {
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

	it("点「应用」→ PUT {id};preview 转正成 active 并清空", async () => {
		renderBar();
		useSkinStore.getState().setPreview({ id: "p1", manifest });
		await waitFor(() => expect(screen.getByText("应用")).toBeTruthy());
		fireEvent.click(screen.getByText("应用"));
		await waitFor(() => expect(H.putCalls).toEqual([{ id: "p1" }]));
		await waitFor(() => expect(useSkinStore.getState().active?.id).toBe("p1"));
		expect(useSkinStore.getState().preview).toBeNull();
	});
});
