// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../../__tests__/select-controls";

/**
 * 皮肤编辑抽屉:挂载即借 preview 通道做整页实时预览(editing 标记压住试穿浮条),
 * 每次改动立即写 preview;保存 = PUT /api/dashboard/skins/:id/manifest(就地更新),
 * 取消丢弃;有脏改动时取消要过确认框。
 */

import {
	SKIN_CSS_HOOK_MAP,
	SKIN_CSS_HOOK_NOTES,
	type SkinManifest,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { EMPTY_SLOTS, useSkinStore } from "../../../store/skin";
import { useThemeStore } from "../../../store/theme";
import { SkinEditor } from "../SkinEditor";

const H = vi.hoisted(() => ({
	putCalls: [] as Array<{ path: string; body: unknown }>,
	postCalls: [] as Array<{ path: string; body: unknown }>,
	uploadCalls: [] as Array<{ path: string; name: string }>,
	getCalls: [] as string[],
	/** 出厂快照;null = 没钉过(GET /default 404)。 */
	defaultManifest: null as unknown,
	/** 下一次传图要不要失败。 */
	uploadFails: false,
	/** 挂住上传用的闸:不为 null 时 upload 要等它开了才返回(仿真实网络的那几秒)。 */
	uploadGate: null as Promise<void> | null,
	putGate: null as Promise<void> | null,
	postGate: null as Promise<void> | null,
	postFails: false,
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			H.getCalls.push(path);
			if (path === "/api/dashboard/skins/s1/default") {
				if (H.defaultManifest === null) throw new Error("该皮肤还没有钉过默认值");
				return { manifest: H.defaultManifest };
			}
			throw new Error(`unexpected GET ${path}`);
		}),
		put: vi.fn(async (path: string, body: unknown) => {
			H.putCalls.push({ path, body });
			if (H.putGate) await H.putGate;
			return { ok: true, warnings: [] };
		}),
		post: vi.fn(async (path: string, body: unknown) => {
			H.postCalls.push({ path, body });
			if (H.postGate) await H.postGate;
			if (H.postFails) throw new Error("Original diagnostic 原因");
			return {
				ok: true,
				manifest: { schemaVersion: 1, name: "AI 皮肤", modes: { light: {} } },
				warnings: ["texts.foo: 不认识的文案槽位,已忽略"],
			};
		}),
		upload: vi.fn(async (path: string, form: FormData) => {
			H.uploadCalls.push({ path, name: (form.get("file") as File | null)?.name ?? "" });
			if (H.uploadGate) await H.uploadGate;
			if (H.uploadFails) throw new Error("图片过大(上限 5MB)");
			// 落盘名由服务端按类型生成(img- / font- 前缀),这里照着仿。
			const name = (form.get("file") as File | null)?.name ?? "";
			return name.endsWith(".woff2")
				? { ok: true, name: "assets/font-99887766.woff2" }
				: { ok: true, name: "assets/img-abcd1234.png" };
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

const ASSETS = ["assets/bg.png", "assets/deco.webp", "assets/font-a1b2c3d4.woff2"];
/** 只覆盖一部分 —— 没登记的那两个必须回落成生成名,不能空着。 */
const ASSET_NAMES = { "assets/font-a1b2c3d4.woff2": "霞鹜文楷 Light.woff2" };

/** 「字体」是折叠段,收起时子节点根本不进 DOM —— 查控件之前先摊开。 */
function openFontFold(): void {
	fireEvent.click(screen.getByText("字体").closest("button") as HTMLButtonElement);
}

function renderEditor(overrides?: {
	manifest?: SkinManifest;
	assetNames?: Record<string, string>;
	onClose?: () => void;
}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = overrides?.onClose ?? vi.fn();
	const utils = render(
		<QueryClientProvider client={qc}>
			<SkinEditor
				id="s1"
				manifest={overrides?.manifest ?? makeManifest()}
				assets={ASSETS}
				assetNames={overrides?.assetNames ?? ASSET_NAMES}
				onClose={onClose}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onClose };
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	H.putCalls = [];
	H.postCalls = [];
	H.uploadCalls = [];
	H.getCalls = [];
	H.uploadFails = false;
	H.uploadGate = null;
	H.putGate = null;
	H.postGate = null;
	H.postFails = false;
	H.defaultManifest = { schemaVersion: 1, name: "出厂樱花", modes: { light: {} } };
	// 编辑器默认编当前主题那一套 —— 主题是这一层的入参,每条用例都从浅色起跑。
	useThemeStore.setState({ preference: "light", systemPrefersDark: false, resolved: "light" });
	useSkinStore.setState({
		active: EMPTY_SLOTS,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(cleanup);

describe("SkinEditor", () => {
	it("semantic color labels translate while edited accent and success colors stay in their original fields", () => {
		renderEditor();
		fireEvent.click(screen.getByText("语义颜色"));
		fireEvent.change(screen.getByLabelText("主强调色"), { target: { value: "#112233" } });
		fireEvent.change(screen.getByLabelText("成功·底"), { target: { value: "rgba(1, 2, 3, 0.4)" } });
		for (const [locale, w] of [
			[
				"en",
				{
					groups: ["Accent colors", "Text", "Surfaces and borders", "Status colors"],
					labels: [
						"Primary accent",
						"Secondary accent",
						"Highlight",
						"Primary text",
						"Secondary text",
						"Tertiary text",
						"Disabled text",
						"Muted text",
						"Surface",
						"Strong surface",
						"Muted surface",
						"Input background",
						"Border",
						"Subtle border",
						"Hover background",
						"Row background",
						"Row border",
						"Code background",
						"Overlay",
						"Text on solid backgrounds",
						"Danger",
						"Danger background",
						"Danger text",
						"Danger border",
						"Success",
						"Success background",
						"Success text",
						"Success border",
						"Warning",
						"Warning background",
						"Warning text",
						"Warning border",
					],
					accent: "Primary accent",
					success: "Success background",
				},
			],
			[
				"ja",
				{
					groups: ["アクセント色", "文字", "サーフェスと枠線", "状態色"],
					labels: [
						"メインアクセント",
						"サブアクセント",
						"ハイライト",
						"本文の文字",
						"補足の文字",
						"補助の文字",
						"無効時の文字",
						"控えめな文字",
						"サーフェス",
						"強いサーフェス",
						"控えめなサーフェス",
						"入力欄の背景",
						"枠線",
						"薄い枠線",
						"ホバー背景",
						"行の背景",
						"行の枠線",
						"コード背景",
						"オーバーレイ",
						"塗りつぶし上の文字",
						"危険",
						"危険の背景",
						"危険の文字",
						"危険の枠線",
						"成功",
						"成功の背景",
						"成功の文字",
						"成功の枠線",
						"警告",
						"警告の背景",
						"警告の文字",
						"警告の枠線",
					],
					accent: "メインアクセント",
					success: "成功の背景",
				},
			],
			[
				"zh-TW",
				{
					groups: ["強調色", "文字", "表面與框線", "狀態色"],
					labels: [
						"主要強調色",
						"次要強調色",
						"醒目點綴",
						"主要文字",
						"次要文字",
						"輔助文字",
						"停用文字",
						"淡化文字",
						"表面",
						"強調表面",
						"淡化表面",
						"輸入框底色",
						"框線",
						"淡色框線",
						"懸停底色",
						"列底色",
						"列框線",
						"程式碼底色",
						"遮罩",
						"實色底上的文字",
						"危險",
						"危險底色",
						"危險文字",
						"危險框線",
						"成功",
						"成功底色",
						"成功文字",
						"成功框線",
						"警告",
						"警告底色",
						"警告文字",
						"警告框線",
					],
					accent: "主要強調色",
					success: "成功底色",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			for (const group of w.groups) expect(screen.getByText(group, { exact: true })).toBeTruthy();
			for (const label of w.labels) expect(screen.getByLabelText(label)).toBeTruthy();
			expect((screen.getByLabelText(w.accent) as HTMLInputElement).value).toBe("#112233");
			expect((screen.getByLabelText(w.success) as HTMLInputElement).value).toBe(
				"rgba(1, 2, 3, 0.4)",
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.colors).toEqual({
				accent: "#112233",
				successSoft: "rgba(1, 2, 3, 0.4)",
			});
		}
		expect(H.putCalls).toEqual([]);
	});

	it("CSS guidance translates without rewriting hook identifiers or either CSS draft", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("自定义 CSS"));
		const shared = '[data-bn="glass"] { border-color: #112233; }';
		const mode = '[data-bn="btn"]:hover { box-shadow: 0 0 2px #445566; }';
		fireEvent.change(screen.getByLabelText("共用 CSS"), { target: { value: shared } });
		fireEvent.change(screen.getByLabelText("本模式 CSS"), { target: { value: mode } });
		for (const [locale, w] of [
			[
				"en",
				{
					title: "Custom CSS",
					prefix: "Selectors must use",
					rules: /properties are limited to visual styling/,
					hooks: "Available hooks",
					shared: "Shared CSS",
					mode: "Current variant CSS",
					placeholder: "Applies only to the current light/dark variant, after shared CSS.",
					example: "e.g. ",
				},
			],
			[
				"ja",
				{
					title: "カスタムCSS",
					prefix: "セレクターは",
					rules: /保存時に許可されない指定を除外/,
					hooks: "利用可能なフック",
					shared: "共通CSS",
					mode: "現在のバリエーションのCSS",
					placeholder: "現在のライト／ダーク版にのみ、共通CSSの後に適用します。",
					example: "例：",
				},
			],
			[
				"zh-TW",
				{
					title: "自訂 CSS",
					prefix: "選擇器僅限",
					rules: /儲存時會逐項移除不允許的設定/,
					hooks: "可用掛點",
					shared: "共用 CSS",
					mode: "目前版本 CSS",
					placeholder: "僅套用至目前的淺色或深色版本，接續共用 CSS 生效。",
					example: "例如 ",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(w.title)).toBeTruthy();
			expect(screen.getByText(w.rules).textContent).toContain(w.prefix);
			expect(screen.getByText('[data-bn="glass"]', { exact: true })).toBeTruthy();
			const hooks = screen.getByRole("list", { name: w.hooks });
			expect(within(hooks).getByText("glass", { exact: true })).toBeTruthy();
			expect(within(hooks).getByText("btn", { exact: true })).toBeTruthy();
			expect((screen.getByLabelText(w.shared) as HTMLTextAreaElement).value).toBe(shared);
			expect((screen.getByLabelText(w.mode) as HTMLTextAreaElement).value).toBe(mode);
			expect(
				screen.getByPlaceholderText(
					`${w.example}[data-bn="glass"]:hover { box-shadow: 0 0 24px rgba(251,114,153,0.4); }`,
				),
			).toBeTruthy();
			expect(screen.getByPlaceholderText(w.placeholder)).toBeTruthy();
		}
		expect(useSkinStore.getState().preview?.manifest.css).toBe(shared);
		expect(useSkinStore.getState().preview?.manifest.modes.light?.css).toBe(mode);
		expect(H.putCalls).toEqual([]);
	});

	it("localized mode synchronization explains overwrites and keeps layout-only changes in preview", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					sync: "Sync to Dark",
					title: "Apply Light to Dark",
					warning:
						"The existing Dark settings will be overwritten. Changes are only previewed until saved; Cancel restores the original appearance.",
					layout: "Copy layout only (keep colors)",
					detail:
						"Copy wallpaper, corners, fonts and glass blur. Keep colors, glass backgrounds and shadows.",
					full: "Copy everything",
					explanation: "Include colors so both variants match: Dark will look like Light.",
					cancel: "Cancel",
					feedback: "Changes applied to Dark in preview. Save to keep them.",
				},
			],
			[
				"ja",
				{
					sync: "同期先：ダーク",
					title: "ライトをダークに適用",
					warning:
						"ダークの既存設定を上書きします。保存するまではプレビューのみです。キャンセルすると元の外観に戻ります。",
					layout: "レイアウトのみコピー（色は維持）",
					detail:
						"壁紙、角丸、フォント、ガラスのぼかしをコピーします。配色、ガラス背景、影は変更しません。",
					full: "すべてコピー",
					explanation: "色も含めて揃え、ダークをライトと同じ外観にします。",
					cancel: "キャンセル",
					feedback: "ダークに適用してプレビュー中です。保存すると反映されます。",
				},
			],
			[
				"zh-TW",
				{
					sync: "同步至深色",
					title: "將淺色套用至深色",
					warning: "深色原有的設定將被覆寫。儲存前僅供預覽，按「取消」即可恢復原本的外觀。",
					layout: "只複製版面（保留配色）",
					detail: "複製桌布、圓角、字型與玻璃模糊；配色、玻璃底色與陰影保持不變。",
					full: "複製全部設定",
					explanation: "連同配色一併複製，讓深色與淺色呈現相同外觀。",
					cancel: "取消",
					feedback: "已將目前調整套用至深色預覽，儲存後才會保留。",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const manifest = makeManifest();
			manifest.modes.light = { ...manifest.modes.light, colors: { accent: "#112233" } };
			manifest.modes.dark = { colors: { accent: "#445566" } };
			const { unmount } = renderEditor({ manifest });
			fireEvent.click(screen.getByRole("button", { name: w.sync }));
			const dialog = screen.getByRole("dialog", { name: "" });
			expect(within(dialog).getByText(w.title)).toBeTruthy();
			expect(within(dialog).getByText(w.warning)).toBeTruthy();
			expect(within(dialog).getByText(w.detail)).toBeTruthy();
			expect(within(dialog).getByText(w.explanation)).toBeTruthy();
			expect(within(dialog).getByRole("button", { name: w.full })).toBeTruthy();
			fireEvent.click(within(dialog).getByRole("button", { name: w.cancel }));
			expect(useSkinStore.getState().preview?.manifest.modes.dark).toEqual({
				colors: { accent: "#445566" },
			});
			fireEvent.click(screen.getByRole("button", { name: w.sync }));
			fireEvent.click(
				within(screen.getByRole("dialog", { name: "" })).getByRole("button", { name: w.layout }),
			);
			await screen.findByText(w.feedback);
			expect(useSkinStore.getState().preview?.manifest.modes.dark?.wallpaper?.image).toBe(
				"assets/bg.png",
			);
			expect(useSkinStore.getState().preview?.manifest.modes.dark?.colors?.accent).toBe("#445566");
			expect(H.putCalls).toEqual([]);
			unmount();
		}
	});

	it("localized mode controls add a missing variant and preserve each variant when switching", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					light: "Light",
					dark: "Dark",
					add: "Add Dark",
					hint: "The top-right theme switch selects the displayed variant. A skin with only one variant is locked to that mode.",
				},
			],
			[
				"ja",
				{
					light: "ライト",
					dark: "ダーク",
					add: "追加：ダーク",
					hint: "右上のテーマ切替で表示するバリエーションを選びます。1種類だけのスキンは、そのモードに固定されます。",
				},
			],
			[
				"zh-TW",
				{
					light: "淺色",
					dark: "深色",
					add: "新增深色",
					hint: "右上角的主題切換決定目前顯示的版本；只有一個版本的外觀會固定使用該模式。",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const { unmount } = renderEditor();
			expect(screen.getByText(w.hint)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: w.add }));
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.dark?.glass?.blur).toBe(16),
			);
			fireEvent.click(screen.getByRole("button", { name: w.dark }));
			await waitFor(() => expect(useSkinStore.getState().preview?.mode).toBe("dark"));
			fireEvent.click(screen.getByRole("button", { name: w.light }));
			await waitFor(() => expect(useSkinStore.getState().preview?.mode).toBe("light"));
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/bg.png",
			);
			expect(H.putCalls).toEqual([]);
			unmount();
		}
	});

	it("upload progress translates while the original filename and selected asset remain intact", async () => {
		let release = () => {};
		H.uploadGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		renderEditor();
		const file = new File(["image"], "Original image 原图.png", { type: "image/png" });
		fireEvent.change(screen.getByLabelText("上传图片"), { target: { files: [file] } });
		await screen.findByText("上传中…");
		for (const [locale, progress, upload] of [
			["en", "Uploading…", "Upload image"],
			["ja", "アップロード中…", "画像をアップロード"],
			["zh-TW", "上傳中…", "上傳圖片"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(progress)).toBeTruthy();
			expect((screen.getByLabelText(upload) as HTMLInputElement).disabled).toBe(true);
		}
		expect(H.uploadCalls).toEqual([{ path: "/api/dashboard/skins/s1/assets", name: file.name }]);
		await act(async () => {
			release();
		});
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/img-abcd1234.png",
			),
		);
		expect(screen.getByRole("combobox", { name: "桌布圖片" }).textContent).toContain(file.name);
		expect(H.putCalls).toEqual([]);
	});

	it("saving stays disabled and localized until the original skin draft has been persisted", async () => {
		let release = () => {};
		H.putGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "Original skin 草稿" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await screen.findByRole("button", { name: "保存中…" });
		for (const [locale, saving, cancel] of [
			["en", "Saving…", "Cancel"],
			["ja", "保存中…", "キャンセル"],
			["zh-TW", "儲存中…", "取消"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect((screen.getByRole("button", { name: saving }) as HTMLButtonElement).disabled).toBe(
				true,
			);
			expect((screen.getByRole("button", { name: cancel }) as HTMLButtonElement).disabled).toBe(
				true,
			);
			expect(onClose).not.toHaveBeenCalled();
		}
		expect(H.putCalls).toHaveLength(1);
		expect(H.putCalls[0].path).toBe("/api/dashboard/skins/s1/manifest");
		expect((H.putCalls[0].body as SkinManifest).name).toBe("Original skin 草稿");
		await act(async () => {
			release();
		});
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("AI pending and failure descriptions follow the language while the request and diagnostic remain unchanged", async () => {
		let release = () => {};
		H.postGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		H.postFails = true;
		renderEditor();
		fireEvent.change(screen.getByLabelText("修改要求"), {
			target: { value: "Original request 原文" },
		});
		fireEvent.click(screen.getByRole("button", { name: "让女仆改" }));
		await screen.findByRole("button", { name: "女仆修改中…" });
		for (const [locale, pending] of [
			["en", "AI is editing…"],
			["ja", "AIが編集中…"],
			["zh-TW", "AI 修改中…"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect((screen.getByRole("button", { name: pending }) as HTMLButtonElement).disabled).toBe(
				true,
			);
		}
		expect(H.postCalls).toEqual([
			{
				path: "/api/dashboard/skins/s1/ai",
				body: { instruction: "Original request 原文", draft: makeManifest() },
			},
		]);
		await act(async () => {
			release();
		});
		await screen.findByText(/Original diagnostic 原因/);
		for (const [locale, failure, request] of [
			["en", "Operation failed:", "Modification request"],
			["ja", "操作に失敗しました：", "変更の依頼"],
			["zh-TW", "操作失敗：", "修改需求"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(failure + "Original diagnostic 原因")).toBeTruthy();
			expect((screen.getByLabelText(request) as HTMLTextAreaElement).value).toBe(
				"Original request 原文",
			);
		}
		expect(useSkinStore.getState().preview?.manifest.name).toBe("樱花夜");
		expect(H.putCalls).toEqual([]);
	});

	it("localized default actions distinguish persisted snapshots from unsaved restoration previews", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					pin: "Set as default",
					pinHint: "Make the saved skin the default snapshot for this package.",
					dirty: "Save your changes before setting the default.",
					pinned: "The saved skin is now the default for this package.",
					restore: "Restore default",
					restoreHint: "Preview the default snapshot. Save to keep it.",
					restored: "The default snapshot is being previewed. Save to keep it.",
					missing: "This skin has no default snapshot. Use “Set as default” first.",
				},
			],
			[
				"ja",
				{
					pin: "既定に設定",
					pinHint: "保存済みのスキンを、このパッケージの既定スナップショットにします。",
					dirty: "既定に設定する前に変更を保存してください。",
					pinned: "保存済みのスキンを、このパッケージの既定に設定しました。",
					restore: "既定に戻す",
					restoreHint: "既定のスナップショットをプレビューします。保存すると反映されます。",
					restored: "既定のスナップショットをプレビュー中です。保存すると反映されます。",
					missing: "既定のスナップショットがありません。先に「既定に設定」を使ってください。",
				},
			],
			[
				"zh-TW",
				{
					pin: "設為預設值",
					pinHint: "將已儲存的外觀設為這個套件的預設快照。",
					dirty: "請先儲存變更，再設為預設值。",
					pinned: "已將儲存的外觀設為這個套件的預設值。",
					restore: "恢復預設值",
					restoreHint: "預覽預設快照，儲存後才會保留。",
					restored: "正在預覽預設快照，儲存後才會保留。",
					missing: "這個外觀尚無預設快照，請先按「設為預設值」。",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			H.defaultManifest = {
				schemaVersion: 1,
				name: "Original snapshot",
				modes: { light: { glass: { blur: 9 } } },
			};
			const { unmount } = renderEditor();
			const pin = screen.getByRole("button", { name: w.pin }) as HTMLButtonElement;
			expect(pin.title).toBe(w.pinHint);
			const writes = H.putCalls.length;
			fireEvent.click(pin);
			await screen.findByText(w.pinned);
			expect(H.putCalls.slice(writes)).toEqual([
				{ path: "/api/dashboard/skins/s1/default", body: undefined },
			]);
			const restore = screen.getByRole("button", { name: w.restore }) as HTMLButtonElement;
			expect(restore.title).toBe(w.restoreHint);
			fireEvent.click(restore);
			await screen.findByText(w.restored);
			expect(screen.queryByText(w.pinned)).toBeNull();
			expect(pin.disabled).toBe(true);
			expect(pin.title).toBe(w.dirty);
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.name).toBe("Original snapshot"),
			);
			expect(H.putCalls).toHaveLength(writes + 1);
			unmount();
			H.defaultManifest = null;
			const empty = renderEditor();
			const unavailable = screen.getByRole("button", { name: w.restore }) as HTMLButtonElement;
			await waitFor(() => expect(unavailable.title).toBe(w.missing));
			expect(unavailable.disabled).toBe(true);
			empty.unmount();
		}
	});

	it("translated editor actions preserve the request and ask before discarding unsaved skin changes", async () => {
		for (const [locale, words] of [
			[
				"en",
				{
					drawer: "Skin editor",
					title: "Edit skin",
					hint: "Changes preview across the page immediately. Save to keep them.",
					request: "Modification request",
					example: "Describe a change, e.g. “Use a cyberpunk style with neon shimmer on cards.”",
					preview: "Preview the result immediately; revise it as needed.",
					ai: "Ask AI to edit",
					cancel: "Cancel",
					save: "Save",
					discardTitle: "Discard changes",
					discardMessage:
						"These changes have not been saved. Closing restores the original appearance. Discard them?",
					discard: "Discard",
				},
			],
			[
				"ja",
				{
					drawer: "スキン編集",
					title: "スキンを編集",
					hint: "変更はすぐにページ全体へプレビューされます。保存すると反映されます。",
					request: "変更の依頼",
					example: "例：「全体をサイバーパンク風にして、カードにネオンのきらめきを追加」",
					preview: "結果をすぐにプレビューし、必要に応じて調整できます。",
					ai: "AIに編集を依頼",
					cancel: "キャンセル",
					save: "保存",
					discardTitle: "変更を破棄",
					discardMessage:
						"変更はまだ保存されていません。閉じると元の外観に戻ります。破棄しますか？",
					discard: "破棄",
				},
			],
			[
				"zh-TW",
				{
					drawer: "外觀編輯器",
					title: "調整外觀",
					hint: "每項變更都會立即在整個頁面預覽，儲存後才會保留。",
					request: "修改需求",
					example: "用一句話描述修改，例如「整體改成賽博龐克風格，卡片加上霓虹流光」",
					preview: "修改後立即預覽，不滿意可再調整。",
					ai: "請 AI 修改",
					cancel: "取消",
					save: "儲存",
					discardTitle: "捨棄變更",
					discardMessage: "變更尚未儲存，關閉後會恢復原本的外觀。確定捨棄嗎？",
					discard: "捨棄",
				},
			],
		] as const) {
			act(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
			const { onClose, unmount } = renderEditor();
			fireEvent.change(screen.getByLabelText("修改要求"), {
				target: { value: "Original request 原文" },
			});
			fireEvent.change(screen.getByLabelText("皮肤名"), {
				target: { value: "Original skin 草稿" },
			});
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByLabelText(words.drawer)).toBeTruthy();
			expect(screen.getByText(words.title)).toBeTruthy();
			expect(screen.getByText(words.hint)).toBeTruthy();
			expect((screen.getByLabelText(words.request) as HTMLTextAreaElement).value).toBe(
				"Original request 原文",
			);
			expect(screen.getByPlaceholderText(words.example)).toBeTruthy();
			expect(screen.getByText(words.preview)).toBeTruthy();
			expect((screen.getByRole("button", { name: words.ai }) as HTMLButtonElement).disabled).toBe(
				false,
			);
			expect(screen.getByRole("button", { name: words.save })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: words.cancel }));
			const dialog = await screen.findByRole("dialog", { name: "" });
			expect(within(dialog).getByText(words.discardTitle)).toBeTruthy();
			expect(within(dialog).getByText(words.discardMessage)).toBeTruthy();
			expect(onClose).not.toHaveBeenCalled();
			fireEvent.click(within(dialog).getByRole("button", { name: words.discard }));
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(H.putCalls).toEqual([]);
			expect(H.postCalls).toEqual([]);
			unmount();
		}
	});

	it("font and motion section text translates without rewriting family names or effect colors", async () => {
		renderEditor();
		openFontFold();
		fireEvent.change(screen.getByLabelText("正文字体栈"), {
			target: { value: "Original Family, monospace" },
		});
		fireEvent.click(screen.getByText("动效"));
		fireEvent.click(screen.getByLabelText("玻璃流光"));
		fireEvent.change(screen.getByLabelText("流光颜色"), { target: { value: "#112233" } });
		fireEvent.change(screen.getByLabelText("光斑颜色"), { target: { value: "#334455, #556677" } });
		for (const [locale, words] of [
			[
				"en",
				{
					font: "Fonts",
					upload: "Upload font",
					family: "Body font stack",
					motion: "Motion",
					shine: "Glass shimmer",
					color: "Shimmer color",
					bokeh: "Bokeh colors",
					placeholder: "1–4 comma-separated colors; blank disables the effect.",
					reduced: "All effects respect the system’s reduced-motion preference.",
				},
			],
			[
				"ja",
				{
					font: "フォント",
					upload: "フォントをアップロード",
					family: "本文フォント",
					motion: "動き",
					shine: "ガラスのきらめき",
					color: "きらめきの色",
					bokeh: "光のぼけの色",
					placeholder: "色1～4個をカンマで区切ります。空欄で無効化。",
					reduced: "すべての動きは、システムのアニメーションを減らす設定に従います。",
				},
			],
			[
				"zh-TW",
				{
					font: "字型",
					upload: "上傳字型",
					family: "內文字型清單",
					motion: "動態效果",
					shine: "玻璃流光",
					color: "流光顏色",
					bokeh: "光斑顏色",
					placeholder: "以逗號分隔 1～4 個顏色，留空即可關閉。",
					reduced: "所有動態效果均遵循系統的減少動態效果偏好設定。",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(words.font, { exact: true })).toBeTruthy();
			expect(screen.getByLabelText(words.upload)).toBeTruthy();
			expect((screen.getByLabelText(words.family) as HTMLInputElement).value).toBe(
				"Original Family, monospace",
			);
			expect(screen.getByText(words.motion, { exact: true })).toBeTruthy();
			expect(
				(screen.getByRole("button", { name: words.shine }) as HTMLButtonElement).getAttribute(
					"aria-pressed",
				),
			).toBe("true");
			expect((screen.getByLabelText(words.color) as HTMLInputElement).value).toBe("#112233");
			expect((screen.getByLabelText(words.bokeh) as HTMLInputElement).value).toBe(
				"#334455, #556677",
			);
			expect(screen.getByPlaceholderText(words.placeholder)).toBeTruthy();
			expect(screen.getByText(words.reduced)).toBeTruthy();
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.effects).toEqual({
					glassShine: { color: "#112233" },
					bokeh: { colors: ["#334455", "#556677"] },
				}),
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.body).toEqual([
				"Original Family",
				"monospace",
			]);
		}
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
	});

	it("layout section labels translate without resetting corner, sidebar or shadow edits", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("圆角 · 阴影 · 版式"));
		fireEvent.change(screen.getByLabelText("卡片圆角"), { target: { value: "18" } });
		fireEvent.change(screen.getByLabelText("胶囊圆角"), { target: { value: "24" } });
		fireEvent.change(screen.getByLabelText("左栏宽度"), { target: { value: "280" } });
		fireEvent.change(screen.getByLabelText("卡片阴影"), { target: { value: "0 1px 3px #123456" } });
		for (const [locale, words] of [
			[
				"en",
				{
					title: "Corners, shadows and layout",
					card: "Card corner radius",
					pill: "Pill corner radius",
					rail: "Sidebar width",
					shadow: "Card shadow",
					floating: "Floating shadow",
					example: "e.g. 0 10px 30px rgba(57,197,187,0.25)",
				},
			],
			[
				"ja",
				{
					title: "角丸・影・レイアウト",
					card: "カードの角丸",
					pill: "ピルの角丸",
					rail: "サイドバー幅",
					shadow: "カードの影",
					floating: "浮いた要素の影",
					example: "例：0 10px 30px rgba(57,197,187,0.25)",
				},
			],
			[
				"zh-TW",
				{
					title: "圓角、陰影與版面",
					card: "卡片圓角",
					pill: "膠囊圓角",
					rail: "側欄寬度",
					shadow: "卡片陰影",
					floating: "浮層陰影",
					example: "例如 0 10px 30px rgba(57,197,187,0.25)",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(words.title, { exact: true })).toBeTruthy();
			expect((screen.getByLabelText(words.card) as HTMLInputElement).value).toBe("18");
			expect((screen.getByLabelText(words.pill) as HTMLInputElement).value).toBe("24");
			expect((screen.getByLabelText(words.rail) as HTMLInputElement).value).toBe("280");
			expect((screen.getByLabelText(words.shadow) as HTMLInputElement).value).toBe(
				"0 1px 3px #123456",
			);
			expect(screen.getByLabelText(words.floating)).toBeTruthy();
			expect(screen.getByPlaceholderText(words.example)).toBeTruthy();
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.radius).toEqual({
					card: 18,
					pill: 24,
				}),
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.railWidth).toBe(280);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.shadows?.card).toBe(
				"0 1px 3px #123456",
			);
		}
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
	});

	it("chat section guidance translates while an edited background remains separate from the page background", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("AI 聊天"));
		fireEvent.change(screen.getByLabelText("聊天页背景"), {
			target: { value: "linear-gradient(#123456, #654321)" },
		});
		for (const [locale, words] of [
			[
				"en",
				{
					title: "AI chat",
					field: "Chat background",
					placeholder: "Solid color or gradient; leave blank to show the page’s skin background.",
					hint: "An active skin styles the whole chat page and hides the four default color presets. The accent follows the main accent color, and glass uses the Glass section above. Only the chat background is configured here.",
				},
			],
			[
				"ja",
				{
					title: "AIチャット",
					field: "チャット背景",
					placeholder:
						"単色またはグラデーション。空欄にするとページ全体のスキン背景が透けて見えます。",
					hint: "スキンの適用中はチャット画面全体の外観が変わり、既定の4色プリセットは非表示になります。アクセント色はメインの色に従い、ガラスには上の「ガラスパネル」の設定を使います。ここではチャット背景のみを設定します。",
				},
			],
			[
				"zh-TW",
				{
					title: "AI 聊天",
					field: "聊天頁面背景",
					placeholder: "純色或漸層；留空會透出整個頁面的外觀背景。",
					hint: "套用外觀時，聊天頁面會整體換裝並隱藏預設的四色主題。強調色跟隨主強調色，玻璃元件使用上方「玻璃面板」的設定；此處僅設定聊天頁面的背景。",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByRole("button", { name: `${words.title}−` })).toBeTruthy();
			expect(screen.getByText(words.hint)).toBeTruthy();
			expect((screen.getByLabelText(words.field) as HTMLTextAreaElement).value).toBe(
				"linear-gradient(#123456, #654321)",
			);
			expect(screen.getByPlaceholderText(words.placeholder)).toBeTruthy();
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.background).toBe(
					"linear-gradient(#123456, #654321)",
				),
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.page).toBeUndefined();
		}
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
	});

	it("editor field labels translate while name, text and wallpaper adjustments remain unsaved preview data", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "Original draft skin" } });
		fireEvent.change(screen.getByLabelText("顶栏标题"), {
			target: { value: "Original header / 原文" },
		});
		fireEvent.change(screen.getByLabelText("壁纸遮罩"), { target: { value: "0.4" } });
		for (const [locale, words] of [
			[
				"en",
				{
					name: "Name",
					author: "Author",
					description: "Description",
					title: "Header title",
					placeholder: "Chat placeholder",
					page: "Page background",
					overlay: "Wallpaper overlay",
					blur: "Wallpaper blur",
					position: "Wallpaper position",
					glass: "Glass opacity",
					clear: "Clear Wallpaper overlay",
					color: "Pick Glass background color",
				},
			],
			[
				"ja",
				{
					name: "名前",
					author: "作者",
					description: "説明",
					title: "ヘッダーのタイトル",
					placeholder: "チャット入力欄の案内",
					page: "ページ背景",
					overlay: "壁紙のオーバーレイ",
					blur: "壁紙のぼかし",
					position: "壁紙の位置",
					glass: "ガラスの不透明度",
					clear: "壁紙のオーバーレイをクリア",
					color: "ガラス背景の色を選択",
				},
			],
			[
				"zh-TW",
				{
					name: "名稱",
					author: "作者",
					description: "描述",
					title: "頂欄標題",
					placeholder: "聊天輸入提示",
					page: "頁面背景",
					overlay: "桌布遮罩",
					blur: "桌布模糊",
					position: "桌布位置",
					glass: "玻璃不透明度",
					clear: "清除桌布遮罩",
					color: "選取玻璃底色",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect((screen.getByLabelText(words.name) as HTMLInputElement).value).toBe(
				"Original draft skin",
			);
			expect((screen.getByLabelText(words.title) as HTMLInputElement).value).toBe(
				"Original header / 原文",
			);
			for (const label of [
				words.author,
				words.description,
				words.placeholder,
				words.page,
				words.overlay,
				words.blur,
				words.position,
				words.glass,
				words.color,
			])
				expect(screen.getByLabelText(label)).toBeTruthy();
			expect(screen.getByRole("button", { name: words.clear })).toBeTruthy();
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.overlay).toBe(0.4),
			);
		}
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
		expect(H.uploadCalls).toEqual([]);
	});

	it("bundled font choices and default markers translate without rewriting resource names or the font fallback list", async () => {
		const manifest = makeManifest();
		manifest.modes.light = { ...manifest.modes.light, fonts: { body: ["Original body font"] } };
		H.defaultManifest = structuredClone(manifest);
		renderEditor({ manifest });
		const nameRow = screen.getByLabelText("皮肤名").parentElement as HTMLElement;
		await waitFor(() => expect(within(nameRow).getByText("默认")).toBeTruthy());
		openFontFold();
		for (const [locale, words] of [
			["en", { font: "Bundled font", none: "(No bundled font)", defaults: "Default" }],
			["ja", { font: "同梱フォント", none: "（同梱フォントを使わない）", defaults: "既定" }],
			["zh-TW", { font: "內附字型", none: "（不使用內附字型）", defaults: "預設" }],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(within(nameRow).getByText(words.defaults)).toBeTruthy();
			const font = screen.getByRole("combobox", { name: words.font });
			expect(selectOptionsOf(font).map((option) => option.textContent)).toEqual([
				words.none,
				"霞鹜文楷 Light.woff2",
			]);
			chooseSelect(font, "霞鹜文楷 Light.woff2");
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBe(
					"assets/font-a1b2c3d4.woff2",
				),
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.body).toEqual([
				"Original body font",
			]);
		}
		chooseSelect(screen.getByRole("combobox", { name: "內附字型" }), "（不使用內附字型）");
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBeUndefined(),
		);
		expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.body).toEqual([
			"Original body font",
		]);
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
		expect(H.uploadCalls).toEqual([]);
	});

	it("chat wallpaper selectors translate without changing page wallpaper or removing the chat background", async () => {
		const manifest = makeManifest();
		manifest.modes.light = {
			...manifest.modes.light,
			chat: { background: "#123456", wallpaper: { image: "assets/deco.webp", fit: "contain" } },
		};
		renderEditor({ manifest });
		fireEvent.click(screen.getByText("AI 聊天"));
		for (const [locale, words] of [
			[
				"en",
				{
					image: "Chat wallpaper",
					fit: "Chat wallpaper fit",
					tile: "Tile",
					none: "(No wallpaper)",
				},
			],
			[
				"ja",
				{
					image: "チャットの壁紙",
					fit: "チャットの壁紙の表示方法",
					tile: "タイル状に並べる",
					none: "（壁紙なし）",
				},
			],
			[
				"zh-TW",
				{ image: "聊天桌布", fit: "聊天桌布顯示方式", tile: "平鋪", none: "（不使用桌布）" },
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			chooseSelect(screen.getByRole("combobox", { name: words.image }), "assets/deco.webp");
			chooseSelect(screen.getByRole("combobox", { name: words.fit }), words.tile);
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.wallpaper?.fit).toBe(
					"tile",
				),
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/bg.png",
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.fit).toBeUndefined();
		}
		chooseSelect(screen.getByRole("combobox", { name: "聊天桌布" }), "（不使用桌布）");
		await waitFor(() =>
			expect(
				useSkinStore.getState().preview?.manifest.modes.light?.chat?.wallpaper,
			).toBeUndefined(),
		);
		expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.background).toBe("#123456");
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
		expect(H.uploadCalls).toEqual([]);
	});

	it("wallpaper selectors translate while asset names and the selected fit remain in the local preview", async () => {
		renderEditor();
		for (const [locale, words] of [
			[
				"en",
				{
					image: "Wallpaper image",
					fit: "Wallpaper fit",
					none: "(No wallpaper)",
					defaults: "Default (fill)",
					cover: "Fill",
					contain: "Show full image",
					tile: "Tile",
				},
			],
			[
				"ja",
				{
					image: "壁紙画像",
					fit: "壁紙の表示方法",
					none: "（壁紙なし）",
					defaults: "既定（全面に表示）",
					cover: "領域を埋める",
					contain: "画像全体を表示",
					tile: "タイル状に並べる",
				},
			],
			[
				"zh-TW",
				{
					image: "桌布圖片",
					fit: "桌布顯示方式",
					none: "（不使用桌布）",
					defaults: "預設（填滿）",
					cover: "填滿",
					contain: "完整顯示",
					tile: "平鋪",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const image = screen.getByRole("combobox", { name: words.image });
			expect(selectOptionsOf(image).map((option) => option.textContent)).toEqual([
				words.none,
				"assets/bg.png",
				"assets/deco.webp",
			]);
			chooseSelect(image, "assets/bg.png");
			const fit = screen.getByRole("combobox", { name: words.fit });
			expect(selectOptionsOf(fit).map((option) => option.textContent)).toEqual([
				words.defaults,
				words.cover,
				words.contain,
				words.tile,
			]);
			chooseSelect(fit, words.tile);
			await waitFor(() =>
				expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.fit).toBe("tile"),
			);
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/bg.png",
			);
		}
		expect(H.putCalls).toEqual([]);
		expect(H.postCalls).toEqual([]);
		expect(H.uploadCalls).toEqual([]);
	});

	it("挂载:editing=true 且 preview=当前 draft;卸载:两者复位", () => {
		const { unmount } = renderEditor();
		expect(useSkinStore.getState().editing).toBe(true);
		expect(useSkinStore.getState().preview?.id).toBe("s1");
		expect(useSkinStore.getState().preview?.manifest.name).toBe("樱花夜");
		unmount();
		expect(useSkinStore.getState().editing).toBe(false);
		expect(useSkinStore.getState().preview).toBeNull();
	});

	it("玻璃片透明度滑杆(与推送卡片同名同义):保色相只调 alpha", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.3" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.glass?.background).toBe(
				"rgba(255, 255, 255, 0.3)",
			),
		);
	});

	it("完全透明开关:开 = 透明度与模糊一起归零;关 = 清字段回默认", async () => {
		renderEditor();
		fireEvent.click(screen.getByLabelText("完全透明(去磨砂模糊)"));
		await waitFor(() => {
			const g = useSkinStore.getState().preview?.manifest.modes.light?.glass;
			expect(g?.background).toBe("rgba(255, 255, 255, 0)");
			expect(g?.blur).toBe(0);
		});
		expect((screen.getByLabelText("玻璃片透明度") as HTMLInputElement).disabled).toBe(true);

		fireEvent.click(screen.getByLabelText("完全透明(去磨砂模糊)"));
		await waitFor(() => {
			const g = useSkinStore.getState().preview?.manifest.modes.light?.glass;
			expect(g?.background).toBeUndefined();
			expect(g?.blur).toBeUndefined();
		});
	});

	it("玻璃高级字段(能力对齐):色相/描边/双档模糊都有编辑口", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃描边"), {
			target: { value: "rgba(57, 197, 187, 0.3)" },
		});
		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "32" } });
		fireEvent.change(screen.getByLabelText("强玻璃模糊"), { target: { value: "28" } });
		await waitFor(() => {
			const g = useSkinStore.getState().preview?.manifest.modes.light?.glass;
			expect(g?.border).toBe("rgba(57, 197, 187, 0.3)");
			expect(g?.blur).toBe(32);
			expect(g?.strongBlur).toBe(28);
		});
		expect(screen.getByLabelText("玻璃底色")).toBeTruthy();
		expect(screen.getByLabelText("强玻璃底色")).toBeTruthy();
		expect(screen.getByLabelText("强玻璃描边")).toBeTruthy();
	});

	it("拖壁纸模糊滑杆 → preview 的 wallpaper.blur 实时反映", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("壁纸模糊"), { target: { value: "12" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.blur).toBe(12),
		);
	});

	it("壁纸下拉列出包内资产;选「(不用壁纸)」→ wallpaper 从 draft 消失", async () => {
		renderEditor();
		const select = screen.getByRole("combobox", { name: "壁纸图片" }) as HTMLButtonElement;
		const options = selectOptionsOf(select).map((o) => o.textContent);
		expect(options).toContain("assets/bg.png");
		expect(options).toContain("assets/deco.webp");
		chooseSelect(select, "(不用壁纸)");
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper).toBeUndefined(),
		);
	});

	it("保存 → PUT 当前 draft;该皮肤正占着槽时同步转正(只动占用的槽)", async () => {
		useSkinStore
			.getState()
			.setActive({ light: { id: "s1", manifest: makeManifest() }, dark: null });
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.8" } });
		fireEvent.click(screen.getByText("保存"));
		await waitFor(() => expect(H.putCalls).toHaveLength(1));
		expect(H.putCalls[0].path).toBe("/api/dashboard/skins/s1/manifest");
		const sent = H.putCalls[0].body as SkinManifest;
		expect(sent.modes.light?.glass?.background).toBe("rgba(255, 255, 255, 0.8)");
		await waitFor(() =>
			expect(useSkinStore.getState().active.light?.manifest.modes.light?.glass?.background).toBe(
				"rgba(255, 255, 255, 0.8)",
			),
		);
		expect(useSkinStore.getState().active.dark).toBeNull();
		expect(onClose).toHaveBeenCalled();
	});

	it("有脏改动时点取消 → 确认框;确认丢弃 → 不发 PUT 直接关", async () => {
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.4" } });
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

	it("自定义 CSS 就地列出全部挂点,悬停给契约里那句说明", () => {
		// 挂点清单从前只写在「复制提示词」那份文本里,那条路删掉之后,手写 CSS 的人
		// 在界面上再也看不到一个挂点名。
		renderEditor();
		fireEvent.click(screen.getByText("自定义 CSS"));
		const list = screen.getByRole("list", { name: "可用挂点" });
		const items = within(list).getAllByRole("listitem");
		expect(items.map((li) => li.textContent)).toEqual(Object.keys(SKIN_CSS_HOOK_MAP));
		expect(within(list).getByText("nav-item-active")).toBeTruthy();
		const glass = within(list).getByText("glass");
		expect(glass.getAttribute("title")).toBe(SKIN_CSS_HOOK_NOTES.glass);
		expect(screen.queryByText(/制作引导/)).toBeNull();
	});

	it("让女仆改:发 POST /:id/ai 带当前 draft;返回的 manifest 直接进 draft 实时预览", async () => {
		renderEditor();
		// 先手调一个值,验证发出去的 draft 是当前草稿而非初始 manifest
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.25" } });
		fireEvent.change(screen.getByLabelText("修改要求"), {
			target: { value: "换成赛博朋克风" },
		});
		fireEvent.click(screen.getByText("让女仆改"));
		await waitFor(() => expect(H.postCalls).toHaveLength(1));
		expect(H.postCalls[0].path).toBe("/api/dashboard/skins/s1/ai");
		const sent = H.postCalls[0].body as { instruction: string; draft: SkinManifest };
		expect(sent.instruction).toBe("换成赛博朋克风");
		expect(sent.draft.modes.light?.glass?.background).toBe("rgba(255, 255, 255, 0.25)");
		// 产物进 draft → 实时预览;要求框清空
		await waitFor(() => expect(useSkinStore.getState().preview?.manifest.name).toBe("AI 皮肤"));
		expect(H.putCalls).toEqual([]); // 不落盘
	});

	it("动效预设:流光/光斑两道都能开关,改动实时进 preview", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("动效"));

		fireEvent.click(screen.getByLabelText("玻璃流光"));
		fireEvent.change(screen.getByLabelText("光斑颜色"), {
			target: { value: "#fb7299, #00aeec" },
		});
		await waitFor(() => {
			const fx = useSkinStore.getState().preview?.manifest.modes.light?.effects;
			expect(fx?.glassShine).toEqual({});
			expect(fx?.bokeh?.colors).toEqual(["#fb7299", "#00aeec"]);
		});

		// 全关 → effects 字段整个消失
		fireEvent.click(screen.getByLabelText("玻璃流光"));
		fireEvent.change(screen.getByLabelText("光斑颜色"), { target: { value: "" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.effects).toBeUndefined(),
		);
	});

	it("换一套模式 → 光斑颜色框跟着换成那一套的,不留上一套的残影", async () => {
		// 这个框存的是主人正在敲的原文(受控 join 回去会吃掉逗号),所以每一条
		// 「整份换掉 draft」的路径都得让它回到派生态 —— 漏一条的症状就是切过去
		// 之后框里还挂着另一套的颜色,而 draft 里根本没有。
		renderEditor({
			manifest: {
				schemaVersion: 1,
				name: "双套",
				modes: {
					light: {},
					dark: { effects: { bokeh: { colors: ["#123456"] } } },
				},
			},
		});
		fireEvent.click(screen.getByText("动效"));
		expect((screen.getByLabelText("光斑颜色") as HTMLInputElement).value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "深色" }));
		await waitFor(() =>
			expect((screen.getByLabelText("光斑颜色") as HTMLInputElement).value).toBe("#123456"),
		);
	});

	it("双套皮肤:开编辑器默认编**当前主题**那一套", async () => {
		// 一进来就编主人正看着的那套。停在浅色的话:他要么先手动切一下,要么(因为
		// 编哪套锁哪套)整个面板当场从暗色跳成亮色 —— 两种都不是他要的。
		useThemeStore.setState({ preference: "dark", systemPrefersDark: true, resolved: "dark" });
		renderEditor({
			manifest: {
				schemaVersion: 1,
				name: "双套",
				modes: { light: { glass: { blur: 4 } }, dark: { glass: { blur: 20 } } },
			},
		});
		expect((screen.getByLabelText("玻璃模糊") as HTMLInputElement).value).toBe("20");
		expect(useSkinStore.getState().preview?.mode).toBe("dark");
	});

	it("单套皮肤:当前主题那套压根没有 → 回落到它有的那一套", async () => {
		// 「跟当前主题」只对两套都有的皮肤成立。纯浅色皮肤在暗色主题下若也跟主题走,
		// 编辑器会停在一套不存在的模式上 —— 那是一整屏空控件。
		useThemeStore.setState({ preference: "dark", systemPrefersDark: true, resolved: "dark" });
		renderEditor({
			manifest: { schemaVersion: 1, name: "纯浅", modes: { light: { glass: { blur: 4 } } } },
		});
		expect((screen.getByLabelText("玻璃模糊") as HTMLInputElement).value).toBe("4");
		expect(useSkinStore.getState().preview?.mode).toBe("light");
	});

	it("底栏至多挂一条反馈 —— 传图失败要把上一条绿字顶掉", async () => {
		// 红绿分成两个 state 时,互斥全靠每个写点自己记得清对方;传图那条就没清,
		// 于是「已钉为默认值」和「图片过大」会一起挂在底栏上。
		renderEditor();
		fireEvent.click(screen.getByText("设为默认值").closest("button") as HTMLButtonElement);
		await waitFor(() => expect(screen.getByText(/已把当前状态钉为/)).toBeTruthy());
		const { locale, voice } = i18n.state();
		try {
			act(() => i18n.set({ locale: "zh-CN", voice: "maid" }));
			expect(screen.getByText("主人，已把当前状态设为这套皮肤包的默认值啦。")).toBeTruthy();
		} finally {
			act(() => i18n.set({ locale, voice }));
		}

		H.uploadFails = true;
		const file = new File([new Uint8Array([1])], "big.png", { type: "image/png" });
		fireEvent.change(screen.getByLabelText("上传图片"), { target: { files: [file] } });

		await waitFor(() => expect(screen.getByText(/图片过大/)).toBeTruthy());
		expect(screen.queryByText(/已把当前状态钉为/)).toBeNull();
	});

	it("壁纸下拉**不列字体** —— 资产清单是图与字体的全集,不分流就会选出个 woff2 当壁纸", async () => {
		renderEditor();
		const options = selectOptionsOf(screen.getByRole("combobox", { name: "壁纸图片" })).map(
			(o) => o.textContent,
		);
		expect(options).not.toContain("assets/font-a1b2c3d4.woff2");
	});

	it("自带字体下拉列出包内字体;选中 → draft.fonts.asset,选「不用」→ 字段消失", async () => {
		renderEditor();
		openFontFold();
		const select = screen.getByRole("combobox", { name: "自带字体" }) as HTMLButtonElement;
		expect(selectOptionsOf(select).map((o) => o.textContent)).toContain("霞鹜文楷 Light.woff2");
		// 图不许混进来:选了图当字体,保存时才被服务端拒收,而主人已经调了半天。
		expect(selectOptionsOf(select).map((o) => o.textContent)).not.toContain("assets/bg.png");

		chooseSelect(select, "霞鹜文楷 Light.woff2");
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBe(
				"assets/font-a1b2c3d4.woff2",
			),
		);
		chooseSelect(screen.getByRole("combobox", { name: "自带字体" }), "(不用自带字体)");
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBeUndefined(),
		);
	});

	it("下拉显示主人上传时的原名,没登记的回落成生成名", async () => {
		// 盘上是随机 hex(那是安全边界:名字不进路径/URL/CSS),所以界面这一层
		// 必须把原名端出来 —— 否则主人看到的只有一串认不出的 font-a1b2c3d4。
		renderEditor();
		openFontFold();
		const font = selectOptionsOf(screen.getByRole("combobox", { name: "自带字体" }));
		expect(font.find((o) => o.textContent === "霞鹜文楷 Light.woff2")?.textContent).toBe(
			"霞鹜文楷 Light.woff2",
		);

		const image = selectOptionsOf(screen.getByRole("combobox", { name: "壁纸图片" }));
		expect(image.find((o) => o.textContent === "assets/bg.png")?.textContent).toBe("assets/bg.png");
	});

	it("传完之后下拉上立刻是刚传那个文件的名字,不用等重开抽屉", async () => {
		renderEditor();
		openFontFold();
		fireEvent.change(screen.getByLabelText("上传字体"), {
			target: { files: [new File([new Uint8Array([1])], "思源宋体.woff2", { type: "" })] },
		});
		await waitFor(() => {
			const opts = selectOptionsOf(screen.getByRole("combobox", { name: "自带字体" }));
			expect(opts.find((o) => o.textContent === "思源宋体.woff2")?.textContent).toBe(
				"思源宋体.woff2",
			);
		});
	});

	it("传一款字体 → 立刻选成自带字体(会来传字体的人正是想换字体)", async () => {
		renderEditor();
		openFontFold();
		const file = new File([new Uint8Array([1])], "霞鹜文楷.woff2", { type: "" });
		fireEvent.change(screen.getByLabelText("上传字体"), { target: { files: [file] } });

		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBe(
				"assets/font-99887766.woff2",
			),
		);
		expect(H.uploadCalls.at(-1)?.path).toBe("/api/dashboard/skins/s1/assets");
	});

	it("传字体不动字体栈 —— 两栏各管各的,拉不下来还有家族名兜着", async () => {
		renderEditor({
			manifest: {
				schemaVersion: 1,
				name: "樱花夜",
				modes: { light: { fonts: { body: ["霞鹜文楷"] } } },
			},
		});
		openFontFold();
		const file = new File([new Uint8Array([1])], "f.woff2", { type: "" });
		fireEvent.change(screen.getByLabelText("上传字体"), { target: { files: [file] } });

		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBeTruthy(),
		);
		expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.body).toEqual([
			"霞鹜文楷",
		]);
	});

	it("单套皮肤:点「补一套深色」→ draft 长出 dark 套(复制自浅色)", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("补一套深色"));
		await waitFor(() => {
			const dark = useSkinStore.getState().preview?.manifest.modes.dark;
			expect(dark?.glass?.blur).toBe(16);
		});
	});

	it("恢复默认值:用挂载时拉好的快照回填 draft 实时预览,不发落盘请求", async () => {
		renderEditor();
		const btn = screen.getByText("恢复默认值").closest("button") as HTMLButtonElement;
		await waitFor(() => expect(btn.disabled).toBe(false));
		fireEvent.click(btn);
		await waitFor(() => expect(useSkinStore.getState().preview?.manifest.name).toBe("出厂樱花"));
		// 快照在挂载时拉过一次,点击复用,不再发第二次
		expect(H.getCalls).toEqual(["/api/dashboard/skins/s1/default"]);
		expect(H.putCalls).toEqual([]);
	});

	it("与出厂快照一致:数值类内嵌「数值(默认)」,字符串类尾标「默认」;改动后消失", async () => {
		H.defaultManifest = {
			schemaVersion: 1,
			name: "樱花夜",
			modes: { light: { glass: { blur: 16 } } },
		};
		renderEditor();
		// 皮肤名与快照一致 → 输入框尾标「默认」(不带括号);等它出现 = 快照已到位
		const nameRow = screen.getByLabelText("皮肤名").parentElement as HTMLElement;
		await waitFor(() => expect(within(nameRow).getByText("默认")).toBeTruthy());
		expect(within(nameRow).queryByText("(默认)")).toBeNull();
		// 玻璃模糊 16 与快照一致(内嵌标注);强玻璃模糊未配置回落 16px 同形态 → 共 2 处
		expect(screen.getAllByText("16px(默认)")).toHaveLength(2);
		// 未配置的滑杆(数值类)也给数值:玻璃透明度显示原版回落 0.7(默认)
		expect(screen.getByText("0.7(默认)")).toBeTruthy();

		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "20" } });
		await waitFor(() => expect(screen.getByText("20px")).toBeTruthy());
		expect(screen.queryByText("20px(默认)")).toBeNull();
	});

	it("没钉过默认值:恢复按钮禁用、快照匹配标注不出现", async () => {
		H.defaultManifest = null;
		renderEditor();
		const btn = screen.getByText("恢复默认值").closest("button") as HTMLButtonElement;
		await waitFor(() => expect(btn.title).toContain("还没有钉过"));
		expect(btn.disabled).toBe(true);
		// 有值的字段(玻璃模糊 16)不再标 —— 无快照没有比较基准
		expect(screen.getByText("16px")).toBeTruthy();
		const nameRow = screen.getByLabelText("皮肤名").parentElement as HTMLElement;
		expect(within(nameRow).queryByText("默认")).toBeNull();
		// 未配置滑杆的回落显示与快照无关,照常给「数值(默认)」
		expect(screen.getByText("0.7(默认)")).toBeTruthy();
	});

	it("设为默认值:干净状态发 PUT /default;有未保存改动时禁用(先保存)", async () => {
		renderEditor();
		const btn = screen.getByText("设为默认值").closest("button") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
		fireEvent.click(btn);
		await waitFor(() =>
			expect(H.putCalls.map((c) => c.path)).toEqual(["/api/dashboard/skins/s1/default"]),
		);

		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.3" } });
		await waitFor(() => expect(btn.disabled).toBe(true));
	});

	it("传张图进来 → 进包、进下拉、并当场选成壁纸", async () => {
		// 没有这个入口时,给一套皮肤换壁纸只能导出 zip、塞图、改 JSON、再传回来;
		// 而聊天里做出来的皮肤天生零资产,等于压根没有壁纸这回事。
		renderEditor();
		const input = screen.getByLabelText("上传图片") as HTMLInputElement;
		const file = new File([new Uint8Array([1, 2, 3])], "rem.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() =>
			expect(H.uploadCalls).toEqual([{ path: "/api/dashboard/skins/s1/assets", name: "rem.png" }]),
		);
		// 传完立刻用上 —— 传图的人正是想换壁纸,还要再点一次下拉是多余的一步。
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/img-abcd1234.png",
			),
		);
		const options = selectOptionsOf(screen.getByRole("combobox", { name: "壁纸图片" }));
		expect(options.map((o) => o.textContent)).toContain("rem.png");
	});

	it("上传那几秒里改的字段不许被回滚 —— 传完只是补个 image,不是把整段按回去", async () => {
		// 20MB 字体、5MB 壁纸传起来是要几秒的,主人当然会一边等一边接着调。
		// 传完那一下若拿**渲染闭包里的** draft 去拼整段 wallpaper,他这几秒调的
		// 全被按回旧值 —— 和 react-query 那条「要发的东西必须走 variables」同源。
		let release!: () => void;
		H.uploadGate = new Promise<void>((r) => {
			release = () => r();
		});
		renderEditor();
		fireEvent.change(screen.getByLabelText("上传图片"), {
			target: { files: [new File([new Uint8Array([1])], "rem.png", { type: "image/png" })] },
		});
		await waitFor(() => expect(H.uploadCalls).toHaveLength(1));

		// 还挂在网上,主人顺手把遮罩调深了
		fireEvent.change(screen.getByLabelText("壁纸遮罩"), { target: { value: "0.6" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.overlay).toBe(0.6),
		);

		release();
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/img-abcd1234.png",
			),
		);
		// 这一句才是要钉的:传完之后,那几秒的调整还在。
		expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.overlay).toBe(0.6);
	});

	it("「AI 聊天」节只管背景(能力全集=schema 全集):改背景/壁纸落 draft,没有强调色入口", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("AI 聊天"));
		// 颜色全部派生自主强调色、玻璃直用「玻璃」节 —— chat 段不另设一套参数
		expect(screen.queryByLabelText("聊天强调色")).toBeNull();
		expect(screen.queryByLabelText("聊天渐变次色")).toBeNull();
		fireEvent.change(screen.getByLabelText("聊天页背景"), { target: { value: "#0e1c2c" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.background).toBe(
				"#0e1c2c",
			),
		);
		// 聊天壁纸选包内资产 → chat.wallpaper.image 落 draft
		chooseSelect(screen.getByRole("combobox", { name: "聊天壁纸" }), "assets/deco.webp");
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.wallpaper?.image).toBe(
				"assets/deco.webp",
			),
		);
	});
});

