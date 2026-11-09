// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { ChannelAddressPicker, SessionAddressPicker } from "../address-candidates";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../../services/api", () => ({ api: { get: getMock } }));

function wrap(node: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	getMock.mockReset();
});
afterEach(() => cleanup());

describe("SessionAddressPicker", () => {
	it("调带 scope 的新口,把 name / address 画出来,点一项回填 address", async () => {
		getMock.mockResolvedValue({
			candidates: [{ address: "G2" }, { address: "G1", name: "群甲" }],
		});
		const onPick = vi.fn();
		wrap(<SessionAddressPicker connectionId="c1" scope="group" onPick={onPick} />);

		await waitFor(() => expect(screen.getByText("群甲")).toBeTruthy());
		expect(getMock).toHaveBeenCalledWith("/api/connections/c1/addresses?scope=group");
		// 没有名字的项显示占位,与以前一样。
		expect(screen.getByText("(无名称)")).toBeTruthy();
		expect(screen.getByText("发现的群会话")).toBeTruthy();

		fireEvent.click(screen.getByText("群甲"));
		expect(onPick).toHaveBeenCalledWith("G1");
	});

	it("私聊 scope 也带进查询;空列表给出原来的引导话", async () => {
		getMock.mockResolvedValue({ candidates: [] });
		wrap(<SessionAddressPicker connectionId="c1" scope="private" onPick={() => {}} />);
		await waitFor(() => expect(screen.getByText(/暂时没有地址候选/)).toBeTruthy());
		expect(getMock).toHaveBeenCalledWith("/api/connections/c1/addresses?scope=private");
	});

	it("拉失败 → 原来的失败提示", async () => {
		getMock.mockRejectedValue(new Error("boom"));
		wrap(<SessionAddressPicker connectionId="c1" scope="group" onPick={() => {}} />);
		await waitFor(() => expect(screen.getByText(/读取失败/)).toBeTruthy());
	});
});

describe("ChannelAddressPicker", () => {
	it("不点就不发请求", async () => {
		wrap(<ChannelAddressPicker connectionId="c1" onPick={() => {}} />);
		expect(screen.getByText("点「拉取频道」读取此连接提供的频道地址。")).toBeTruthy();
		// 给 react-query 一个机会(误自动拉取的话会在这几个 tick 里发出)。
		await new Promise((r) => setTimeout(r, 30));
		expect(getMock).not.toHaveBeenCalled();
	});

	it("点了才查带 scope=channel 的新口;按 parentAddress 还原两层,点一项回填 parentAddress + address", async () => {
		getMock.mockResolvedValue({
			candidates: [
				{ address: "C1", name: "公告", parentAddress: "G1", parentName: "频道甲" },
				{ address: "C2", name: "闲聊", parentAddress: "G1", parentName: "频道甲" },
				{ address: "C3", name: "动态", parentAddress: "G2", parentName: "频道乙" },
			],
		});
		const onPick = vi.fn();
		wrap(<ChannelAddressPicker connectionId="c1" onPick={onPick} />);

		fireEvent.click(screen.getByRole("button", { name: "拉取频道" }));
		await waitFor(() => expect(screen.getByText("频道乙")).toBeTruthy());
		expect(getMock).toHaveBeenCalledTimes(1);
		expect(getMock).toHaveBeenCalledWith("/api/connections/c1/addresses?scope=channel");

		// 两个服务器名各出现一次(同服务器的子频道归在一组),子频道名都在。
		expect(screen.getAllByText("频道甲")).toHaveLength(1);
		for (const name of ["公告", "闲聊", "动态"]) expect(screen.getByText(name)).toBeTruthy();

		fireEvent.click(screen.getByText("闲聊"));
		expect(onPick).toHaveBeenCalledWith("G1", "C2");
		fireEvent.click(screen.getByText("动态"));
		expect(onPick).toHaveBeenLastCalledWith("G2", "C3");
	});

	it("没有任何子频道 → 原来的空话;拉失败 → 原来的失败提示", async () => {
		getMock.mockResolvedValueOnce({ candidates: [] });
		wrap(<ChannelAddressPicker connectionId="c1" onPick={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "拉取频道" }));
		await waitFor(() => expect(screen.getByText("暂时没有频道地址候选。")).toBeTruthy());

		getMock.mockRejectedValueOnce(new Error("boom"));
		fireEvent.click(screen.getByRole("button", { name: "拉取频道" }));
		await waitFor(() => expect(screen.getByText(/读取失败/)).toBeTruthy());
	});
});

