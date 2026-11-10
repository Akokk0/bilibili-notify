// @vitest-environment jsdom

/**
 * 皮肤库 section 的行为:深浅两个换装 Picker(forms.tsx 的分段按钮组;
 * 各列具备该模式的皮肤+默认装,选中即 PUT 单槽)、试穿(只写 preview,注入由
 * SkinRoot 负责)、导出、直传 zip。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { api } from "../../../services/api";
import { EMPTY_SLOTS, useSkinStore } from "../../../store/skin";
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
		active: { light: null, dark: null } as { light: string | null; dark: string | null },
	},
	manifest: {
		schemaVersion: 1,
		name: "樱花夜",
		modes: { light: {}, dark: {} },
	},
	putCalls: [] as unknown[],
	/** 上传接口这一次要回的提示(清洗层摘了什么)。 */
	uploadWarnings: [] as string[],
	listGate: null as Promise<void> | null,
	manifestFails: false,
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/dashboard/skins") {
				if (H.listGate) await H.listGate;
				return H.list;
			}
			if (path === "/api/dashboard/skins/active") {
				const slot = (id: string | null) => (id ? { id, manifest: H.manifest } : null);
				return { active: { light: slot(H.list.active.light), dark: slot(H.list.active.dark) } };
			}
			if (path === "/api/dashboard/skins/s1/manifest") {
				if (H.manifestFails) throw new Error("Original diagnostic 原因");
				return { manifest: H.manifest, assets: [] };
			}
			throw new Error(`unexpected GET ${path}`);
		}),
		put: vi.fn(async (_path: string, body: unknown) => {
			H.putCalls.push(body);
			// 模拟服务端落槽:整套启用按 modes 占槽;带 theme 的单槽设置;null 清两槽
			const req = body as { id: string | null; theme?: "light" | "dark" };
			if (req.theme) H.list.active[req.theme] = req.id;
			else if (req.id === null) H.list.active = { light: null, dark: null };
			else H.list.active = { light: req.id, dark: req.id };
			return { ok: true };
		}),
		delete: vi.fn(async () => ({ ok: true })),
		upload: vi.fn(async (path: string) =>
			path.endsWith("/import-preview")
				? { ok: true, name: "樱花夜", warnings: H.uploadWarnings, conflict: true }
				: { ok: true, id: "s1", warnings: H.uploadWarnings },
		),
	},
}));

function Location() {
	const location = useLocation();
	return (
		<output aria-label="当前位置">
			{location.pathname}
			{location.search}
		</output>
	);
}

