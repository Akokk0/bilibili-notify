// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { QQGuildPicker, QQSessionPicker } from "../qq-address-pickers";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../../services/api", () => ({ api: { get: getMock } }));

function wrap(node: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
	getMock.mockReset();
});
afterEach(() => cleanup());

describe("QQSessionPicker", () => {
	it("调带 scope 的新口,把 name / address 画出来,点一项回填 address", async () => {
		getMock.mockResolvedValue({
			candidates: [{ address: "G2" }, { address: "G1", name: "群甲" }],
		});
		const onPick = vi.fn();
		wrap(<QQSessionPicker connectionId="c1" scope="group" onPick={onPick} />);

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
		wrap(<QQSessionPicker connectionId="c1" scope="private" onPick={() => {}} />);
		await waitFor(() => expect(screen.getByText(/暂无发现的用户会话/)).toBeTruthy());
		expect(getMock).toHaveBeenCalledWith("/api/connections/c1/addresses?scope=private");
	});

	it("拉失败 → 原来的失败提示", async () => {
		getMock.mockRejectedValue(new Error("boom"));
		wrap(<QQSessionPicker connectionId="c1" scope="group" onPick={() => {}} />);
		await waitFor(() => expect(screen.getByText(/拉取失败/)).toBeTruthy());
	});
});

describe("QQGuildPicker", () => {
	it("不点就不发请求", async () => {
		wrap(<QQGuildPicker connectionId="c1" onPick={() => {}} />);
		expect(screen.getByText("点「拉取频道」从 QQ 实时枚举。")).toBeTruthy();
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
		wrap(<QQGuildPicker connectionId="c1" onPick={onPick} />);

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
		wrap(<QQGuildPicker connectionId="c1" onPick={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "拉取频道" }));
		await waitFor(() => expect(screen.getByText("未发现任何频道服务器。")).toBeTruthy());

		getMock.mockRejectedValueOnce(new Error("boom"));
		fireEvent.click(screen.getByRole("button", { name: "拉取频道" }));
		await waitFor(() => expect(screen.getByText(/拉取失败/)).toBeTruthy());
	});
});
