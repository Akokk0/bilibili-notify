// @vitest-environment jsdom

/**
 * 皮肤库 section 的行为:列表(默认装永远在列)、启用、试穿(只写 preview,
 * 注入由 SkinRoot 负责)、恢复默认。上传/组包走 services 层已测的纯函数。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSkinStore } from "../../../store/skin";
import { SkinSection } from "../SkinSection";

const H = vi.hoisted(() => ({
	list: {
		list: [
			{
				id: "s1",
				name: "樱花夜",
				author: "测试",
				modes: ["light", "dark"],
				hasWallpaper: true,
			},
		],
		activeId: null as string | null,
	},
	manifest: {
		schemaVersion: 1,
		name: "樱花夜",
		modes: { light: {}, dark: {} },
	},
	putCalls: [] as unknown[],
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/skins") return H.list;
			if (path === "/api/skins/s1/manifest") return { manifest: H.manifest, assets: [] };
			throw new Error(`unexpected GET ${path}`);
		}),
		put: vi.fn(async (_path: string, body: unknown) => {
			H.putCalls.push(body);
			return { ok: true };
		}),
		delete: vi.fn(async () => ({ ok: true })),
		upload: vi.fn(async () => ({ ok: true, id: "s1", warnings: [] })),
	},
}));

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SkinSection />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	H.putCalls = [];
	H.list.activeId = null;
	useSkinStore.setState({
		active: null,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(cleanup);

describe("SkinSection", () => {
	it("列表:默认装永远在列,皮肤条目带模式/壁纸标签", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("樱花夜")).toBeTruthy());
		expect(screen.getByText("默认装")).toBeTruthy();
		expect(screen.getByText("浅色")).toBeTruthy();
		expect(screen.getByText("深色")).toBeTruthy();
		expect(screen.getByText("壁纸")).toBeTruthy();
	});

	it("未换装时默认装标「使用中」;点皮肤「启用」→ PUT {id} 且 store.active 更新", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("樱花夜")).toBeTruthy());
		expect(screen.getByText("使用中")).toBeTruthy();

		fireEvent.click(screen.getByText("启用"));
		await waitFor(() => expect(H.putCalls).toEqual([{ id: "s1" }]));
		await waitFor(() => expect(useSkinStore.getState().active?.id).toBe("s1"));
	});

	it("点「试穿」→ 只写 preview,不动 active、不发 PUT", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("试穿")).toBeTruthy());
		fireEvent.click(screen.getByText("试穿"));
		await waitFor(() => expect(useSkinStore.getState().preview?.id).toBe("s1"));
		expect(useSkinStore.getState().active).toBeNull();
		expect(H.putCalls).toEqual([]);
	});

	it("点「调整」→ 拉 manifest+assets 打开编辑抽屉;默认装行没有这个入口", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("樱花夜")).toBeTruthy());
		// 只有皮肤行有「调整」;默认装行没有 → 恰好一个
		const editButtons = screen.getAllByText("调整");
		expect(editButtons).toHaveLength(1);
		fireEvent.click(editButtons[0]);
		await waitFor(() => expect(screen.getByText("调整皮肤")).toBeTruthy());
		// 编辑器已接管 preview 通道
		expect(useSkinStore.getState().editing).toBe(true);
		expect(useSkinStore.getState().preview?.id).toBe("s1");
	});

	it("已换装时:默认装行有「启用」(恢复默认)→ PUT {id:null}", async () => {
		H.list.activeId = "s1";
		renderSection();
		await waitFor(() => expect(screen.getByText("樱花夜")).toBeTruthy());
		// 此时「使用中」在皮肤行;默认装行的「启用」是唯一一个
		fireEvent.click(screen.getByText("启用"));
		await waitFor(() => expect(H.putCalls).toEqual([{ id: null }]));
		await waitFor(() => expect(useSkinStore.getState().active).toBeNull());
	});
});
