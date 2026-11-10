// @vitest-environment jsdom
import { chooseSelect } from "../../__tests__/select-controls";
import { i18n } from "../../i18n";

/**
 * 编辑器的**皮肤这一档**:名字 / 作者 / 说明的接线(ADR-0014 第二步续)。
 *
 * 从前皮肤装进来叫什么名字就再也改不了 —— 编辑器与皮肤库都没有入口。补上这一档时最容易
 * 留下的是静默失败:框敲得动、头部那行也跟着变,**存出去的清单里却还是旧名**(改的是草稿
 * 的副本)。所以这里只看两样东西:`PUT` 出去的那份 payload,以及只读皮肤上这几个口在不在。
 *
 * 另钉「存不下去就把保存钮灰掉」:不拦的话按下去吃的是装包门一句「name: 太短」或
 * 「knobs[3]: 旋钮 key「accent」重复」—— 皮肤里带名字的东西有好几样(块有 id、字体有
 * family),那个 3 也对不上界面上第几行,主人根本不知道说的是哪一个。
 *
 * 下半场是**旋钮声明**:皮肤声明几枚,卡片页那个旋钮区就画几个控件。编辑器从前一枚都编
 * 不了,自制皮肤的旋钮区于是永远是空的。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import CardSkinEditor from "../CardSkinEditor";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const MANIFEST = {
	schemaVersion: 2,
	name: "霓虹",
	author: "阿绫",
	cards: {
		live: {
			width: 600,
			css: "",
			blocks: [
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			],
		},
	},
};

function mockApi({ builtin = false, knobs }: { builtin?: boolean; knobs?: unknown[] } = {}): void {
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url === "/api/cards/skins") {
			return Promise.resolve({
				skins: [
					{ id: "default", name: "默认", builtin: true, updatedAt: 0, knobs: [] },
					{ id: "neon", name: "霓虹", builtin, updatedAt: 0, knobs: [] },
				],
				active: "neon",
				fallbacks: [],
			});
		}
		if (url === "/api/cards/skins/neon") {
			const manifest = structuredClone(MANIFEST) as Record<string, unknown>;
			if (knobs) manifest.knobs = structuredClone(knobs);
			return Promise.resolve({ manifest });
		}
		return Promise.resolve({});
	});
	vi.mocked(api.post).mockResolvedValue({
		html: "<html><body></body></html>",
		width: 600,
		warnings: [],
		scene: "streaming",
	});
	vi.mocked(api.put).mockResolvedValue({ ok: true, warnings: [] });
}

function renderEditor() {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/cards/skins/neon"]}>
				<Routes>
					<Route path="/cards/skins/:id" element={<CardSkinEditor />} />
					<Route path="/library" element={<LibraryLocation />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

function LibraryLocation() {
	const location = useLocation();
	return (
		<output aria-label="返回位置">
			{location.pathname}
			{location.search}
		</output>
	);
}

it("编辑完成后返回资源库的卡片皮肤分类", async () => {
	mockApi();
	renderEditor();
	fireEvent.click(await screen.findByRole("button", { name: "返回资源库" }));
	expect((await screen.findByLabelText("返回位置")).textContent).toBe(
		"/library?category=card-skins",
	);
});

/** 最近一次 `PUT` 出去的那份清单。 */
const saved = () =>
	vi.mocked(api.put).mock.calls.at(-1)?.[1] as {
		name: string;
		author?: string;
		description?: string;
	};

/** 最近一次 `PUT` 出去那份清单里的旋钮表。 */
const savedKnobs = (): Array<Record<string, unknown>> =>
	(saved() as unknown as { knobs?: Array<Record<string, unknown>> }).knobs ?? [];

const saveBtn = () => screen.getByRole("button", { name: "保存" });
const save = () => fireEvent.click(saveBtn());

