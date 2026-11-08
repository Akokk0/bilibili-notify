// @vitest-environment jsdom

/**
 * 卡片皮肤库那一节(ADR-0014 决策 5 / 20)。
 *
 * 钉的五条各对应一个静默失败:① 内置那份排首位 + 「使用中」跟着 `active` 走(排序
 * 写反 / 徽标读错字段,页面照样长得像一回事);② 「启用」打的是 `PUT /active`(启用
 * 指针住在配置里,不在店里);③ 删不掉时服务端那句「谁在用」原样露给主人 ——
 * 自编一句「删除失败」等于把唯一能照着去改的线索吞掉;④ 内置那份**没有**删除钮
 * (摆一颗点了必失败的钮是骗人);⑤ 上传成功后列表真的重取(不 invalidate 的话新
 * 装的皮肤要刷页面才看得见)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CardSkinSection } from "../CardSkinSection";

const { FakeApiError } = vi.hoisted(() => {
	// 与真 `ApiError` 一样:`code` / `issues` 从错误体里读出来。
	class FakeApiError extends Error {
		readonly code?: string;
		readonly issues?: Array<{ message: string }>;
		constructor(
			readonly status: number,
			readonly body: unknown,
			message: string,
		) {
			super(message);
			const b = body as { code?: string; issues?: Array<{ message: string }> } | undefined;
			this.code = b?.code;
			this.issues = b?.issues;
		}
	}
	return { FakeApiError };
});

vi.mock("../../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(),
		put: vi.fn(),
		post: vi.fn(),
		delete: vi.fn(),
		upload: vi.fn(),
	},
}));

import { i18n } from "../../../i18n";
import { api } from "../../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

/** 服务端刻意把内置那份排在后面 —— 首位是本节自己排出来的,不是抄来的顺序。 */
const LIST = {
	skins: [
		{
			id: "aurora",
			name: "极光",
			author: "伦伦酱",
			description: "冷色玻璃",
			builtin: false,
			updatedAt: 2,
		},
		{ id: "default", name: "默认皮肤", builtin: true, updatedAt: 0 },
	],
	active: "aurora",
};

function Location() {
	const location = useLocation();
	return (
		<output aria-label="当前位置">
			{location.pathname}
			{location.search}
		</output>
	);
}