function renderSection(mode: "manage" | "select" = "manage") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<Location />
				<SkinSection mode={mode} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	H.putCalls = [];
	H.uploadWarnings = [];
	H.listGate = null;
	H.manifestFails = false;
	H.list.active = { light: null, dark: null };
	H.list.list[0].modes = ["light", "dark"];
	useSkinStore.setState({
		active: EMPTY_SLOTS,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(cleanup);

describe("SkinSection", () => {
	it("loading and preview failures translate while raw diagnostics and inactive slots remain intact", async () => {
		let release = () => {};
		H.listGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		H.manifestFails = true;
		renderSection();
		for (const [locale, reading] of [
			["en", "Loading skin library"],
			["ja", "スキンライブラリーを読み込み中"],
			["zh-TW", "正在讀取外觀資源庫"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(`${reading}…`)).toBeTruthy();
		}
		await act(async () => {
			release();
		});
		await screen.findByText("樱花夜");
		fireEvent.click(screen.getByRole("button", { name: "試用" }));
		await screen.findByText(/Original diagnostic 原因/);
		for (const [locale, failure] of [
			["en", "Operation failed:"],
			["ja", "操作に失敗しました："],
			["zh-TW", "操作失敗："],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(`${failure}Original diagnostic 原因`)).toBeTruthy();
		}
		expect(useSkinStore.getState().preview).toBeNull();
		expect(useSkinStore.getState().active).toEqual(EMPTY_SLOTS);
		expect(H.putCalls).toEqual([]);
	});

	it("translated deletion dialogs preserve original names and distinguish one variant from the whole package", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					remove: "Delete",
					title: "Delete skin",
					dual: "“樱花夜” has Light and Dark variants. Which part should be deleted? This cannot be undone.",
					single: "Delete “樱花夜”? This cannot be undone.",
					light: "Delete Light only (keep Dark)",
					dark: "Delete Dark only (keep Light)",
					all: "Delete whole package",
					cancel: "Cancel",
				},
			],
			[
				"ja",
				{
					remove: "削除",
					title: "スキンを削除",
					dual: "「樱花夜」にはライト版とダーク版があります。どちらを削除しますか？この操作は取り消せません。",
					single: "「樱花夜」を削除しますか？この操作は取り消せません。",
					light: "ライトのみ削除（ダークは残す）",
					dark: "ダークのみ削除（ライトは残す）",
					all: "パッケージ全体を削除",
					cancel: "キャンセル",
				},
			],
			[
				"zh-TW",
				{
					remove: "刪除",
					title: "刪除外觀",
					dual: "「樱花夜」有淺色和深色兩個版本。要刪除哪個部分？刪除後無法復原。",
					single: "確定刪除「樱花夜」？刪除後無法復原。",
					light: "只刪除淺色（保留深色）",
					dark: "只刪除深色（保留淺色）",
					all: "刪除整個套件",
					cancel: "取消",
				},
			],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			H.list.list[0].modes = ["light", "dark"];
			vi.mocked(api.delete).mockClear();
			const dual = renderSection();
			await screen.findByText("樱花夜");
			fireEvent.click(screen.getByRole("button", { name: w.remove }));
			const dialog = await screen.findByRole("dialog");
			expect(within(dialog).getByText(w.title)).toBeTruthy();
			expect(within(dialog).getByText(w.dual)).toBeTruthy();
			expect(within(dialog).getByRole("button", { name: w.light })).toBeTruthy();
			expect(within(dialog).getByRole("button", { name: w.dark })).toBeTruthy();
			expect(within(dialog).getByRole("button", { name: w.all })).toBeTruthy();
			fireEvent.click(within(dialog).getByRole("button", { name: w.cancel }));
			expect(api.delete).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: w.remove }));
			fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: w.light }));
			await waitFor(() =>
				expect(api.delete).toHaveBeenCalledWith("/api/dashboard/skins/s1/modes/light"),
			);
			dual.unmount();
			H.list.list[0].modes = ["dark"];
			vi.mocked(api.delete).mockClear();
			const single = renderSection();
			await screen.findByText("樱花夜");
			fireEvent.click(screen.getByRole("button", { name: w.remove }));
			const confirm = await screen.findByRole("dialog");
			expect(within(confirm).getByText(w.single)).toBeTruthy();
			fireEvent.click(within(confirm).getByRole("button", { name: w.remove }));
			await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/dashboard/skins/s1"));
			single.unmount();
		}
	});

	it("translated appearance pickers retain separate slots and send only the explicitly selected slot", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					native: "Default appearance",
					light: "Light mode skins",
					dark: "Dark mode skins",
					lightLabel: "Light mode",
					darkLabel: "Dark mode",
					default: "Default",
					used: "In use",
				},
			],
			[
				"ja",
				{
					native: "既定の外観",
					light: "ライトモードのスキン",
					dark: "ダークモードのスキン",
					lightLabel: "ライトモード",
					darkLabel: "ダークモード",
					default: "既定",
					used: "使用中",
				},
			],
			[
				"zh-TW",
				{
					native: "預設外觀",
					light: "淺色模式外觀",
					dark: "深色模式外觀",
					lightLabel: "淺色模式",
					darkLabel: "深色模式",
					default: "預設外觀",
					used: "使用中",
				},
			],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			H.putCalls = [];
			H.list.active = { light: null, dark: null };
			const empty = renderSection();
			await screen.findByText(w.native);
			empty.unmount();
			H.list.active = { light: "s1", dark: "s1" };
			const managed = renderSection();
			await screen.findByText(w.used);
			managed.unmount();
			const selection = renderSection("select");
			await screen.findAllByText("樱花夜");
			const light = within(screen.getByRole("group", { name: w.light }));
			const dark = within(screen.getByRole("group", { name: w.dark }));
			expect(light.getByText(w.lightLabel)).toBeTruthy();
			expect(dark.getByText(w.darkLabel)).toBeTruthy();
			expect(light.getByRole("button", { name: "樱花夜" }).getAttribute("aria-pressed")).toBe(
				"true",
			);
			expect(dark.getByRole("button", { name: "樱花夜" }).getAttribute("aria-pressed")).toBe(
				"true",
			);
			expect(H.putCalls).toEqual([]);
			fireEvent.click(light.getByRole("button", { name: w.default }));
			await waitFor(() => expect(H.putCalls).toEqual([{ theme: "light", id: null }]));
			await waitFor(() =>
				expect(light.getByRole("button", { name: w.default }).getAttribute("aria-pressed")).toBe(
					"true",
				),
			);
			expect(dark.getByRole("button", { name: "樱花夜" }).getAttribute("aria-pressed")).toBe(
				"true",
			);
			selection.unmount();
		}
	});

	it("localized management actions preserve skin names and preview without activating a skin", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					title: "Dashboard skins · skins",
					subtitle:
						"Upload a skin package, or create one in the skin workshop in the maid chat sidebar.",
					applied: "Skin applied",
					usage: "Light · In use",
					wallpaper: "Wallpaper",
					upload: "Upload skin package",
					preview: "Try on",
					edit: "Edit",
					export: "Export",
					remove: "Delete",
					author: "Author: 测试",
					recovery: /If a skin makes the interface unreadable/,
					restore: /forces the default appearance for this session/,
				},
			],
			[
				"ja",
				{
					title: "画面スキン · skins",
					subtitle:
						"スキンパッケージをアップロードするか、メイドチャットのサイドバーでスキン工房を作成します。",
					applied: "スキン適用中",
					usage: "ライト · 使用中",
					wallpaper: "壁紙",
					upload: "スキンをアップロード",
					preview: "試着",
					edit: "編集",
					export: "エクスポート",
					remove: "削除",
					author: "作者：测试",
					recovery: /スキンで画面が読みにくくなった場合/,
					restore: /このセッションでは既定の外観を強制/,
				},
			],
			[
				"zh-TW",
				{
					title: "介面外觀 · skins",
					subtitle: "上傳外觀套件，或到女僕聊天側欄建立外觀工坊來製作。",
					applied: "已套用外觀",
					usage: "淺色 · 使用中",
					wallpaper: "桌布",
					upload: "上傳外觀套件",
					preview: "試用",
					edit: "調整",
					export: "匯出",
					remove: "刪除",
					author: "作者：测试",
					recovery: /若外觀讓介面難以辨識/,
					restore: /本次工作階段會強制使用預設外觀/,
				},
			],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			H.list.active = { light: "s1", dark: null };
			const { unmount } = renderSection();
			await screen.findByText("樱花夜");
			expect(screen.getByText(w.title)).toBeTruthy();
			expect(screen.getByText(w.subtitle)).toBeTruthy();
			expect(screen.getByText(w.applied)).toBeTruthy();
			expect(screen.getByText(w.usage)).toBeTruthy();
			expect(screen.getByText(w.wallpaper)).toBeTruthy();
			expect(screen.getByLabelText(w.upload)).toBeTruthy();
			expect(screen.getByRole("button", { name: w.edit })).toBeTruthy();
			expect(screen.getByRole("button", { name: w.export })).toBeTruthy();
			expect(screen.getByRole("button", { name: w.remove })).toBeTruthy();
			expect(screen.getByText(w.author)).toBeTruthy();
			expect(screen.getByText(w.recovery)).toBeTruthy();
			expect(screen.getByText(w.restore)).toBeTruthy();
			expect(screen.getByText("?skin=off")).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: w.preview }));
			await waitFor(() => expect(useSkinStore.getState().preview?.id).toBe("s1"));
			expect(useSkinStore.getState().preview?.manifest.name).toBe("樱花夜");
			expect(H.putCalls).toEqual([]);
			unmount();
			useSkinStore.getState().setPreview(null);
		}
	});

	function pickerGroup(name: string): HTMLElement {
		return screen.getByRole("group", { name });
	}

	it("系统页只选用；管理在当前页跳转，不改当前深浅色槽位", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		try {
			renderSection("select");
			await screen.findAllByText("樱花夜");
			fireEvent.click(screen.getByRole("button", { name: "管理资源" }));
			expect(screen.getByLabelText("当前位置").textContent).toBe(
				"/library?category=dashboard-skins",
			);
			expect(open).not.toHaveBeenCalled();
			expect(H.putCalls).toEqual([]);
			expect(screen.queryByRole("button", { name: "调整" })).toBeNull();
			expect(screen.queryByRole("button", { name: "上传皮肤包" })).toBeNull();
			expect(pickerGroup("浅色模式皮肤")).toBeTruthy();
		} finally {
			open.mockRestore();
		}
	});

	it("做皮肤只指路到聊天里的皮肤工坊 —— 复制提示词给外部 AI 那条路已经没了", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		expect(screen.getByText(/新建皮肤工坊/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "制作皮肤" })).toBeNull();
		expect(screen.queryByText(/任意 AI/)).toBeNull();
	});

	it("导入 zip 只入库并展示清洗提示，不自动试穿或启用", async () => {
		// 「哪几句被摘了」正是这条路上最该让人看见的东西。
		H.uploadWarnings = ["属性 pointer-events 不在白名单"];
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));

		const zip = new File([new Uint8Array([0x50, 0x4b])], "sakura.zip", {
			type: "application/zip",
		});
		fireEvent.change(screen.getByLabelText("上传皮肤包"), {
			target: { files: [zip] },
		});

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/pointer-events/)).toBeTruthy();
		expect(vi.mocked(api.upload).mock.calls.at(-1)?.[0]).toBe(
			"/api/dashboard/skins/import-preview",
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText(/pointer-events/)).toBeTruthy();
		expect(useSkinStore.getState().preview).toBeNull();
		expect(H.putCalls).toEqual([]);
	});

	it("管理列表保留模式/壁纸标签与导出，选用操作留在系统页", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		expect(screen.queryByRole("group", { name: "浅色模式皮肤" })).toBeNull();
		expect(screen.queryByRole("group", { name: "深色模式皮肤" })).toBeNull();
		expect(screen.getByText("浅色")).toBeTruthy();
		expect(screen.getByText("深色")).toBeTruthy();
		expect(screen.getByText("壁纸")).toBeTruthy();
		expect(screen.getAllByText("导出")).toHaveLength(1);
	});

	it("Picker 只列具备该模式的皮肤 + 默认装", async () => {
		H.list.list[0].modes = ["light"];
		renderSection("select");
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		const light = within(pickerGroup("浅色模式皮肤")).getAllByRole("button");
		expect(light.map((el) => el.textContent)).toEqual(["默认装", "樱花夜"]);
		const dark = within(pickerGroup("深色模式皮肤")).getAllByRole("button");
		expect(dark.map((el) => el.textContent)).toEqual(["默认装"]);
		// 未换装:两组的「默认装」都是选中态
		expect(light[0].getAttribute("aria-pressed")).toBe("true");
		expect(dark[0].getAttribute("aria-pressed")).toBe("true");
	});

	it("浅色 Picker 点皮肤 → PUT {theme:'light', id} 且选中态切换", async () => {
		renderSection("select");
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		fireEvent.click(within(pickerGroup("浅色模式皮肤")).getByText("樱花夜"));
		await waitFor(() => expect(H.putCalls).toEqual([{ theme: "light", id: "s1" }]));
		await waitFor(() => expect(useSkinStore.getState().active.light?.id).toBe("s1"));
		expect(useSkinStore.getState().active.dark).toBeNull();
		await waitFor(() =>
			expect(
				within(pickerGroup("浅色模式皮肤")).getByText("樱花夜").getAttribute("aria-pressed"),
			).toBe("true"),
		);
	});

	it("Picker 点「默认装」→ PUT {theme, id:null} 卸下该槽;点已选中的不重复发", async () => {
		H.list.list[0].modes = ["light"];
		H.list.active = { light: "s1", dark: null };
		renderSection("select");
		await waitFor(() =>
			expect(within(pickerGroup("浅色模式皮肤")).getByText("樱花夜")).toBeTruthy(),
		);

		// 点已选中的皮肤:不发请求
		fireEvent.click(within(pickerGroup("浅色模式皮肤")).getByText("樱花夜"));
		expect(H.putCalls).toEqual([]);

		fireEvent.click(within(pickerGroup("浅色模式皮肤")).getByText("默认装"));
		await waitFor(() => expect(H.putCalls).toEqual([{ theme: "light", id: null }]));
		await waitFor(() => expect(useSkinStore.getState().active.light).toBeNull());
	});

	it("点「试穿」→ 只写 preview,不动 active、不发 PUT", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("试穿")).toBeTruthy());
		fireEvent.click(screen.getByText("试穿"));
		await waitFor(() => expect(useSkinStore.getState().preview?.id).toBe("s1"));
		expect(useSkinStore.getState().active).toEqual(EMPTY_SLOTS);
		expect(H.putCalls).toEqual([]);
	});

	it("点「调整」→ 拉 manifest+assets 打开编辑抽屉;默认装行没有这个入口", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		// 只有皮肤行有「调整」;默认装行没有 → 恰好一个
		const editButtons = screen.getAllByText("调整");
		expect(editButtons).toHaveLength(1);
		fireEvent.click(editButtons[0]);
		await waitFor(() => expect(screen.getByText("调整皮肤")).toBeTruthy());
		// 编辑器已接管 preview 通道。**必须等**:editing 与 preview 都是编辑器挂载后
		// 的 effect 写的,抽屉标题在渲染提交时就有了,effect 还差一拍 —— 同步断言在
		// 慢跑器上会踩进这道缝(v0.7.0 发版 gate 四跑一红,红的就是这里)。
		await waitFor(() => {
			expect(useSkinStore.getState().editing).toBe(true);
			expect(useSkinStore.getState().preview?.id).toBe("s1");
		});
	});

	it("双模皮肤占两槽时，两个选用控件都显示选中", async () => {
		H.list.active = { light: "s1", dark: "s1" };
		renderSection("select");
		await waitFor(() => expect(screen.getAllByText("樱花夜")).toHaveLength(2));
		expect(
			within(pickerGroup("浅色模式皮肤")).getByText("樱花夜").getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			within(pickerGroup("深色模式皮肤")).getByText("樱花夜").getAttribute("aria-pressed"),
		).toBe("true");
	});
});

