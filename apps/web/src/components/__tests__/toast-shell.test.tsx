// @vitest-environment jsdom
/**
 * 右下角 toast 层。原来只装推送事件;应用内更新借它发「有新版」的通知卡 ——
 * 同一个壳、同一条队列,只是这种卡带一个按钮、而且不自己消失。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AUTO_DISMISS_MS, type PushEventView, useToastStore } from "../../store/notifications";
import { ToastShell } from "../toast-shell";

function pushView(id: string, over: Partial<PushEventView> = {}): PushEventView {
	return {
		id,
		pushId: id,
		ts: "2026-09-02T10:00:00.000Z",
		kind: "dynamic",
		status: "delivered",
		uid: "u1",
		subscriptionId: "s1",
		targetId: "t1",
		messages: [{ text: "一条动态", role: "main", ok: true }],
		...over,
	};
}

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{`${loc.pathname}${loc.search}${loc.hash}`}</div>;
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
		act(() => useToastStore.getState().push(pushView("h1")));
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

describe("通知卡与推送 toast 抢队列", () => {
	it("推送刷屏把队列灌满 → 挤掉的是最老的推送,通知卡留着", () => {
		// 队列上限 5,从头部丢。通知卡先入队(面板一打开就查更新),SC / 舰长一开播几秒
		// 就能烧掉五条推送 —— 第一个被丢的就是它。「有新版」一年才几回,错过了得等下次
		// 开面板;推送是流水,少一条无所谓。
		const store = useToastStore.getState();
		store.notify(NOTICE);
		for (let i = 0; i < 6; i++) {
			store.push(
				pushView(`push-${i}`, { messages: [{ text: `推送 ${i}`, role: "main", ok: true }] }),
			);
		}

		const items = useToastStore.getState().items;
		expect(items).toHaveLength(5);
		expect(items.some((t) => t.id === NOTICE.id)).toBe(true);
		expect(items.some((t) => t.id === "push-0")).toBe(false);
	});
});

describe("推送 toast —— 一次推送多条消息", () => {
	it("首条本体当文案,多条时挂「N 条」胶囊;@全体 抢先落地也不当文案", () => {
		renderShell();
		act(() =>
			useToastStore.getState().push(
				pushView("h1", {
					kind: "live-end",
					messages: [
						{ text: "@全体", role: "extra", ok: true },
						{ text: "下播了", role: "main", ok: true },
						{ text: "[弹幕词云]", role: "extra", ok: true },
					],
				}),
			),
		);
		expect(screen.getByText("下播了")).toBeTruthy();
		expect(screen.queryByText("@全体")).toBeNull();
		expect(screen.getByText("3 条")).toBeTruthy();
		expect(screen.getByText("下播")).toBeTruthy();
	});

	it("部分失败标警示色「部分失败」,失败标红「推送失败」", () => {
		renderShell();
		act(() => {
			useToastStore.getState().push(pushView("h1", { status: "partial" }));
			useToastStore.getState().push(pushView("h2", { status: "failed" }));
		});
		expect(screen.getByText("部分失败")).toBeTruthy();
		expect(screen.getByText("推送失败")).toBeTruthy();
	});

	it("replace:卡还在就原地换字、不重排;卡已经关了就不再弹", () => {
		renderShell();
		act(() => {
			useToastStore.getState().push(
				pushView("h1", {
					kind: "live-end",
					messages: [{ text: "下播了", role: "main", ok: true }],
				}),
			);
			useToastStore.getState().push(pushView("h2"));
		});
		act(() =>
			useToastStore.getState().replace(
				pushView("h1", {
					kind: "live-end",
					status: "partial",
					messages: [
						{ text: "下播了", role: "main", ok: true },
						{ text: "总结", role: "extra", ok: false },
					],
				}),
			),
		);
		expect(screen.getByText("2 条")).toBeTruthy();
		expect(useToastStore.getState().items.map((t) => t.id)).toEqual(["h1", "h2"]);

		act(() => useToastStore.getState().dismiss("h1"));
		act(() => useToastStore.getState().replace(pushView("h1", { status: "delivered" })));
		expect(useToastStore.getState().items.map((t) => t.id)).toEqual(["h2"]);
	});
});

describe("推送 toast —— 无目标", () => {
	it("标警示色「无目标」,带「去配置」钮:点了跳到该 UP 的抽屉(?open=订阅 id),卡随即收起", async () => {
		renderShell();
		act(() =>
			useToastStore
				.getState()
				.push(pushView("h1", { status: "no-targets", targetId: null, subscriptionId: "sub-9" })),
		);
		expect(screen.getByText("无目标")).toBeTruthy();
		expect(screen.getByText("一条动态")).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "去配置" }));

		expect(screen.getByTestId("loc").textContent).toBe("/subs?open=sub-9");
		expect(screen.queryByText("一条动态")).toBeNull();
	});

	it("有目标的卡不带「去配置」", () => {
		renderShell();
		act(() => useToastStore.getState().push(pushView("h1")));
		expect(screen.queryByRole("button", { name: "去配置" })).toBeNull();
	});
});