describe("SkinEditor / 把这一套套到另一套", () => {
	function twoModes(): SkinManifest {
		return {
			schemaVersion: 1,
			name: "双套",
			modes: {
				light: {
					colors: { accent: "#fb7299" },
					wallpaper: { image: "assets/bg.png", overlay: 0.35 },
					radius: { card: 20 },
				},
				dark: { colors: { accent: "#00aeec" } },
			},
		};
	}

	it("单套皮肤没有这颗钮 —— 没有「另一套」可套", () => {
		renderEditor();
		expect(screen.queryByRole("button", { name: /同步到/ })).toBeNull();
		expect(screen.getByText("补一套深色")).toBeTruthy();
	});

	it("整套套过去 → 另一套变得一模一样,且只进预览不落盘", async () => {
		renderEditor({ manifest: twoModes() });
		fireEvent.click(screen.getByRole("button", { name: "同步到深色" }));
		fireEvent.click(screen.getByRole("button", { name: "整套套过去" }));

		await waitFor(() => {
			const m = useSkinStore.getState().preview?.manifest;
			expect(m?.modes.dark).toEqual(m?.modes.light);
		});
		// 落盘永远是主人点「保存」那一下的事(与「让女仆改」「恢复默认值」同构)。
		expect(H.putCalls).toHaveLength(0);
	});

	it("只套版式 → 壁纸圆角过去,配色留在原地", async () => {
		renderEditor({ manifest: twoModes() });
		fireEvent.click(screen.getByRole("button", { name: "同步到深色" }));
		fireEvent.click(screen.getByRole("button", { name: "只套版式(不动颜色)" }));

		await waitFor(() => {
			const d = useSkinStore.getState().preview?.manifest.modes.dark;
			expect(d?.wallpaper).toEqual({ image: "assets/bg.png", overlay: 0.35 });
			expect(d?.radius).toEqual({ card: 20 });
			expect(d?.colors).toEqual({ accent: "#00aeec" });
		});
	});

	it("弹窗里取消 → 一个字都不动", async () => {
		renderEditor({ manifest: twoModes() });
		fireEvent.click(screen.getByRole("button", { name: "同步到深色" }));
		// 底栏也有一颗「取消」,抽屉本身也是 role=dialog —— 从弹窗自己的钮反查它所在
		// 的那个 dialog,别点成关抽屉那颗。
		const dialog = screen
			.getByRole("button", { name: "整套套过去" })
			.closest('[role="dialog"]') as HTMLElement;
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "整套套过去" })).toBeNull());
		expect(useSkinStore.getState().preview?.manifest.modes.dark).toEqual({
			colors: { accent: "#00aeec" },
		});
	});
});