function renderSection(mode: "select" | "manage" = "manage") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// 「编辑」那颗钮要跳路由,所以这一节现在吃 router context。
	return render(
		<MemoryRouter>
			<Location />
			<QueryClientProvider client={qc}>
				<CardSkinSection mode={mode} />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/**
 * 某套皮肤那一行(行内按钮都从这里面找,免得撞上别行的同名钮)。
 *
 * 按 `data-skin` 找,**不按 class 串找** —— 从前这里写的是
 * `closest("div.flex.items-center.gap-3")`,一次排版调整(把名字与那排钮改成上下两行)
 * 就让五条用例一起红,而被测的行为一点没变。
 */
async function rowOf(name: string): Promise<HTMLElement> {
	const label = await screen.findByText(name);
	const row = label.closest("[data-skin]");
	if (!row) throw new Error(`row for ${name} not found`);
	return row as HTMLElement;
}

beforeEach(() => {
	vi.mocked(api.get).mockResolvedValue(LIST);
	vi.mocked(api.put).mockResolvedValue({ ok: true });
	vi.mocked(api.post).mockResolvedValue({ id: "aurora-copy" });
	vi.mocked(api.delete).mockResolvedValue({ ok: true });
	vi.mocked(api.upload).mockResolvedValue({ id: "new-skin", warnings: [] });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/**
 * 出图回落的账本(决策 19「回落必须可见」)。刻意不做 toast —— 回落发生在推送那一刻,
 * 主人多半不在面板前。这两条钉的是:**列得出来**(账本下发了却没人画,等于决策 19 没做),
 * 以及**「知道了」真的打到服务端**(只在前端藏起来的话,刷一下页面它又回来了)。
 */
describe("卡片皮肤库 · 回落告警", () => {
	it("localized fallback notices keep original reasons and unknown skin IDs while acknowledging the existing ledger", async () => {
		vi.mocked(api.get).mockResolvedValue({
			...LIST,
			fallbacks: [
				{
					skinId: "aurora",
					kind: "live",
					reason: "Original timeout 原因",
					at: 1757000000000,
					count: 1,
				},
				{
					skinId: "orphan-skin",
					kind: "live",
					reason: "Original timeout 原因",
					at: 1757000000000,
					count: 3,
				},
			],
		});
		for (const [locale, w] of [
			[
				"en",
				{
					title: "Some cards could not use their skin and fell back to the built-in default.",
					known: "极光 · Live card: Original timeout 原因",
					unknown: "Skin orphan-skin · Live card: Original timeout 原因",
					count: "(3 times)",
					ack: "Acknowledge",
				},
			],
			[
				"ja",
				{
					title: "一部のカードをスキンで描画できず、内蔵の既定スキンに切り替えました。",
					known: "极光・配信カード：Original timeout 原因",
					unknown: "スキン orphan-skin・配信カード：Original timeout 原因",
					count: "（3回）",
					ack: "確認",
				},
			],
			[
				"zh-TW",
				{
					title: "部分卡片無法套用外觀，已回退至內建預設外觀。",
					known: "极光的直播卡片：Original timeout 原因",
					unknown: "外觀 orphan-skin的直播卡片：Original timeout 原因",
					count: "（3 次）",
					ack: "了解",
				},
			],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			vi.mocked(api.delete).mockClear();
			const { unmount } = renderSection("select");
			await screen.findByText(w.title);
			expect(screen.getByText((text) => text.startsWith(w.known))).toBeTruthy();
			expect(
				screen.getByText((text) => text.startsWith(w.unknown) && text.includes(w.count)),
			).toBeTruthy();
			expect(api.delete).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: w.ack }));
			await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/cards/skins/fallbacks"));
			expect(api.put).not.toHaveBeenCalled();
			unmount();
		}
	});

	const WITH_FALLBACK = {
		...LIST,
		fallbacks: [
			{ skinId: "aurora", kind: "live", reason: "渲染失败(超时)", at: 1_757_000_000_000, count: 3 },
		],
	};

	it("账本非空 → 把「哪套皮肤、哪种卡、为什么」摆出来,皮肤名按 id 对回去", async () => {
		vi.mocked(api.get).mockResolvedValue(WITH_FALLBACK);
		renderSection("select");
		const note = await screen.findByText(/有卡片没能按皮肤画出来/);
		// WarnNote 自带 `data-bn="note note-warn"` —— 爬到它那层才是整块告警,
		// 爬一层只会停在标题那个 div 上。
		const box = note.closest('[data-bn~="note"]');
		if (!box) throw new Error("告警盒没渲染");
		expect(within(box as HTMLElement).getByText(/极光 的直播卡渲染失败\(超时\)/)).toBeTruthy();
		// 账本记的是 id,面板要回头对成名字 —— 对不上才退回 id。
		expect(box.textContent).not.toContain("aurora");
		expect(box.textContent).toContain("3 次");
	});

	it("点「知道了」打 DELETE /api/cards/skins/fallbacks 并重取列表", async () => {
		vi.mocked(api.get).mockResolvedValue(WITH_FALLBACK);
		renderSection("select");
		const before = vi.mocked(api.get).mock.calls.length;
		fireEvent.click(await screen.findByText("知道了"));
		await waitFor(() =>
			expect(vi.mocked(api.delete)).toHaveBeenCalledWith("/api/cards/skins/fallbacks"),
		);
		await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(before));
	});

	it("账本空 → 一个字都不画", async () => {
		renderSection("select");
		await screen.findByText("极光");
		expect(screen.queryByText(/有卡片没能按皮肤画出来/)).toBeNull();
	});
});