/** 点头部那行皮肤名 —— 它就是进这一档的门。 */
async function openSkinTab(name = "霓虹"): Promise<void> {
	fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 · 皮肤这一档的接线", () => {
	it.each([
		["en", "Skin name", "Author", "Description", "Save"],
		["ja", "スキン名", "作者", "説明", "保存"],
		["zh-TW", "外觀名稱", "作者", "說明", "儲存"],
	] as const)(
		"%s metadata labels translate while original text remains editable and built-ins remain read-only",
		async (locale, name, author, description, saveLabel) => {
			mockApi();
			renderEditor();
			await openSkinTab();
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(api.put).not.toHaveBeenCalled();
			expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe("霓虹");
			expect((screen.getByLabelText(author) as HTMLInputElement).value).toBe("阿绫");
			fireEvent.change(screen.getByLabelText(name), { target: { value: "Original name 原文" } });
			fireEvent.change(screen.getByLabelText(author), { target: { value: "" } });
			fireEvent.change(screen.getByLabelText(description), {
				target: { value: "Original description 原文" },
			});
			fireEvent.click(screen.getByRole("button", { name: saveLabel }));
			await waitFor(() => expect(api.put).toHaveBeenCalled());
			expect(saved()).toMatchObject({
				name: "Original name 原文",
				description: "Original description 原文",
				cards: MANIFEST.cards,
			});
			expect(saved()).not.toHaveProperty("author");
			cleanup();
			mockApi({ builtin: true });
			renderEditor();
			await openSkinTab();
			for (const label of [name, author, description])
				expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
		},
	);
	it.each([
		[
			"en",
			"The built-in default skin is read-only. To edit it, return to the library and duplicate it first.",
			"Save",
			"Back to library",
		],
		[
			"ja",
			"内蔵の既定スキンは読み取り専用です。編集するには、ライブラリーに戻って先に複製してください。",
			"保存",
			"ライブラリーに戻る",
		],
		["zh-TW", "內建預設外觀為唯讀；若要編輯，請先返回資源庫複製一份。", "儲存", "返回資源庫"],
	] as const)(
		"%s built-in warning stays read-only and returns to the card skin library",
		async (locale, warning, saveLabel, back) => {
			mockApi({ builtin: true });
			renderEditor();
			await screen.findByText("封面图");
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(warning)).toBeTruthy();
			expect((screen.getByRole("button", { name: saveLabel }) as HTMLButtonElement).disabled).toBe(
				true,
			);
			fireEvent.click(screen.getByRole("button", { name: back }));
			expect((await screen.findByLabelText("返回位置")).textContent).toBe(
				"/library?category=card-skins",
			);
			expect(api.put).not.toHaveBeenCalled();
		},
	);
	it.each([
		["en", "Save", "Saving…", "Save failed: Original failure 原文"],
		["ja", "保存", "保存中…", "保存に失敗しました：Original failure 原文"],
		["zh-TW", "儲存", "儲存中…", "儲存失敗：Original failure 原文"],
	] as const)(
		"%s saving state and failure translate without discarding the edited manifest",
		async (locale, saveLabel, saving, failed) => {
			mockApi();
			let rejectSave: ((error: Error) => void) | undefined;
			vi.mocked(api.put).mockReturnValue(
				new Promise<never>((_resolve, reject) => {
					rejectSave = reject;
				}),
			);
			renderEditor();
			await screen.findByText("封面图");
			await openSkinTab();
			fireEvent.change(screen.getByLabelText("皮肤名"), {
				target: { value: "Original draft 原文" },
			});
			act(() => i18n.set({ locale, voice: "plain" }));
			fireEvent.click(screen.getByRole("button", { name: saveLabel }));
			expect(
				((await screen.findByRole("button", { name: saving })) as HTMLButtonElement).disabled,
			).toBe(true);
			if (!rejectSave) throw new Error("save was not started");
			await act(async () => {
				rejectSave?.(new Error("Original failure 原文"));
			});
			expect(await screen.findByText(failed)).toBeTruthy();
			expect(
				(
					screen.getByLabelText(
						{ en: "Skin name", ja: "スキン名", "zh-TW": "外觀名稱" }[locale],
					) as HTMLInputElement
				).value,
			).toBe("Original draft 原文");
			expect((screen.getByRole("button", { name: saveLabel }) as HTMLButtonElement).disabled).toBe(
				false,
			);
			expect(api.put).toHaveBeenCalledTimes(1);
			expect(saved()).toMatchObject({
				name: "Original draft 原文",
				author: "阿绫",
				cards: MANIFEST.cards,
			});
		},
	);
	it.each([
		["en", "Unable to load this skin: Original diagnostic 原文", "Save"],
		["ja", "スキンを読み込めません：Original diagnostic 原文", "保存"],
		["zh-TW", "無法讀取此外觀：Original diagnostic 原文", "儲存"],
	] as const)(
		"%s load failure localizes the complete message and keeps raw diagnostics",
		async (locale, message, saveLabel) => {
			mockApi();
			const baseGet = vi.mocked(api.get).getMockImplementation();
			if (!baseGet) throw new Error("base API fixture is not configured");
			vi.mocked(api.get).mockImplementation((url: string) =>
				url === "/api/cards/skins/neon"
					? Promise.reject(new Error("Original diagnostic 原文"))
					: baseGet(url),
			);
			i18n.set({ locale, voice: "plain" });
			renderEditor();
			expect(await screen.findByText(message)).toBeTruthy();
			expect((screen.getByRole("button", { name: saveLabel }) as HTMLButtonElement).disabled).toBe(
				true,
			);
			expect(api.put).not.toHaveBeenCalled();
		},
	);
	it.each([
		[
			"en",
			"Back to library",
			"Save",
			"Unsaved changes",
			"Grid canvas · Live card",
			"Inspector",
			"In use",
		],
		[
			"ja",
			"ライブラリーに戻る",
			"保存",
			"未保存の変更あり",
			"グリッドキャンバス · 配信カード",
			"インスペクター",
			"使用中",
		],
		["zh-TW", "返回資源庫", "儲存", "有未儲存的變更", "網格畫布 · 直播卡片", "檢查器", "使用中"],
	] as const)(
		"%s editor actions translate while preserving the current card and unsaved skin metadata",
		async (locale, back, saveLabel, dirty, canvas, inspector, inUse) => {
			mockApi();
			renderEditor();
			await screen.findByText("封面图");
			await openSkinTab();
			fireEvent.change(screen.getByLabelText("皮肤名"), {
				target: { value: "Original name 原名" },
			});
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByRole("button", { name: back })).toBeTruthy();
			expect(screen.getByText(dirty)).toBeTruthy();
			expect(screen.getByText(canvas)).toBeTruthy();
			expect(screen.getByText(inspector)).toBeTruthy();
			expect(screen.getByText(inUse)).toBeTruthy();
			expect(
				(screen.getByLabelText(locale === "en" ? "Author" : "作者") as HTMLInputElement).value,
			).toBe("阿绫");
			expect(api.put).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: saveLabel }));
			await waitFor(() =>
				expect(api.put).toHaveBeenCalledWith(
					"/api/cards/skins/neon",
					expect.objectContaining({
						name: "Original name 原名",
						author: "阿绫",
						cards: MANIFEST.cards,
					}),
				),
			);
		},
	);
	it("点头部皮肤名 → 检查器换成皮肤那一档;改名存出去真的是新名", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "青柠" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(saved().name).toBe("青柠");
	});

	it("作者与说明同一根线;清空的那个是**删键**,不是空串", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("说明"), { target: { value: "夜里好看" } });
		fireEvent.change(screen.getByLabelText("作者"), { target: { value: "" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(saved().description).toBe("夜里好看");
		expect("author" in saved()).toBe(false);
	});

	it("名字空了 → 保存钮变灰,并且说出是哪儿不对", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "  " } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("皮肤得有个名字")).toBeTruthy();
	});

	it("内置皮肤是只读的 —— 这三个框一个都不给编", async () => {
		mockApi({ builtin: true });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		for (const label of ["皮肤名", "作者", "说明"]) {
			expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
		}
	});
});