describe("删除 —— 双色皮肤可以只删一色", () => {
	const del = () => vi.mocked(api.delete);

	async function openDeleteDialog() {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		del().mockClear();
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
	}

	it("双色皮肤 → 弹窗给三选一,而不是一句「确定删除吗」", async () => {
		// 从前只有「删整套」:想扔掉其中一色,得整套删了重做。
		await openDeleteDialog();
		expect(await screen.findByRole("button", { name: /只删浅色/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /只删深色/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /删除整套/ })).toBeTruthy();
	});

	it("只删浅色 → 打到那一色的端点上,不是整套那条", async () => {
		await openDeleteDialog();
		fireEvent.click(await screen.findByRole("button", { name: /只删浅色/ }));
		await waitFor(() => expect(del()).toHaveBeenCalled());
		expect(del().mock.calls[0]?.[0]).toBe("/api/dashboard/skins/s1/modes/light");
	});

	it("只删深色 → 同上,主人挑哪色就发哪色", async () => {
		await openDeleteDialog();
		fireEvent.click(await screen.findByRole("button", { name: /只删深色/ }));
		await waitFor(() => expect(del()).toHaveBeenCalled());
		expect(del().mock.calls[0]?.[0]).toBe("/api/dashboard/skins/s1/modes/dark");
	});

	it("删除整套 → 还是老那条路", async () => {
		await openDeleteDialog();
		fireEvent.click(await screen.findByRole("button", { name: /删除整套/ }));
		await waitFor(() => expect(del()).toHaveBeenCalled());
		expect(del().mock.calls[0]?.[0]).toBe("/api/dashboard/skins/s1");
	});

	it("单色皮肤 → 照旧是一句「确定删除吗」,不摆一排选不动的按钮", async () => {
		// 只有一色时「只删这一色」等于「删整套」,摆出来只会让人犹豫该点哪个。
		H.list.list[0].modes = ["dark"];
		await openDeleteDialog();
		expect(await screen.findByText(/确定删除/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /只删/ })).toBeNull();
	});
});

