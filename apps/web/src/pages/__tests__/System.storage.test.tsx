// @vitest-environment jsdom

import type { GenerationView, StorageUsageResponse } from "@bilibili-notify/contract";
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import System from "../System";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const USAGE: StorageUsageResponse = {
	rows: [
		{ category: "stats", sizeBytes: 1048576, clearable: true },
		{ category: "historyText", sizeBytes: 2048, clearable: true },
		{ category: "historyImages", sizeBytes: 4096, clearable: true },
		{ category: "ai", sizeBytes: 8192, clearable: true },
		{ category: "generations", sizeBytes: 65536, clearable: false, deletableGenerations: 1 },
		{ category: "otherImages", sizeBytes: 32768, clearable: false },
		{ category: "logs", sizeBytes: 16384, clearable: false },
	],
};
const GENERATIONS: GenerationView[] = [];
const clients: QueryClient[] = [];

function renderSystem(initialEntry = "/system") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
	clients.push(qc);
	render(
		<MemoryRouter initialEntries={[initialEntry]}>
			<QueryClientProvider client={qc}>
				<System />
			</QueryClientProvider>
		</MemoryRouter>,
	);
	return qc;
}

async function openStorage() {
	fireEvent.click(screen.getByRole("button", { name: "存储" }));
	const list = await screen.findByRole("list", { name: "分类用量" });
	await waitFor(() =>
		expect((screen.getByRole("button", { name: "重新测量" }) as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	return list;
}

beforeEach(() => {
	GENERATIONS.length = 0;
	i18n.set({ locale: "zh-CN", voice: "plain" });
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	vi.resetAllMocks();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/settings") return { core: makeDefaultGlobalSettings() };
		if (path === "/api/settings/invalid") return { entries: [] };
		if (path === "/api/settings/integrations") return { integrations: [] };
		if (path === "/api/sources/bilibili/auth") return { state: { status: "logged-out" } };
		if (path === "/api/connections/capabilities") return {};
		if (path === "/api/system/storage") return structuredClone(USAGE);
		if (path === "/api/system/generations") return { generations: structuredClone(GENERATIONS) };
		return [];
	});
});

function generation(seq: number, patch: Partial<GenerationView> = {}): GenerationView {
	return {
		seq,
		current: false,
		partial: false,
		formatVersion: 1,
		createdBy: "1.0.0",
		lastActiveAt: null,
		deletable: true,
		lockReason: null,
		deletableAt: null,
		sizeBytes: 1048576,
		reclaimableBytes: 65536,
		...patch,
	};
}

it("旧代展示目录大小与可释放下界，受保护的代不能删除，可删代仍需确认", async () => {
	GENERATIONS.push(
		generation(2),
		generation(3, { current: true, deletable: false, lockReason: "current" }),
		generation(0, {
			deletable: false,
			lockReason: "protected-source",
			deletableAt: "2026-12-01T00:00:00.000Z",
		}),
	);
	vi.mocked(api.delete).mockResolvedValue({ freedBytes: 16384 });
	renderSystem();
	await openStorage();
	const list = await screen.findByRole("list", { name: "旧代列表" });
	expect(within(list).getAllByText("目录大小：1 MiB")).toHaveLength(3);
	expect(within(list).getAllByText("可释放至少：64 KiB")).toHaveLength(3);
	expect(
		(within(list).getByRole("button", { name: "删除第 3 代" }) as HTMLButtonElement).disabled,
	).toBe(true);
	expect(
		(within(list).getByRole("button", { name: "删除第 0 代" }) as HTMLButtonElement).disabled,
	).toBe(true);
	expect(within(list).getByText("当前正在使用，不能删除。")).toBeTruthy();
	expect(within(list).getByText("当前代的来源代，需保留至保护期结束。")).toBeTruthy();
	fireEvent.click(within(list).getByRole("button", { name: "删除第 2 代" }));
	expect(screen.getByRole("dialog").textContent).toContain("64 KiB");
	expect(screen.getByRole("dialog").textContent).toContain("无法恢复");
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
	expect(api.delete).not.toHaveBeenCalled();
	fireEvent.click(within(list).getByRole("button", { name: "删除第 2 代" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认删除" }));
	await screen.findByText("已删除旧代，释放至少 16 KiB。");
	expect(api.delete).toHaveBeenCalledExactlyOnceWith("/api/system/generations/2");
	await waitFor(() =>
		expect(
			vi.mocked(api.get).mock.calls.filter(([path]) => path === "/api/system/generations"),
		).toHaveLength(2),
	);
});

it("手动清扫先说明引用和24小时保护，取消不请求，按服务端回报显示每种结果", async () => {
	vi.mocked(api.post).mockResolvedValue({
		removedCount: 3,
		removedBytes: 2048,
		referenced: 11,
		inGrace: 5,
	});
	renderSystem();
	await openStorage();
	fireEvent.click(screen.getByRole("button", { name: "清扫图库" }));
	expect(screen.getByRole("dialog").textContent).toContain("24 小时");
	expect(screen.getByRole("dialog").textContent).toContain("引用");
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
	expect(api.post).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "清扫图库" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认清扫" }));
	await screen.findByText("已删除 3 张图片，实际释放 2 KiB；仍有引用 11 张，宽限期内 5 张。");
	expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/system/storage/images/sweep");
	expect(api.delete).not.toHaveBeenCalled();
});

it("历史保留在存储分区沿用七档草稿，跨区及即时清理不丢草稿，保存只写历史设置", async () => {
	vi.mocked(api.delete).mockResolvedValue({ freedBytes: 0 });
	renderSystem();
	fireEvent.click(screen.getByRole("button", { name: "运行" }));
	await screen.findByText("Core · 应用");
	expect(screen.queryByText("图片与重推原件保留")).toBeNull();
	await openStorage();
	const field = document.querySelector<HTMLElement>('[data-code="core.history.retentionDays"]');
	expect(field).toBeTruthy();
	if (!field) return;
	expect(
		within(field)
			.getAllByRole("button")
			.map((button) => button.textContent),
	).toEqual(["90 天", "60 天", "30 天", "15 天", "7 天", "3 天", "1 天"]);
	fireEvent.click(within(field).getByRole("button", { name: "7 天" }));
	fireEvent.click(screen.getByRole("button", { name: "运行" }));
	await openStorage();
	expect(screen.getByRole("button", { name: "7 天" }).getAttribute("aria-pressed")).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "清空女仆 AI" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认清空" }));
	await screen.findByText("已清空，实际释放 0 B。");
	expect(screen.getByRole("button", { name: "7 天" }).getAttribute("aria-pressed")).toBe("true");
	expect(api.patch).not.toHaveBeenCalled();
	await act(async () => {
		await useDraftStore.getState().current?.onSave();
	});
	expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/settings", {
		core: { history: { retentionDays: 7 } },
	});
});

it("操作处理中显示状态并阻止重复清理，失败如实展示且可重新确认重试", async () => {
	let rejectDelete: (error: Error) => void = () => {};
	vi.mocked(api.delete).mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectDelete = reject;
			}),
	);
	renderSystem();
	await openStorage();
	fireEvent.click(screen.getByRole("button", { name: "清空数据统计" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认清空" }));
	await screen.findByText("正在处理存储操作…");
	for (const name of ["清空数据统计", "清扫图库", "重新测量"])
		expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
	await act(async () => rejectDelete(new Error("disk busy")));
	await screen.findByText("操作失败：disk busy");
	expect(screen.queryByText(/已清空/)).toBeNull();
	vi.mocked(api.delete).mockResolvedValueOnce({ freedBytes: 0 });
	fireEvent.click(screen.getByRole("button", { name: "清空数据统计" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认清空" }));
	await screen.findByText("已清空，实际释放 0 B。");
	expect(api.delete).toHaveBeenCalledTimes(2);
});

it("删除时保护条件已变化：保留服务端失败原因并刷新列表，不继续提供旧的可删状态", async () => {
	GENERATIONS.push(generation(1));
	vi.mocked(api.delete).mockImplementation(async () => {
		GENERATIONS[0] = generation(1, { deletable: false, lockReason: "protected-previous" });
		throw new Error("generation is protected");
	});
	renderSystem();
	await openStorage();
	fireEvent.click(screen.getByRole("button", { name: "删除第 1 代" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认删除" }));
	await screen.findByText("操作失败：generation is protected");
	expect(
		within(screen.getByRole("region", { name: "旧版本数据" })).getByText(
			"操作失败：generation is protected",
		),
	).toBeTruthy();
	await screen.findByText("上一代数据，需保留至保护期结束。");
	expect((screen.getByRole("button", { name: "删除第 1 代" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	expect(screen.queryByText(/已删除旧代/)).toBeNull();
	expect(api.delete).toHaveBeenCalledTimes(1);
});

it("用量读取失败保留未知态，重新测量可恢复，不显示为零或提供清空按钮", async () => {
	const get = vi.mocked(api.get).getMockImplementation();
	let fail = true;
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/system/storage" && fail) throw new Error("measurement unavailable");
		return get?.(path);
	});
	renderSystem();
	fireEvent.click(screen.getByRole("button", { name: "存储" }));
	await screen.findByText("读取失败：measurement unavailable");
	expect(screen.queryByRole("list", { name: "分类用量" })).toBeNull();
	expect(screen.queryByRole("button", { name: "清空数据统计" })).toBeNull();
	fail = false;
	fireEvent.click(screen.getByRole("button", { name: "重新测量" }));
	expect(await screen.findByRole("list", { name: "分类用量" })).toBeTruthy();
});

it("所有旧代保护原因都单独显示，写到一半与未知格式也不给绕过入口", async () => {
	const locks = [
		["current", "当前正在使用，不能删除。"],
		["partial", "这代尚未写完，由启动流程处理，不能在此删除。"],
		["unreadable", "代信息无法读取，不能安全删除；需要手动检查。"],
		["newer-format", "数据格式比当前程序更新，不能删除。"],
		["protected-source", "当前代的来源代，需保留至保护期结束。"],
		["protected-previous", "上一代数据，需保留至保护期结束。"],
		["current-age-unknown", "无法确定当前代的创建时间，旧代暂受保护。"],
	] as const;
	for (const [index, [lockReason]] of locks.entries())
		GENERATIONS.push(
			generation(index, {
				deletable: false,
				lockReason,
				partial: lockReason === "partial",
				current: lockReason === "current",
			}),
		);
	renderSystem();
	await openStorage();
	const list = await screen.findByRole("list", { name: "旧代列表" });
	for (const [index, [, reason]] of locks.entries()) {
		expect(within(list).getByText(reason)).toBeTruthy();
		expect(
			(within(list).getByRole("button", { name: `删除第 ${index} 代` }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	}
	expect(api.delete).not.toHaveBeenCalled();
});

it("存储深链直接打开该分区，切换口吻保留实际操作结果并现取文字", async () => {
	vi.mocked(api.delete).mockResolvedValue({ freedBytes: 512 });
	renderSystem("/system#storage");
	await screen.findByRole("list", { name: "分类用量" });
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "清空数据统计" }) as HTMLButtonElement).disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "清空数据统计" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认清空" }));
	await screen.findByText("已清空，实际释放 512 B。");
	act(() => i18n.set({ locale: "zh-CN", voice: "maid" }));
	await screen.findByText("主人，已清空，实际释放了 512 B。");
	expect(
		within(screen.getByRole("list", { name: "分类用量" })).getAllByRole("listitem"),
	).toHaveLength(7);
	expect(api.delete).toHaveBeenCalledTimes(1);
});

afterEach(() => {
	cleanup();
	for (const qc of clients.splice(0)) qc.clear();
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

it("只在打开存储分区时测量，七类用量保留只读行，清空仅开放四类", async () => {
	renderSystem();
	expect(vi.mocked(api.get).mock.calls.some(([path]) => path === "/api/system/storage")).toBe(
		false,
	);
	const list = await openStorage();
	const rows = within(list).getAllByRole("listitem");
	expect(rows).toHaveLength(7);
	expect(rows.map((row) => within(row).getByRole("heading").textContent)).toEqual([
		"数据统计",
		"推送历史文字",
		"推送历史图片",
		"女仆 AI",
		"日志",
		"其他图片",
		"旧版本数据",
	]);
	expect(within(rows[0]).getByText("1 MiB")).toBeTruthy();
	for (const row of rows.slice(0, 4))
		expect(within(row).getByRole("button", { name: /清空/ })).toBeTruthy();
	for (const row of rows.slice(4))
		expect(within(row).queryByRole("button", { name: /清空/ })).toBeNull();
	expect(api.delete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "运行" }));
	await openStorage();
	await waitFor(() =>
		expect(
			vi.mocked(api.get).mock.calls.filter(([path]) => path === "/api/system/storage"),
		).toHaveLength(2),
	);
});

it.each([
	["stats", "数据统计", "订阅以来涨粉的起点将从清空后重新计算"],
	["historyText", "推送历史文字", "年度总结的「你和 BN」"],
	["historyImages", "推送历史图片", "保留今天的图片"],
	["ai", "女仆 AI", "全部女仆对话"],
])(
	"清空 %s 先说明实际范围并确认，取消不请求，完成显示实际释放量",
	async (category, label, warning) => {
		vi.mocked(api.delete).mockResolvedValue({ freedBytes: 512 });
		renderSystem();
		await openStorage();
		fireEvent.click(screen.getByRole("button", { name: `清空${label}` }));
		expect(screen.getByRole("dialog").textContent).toContain(warning);
		expect(screen.getByRole("dialog").textContent).toContain("无法恢复");
		expect(api.delete).not.toHaveBeenCalled();
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
		expect(api.delete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: `清空${label}` }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认清空" }));
		await screen.findByText("已清空，实际释放 512 B。");
		expect(api.delete).toHaveBeenCalledExactlyOnceWith(`/api/system/storage/${category}`);
		await waitFor(() =>
			expect(
				vi.mocked(api.get).mock.calls.filter(([path]) => path === "/api/system/storage"),
			).toHaveLength(2),
		);
		expect(api.patch).not.toHaveBeenCalled();
	},
);

it.each([
	[
		"ja",
		"ご主人様、昨日までの履歴画像と再送用の元データを削除しますよ。今日の画像は残しますね。",
		"ご主人様、いま使っている世代は削除できませんよ。",
		"ご主人様、削除が完了しました。実際に空いた容量は512 Bですよ。",
		"削除する",
	],
	[
		"zh-TW",
		"主人，這會清理截至昨天的歷史圖片與重送原始資料，今天的圖片會保留喔。",
		"主人，目前正在使用的這一代不能刪除喔。",
		"主人，已清空，實際釋出了 512 B。",
		"確認清空",
	],
] as const)(
	"%s maid storage confirmation keeps protection and does not repeat an explicit clear",
	async (locale, scope, protectedHint, done, confirm) => {
		GENERATIONS.push(generation(3, { current: true, deletable: false, lockReason: "current" }));
		vi.mocked(api.delete).mockResolvedValue({ freedBytes: 512 });
		renderSystem();
		const list = await openStorage();
		const protectedButton = await screen.findByRole("button", { name: "删除第 3 代" });
		fireEvent.click(screen.getByRole("button", { name: "清空推送历史图片" }));
		const dialog = screen.getByRole("dialog");
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(dialog.textContent).toContain(scope);
		expect(dialog.textContent).toContain("4 KiB");
		expect(screen.getByText(protectedHint)).toBeTruthy();
		expect((protectedButton as HTMLButtonElement).disabled).toBe(true);
		expect(list.querySelectorAll("li")).toHaveLength(7);
		expect(api.delete).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
		await screen.findByText(done);
		for (const voice of ["plain", "maid"] as const) {
			act(() => i18n.set({ voice }));
			if (voice === "maid") expect(screen.getByText(done)).toBeTruthy();
			expect(api.delete).toHaveBeenCalledExactlyOnceWith("/api/system/storage/historyImages");
			expect(api.post).not.toHaveBeenCalled();
			expect(api.patch).not.toHaveBeenCalled();
		}
	},
);

it("storage confirmation translates in place while keeping category, protection and actual freed bytes", async () => {
	GENERATIONS.push(generation(3, { current: true, deletable: false, lockReason: "current" }));
	vi.mocked(api.delete).mockResolvedValue({ freedBytes: 512 });
	renderSystem();
	const list = await openStorage();
	const protectedButton = (await screen.findByRole("button", {
		name: "删除第 3 代",
	})) as HTMLButtonElement;
	fireEvent.click(screen.getByRole("button", { name: "清空推送历史图片" }));
	const dialog = screen.getByRole("dialog");
	for (const [locale, confirm, today] of [
		["en", "Confirm clear", "Keep today’s images"],
		["ja", "削除する", "今日の画像は残します"],
		["zh-TW", "確認清空", "保留今天的圖片"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(dialog.textContent).toContain(today);
		expect(dialog.textContent).toContain("4 KiB");
		expect(within(dialog).getByRole("button", { name: confirm })).toBeTruthy();
		expect(list.querySelectorAll("li")).toHaveLength(7);
		expect(protectedButton.disabled).toBe(true);
		expect(api.delete).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
	}
	fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(api.delete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "清空推播歷史圖片" }));
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "確認清空" }));
	await screen.findByText("已清空，實際釋出 512 B。");
	expect(api.delete).toHaveBeenCalledExactlyOnceWith("/api/system/storage/historyImages");
});

it("storage retention days use the current language and English singular without changing selection", async () => {
	renderSystem("/system#storage");
	await screen.findByRole("list", { name: "分类用量" });
	const field = document.querySelector<HTMLElement>('[data-code="core.history.retentionDays"]');
	expect(field).toBeTruthy();
	if (!field) throw new Error("retention field missing");
	for (const [locale, one, three, selected] of [
		["en", "1 day", "3 days", "30 days"],
		["ja", "1 日", "3 日", "30 日"],
		["zh-TW", "1 天", "3 天", "30 天"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(within(field).getByRole("button", { name: one })).toBeTruthy();
		expect(within(field).getByRole("button", { name: three })).toBeTruthy();
		expect(within(field).getByRole("button", { name: selected }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(api.patch).not.toHaveBeenCalled();
	}
});
