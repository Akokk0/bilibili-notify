// @vitest-environment jsdom

/**
 * Subscriptions 页右键 / 长按快捷菜单的接线集成测试。验证:右键弹菜单;菜单五项各自接到
 * 正确的 api(删除走二次确认后 DELETE、禁用走 PATCH enabled、编辑标签走弹框后
 * PATCH tagIds、就地新建标签先 PUT 整张标签表、复制 UID 走剪贴板);批量删除也统一走确认框。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import { makeSource } from "../rules/__tests__/fixtures";
import Subscriptions from "../Subscriptions";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

vi.mock("../../utils/clipboard", () => ({
	copyToClipboard: vi.fn().mockResolvedValue(true),
}));

import { i18n } from "../../i18n";
import { copyToClipboard } from "../../utils/clipboard";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

function makeSub(uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "bilibili", externalId: uid }),
		cachedProfile: {
			name,
			followers: 0,
			refreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const TAGS = [GAME];

const SUB_A = makeSub("111", "UP甲");
const SUB_B = makeSub("222", "UP乙");

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subscriptions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		// `/api/subscriptions/tags` 也以 `/api/subscriptions` 开头:订阅列表那条必须精确匹配,别让标签表串味进来。
		if (path === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
		if (path === "/api/subscriptions/tags") return Promise.resolve([...TAGS]);
		if (path === "/api/subscriptions") return Promise.resolve([SUB_A, SUB_B]);
		if (path.startsWith("/api/targets")) return Promise.resolve([]);
		return Promise.resolve([]);
	});
	(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue(SUB_A);
	(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Subscriptions 快捷菜单", () => {
	it("context menu labels translate for enabled and disabled subscriptions without invoking their actions", async () => {
		const get = vi.mocked(api.get).getMockImplementation();
		if (!get) throw new Error("Expected the subscription API fixture");
		vi.mocked(api.get).mockImplementation((path) =>
			path === "/api/subscriptions"
				? (Promise.resolve([SUB_A, { ...SUB_B, enabled: false }]) as never)
				: get(path),
		);
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
		for (const [locale, names] of [
			[
				"en",
				["Edit details", "Disable subscription", "Copy UID", "Edit tags", "Delete subscription"],
			],
			["ja", ["詳細を編集", "購読を無効にする", "UIDをコピー", "タグを編集", "購読を削除"]],
			["zh-TW", ["編輯詳細資料", "停用訂閱", "複製 UID", "編輯標籤", "刪除訂閱"]],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const menu = within(screen.getByRole("menu"));
			for (const name of names) expect(menu.getByRole("menuitem", { name })).toBeTruthy();
		}
		fireEvent.keyDown(document, { key: "Escape" });
		fireEvent.contextMenu(screen.getByText("UP乙"), { clientX: 100, clientY: 100 });
		for (const [locale, name] of [
			["en", "Enable subscription"],
			["ja", "購読を有効にする"],
			["zh-TW", "啟用訂閱"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(within(screen.getByRole("menu")).getByRole("menuitem", { name })).toBeTruthy();
		}
		expect(api.post).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("list filters and selection labels translate while search, selected identities and user tag names remain unchanged", async () => {
		i18n.set({ locale: "en", voice: "plain" });
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
		fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
		for (const [locale, words] of [
			[
				"en",
				{
					search: "Search subscriptions by name or ID…",
					all: "All2",
					enabled: "Enabled2",
					disabled: "Disabled0",
					tags: "Tags",
					untagged: "Untagged2",
					selected: "2 selected",
					enable: "Enable selected",
					disable: "Disable selected",
					remove: "Delete selected",
					empty: "No matching subscriptions",
					hint: "Try another search or filter.",
				},
			],
			[
				"ja",
				{
					search: "名前またはIDで購読を検索…",
					all: "すべて2",
					enabled: "有効2",
					disabled: "無効0",
					tags: "タグ",
					untagged: "タグなし2",
					selected: "2件を選択中",
					enable: "選択項目を有効にする",
					disable: "選択項目を無効にする",
					remove: "選択項目を削除",
					empty: "一致する購読はありません",
					hint: "検索語や絞り込み条件を変更してください。",
				},
			],
			[
				"zh-TW",
				{
					search: "搜尋訂閱名稱或 ID…",
					all: "全部2",
					enabled: "已啟用2",
					disabled: "已停用0",
					tags: "標籤",
					untagged: "無標籤2",
					selected: "已選取 2 項",
					enable: "啟用所選項目",
					disable: "停用所選項目",
					remove: "刪除所選項目",
					empty: "沒有符合的訂閱",
					hint: "請換個關鍵字或篩選條件。",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const search = screen.getByPlaceholderText(words.search);
			expect(screen.getAllByRole("button", { name: words.all })[0]).toBeTruthy();
			expect(screen.getByRole("button", { name: words.enabled })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.untagged })).toBeTruthy();
			expect(screen.getByText(words.tags, { exact: true })).toBeTruthy();
			expect(screen.getByRole("button", { name: "游戏0" })).toBeTruthy();
			expect(screen.getByText(words.selected, { exact: true })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.enable })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.disable })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.remove })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: words.disabled }));
			expect(screen.getByText(words.empty)).toBeTruthy();
			expect(screen.getByText(words.hint)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: words.enabled }));
			fireEvent.change(search, { target: { value: "UP甲" } });
			expect(screen.queryByText("UP乙")).toBeNull();
			act(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
			expect((screen.getByPlaceholderText("搜索订阅的名字或 id…") as HTMLInputElement).value).toBe(
				"UP甲",
			);
			fireEvent.change(screen.getByPlaceholderText("搜索订阅的名字或 id…"), {
				target: { value: "" },
			});
		}
		expect(api.post).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it("deletion warnings translate without losing selected identities or deleting before confirmation", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
		fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
		fireEvent.click(screen.getByRole("button", { name: "批量删除" }));
		for (const [locale, title, warning, confirm] of [
			[
				"en",
				"Delete the 2 selected subscriptions?",
				"Deleting a subscription permanently removes all of its push settings.",
				"Confirm deletion",
			],
			[
				"ja",
				"選択した2件の購読を削除しますか？",
				"購読を削除すると、その購読の通知設定もすべて削除され、元に戻せません。",
				"削除を確定",
			],
			[
				"zh-TW",
				"刪除所選的 2 項訂閱？",
				"刪除訂閱時，該訂閱的所有推送設定也會一併移除，且無法復原。",
				"確認刪除",
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const dialog = within(screen.getByRole("dialog"));
			expect(dialog.getByText(title)).toBeTruthy();
			expect(dialog.getByText(warning)).toBeTruthy();
			expect(dialog.getByRole("button", { name: confirm })).toBeTruthy();
			expect(api.delete).not.toHaveBeenCalled();
		}
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
		expect(screen.getByText("已選取 2 項", { exact: true })).toBeTruthy();
		expect(api.delete).not.toHaveBeenCalled();
		act(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
		fireEvent.click(await screen.findByText("删除订阅"));
		for (const [locale, title] of [
			["en", "Delete this subscription?"],
			["ja", "この購読を削除しますか？"],
			["zh-TW", "刪除此訂閱？"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(within(screen.getByRole("dialog")).getByText(title)).toBeTruthy();
		}
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "確認刪除" }));
		await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`));
		expect(api.delete).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"en",
			{
				enable: "Enable selected",
				disable: "Disable selected",
				remove: "Delete selected",
				confirm: "Confirm deletion",
				enabledError: "Could not enable 1 of 2 subscriptions.",
				disabledError: "Could not disable 1 of 2 subscriptions.",
				deleteError: "Could not delete 1 of 2 subscriptions.",
			},
		],
		[
			"ja",
			{
				enable: "選択項目を有効にする",
				disable: "選択項目を無効にする",
				remove: "選択項目を削除",
				confirm: "削除を確定",
				enabledError: "2件中1件の購読を有効にできませんでした。",
				disabledError: "2件中1件の購読を無効にできませんでした。",
				deleteError: "2件中1件の購読を削除できませんでした。",
			},
		],
		[
			"zh-TW",
			{
				enable: "啟用所選項目",
				disable: "停用所選項目",
				remove: "刪除所選項目",
				confirm: "確認刪除",
				enabledError: "2 項訂閱中有 1 項無法啟用。",
				disabledError: "2 項訂閱中有 1 項無法停用。",
				deleteError: "2 項訂閱中有 1 項無法刪除。",
			},
		],
	] as const)(
		"partial bulk failures report translated counts without retrying successful subscriptions (%s)",
		async (locale, words) => {
			i18n.set({ locale, voice: "plain" });
			vi.mocked(api.post).mockImplementation(async (_path, body) => {
				if ((body as Subscription).id === SUB_B.id) throw new Error("original denied");
				return [SUB_A, SUB_B] as never;
			});
			vi.mocked(api.delete).mockImplementation(async (path) => {
				if (path.endsWith(SUB_B.id)) throw new Error("original denied");
				return undefined as never;
			});
			renderSubs();
			await screen.findByText("UP甲");
			for (const [action, message] of [
				[words.enable, words.enabledError],
				[words.disable, words.disabledError],
			] as const) {
				fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
				fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
				fireEvent.click(screen.getByRole("button", { name: action }));
				expect(await screen.findByText(message)).toBeTruthy();
				await waitFor(() =>
					expect(screen.queryByRole("button", { name: words.remove })).toBeNull(),
				);
			}
			expect(api.post).toHaveBeenCalledTimes(4);
			for (const enabled of [true, false]) {
				for (const sub of [SUB_A, SUB_B])
					expect(api.post).toHaveBeenCalledWith("/api/subscriptions", { ...sub, enabled });
			}
			fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
			fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
			fireEvent.click(screen.getByRole("button", { name: words.remove }));
			expect(api.delete).not.toHaveBeenCalled();
			fireEvent.click(
				within(screen.getByRole("dialog")).getByRole("button", { name: words.confirm }),
			);
			expect(await screen.findByText(words.deleteError)).toBeTruthy();
			expect(api.delete).toHaveBeenCalledTimes(2);
			expect(api.delete).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`);
			expect(api.delete).toHaveBeenCalledWith(`/api/subscriptions/${SUB_B.id}`);
			vi.mocked(api.post).mockResolvedValue([] as never);
		},
	);

	it("subscription loading and read failure guidance translate without replacing the original diagnostic or writing data", async () => {
		let rejectList!: (error: Error) => void;
		const pending = new Promise<Subscription[]>((_resolve, reject) => {
			rejectList = reject;
		});
		const get = vi.mocked(api.get).getMockImplementation();
		if (!get) throw new Error("Expected the subscription API fixture");
		vi.mocked(api.get).mockImplementation((path) =>
			path === "/api/subscriptions" ? (pending as never) : get(path),
		);
		i18n.set({ locale: "en", voice: "plain" });
		renderSubs();
		for (const [locale, loading, hint] of [
			["en", "Loading subscriptions…", "This should only take a moment."],
			["ja", "購読一覧を読み込み中…", "まもなく完了します。"],
			["zh-TW", "正在讀取訂閱清單…", "即將完成。"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(await screen.findByText(loading)).toBeTruthy();
			expect(screen.getByText(hint)).toBeTruthy();
		}
		await act(async () => rejectList(new Error("original database EACCES / 原因")));
		for (const [locale, message] of [
			["en", "Could not load subscriptions: original database EACCES / 原因"],
			["ja", "購読を読み込めませんでした：original database EACCES / 原因"],
			["zh-TW", "無法載入訂閱：original database EACCES / 原因"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(await screen.findByText(message)).toBeTruthy();
		}
		expect(api.post).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it.each([
		[
			"en",
			{
				copy: "Copy UID",
				copied: "Copied",
				copyFailed: "Could not copy. Copy the value manually.",
				disable: "Disable subscription",
				saveFailed: "The operation failed. Try again later.",
			},
		],
		[
			"ja",
			{
				copy: "UIDをコピー",
				copied: "コピーしました",
				copyFailed: "コピーできませんでした。手動でコピーしてください。",
				disable: "購読を無効にする",
				saveFailed: "操作に失敗しました。しばらくしてから再試行してください。",
			},
		],
		[
			"zh-TW",
			{
				copy: "複製 UID",
				copied: "已複製",
				copyFailed: "無法複製，請手動複製。",
				disable: "停用訂閱",
				saveFailed: "操作失敗，請稍後再試。",
			},
		],
	] as const)(
		"copy and patch feedback translate while the original external ID and failed subscription are retained (%s)",
		async (locale, words) => {
			i18n.set({ locale, voice: "plain" });
			vi.mocked(api.patch).mockRejectedValue(new Error("original denied"));
			renderSubs();
			await screen.findByText("UP甲");
			for (const [result, feedback] of [
				[false, words.copyFailed],
				[true, words.copied],
			] as const) {
				vi.mocked(copyToClipboard).mockResolvedValue(result);
				fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
				fireEvent.click(
					within(screen.getByRole("menu")).getByRole("menuitem", { name: words.copy }),
				);
				expect(await screen.findByText(feedback, { exact: true })).toBeTruthy();
			}
			expect(copyToClipboard).toHaveBeenNthCalledWith(1, "111");
			expect(copyToClipboard).toHaveBeenNthCalledWith(2, "111");
			fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
			fireEvent.click(
				within(screen.getByRole("menu")).getByRole("menuitem", { name: words.disable }),
			);
			expect(await screen.findByText(words.saveFailed)).toBeTruthy();
			expect(screen.getByText("UP甲")).toBeTruthy();
			expect(api.patch).toHaveBeenCalledTimes(1);
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`, { enabled: false });
			expect(api.post).not.toHaveBeenCalled();
			expect(api.delete).not.toHaveBeenCalled();
		},
	);

	it("右键卡片 → 弹出快捷菜单", async () => {
		renderSubs();
		await screen.findByText("UP甲");

		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		expect(await screen.findByText("删除订阅")).toBeTruthy();
	});

	it("菜单「删除订阅」→ 弹二次确认 → 确认后 DELETE 该订阅", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("删除订阅"));
		fireEvent.click(await screen.findByText("确认删除"));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`));
	});

	it("菜单删除的确认框点取消 → 不删除", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
		fireEvent.click(await screen.findByText("删除订阅"));

		fireEvent.click(await screen.findByText("取消"));

		expect(api.delete).not.toHaveBeenCalled();
	});

	it("菜单「禁用订阅」→ PATCH enabled:false", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("禁用订阅"));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`, { enabled: false }),
		);
	});

	it("菜单「编辑标签」→ 弹框 → 勾选已有的标签并确定 → PATCH tagIds,不动标签表", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("编辑标签"));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(await within(dialog).findByRole("checkbox", { name: "游戏" }));
		fireEvent.click(within(dialog).getByText("确定"));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`, {
				tagIds: [GAME.id],
			}),
		);
		expect(api.put).not.toHaveBeenCalled();
	});

	it("菜单「编辑标签」→ 就地新建并确定 → 先 PUT 整张表(末尾追加),再 PATCH tagIds 挂上新标签", async () => {
		// 服务端回存下的那张表;这里就是请求体原样。
		(api.put as ReturnType<typeof vi.fn>).mockImplementation((_path: string, body: unknown) =>
			Promise.resolve(body),
		);
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("编辑标签"));
		const dialog = await screen.findByRole("dialog");
		// 等标签表读到(读到之前不许新建)。
		await within(dialog).findByRole("checkbox", { name: "游戏" });
		fireEvent.change(within(dialog).getByPlaceholderText("新建标签名"), {
			target: { value: "重点" },
		});
		fireEvent.click(within(dialog).getByText("添加"));
		await within(dialog).findByRole("checkbox", { name: "重点" });
		fireEvent.click(within(dialog).getByText("确定"));

		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		const put = api.put as ReturnType<typeof vi.fn>;
		expect(put).toHaveBeenCalledTimes(1);
		const [path, table] = put.mock.calls[0] as [string, Array<{ id: string; name: string }>];
		expect(path).toBe("/api/subscriptions/tags");
		expect(table).toHaveLength(2);
		expect(table[0]).toEqual(GAME);
		expect(table[1].name).toBe("重点");
		expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`, {
			tagIds: [table[1].id],
		});
		// 先落标签表、再挂到订阅上:订阅上只许挂表里有的 id,次序反了会被服务端 400。
		expect(put.mock.invocationCallOrder[0]).toBeLessThan(
			(api.patch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
		);
	});

	it("菜单「复制 UID」→ 调 copyToClipboard(uid) 并弹提示", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("复制 UID"));

		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("111"));
		expect(await screen.findByText(/已复制/)).toBeTruthy();
	});

	it("批量删除 → 弹确认框 → 确认后逐个 DELETE 选中项", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		// 勾选两张卡(点一次后该卡的选择框 aria-label 变「已选」,故每次都取当前第一个「选择」)
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);

		fireEvent.click(await screen.findByText("批量删除"));
		fireEvent.click(await screen.findByText("确认删除"));

		await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2));
	});

	it("抽屉「移除订阅」→ 弹确认框 → 确认后 DELETE", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.click(screen.getByText("UP甲")); // 打开抽屉

		fireEvent.click(await screen.findByText("移除订阅"));
		fireEvent.click(await screen.findByText("确认删除"));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/subscriptions/${SUB_A.id}`));
	});

	it("批量禁用后 → 自动清空勾选(批量栏消失)", async () => {
		(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
		expect(screen.getByText(/已选 2 项/)).toBeTruthy();

		fireEvent.click(screen.getByText("批量禁用"));

		await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());
	});
});