/**
 * 旋钮声明的接线。皮肤声明几枚旋钮,卡片页那个旋钮区就画几个控件 —— 编辑器从前一枚都
 * 编不了,所以**自制皮肤的旋钮区永远是空的**。
 *
 * 同样只看 `PUT` 出去那份 payload:面板上加得出一行、改得动档位,而清单里一个字没变,
 * 是这条线最像成功的失败形态。
 */
describe("编辑器 · 旋钮声明的接线", () => {
	it.each([
		{
			locale: "en",
			first: "Control 1",
			second: "Control 2",
			third: "Control 3",
			initial: "Initial value",
			image: "Images have no initial value.",
			save: "Save",
			help: "Each declaration adds a control to Skin controls on the card settings page. Changes are injected as --bn-knob-<key>; reference them in this skin’s CSS with var(--bn-knob-<key>, fallback). Initial values are not injected. The CSS fallback is the actual default.",
		},
		{
			locale: "ja",
			first: "調整項目1",
			second: "調整項目2",
			third: "調整項目3",
			initial: "初期値",
			image: "画像には初期値がありません。",
			save: "保存",
			help: "宣言した項目は、カード設定画面の「スキンの調整」に表示されます。変更値は --bn-knob-<key> として注入され、スキンのCSSから var(--bn-knob-<key>, fallback) で参照できます。初期値は注入されません。実際の既定値はCSSのフォールバックです。",
		},
		{
			locale: "zh-TW",
			first: "調整項目 1",
			second: "調整項目 2",
			third: "調整項目 3",
			initial: "起始值",
			image: "圖片沒有起始值。",
			save: "儲存",
			help: "宣告的項目會顯示於卡片設定頁的「外觀調整」。修改值會注入為 --bn-knob-<key>，可在此外觀的 CSS 中使用 var(--bn-knob-<key>, fallback) 引用。起始值不會注入，真正的預設值是 CSS 中的後備值。",
		},
	] as const)(
		"$locale explains initial values and preserves color, font and image declaration shapes",
		async (l) => {
			const knobs = [
				{ key: "accent", label: "Original accent", type: "color", default: "#123456" },
				{ key: "font", label: "Original font", type: "font", default: "Original Font" },
				{ key: "wallpaper", label: "Original wallpaper", type: "image" },
			];
			mockApi({ knobs });
			renderEditor();
			await openSkinTab();
			act(() => i18n.set({ locale: l.locale, voice: "plain" }));
			expect(screen.getByText(l.help)).toBeTruthy();
			expect(api.put).not.toHaveBeenCalled();
			fireEvent.change(
				within(screen.getByRole("group", { name: l.first })).getByLabelText(l.initial),
				{ target: { value: "#abcdef" } },
			);
			fireEvent.change(
				within(screen.getByRole("group", { name: l.second })).getByLabelText(l.initial),
				{ target: { value: "Original Font 原文" } },
			);
			const image = within(screen.getByRole("group", { name: l.third }));
			expect(image.getByText(l.image)).toBeTruthy();
			expect(image.queryByLabelText(l.initial)).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: l.save }));
			await waitFor(() => expect(api.put).toHaveBeenCalled());
			expect(savedKnobs()).toEqual([
				{ key: "accent", label: "Original accent", type: "color", default: "#abcdef" },
				{ key: "font", label: "Original font", type: "font", default: "Original Font 原文" },
				{ key: "wallpaper", label: "Original wallpaper", type: "image" },
			]);
			expect(saved()).toMatchObject({ cards: MANIFEST.cards });
			cleanup();
			mockApi({ builtin: true, knobs });
			renderEditor();
			await openSkinTab();
			expect(
				(
					within(screen.getByRole("group", { name: l.second })).getByLabelText(
						l.initial,
					) as HTMLInputElement
				).disabled,
			).toBe(true);
		},
	);
	it("加一枚 → 存出去的清单里真的有 knobs", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()).toHaveLength(1);
		expect(savedKnobs()[0]).toMatchObject({ type: "color" });
	});

	it("改 key / 名字 / 档位 → 三样都存得出去,改档时值跟着换形状", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();
		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));

		fireEvent.change(screen.getByLabelText("旋钮 key"), { target: { value: "glass-opacity" } });
		fireEvent.change(screen.getByLabelText("旋钮名字"), { target: { value: "玻璃白纱" } });
		chooseSelect(screen.getByRole("combobox", { name: "旋钮档位" }), "数值");
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({
			key: "glass-opacity",
			label: "玻璃白纱",
			type: "number",
		});
		// 档位换了,起手位置得是那一档的形状 —— 留着 `"#ffffff"` 的话装包门当场拒。
		expect(typeof (savedKnobs()[0] as { default: unknown }).default).toBe("number");
	});

	it("删掉唯一那一枚 → 存出去的清单里连 knobs 键都没了(不是留个空数组)", async () => {
		// 夹具自带一枚:加完再删是净零,草稿不脏、保存钮本来就该灰着,那样测不到这根线。
		mockApi({ knobs: [{ key: "accent", label: "主色", type: "color", default: "#e0c3fc" }] });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /删掉这枚旋钮/ }));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect("knobs" in (saved() as object)).toBe(false);
	});

	it("key 撞了 → 保存钮变灰,并且说出是哪个 key", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();
		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));
		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));

		// 读 DOM 属性不保险(受控件的 `value` 属性未必跟着走),取的是元素的属性值。
		const keys = screen.getAllByLabelText("旋钮 key") as HTMLInputElement[];
		fireEvent.change(keys[1], { target: { value: keys[0].value } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/重复了/)).toBeTruthy();
	});

	it("内置皮肤是只读的 —— 加不了也删不掉", async () => {
		mockApi({ builtin: true });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		expect(screen.queryByRole("button", { name: /添加旋钮/ })).toBeNull();
	});
});