describe("卡片皮肤库", () => {
	it("empty libraries and the builtin appearance badge are localized without selecting or importing resources", async () => {
		for (const [locale, builtin, empty] of [
			["en", "Built-in skin", "The skin library is empty. Upload a skin package to get started."],
			[
				"ja",
				"内蔵スキン",
				"スキンライブラリーは空です。スキンパッケージをアップロードしてください。",
			],
			["zh-TW", "內建外觀", "外觀資源庫是空的，請先上傳外觀套件。"],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			vi.mocked(api.get).mockResolvedValue({ ...LIST, active: "default" });
			const view = renderSection();
			await screen.findByText(builtin);
			view.unmount();
			vi.mocked(api.get).mockResolvedValue({ skins: [], active: "default" });
			const blank = renderSection();
			await screen.findByText(empty);
			expect(api.put).not.toHaveBeenCalled();
			expect(api.upload).not.toHaveBeenCalled();
			blank.unmount();
		}
	});

	it("localized deletion requires confirmation and preserves the server conflict explanation", async () => {
		const reason = "Original owner 原订阅 still uses this skin";
		vi.mocked(api.delete).mockRejectedValue(
			new FakeApiError(409, { code: "conflict", message: reason }, reason),
		);
		for (const [locale, w] of [
			[
				"en",
				{
					remove: "Delete",
					title: "Delete card skin",
					message: "Delete “极光”? This cannot be undone.",
					cancel: "Cancel",
					failure: "Operation failed: ",
				},
			],
			[
				"ja",
				{
					remove: "削除",
					title: "カードスキンを削除",
					message: "「极光」を削除しますか？この操作は取り消せません。",
					cancel: "キャンセル",
					failure: "操作に失敗しました：",
				},
			],
			[
				"zh-TW",
				{
					remove: "刪除",
					title: "刪除卡片外觀",
					message: "確定刪除「极光」？刪除後無法復原。",
					cancel: "取消",
					failure: "操作失敗：",
				},
			],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			vi.mocked(api.delete).mockClear();
			const { unmount } = renderSection();
			const row = within(await rowOf("极光"));
			fireEvent.click(row.getByRole("button", { name: w.remove }));
			const dialog = await screen.findByRole("dialog");
			expect(within(dialog).getByText(w.title)).toBeTruthy();
			expect(within(dialog).getByText(w.message)).toBeTruthy();
			fireEvent.click(within(dialog).getByRole("button", { name: w.cancel }));
			expect(api.delete).not.toHaveBeenCalled();
			fireEvent.click(row.getByRole("button", { name: w.remove }));
			fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: w.remove }));
			await screen.findByText(`${w.failure}${reason}`);
			expect(api.delete).toHaveBeenCalledWith("/api/cards/skins/aurora");
			expect(api.put).not.toHaveBeenCalled();
			unmount();
		}
	});

	it("localized library controls retain original resources and copy builtins before editing", async () => {
		for (const [locale, w] of [
			[
				"en",
				{
					title: "Card skins · card-skin",
					hint: "Import and manage notification card skins. Choose one in card settings. Built-in skins are read-only; copy them before editing.",
					applied: "Skin applied",
					builtin: "Built-in",
					used: "In use",
					upload: "Upload skin package",
					copyEdit: "Copy and edit",
					edit: "Edit",
					copy: "Duplicate",
					export: "Export",
					remove: "Delete",
					author: "Author: 伦伦酱 · 冷色玻璃",
				},
			],
			[
				"ja",
				{
					title: "カードスキン · card-skin",
					hint: "通知カードのスキンをインポート・管理します。使用するスキンはカード設定で選びます。内蔵スキンは読み取り専用のため、編集前にコピーしてください。",
					applied: "スキン適用中",
					builtin: "内蔵",
					used: "使用中",
					upload: "スキンをアップロード",
					copyEdit: "コピーして編集",
					edit: "編集",
					copy: "複製",
					export: "エクスポート",
					remove: "削除",
					author: "作者：伦伦酱 · 冷色玻璃",
				},
			],
			[
				"zh-TW",
				{
					title: "卡片外觀 · card-skin",
					hint: "匯入與管理通知卡片的外觀；選用請到卡片設定。內建外觀為唯讀，修改前請先複製。",
					applied: "已套用外觀",
					builtin: "內建",
					used: "使用中",
					upload: "上傳外觀套件",
					copyEdit: "複製並編輯",
					edit: "編輯",
					copy: "複製一份",
					export: "匯出",
					remove: "刪除",
					author: "作者：伦伦酱 · 冷色玻璃",
				},
			],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			vi.mocked(api.post).mockClear();
			const { unmount } = renderSection();
			const builtin = within(await rowOf("默认皮肤"));
			const custom = within(await rowOf("极光"));
			expect(screen.getByText(w.title)).toBeTruthy();
			expect(screen.getByText(w.hint)).toBeTruthy();
			expect(screen.getByText(w.applied)).toBeTruthy();
			expect(screen.getByLabelText(w.upload)).toBeTruthy();
			expect(builtin.getByText(w.builtin)).toBeTruthy();
			expect(builtin.queryByRole("button", { name: w.remove })).toBeNull();
			expect(custom.getByText(w.used)).toBeTruthy();
			expect(custom.getByRole("button", { name: w.edit })).toBeTruthy();
			expect(custom.getByRole("button", { name: w.copy })).toBeTruthy();
			expect(custom.getByRole("button", { name: w.export })).toBeTruthy();
			expect(custom.getByRole("button", { name: w.remove })).toBeTruthy();
			expect(screen.getByText(w.author)).toBeTruthy();
			fireEvent.click(builtin.getByRole("button", { name: w.copyEdit }));
			await waitFor(() =>
				expect(screen.getByLabelText("当前位置").textContent).toBe("/cards/skins/aurora-copy"),
			);
			expect(api.post).toHaveBeenCalledWith("/api/cards/skins/default/duplicate", {});
			expect(api.put).not.toHaveBeenCalled();
			unmount();
		}
	});

	it("内置皮肤复制后才编辑，不启用副本", async () => {
		renderSection();
		fireEvent.click(within(await rowOf("默认皮肤")).getByRole("button", { name: "复制并编辑" }));
		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/cards/skins/default/duplicate", {}),
		);
		expect(api.put).not.toHaveBeenCalled();
	});

	it("管理资源当前页直达卡片皮肤分类，不切换当前默认皮肤", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		try {
			renderSection("select");
			await screen.findByText("极光");
			fireEvent.click(screen.getByRole("button", { name: "管理资源" }));
			expect(screen.getByLabelText("当前位置").textContent).toBe("/library?category=card-skins");
			expect(open).not.toHaveBeenCalled();
			expect(api.put).not.toHaveBeenCalled();
			expect(screen.getByRole("combobox")).toBeTruthy();
		} finally {
			open.mockRestore();
		}
	});
	it("内置那份排首位,「使用中」跟着 active 走", async () => {
		renderSection();
		await screen.findByText("默认皮肤");

		const names = screen.getAllByText(/默认皮肤|极光/).map((el) => el.textContent);
		expect(names[0]).toBe("默认皮肤");

		expect(within(await rowOf("默认皮肤")).getByText("内置")).toBeTruthy();
		// active = aurora,所以「使用中」在极光那行,不在内置那行。
		expect(within(await rowOf("极光")).getByText("使用中")).toBeTruthy();
		expect(within(await rowOf("默认皮肤")).queryByText("使用中")).toBeNull();
		// 作者与描述合成一行。
		expect(screen.getByText("作者：伦伦酱 · 冷色玻璃")).toBeTruthy();
	});

	it("「启用」打 PUT /api/cards/skins/active", async () => {
		renderSection("select");
		fireEvent.click(await screen.findByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: "默认皮肤（内置）" }));

		await waitFor(() =>
			expect(api.put).toHaveBeenCalledWith("/api/cards/skins/active", { id: "default" }),
		);
	});

	it("选用当前皮肤不重复写入，原页不提供编辑或删除", async () => {
		renderSection("select");
		fireEvent.click(await screen.findByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: "极光" }));
		expect(api.put).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
	});

	it("内置那份不给删除钮", async () => {
		renderSection();
		expect(within(await rowOf("默认皮肤")).queryByRole("button", { name: "删除" })).toBeNull();
		// 反面:自制那套有。
		expect(within(await rowOf("极光")).getByRole("button", { name: "删除" })).toBeTruthy();
	});

	it("删除撞 conflict → 把服务端 message 里点名的「谁在用」原样显示出来", async () => {
		const message = "这套皮肤还在用（全局默认，小白 单独指定了它），换掉之后再删";
		vi.mocked(api.delete).mockRejectedValue(
			new FakeApiError(409, { code: "conflict", message }, message),
		);

		renderSection();
		const row = await rowOf("极光");
		fireEvent.click(within(row).getByRole("button", { name: "删除" }));

		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

		await screen.findByText(/这套皮肤还在用（全局默认，小白 单独指定了它），换掉之后再删/);
	});

	it("上传的包没过装包门 → 概括与逐条原因都显示出来(只读 message 会把线索丢了)", async () => {
		vi.mocked(api.upload).mockRejectedValue(
			new FakeApiError(
				400,
				{
					code: "invalid",
					message: "这个皮肤包没通过检查（共 2 条）",
					issues: [{ message: "name 缺失" }, { message: "cards 不是对象" }],
				},
				"这个皮肤包没通过检查（共 2 条）",
			),
		);

		const { container } = renderSection();
		await screen.findByText("极光");
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File([new Uint8Array([1])], "skin.zip", { type: "application/zip" })] },
		});

		await screen.findByText(/这个皮肤包没通过检查（共 2 条）：name 缺失；cards 不是对象/);
	});

	it("上传成功 → 列表重取,并把清洗提示列出来", async () => {
		vi.mocked(api.upload).mockImplementation(async (path) =>
			path.endsWith("/import-preview")
				? { ok: true, name: "新皮肤", warnings: [], conflict: false }
				: {
						id: "new-skin",
						warnings: ["直播卡「封面」块的 filter 声明已丢弃"],
					},
		);

		const { container } = renderSection();
		await screen.findByText("极光");
		const before = vi.mocked(api.get).mock.calls.length;

		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File([new Uint8Array([1, 2, 3])], "skin.zip", { type: "application/zip" });
		fireEvent.change(input, { target: { files: [file] } });
		const dialog = await screen.findByRole("dialog");
		expect(vi.mocked(api.upload).mock.calls.at(-1)?.[0]).toBe("/api/cards/skins/import-preview");
		expect(vi.mocked(api.get).mock.calls.length).toBe(before);
		fireEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));

		await waitFor(() => expect(api.upload).toHaveBeenCalled());
		await waitFor(() => expect(vi.mocked(api.upload).mock.calls.length).toBe(2));
		const [uploadUrl, form] = vi.mocked(api.upload).mock.calls[1] as [string, FormData];
		expect(uploadUrl).toBe("/api/cards/skins");
		expect(form.get("file")).toBe(file);

		// invalidate 之后列表必须真的再取一次 —— 不然新装的皮肤要刷页面才看得见。
		await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(before));
		await screen.findByText("直播卡「封面」块的 filter 声明已丢弃");
	});
});
