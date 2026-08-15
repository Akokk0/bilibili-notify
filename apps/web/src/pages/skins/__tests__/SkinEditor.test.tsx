// @vitest-environment jsdom

/**
 * 皮肤编辑抽屉:挂载即借 preview 通道做整页实时预览(editing 标记压住试穿浮条),
 * 每次改动立即写 preview;保存 = PUT /api/skins/:id/manifest(就地更新),
 * 取消丢弃;有脏改动时取消要过确认框。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSkinStore } from "../../../store/skin";
import { SkinEditor } from "../SkinEditor";

const H = vi.hoisted(() => ({
	putCalls: [] as Array<{ path: string; body: unknown }>,
}));

vi.mock("../../../services/api", () => ({
	api: {
		put: vi.fn(async (path: string, body: unknown) => {
			H.putCalls.push({ path, body });
			return { ok: true, warnings: [] };
		}),
	},
}));

function makeManifest(): SkinManifest {
	return {
		schemaVersion: 1,
		name: "樱花夜",
		modes: {
			light: {
				wallpaper: { image: "assets/bg.png", overlay: 0.2 },
				glass: { blur: 16 },
			},
		},
	};
}

const ASSETS = ["assets/bg.png", "assets/deco.webp"];

function renderEditor(overrides?: { manifest?: SkinManifest; onClose?: () => void }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = overrides?.onClose ?? vi.fn();
	const utils = render(
		<QueryClientProvider client={qc}>
			<SkinEditor
				id="s1"
				manifest={overrides?.manifest ?? makeManifest()}
				assets={ASSETS}
				onClose={onClose}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onClose };
}

beforeEach(() => {
	H.putCalls = [];
	useSkinStore.setState({
		active: null,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(cleanup);

describe("SkinEditor", () => {
	it("挂载:editing=true 且 preview=当前 draft;卸载:两者复位", () => {
		const { unmount } = renderEditor();
		expect(useSkinStore.getState().editing).toBe(true);
		expect(useSkinStore.getState().preview?.id).toBe("s1");
		expect(useSkinStore.getState().preview?.manifest.name).toBe("樱花夜");
		unmount();
		expect(useSkinStore.getState().editing).toBe(false);
		expect(useSkinStore.getState().preview).toBeNull();
	});

	it("拖玻璃模糊滑杆 → preview.manifest 立即反映(实时预览)", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "32" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.glass?.blur).toBe(32),
		);
	});

	it("壁纸下拉列出包内资产;选「(不用壁纸)」→ wallpaper 从 draft 消失", async () => {
		renderEditor();
		const select = screen.getByLabelText("壁纸图片") as HTMLSelectElement;
		const options = [...select.options].map((o) => o.textContent);
		expect(options).toContain("assets/bg.png");
		expect(options).toContain("assets/deco.webp");
		fireEvent.change(select, { target: { value: "" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper).toBeUndefined(),
		);
	});

	it("保存 → PUT 当前 draft;该皮肤正是 active 时同步转正", async () => {
		useSkinStore.getState().setActive({ id: "s1", manifest: makeManifest() });
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "8" } });
		fireEvent.click(screen.getByText("保存"));
		await waitFor(() => expect(H.putCalls).toHaveLength(1));
		expect(H.putCalls[0].path).toBe("/api/skins/s1/manifest");
		const sent = H.putCalls[0].body as SkinManifest;
		expect(sent.modes.light?.glass?.blur).toBe(8);
		await waitFor(() =>
			expect(useSkinStore.getState().active?.manifest.modes.light?.glass?.blur).toBe(8),
		);
		expect(onClose).toHaveBeenCalled();
	});

	it("有脏改动时点取消 → 确认框;确认丢弃 → 不发 PUT 直接关", async () => {
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "40" } });
		fireEvent.click(screen.getByText("取消"));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByText("丢弃"));
		expect(onClose).toHaveBeenCalled();
		expect(H.putCalls).toEqual([]);
	});

	it("没有改动时点取消 → 直接关,不弹确认", () => {
		const { onClose } = renderEditor();
		fireEvent.click(screen.getByText("取消"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("自定义 CSS:共用/本模式两个编辑区,输入即进 preview(实时生效)", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("自定义 CSS"));
		fireEvent.change(screen.getByLabelText("共用 CSS"), {
			target: { value: '[data-bn="glass"]{border-width:2px}' },
		});
		fireEvent.change(screen.getByLabelText("本模式 CSS"), {
			target: { value: '[data-bn="btn"]{opacity:0.9}' },
		});
		await waitFor(() => {
			const m = useSkinStore.getState().preview?.manifest;
			expect(m?.css).toBe('[data-bn="glass"]{border-width:2px}');
			expect(m?.modes.light?.css).toBe('[data-bn="btn"]{opacity:0.9}');
		});
		// 清空 = 字段消失
		fireEvent.change(screen.getByLabelText("共用 CSS"), { target: { value: "" } });
		await waitFor(() => expect(useSkinStore.getState().preview?.manifest.css).toBeUndefined());
	});

	it("单套皮肤:点「补一套深色」→ draft 长出 dark 套(复制自浅色)", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("补一套深色"));
		await waitFor(() => {
			const dark = useSkinStore.getState().preview?.manifest.modes.dark;
			expect(dark?.glass?.blur).toBe(16);
		});
	});
});
