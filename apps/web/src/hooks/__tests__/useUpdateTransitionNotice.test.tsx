// @vitest-environment jsdom
/**
 * 后台下载收尾时,右下角那张「正在下载」换成「已就绪」或「下载失败」。
 *
 * 守的是三件事:换卡用的是**同一个 id**(打开面板那张还在就是原地换字,不叠第二张);用户
 * 已经关掉了「正在下载」那张,收尾时照样再弹(主人拍板的「下完再提醒」);其余迁移一律不出声。
 */

import type { UpdateStatusView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { UPDATE_QUERY_KEY } from "../../components/update/status";
import { i18n } from "../../i18n";
import { useToastStore } from "../../store/notifications";
import { transitionNotice, useUpdateTransitionNotice } from "../useUpdateTransitionNotice";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function dto(state: UpdateStatusView["state"]): UpdateStatusView {
	return { currentVersion: "0.8.0", rollbackTarget: null, pinnedVersion: null, state };
}

const NOTES = "链接解析学会了认群。";
const ACTION = { label: "去更新", to: "/system#update" };
const downloading = dto({
	phase: "downloading",
	target: "0.9.0",
	releaseUrl: "https://x",
	notes: NOTES,
});
const ready = dto({ phase: "ready", target: "0.9.0", releaseUrl: "https://x", notes: NOTES });
const failed = dto({
	phase: "error",
	code: "download_failed",
	helpUrl: "https://x",
	checkedAt: "2026-10-27T00:00:00.000Z",
});

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

describe("transitionNotice", () => {
	it("正在下载 → 已就绪:同 id、标题「X 已就绪」、正文概述 + 状态句", () => {
		expect(transitionNotice(downloading, ready)).toEqual({
			id: "update:0.9.0",
			title: "0.9.0 已就绪",
			body: `${NOTES}\n已经下好了,到系统页按一下重启就换。`,
			action: ACTION,
		});
	});

	it("正在下载 → 出错:error 不带版本号,用上一拍记着的那个", () => {
		expect(transitionNotice(downloading, failed)).toEqual({
			id: "update:0.9.0",
			title: "0.9.0 下载失败",
			body: `${NOTES}\n没下下来,到系统页看看是哪一步没成。`,
			action: ACTION,
		});
	});

	it("正在下载 0.9.1 → 报回来的是盘上早就就绪的 0.9.0:那是 0.9.1 没下下来,不是它就绪了", () => {
		// 服务端把「盘上有一份装好的」这个事实压在下载失败的结论上面(reportedState),
		// 面板从两拍状态之间只能靠版本号对不上看出来。
		const next = dto({ phase: "downloading", target: "0.9.1", releaseUrl: "https://x" });
		expect(transitionNotice(next, ready)).toMatchObject({
			id: "update:0.9.1",
			title: "0.9.1 下载失败",
			body: "没下下来,到系统页看看是哪一步没成。",
		});
	});

	it.each<[string, UpdateStatusView, UpdateStatusView]>([
		["还没查 → 正在下载(开面板那张卡由检查钩子发)", dto({ phase: "idle" }), downloading],
		[
			"有新版 → 已就绪(用户自己按的下载,系统页看得见)",
			dto({
				phase: "available",
				target: "0.9.0",
				releaseUrl: "https://x",
				checkedAt: "2026-10-27T00:00:00.000Z",
			}),
			ready,
		],
		[
			"已就绪 → 已是最新(撤回)",
			ready,
			dto({ phase: "up-to-date", checkedAt: "2026-10-27T00:00:00.000Z" }),
		],
		["正在下载 → 正在下载(轮询看到同一拍)", downloading, downloading],
		[
			"正在下载 → 已排队回退(用户自己按的)",
			downloading,
			dto({ phase: "rolled-back", target: "0.7.0" }),
		],
	])("其余迁移不出声:%s", (_name, before, after) => {
		expect(transitionNotice(before, after)).toBeNull();
	});
});

describe("useUpdateTransitionNotice", () => {
	function Harness() {
		useUpdateTransitionNotice();
		return null;
	}

	function mount(initial: UpdateStatusView) {
		vi.mocked(api.get).mockResolvedValue(initial);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<Harness />
			</QueryClientProvider>,
		);
		return qc;
	}

	beforeEach(() => {
		useToastStore.getState().clear();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});
	it.each([
		[
			"en",
			"0.9.0 is ready",
			"The download is ready. Restart from System to apply it.",
			"Download failed: 0.9.0",
			"The download failed. Check System for details.",
			"View update",
		],
		[
			"ja",
			"0.9.0の準備ができました",
			"ダウンロードが完了しました。「システム」から再起動すると適用されます。",
			"0.9.0のダウンロードに失敗しました",
			"ダウンロードに失敗しました。「システム」で詳細を確認してください。",
			"更新を表示",
		],
		[
			"zh-TW",
			"0.9.0 已就緒",
			"下載已完成，到「系統」重新啟動即可套用。",
			"0.9.0 下載失敗",
			"下載失敗，請到「系統」查看詳細原因。",
			"查看更新",
		],
	] as const)(
		"%s replaces a background-download notice in place and preserves raw notes and target",
		async (locale, readyTitle, readyLine, failedTitle, failedLine, label) => {
			i18n.set({ locale, voice: "plain" });
			const qc = mount(downloading);
			await waitFor(() => expect(qc.getQueryData(UPDATE_QUERY_KEY)).toEqual(downloading));
			useToastStore.getState().notify({ id: "update:0.9.0", title: "Original downloading title" });
			qc.setQueryData(UPDATE_QUERY_KEY, ready);
			await waitFor(() =>
				expect(useToastStore.getState().items[0]).toMatchObject({
					id: "update:0.9.0",
					title: readyTitle,
					body: `${NOTES}\n${readyLine}`,
					action: { label, to: "/system#update" },
				}),
			);
			expect(useToastStore.getState().items).toHaveLength(1);
			expect(transitionNotice(downloading, failed)).toEqual({
				id: "update:0.9.0",
				title: failedTitle,
				body: `${NOTES}\n${failedLine}`,
				action: { label, to: "/system#update" },
			});
			expect(transitionNotice(ready, ready)).toBeNull();
		},
	);

	it("缓存从「正在下载」变成「已就绪」→ 出卡;挂载时那一拍本身不出声", async () => {
		const qc = mount(downloading);
		await waitFor(() => expect(qc.getQueryData(UPDATE_QUERY_KEY)).toEqual(downloading));
		expect(useToastStore.getState().items).toHaveLength(0);

		qc.setQueryData(UPDATE_QUERY_KEY, ready);

		await waitFor(() => expect(useToastStore.getState().items).toHaveLength(1));
		expect(useToastStore.getState().items[0]).toMatchObject({
			kind: "notice",
			id: "update:0.9.0",
			title: "0.9.0 已就绪",
		});
	});

	it("打开面板那张「正在下载」还在 → 原地换成「已就绪」,不叠第二张", async () => {
		const qc = mount(downloading);
		await waitFor(() => expect(qc.getQueryData(UPDATE_QUERY_KEY)).toEqual(downloading));
		useToastStore.getState().notify({ id: "update:0.9.0", title: "正在下载 0.9.0" });

		qc.setQueryData(UPDATE_QUERY_KEY, ready);

		await waitFor(() =>
			expect(
				useToastStore.getState().items.map((t) => (t.kind === "notice" ? t.title : t.kind)),
			).toEqual(["0.9.0 已就绪"]),
		);
	});

	it("用户先关掉了「正在下载」那张 → 收尾时照样再弹(下完再提醒)", async () => {
		const qc = mount(downloading);
		await waitFor(() => expect(qc.getQueryData(UPDATE_QUERY_KEY)).toEqual(downloading));
		useToastStore.getState().notify({ id: "update:0.9.0", title: "正在下载 0.9.0" });
		useToastStore.getState().dismiss("update:0.9.0");
		expect(useToastStore.getState().items).toHaveLength(0);

		qc.setQueryData(UPDATE_QUERY_KEY, failed);

		await waitFor(() => expect(useToastStore.getState().items).toHaveLength(1));
		expect(useToastStore.getState().items[0]).toMatchObject({ title: "0.9.0 下载失败" });
	});
});