/**
 * 三档自己那几项的接线。这一段最像成功的失败形态是**改得动、存不出去**:数值那一行的
 * 取值域框敲得动,而 `PUT` 里还是 0~100。
 */
describe("编辑器 · 三档附加字段的接线", () => {
	it.each([
		{
			locale: "en",
			first: "Control 1",
			second: "Control 2",
			third: "Control 3",
			min: "Minimum",
			max: "Maximum",
			step: "Step",
			unit: "Unit",
			initial: "Initial value",
			on: "CSS value when on",
			off: "CSS value when off",
			option: "Option CSS value",
			optionLabel: "Option label",
			chip: "Initial",
			save: "Save",
		},
		{
			locale: "ja",
			first: "調整項目1",
			second: "調整項目2",
			third: "調整項目3",
			min: "最小値",
			max: "最大値",
			step: "刻み幅",
			unit: "単位",
			initial: "初期値",
			on: "オン時のCSS値",
			off: "オフ時のCSS値",
			option: "選択肢のCSS値",
			optionLabel: "選択肢の表示名",
			chip: "初期",
			save: "保存",
		},
		{
			locale: "zh-TW",
			first: "調整項目 1",
			second: "調整項目 2",
			third: "調整項目 3",
			min: "最小值",
			max: "最大值",
			step: "步進值",
			unit: "單位",
			initial: "起始值",
			on: "開啟時的 CSS 值",
			off: "關閉時的 CSS 值",
			option: "選項 CSS 值",
			optionLabel: "選項名稱",
			chip: "起始",
			save: "儲存",
		},
	] as const)(
		"$locale numeric, switch and select controls preserve typed values and CSS literals",
		async (l) => {
			mockApi({
				knobs: [
					{ key: "blur", label: "Original blur", type: "number", default: 8, min: 0, max: 40 },
					{
						key: "badge",
						label: "Original badge",
						type: "switch",
						default: true,
						on: "block",
						off: "none",
					},
					{
						key: "corner",
						label: "Original corner",
						type: "select",
						default: "12px",
						options: [
							{ value: "12px", label: "Original round" },
							{ value: "0px", label: "Original square" },
						],
					},
				],
			});
			renderEditor();
			await openSkinTab();
			act(() => i18n.set({ locale: l.locale, voice: "plain" }));
			expect(api.put).not.toHaveBeenCalled();
			const num = within(screen.getByRole("group", { name: l.first }));
			fireEvent.change(num.getByLabelText(l.min), { target: { value: "2" } });
			fireEvent.change(num.getByLabelText(l.max), { target: { value: "24" } });
			fireEvent.change(num.getByLabelText(l.step), { target: { value: "2" } });
			fireEvent.change(num.getByLabelText(l.initial), { target: { value: "10" } });
			chooseSelect(num.getByRole("combobox", { name: l.unit }), "px");
			const toggle = within(screen.getByRole("group", { name: l.second }));
			fireEvent.change(toggle.getByLabelText(l.on), { target: { value: "flex" } });
			fireEvent.change(toggle.getByLabelText(l.off), { target: { value: "contents" } });
			fireEvent.click(toggle.getByRole("button", { name: l.initial }));
			const choice = within(screen.getByRole("group", { name: l.third }));
			fireEvent.change(choice.getAllByLabelText(l.option)[1], { target: { value: "4px" } });
			fireEvent.change(choice.getAllByLabelText(l.optionLabel)[1], {
				target: { value: "Original slight 原文" },
			});
			fireEvent.click(choice.getAllByRole("button", { name: l.chip })[1]);
			fireEvent.click(screen.getByRole("button", { name: l.save }));
			await waitFor(() => expect(api.put).toHaveBeenCalled());
			expect(savedKnobs()).toEqual([
				{
					key: "blur",
					label: "Original blur",
					type: "number",
					default: 10,
					min: 2,
					max: 24,
					step: 2,
					unit: "px",
				},
				{
					key: "badge",
					label: "Original badge",
					type: "switch",
					default: false,
					on: "flex",
					off: "contents",
				},
				{
					key: "corner",
					label: "Original corner",
					type: "select",
					default: "4px",
					options: [
						{ value: "12px", label: "Original round" },
						{ value: "4px", label: "Original slight 原文" },
					],
				},
			]);
		},
	);
	const numberKnob = [{ key: "blur", label: "糊化", type: "number", default: 8, min: 0, max: 40 }];
	const selectKnob = [
		{
			key: "corner",
			label: "圆角",
			type: "select",
			default: "12px",
			options: [{ value: "12px", label: "圆" }],
		},
	];
	const switchKnob = [
		{ key: "badge", label: "徽章", type: "switch", default: true, on: "block", off: "none" },
	];

	it("数值:取值域 / 步长 / 单位都存得出去", async () => {
		mockApi({ knobs: numberKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("取值上限"), { target: { value: "24" } });
		fireEvent.change(screen.getByLabelText("步长"), { target: { value: "2" } });
		chooseSelect(screen.getByRole("combobox", { name: "单位" }), "px");
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({ min: 0, max: 24, step: 2, unit: "px" });
	});

	it("数值:单位选回「无单位」→ 键删掉,不是存个空串", async () => {
		mockApi({ knobs: [{ ...numberKnob[0], unit: "px" }] });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		chooseSelect(screen.getByRole("combobox", { name: "单位" }), "无单位");
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect("unit" in (savedKnobs()[0] ?? {})).toBe(false);
	});

	it("开关:两端的字面量存得出去", async () => {
		mockApi({ knobs: switchKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("开的时候注什么"), { target: { value: "flex" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({ on: "flex", off: "none" });
	});

	it("下拉:加一个候选、把它设成起手位置 —— 两样都存得出去", async () => {
		mockApi({ knobs: selectKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /添加候选/ }));
		fireEvent.change(screen.getAllByLabelText("候选注什么")[1] as HTMLInputElement, {
			target: { value: "0px" },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "起手" })[1] as HTMLElement);
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({
			default: "0px",
			options: [
				{ value: "12px", label: "圆" },
				{ value: "0px", label: "候选 2" },
			],
		});
	});

	it("下拉:起手位置被改得不在候选里 → 保存钮变灰并说清楚", async () => {
		mockApi({ knobs: selectKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		// 只有一个候选时它就是起手位置;把它的值改掉,起手位置立刻悬空。
		fireEvent.change(screen.getByLabelText("候选注什么"), { target: { value: "0px" } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/不在候选里/)).toBeTruthy();
	});

	it("下拉:只剩一个候选时删不掉 —— 那颗钮压根不出现", async () => {
		mockApi({ knobs: selectKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		expect(screen.queryByRole("button", { name: /删掉这个候选/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /添加候选/ }));
		expect(screen.getAllByRole("button", { name: /删掉这个候选/ })).toHaveLength(2);
	});
});

/**
 * 皮肤的**资产**与**自带字体**。清单里的 `asset:assets/<文件>` 只能指包内文件 —— 这两节
 * 是把文件送进包里、再让字体指到它的唯一一条路。
 *
 * 钉四条:① 传上去之后候选表里**当场有它**(不刷新就选不到 = 这根线等于没接);② 字体
 * 那张表的 family 与指向都存得出去;③ 传的是**皮肤目录**那条路由,不是主人自己的字体库
 * (指错了地方,导出的 zip 里就没有这份字体,别人装上是回落字体);④ 只读皮肤上传不了。
 */
describe("编辑器 · 皮肤资产与自带字体", () => {
	/** `GET /:id/assets` 的活值 —— 传完要重拉,这里模拟服务端那份在变。 */
	let assets: string[] = [];

	function mockWithAssets(builtin = false): void {
		assets = [];
		vi.mocked(api.get).mockImplementation(async (url: string) => {
			if (url === "/api/cards/skins") {
				return {
					skins: [
						{ id: "default", name: "默认", builtin: true, updatedAt: 0, knobs: [] },
						{ id: "neon", name: "霓虹", builtin, updatedAt: 0, knobs: [] },
					],
					active: "neon",
					fallbacks: [],
				};
			}
			if (url === "/api/cards/skins/neon") return { manifest: structuredClone(MANIFEST) };
			if (url === "/api/cards/skins/neon/assets") return { assets: [...assets] };
			if (url === "/api/cards/renderer") return { enabled: true };
			return {};
		});
		vi.mocked(api.post).mockResolvedValue({
			html: "<html><body></body></html>",
			width: 600,
			warnings: [],
			scene: "streaming",
		});
		vi.mocked(api.put).mockResolvedValue({ ok: true, warnings: [] });
		vi.mocked(api.upload).mockImplementation(async () => {
			assets.push("assets/song.ttf");
			return { name: "assets/song.ttf" };
		});
	}

	const pick = (file: File) =>
		fireEvent.change(screen.getByLabelText("传一份资产"), { target: { files: [file] } });

	it.each([
		[
			"en",
			"Upload asset",
			"Add font",
			"Font family",
			"Font asset",
			"Save",
			"This skin has no bundled files.",
			"Images and fonts are stored in this skin’s package and included in its exported ZIP. Reference them as asset:<name> in block CSS or HTML.",
			"Each row creates an @font-face rule. Use font-family:<family> in block CSS to apply it.",
		],
		[
			"ja",
			"アセットをアップロード",
			"フォントを追加",
			"フォント名",
			"フォントのアセット",
			"保存",
			"このスキンに同梱ファイルはありません。",
			"画像とフォントはこのスキンのパッケージ内に保存され、書き出すZIPにも含まれます。ブロックのCSSやHTMLでは asset:<name> で参照できます。",
			"各行で @font-face ルールを1つ定義します。ブロックのCSSで font-family:<family> を指定すると適用できます。",
		],
		[
			"zh-TW",
			"上傳素材",
			"新增字型",
			"字型名稱",
			"字型素材",
			"儲存",
			"此外觀尚未附帶任何檔案。",
			"圖片與字型儲存於此外觀的套件內，匯出的 ZIP 也會包含這些檔案。在區塊 CSS 或 HTML 中，使用 asset:<name> 引用。",
			"每列會建立一條 @font-face 規則。在區塊 CSS 中使用 font-family:<family> 即可套用。",
		],
	] as const)(
		"%s bundled assets and fonts use localized controls and preserve package references",
		async (locale, upload, add, family, asset, saveLabel, empty, assetHelp, fontHelp) => {
			mockWithAssets();
			renderEditor();
			await openSkinTab();
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(empty)).toBeTruthy();
			expect(screen.getByText(assetHelp)).toBeTruthy();
			expect(screen.getByText(fontHelp)).toBeTruthy();
			expect(api.upload).not.toHaveBeenCalled();
			await act(async () => {
				fireEvent.change(screen.getByLabelText(upload), {
					target: { files: [new File([new Uint8Array([1])], "song.ttf")] },
				});
			});
			expect(vi.mocked(api.upload).mock.calls.at(-1)?.[0]).toBe("/api/cards/skins/neon/assets");
			await screen.findByText("assets/song.ttf");
			fireEvent.click(screen.getByRole("button", { name: add }));
			fireEvent.change(screen.getByLabelText(family), { target: { value: "Original Font 原文" } });
			chooseSelect(screen.getByRole("combobox", { name: asset }), "assets/song.ttf");
			fireEvent.click(screen.getByRole("button", { name: saveLabel }));
			await waitFor(() => expect(api.put).toHaveBeenCalled());
			expect((saved() as unknown as { fonts: unknown }).fonts).toEqual([
				{ family: "Original Font 原文", asset: "asset:assets/song.ttf" },
			]);
			cleanup();
			mockWithAssets(true);
			renderEditor();
			await openSkinTab();
			expect(screen.queryByLabelText(upload)).toBeNull();
			expect(screen.queryByRole("button", { name: add })).toBeNull();
		},
	);

	it("传一份字体 → 走皮肤目录那条路由,传完候选表里当场有它", async () => {
		mockWithAssets();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		await act(async () => {
			pick(new File([new Uint8Array([1])], "song.ttf"));
		});

		expect(vi.mocked(api.upload).mock.calls.at(-1)?.[0]).toBe("/api/cards/skins/neon/assets");
		expect(await screen.findByText("assets/song.ttf")).toBeTruthy();
	});

	it("自带字体:起一行、填 family、指到那份资产 —— 三样都存得出去", async () => {
		mockWithAssets();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();
		await act(async () => {
			pick(new File([new Uint8Array([1])], "song.ttf"));
		});
		await screen.findByText("assets/song.ttf");

		fireEvent.click(screen.getByRole("button", { name: /添加字体/ }));
		fireEvent.change(screen.getByLabelText("字体名"), { target: { value: "Song" } });
		chooseSelect(screen.getByRole("combobox", { name: "用哪份资产" }), "assets/song.ttf");
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		const body = saved() as unknown as { fonts?: Array<Record<string, unknown>> };
		expect(body.fonts).toEqual([{ family: "Song", asset: "asset:assets/song.ttf" }]);
	});

	it("一份资产都没有 → 字体那张表说清楚要先传,而不是给一个空下拉", async () => {
		mockWithAssets();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /添加字体/ }));
		expect(screen.getByText(/先在上面传一份字体文件/)).toBeTruthy();
	});

	it("内置皮肤是只读的 —— 传不了也加不了", async () => {
		mockWithAssets(true);
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		expect(screen.queryByLabelText("传一份资产")).toBeNull();
		expect(screen.queryByRole("button", { name: /添加字体/ })).toBeNull();
	});
});

it.each([
	[
		"ja",
		"ご主人様、左で選んだシーンに出るブロックだけを並べていますよ。画像一覧や動画など、そのシーンだけのブロックは切り替えると現れます。ブロックを選ぶと右のインスペクターで位置を変えられます。カバー画像などの1枚画像は上下の端を引くと高さが変わり、それ以外は内容に合わせて高くなります。",
		"ご主人様、内蔵の既定スキンは編集できませんよ。スキンライブラリーに戻り、「コピーして編集」してから編集してくださいね。",
		"保存",
		"ライブラリーに戻る",
	],
	[
		"zh-TW",
		"主人，這裡只排列左側所選場景會出現的區塊喔；圖庫、影片等特定場景的區塊，切換後才會顯示。選一個區塊，就能在右側檢查器改位置；封面這類單張圖片可拖曳上下邊緣調高度，其他區塊則由內容撐高。",
		"主人，內建預設外觀不能編輯喔；請先回外觀資源庫「複製並編輯」，再來修改吧。",
		"儲存",
		"返回資源庫",
	],
] as const)(
	"%s 女仆场景指导与内置只读提示切语不保存，并返回资源库分类",
	async (locale, scene, readonly, saveLabel, back) => {
		mockApi({ builtin: true });
		renderEditor();
		await screen.findByText("封面图");
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(scene)).toBeTruthy();
		expect(screen.getByText(readonly)).toBeTruthy();
		expect((screen.getByRole("button", { name: saveLabel }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(api.put).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: back }));
		expect((await screen.findByLabelText("返回位置")).textContent).toBe(
			"/library?category=card-skins",
		);
		expect(api.put).not.toHaveBeenCalled();
	},
);