it.each([
	[
		"ja",
		"ご主人様、スキンパッケージをアップロードしてダッシュボードを着替えましょう。メイドとのチャットのサイドバーで「新しいスキン工房」を開いて、作ってもらうこともできますよ。",
		"ご主人様、スキンで画面が読みにくくなったら、アドレスに ",
		"ご主人様、「樱花夜」にはライトとダークの2種類があります。どの部分を削除しますか？削除すると元に戻せませんよ。",
		"ご主人様、「樱花夜」を削除しますか？削除すると元に戻せませんよ。",
		"削除",
		"キャンセル",
	],
	[
		"zh-TW",
		"主人，上傳外觀套件就能替面板換裝喔，也可以到女僕聊天側欄開啟「新增外觀工坊」，請她製作一套。",
		"主人，如果外觀讓畫面難以辨識，請在網址列加上 ",
		"主人，「樱花夜」有淺色和深色兩個版本，要刪除哪個部分呢？刪除後就無法還原了喔。",
		"主人，確定刪除「樱花夜」嗎？刪除後就無法還原了喔。",
		"刪除",
		"取消",
	],
] as const)(
	"%s 女仆资源说明与双色/整包删除警告保留原名，取消不删除",
	async (locale, intro, recovery, dualWarning, singleWarning, remove, cancel) => {
		const dual = renderSection();
		await screen.findByText("樱花夜");
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(intro)).toBeTruthy();
		expect(dual.container.textContent).toContain(recovery);
		expect(screen.getByText("?skin=off").tagName).toBe("CODE");
		fireEvent.click(screen.getByRole("button", { name: remove }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(dualWarning)).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: cancel }));
		expect(api.delete).not.toHaveBeenCalled();
		dual.unmount();
		H.list.list[0].modes = ["dark"];
		const single = renderSection();
		await screen.findByText("樱花夜");
		fireEvent.click(screen.getByRole("button", { name: remove }));
		const confirm = await screen.findByRole("dialog");
		expect(within(confirm).getByText(singleWarning)).toBeTruthy();
		fireEvent.click(within(confirm).getByRole("button", { name: cancel }));
		expect(api.delete).not.toHaveBeenCalled();
		expect(H.putCalls).toEqual([]);
		expect(H.list.list[0].name).toBe("樱花夜");
		single.unmount();
	},
);