it.each([
	[
		"ja",
		"failed",
		"ご主人様、アドレスを読み込めません。接続が保存済みで、正常に動いているか確認してくださいね。",
	],
	[
		"ja",
		"empty",
		"ご主人様、アドレス候補はまだありませんよ。接続の状態を確認して更新するか、アドレスを手動で入力してくださいね。",
	],
	[
		"ja",
		"channel",
		"ご主人様、チャンネルを読み込めません。接続が保存済みで、認証情報が正しいか確認してくださいね。",
	],
	["zh-TW", "failed", "主人，無法讀取位址，請確認連線已儲存且正常執行喔。"],
	["zh-TW", "empty", "主人，目前沒有位址候選，請檢查連線狀態後重新整理，也可以手動填寫位址喔。"],
	["zh-TW", "channel", "主人，無法讀取頻道，請確認連線已儲存且憑證正確喔。"],
] as const)(
	"%s maid %s guidance does not retry or select an address on language change",
	async (locale, state, hint) => {
		if (state === "empty") getMock.mockResolvedValue({ candidates: [] });
		else getMock.mockRejectedValue(new Error("Original diagnostic 原文"));
		const onPick = vi.fn();
		if (state === "channel") {
			wrap(<ChannelAddressPicker connectionId="original-connection" onPick={onPick} />);
			expect(getMock).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "拉取频道" }));
		} else
			wrap(
				<SessionAddressPicker connectionId="original-connection" scope="group" onPick={onPick} />,
			);
		await screen.findByText(state === "empty" ? /暂时没有地址候选/ : /读取失败/);
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(hint)).toBeTruthy();
		act(() => i18n.set({ voice: "plain" }));
		expect(screen.queryByText(hint)).toBeNull();
		expect(getMock).toHaveBeenCalledExactlyOnceWith(
			`/api/connections/original-connection/addresses?scope=${state === "channel" ? "channel" : "group"}`,
		);
		expect(onPick).not.toHaveBeenCalled();
	},
);

it.each(["group", "private"] as const)(
	"%s address candidates translate without refetching or changing raw addresses",
	async (scope) => {
		i18n.set({ locale: "en", voice: "plain" });
		getMock.mockResolvedValue({
			candidates: [{ address: "raw:G2" }, { address: "raw:G1", name: "原会话名称" }],
		});
		const onPick = vi.fn();
		wrap(<SessionAddressPicker connectionId="c1" scope={scope} onPick={onPick} />);
		await screen.findByText("原会话名称");
		for (const [locale, group, user, unnamed, refresh] of [
			["en", "Discovered group sessions", "Discovered user sessions", "(Unnamed)", "Refresh"],
			[
				"ja",
				"検出されたグループセッション",
				"検出されたユーザーセッション",
				"（名前なし）",
				"更新",
			],
			["zh-TW", "偵測到的群組會話", "偵測到的使用者會話", "（未命名）", "重新整理"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(scope === "group" ? group : user)).toBeTruthy();
			expect(screen.getByText(unnamed)).toBeTruthy();
			expect(screen.getByRole("button", { name: refresh })).toBeTruthy();
			expect(screen.getByText("raw:G1")).toBeTruthy();
			expect(getMock).toHaveBeenCalledOnce();
			expect(onPick).not.toHaveBeenCalled();
		}
		fireEvent.click(screen.getByRole("button", { name: /原会话名称/ }));
		expect(onPick).toHaveBeenCalledOnce();
		expect(onPick).toHaveBeenCalledWith("raw:G1");
		expect(getMock).toHaveBeenCalledWith(`/api/connections/c1/addresses?scope=${scope}`);
	},
);

it("channel guidance translates without fetching until requested and preserves both selected addresses", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	getMock.mockResolvedValue({
		candidates: [
			{ address: "raw:C1", name: "原子频道", parentAddress: "raw:G1", parentName: "原频道" },
		],
	});
	const onPick = vi.fn();
	wrap(<ChannelAddressPicker connectionId="c1" onPick={onPick} />);
	for (const [locale, title, action, hint] of [
		[
			"en",
			"Channel addresses",
			"Fetch channels",
			"Choose “Fetch channels” to read channel addresses from this connection.",
		],
		[
			"ja",
			"チャンネルのアドレス候補",
			"チャンネルを取得",
			"「チャンネルを取得」で、この接続が提供するチャンネルのアドレスを読み込みます。",
		],
		["zh-TW", "頻道位址候選", "取得頻道", "點選「取得頻道」，讀取此連線提供的頻道位址。"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByText(hint)).toBeTruthy();
		expect(screen.getByRole("button", { name: action })).toBeTruthy();
		expect(getMock).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: "取得頻道" }));
	await screen.findByText("原频道");
	act(() => i18n.set({ locale: "en" }));
	fireEvent.click(screen.getByRole("button", { name: "原子频道" }));
	expect(getMock).toHaveBeenCalledOnce();
	expect(getMock).toHaveBeenCalledWith("/api/connections/c1/addresses?scope=channel");
	expect(onPick).toHaveBeenCalledOnce();
	expect(onPick).toHaveBeenCalledWith("raw:G1", "raw:C1");
});
