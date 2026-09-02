// @vitest-environment jsdom
/**
 * 右下角 toast 层。原来只装推送事件;应用内更新借它发「有新版」的通知卡 ——
 * 同一个壳、同一条队列,只是这种卡带一个按钮、而且不自己消失。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AUTO_DISMISS_MS, useToastStore } from "../../store/notifications";
import { ToastShell } from "../toast-shell";

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{`${loc.pathname}${loc.hash}`}</div>;
}

function renderShell() {
	return render(
		<MemoryRouter initialEntries={["/"]}>
			<ToastShell />
			<Routes>
				<Route path="*" element={<LocationProbe />} />
			</Routes>
		</MemoryRouter>,
	);
}

const NOTICE = {
	id: "update:0.9.0",
	title: "有新版 0.9.0",
	body: "到系统页下载。",
	action: { label: "去更新", to: "/system#update" },
};

beforeEach(() => {
	useToastStore.getState().clear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("ToastShell —— 通知卡", () => {
	it("带按钮的通知:点了就跳到它指的地方,卡随即收起", async () => {
		renderShell();
		act(() => useToastStore.getState().notify(NOTICE));

		expect(screen.getByText("有新版 0.9.0")).toBeTruthy();
		expect(screen.getByText("到系统页下载。")).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "去更新" }));

		expect(screen.getByTestId("loc").textContent).toBe("/system#update");
		expect(screen.queryByText("有新版 0.9.0")).toBeNull();
	});

	it("通知卡不自己消失 —— 推送 toast 五秒就走,这种要等人看见", () => {
		vi.useFakeTimers();
		renderShell();
		act(() => useToastStore.getState().notify(NOTICE));

		act(() => {
			vi.advanceTimersByTime(AUTO_DISMISS_MS * 3);
		});

		expect(screen.getByText("有新版 0.9.0")).toBeTruthy();
	});

	it("推送 toast 照旧五秒自动收起 —— 通知卡的例外别漏到这边来", () => {
		vi.useFakeTimers();
		renderShell();
		act(() =>
			useToastStore.getState().push({
				id: "h1",
				ts: "2026-09-02T10:00:00.000Z",
				source: "dynamic",
				uid: "u1",
				subscriptionId: "s1",
				targetIds: ["t1"],
				ok: true,
				text: "一条动态",
			}),
		);
		expect(screen.getByText("一条动态")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
		});

		expect(screen.queryByText("一条动态")).toBeNull();
	});

	it("同一条通知发两次只留一张 —— 打开面板那次和手动检查那次会撞", () => {
		renderShell();
		act(() => {
			useToastStore.getState().notify(NOTICE);
			useToastStore.getState().notify(NOTICE);
		});
		expect(screen.getAllByText("有新版 0.9.0")).toHaveLength(1);
	});
});
