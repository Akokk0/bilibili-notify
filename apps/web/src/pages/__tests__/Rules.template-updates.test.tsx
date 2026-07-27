// @vitest-environment jsdom

/**
 * 「默认文案有更新」的逐字段小标记。
 *
 * 主人改了某条模板的默认,已装好的用户拿不到 —— 他们盘上写的是当初那一版。这套
 * 提示就是让他们知道,并自己选:换成新的,还是留着自己的。判定本身是纯函数
 * (`@bilibili-notify/internal/template-defaults`),这里只管界面接线接对没有 ——
 * 标记该亮时亮、点完消失、两个动作各自改对了东西。
 */

import { DEFAULT_TEMPLATES } from "@bilibili-notify/internal";
import { templateFingerprint } from "@bilibili-notify/internal/template-defaults";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import type { GlobalConfig } from "../../types/globals";
import Rules from "../Rules";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

/** 造一份 globals;`mutate` 里改 defaults。 */
function globalsWith(mutate: (d: ReturnType<typeof makeDefaults>) => void): GlobalConfig {
	const defaults = makeDefaults();
	// fixture 的模板全是空串,先摆成「值就等于当前默认」的干净基线,
	// 这样只有测试自己动过的那条才会亮灯。
	defaults.templates = { ...defaults.templates, ...DEFAULT_TEMPLATES };
	mutate(defaults);
	return { app: {}, master: {}, defaults } as unknown as GlobalConfig;
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function mount(g: GlobalConfig) {
	vi.mocked(api.get).mockImplementation((url: string) =>
		Promise.resolve(url.includes("/api/subs") ? [] : JSON.parse(JSON.stringify(g))),
	);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Rules />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

/** 切到「直播消息版式」那一节 —— liveStart 住在那儿。 */
async function gotoLiveMsg(): Promise<void> {
	await waitFor(() => expect(screen.getAllByText("直播消息版式").length).toBeGreaterThan(0));
	fireEvent.click(screen.getAllByText("直播消息版式")[0]);
}

/** liveStart 字段上的提示条(没有就 null)。 */
function noticeOfLiveStart(): Element | null {
	return document.querySelector('[data-code="templates.liveStart"] [data-template-update]');
}

/** liveStart 的输入框。 */
function liveStartInput(): HTMLTextAreaElement | HTMLInputElement {
	const el = document.querySelector(
		'[data-code="templates.liveStart"] textarea, [data-code="templates.liveStart"] input',
	);
	if (!el) throw new Error("liveStart 输入框没找到");
	return el as HTMLTextAreaElement | HTMLInputElement;
}

describe("默认文案有更新的小标记", () => {
	it("盘上还是旧默认、账本又没记过这一版 → 该字段亮标记", async () => {
		mount(globalsWith((d) => (d.templates.liveStart = "上一版的开播文案")));
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
	});

	it("值已经等于当前默认 → 不亮标记,没什么可更新的", async () => {
		mount(globalsWith(() => {}));
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput()).toBeTruthy());
		expect(noticeOfLiveStart()).toBeNull();
	});

	it("账本已经记过这一版 → 不亮标记,哪怕文案是主人自己写的", async () => {
		// 手写过文案的主人,值**永远**不等于默认。若这条不成立,提示会一直挂着不灭。
		mount(
			globalsWith((d) => {
				d.templates.liveStart = "我自己写的";
				d.templateDefaultsSeen = { liveStart: templateFingerprint(DEFAULT_TEMPLATES.liveStart) };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput()).toBeTruthy());
		expect(noticeOfLiveStart()).toBeNull();
	});

	it("点「用新默认」→ 文案换成当前默认,提示消失", async () => {
		mount(globalsWith((d) => (d.templates.liveStart = "上一版的开播文案")));
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
		fireEvent.click(screen.getByText("用新默认"));
		await waitFor(() => expect(liveStartInput().value).toBe(DEFAULT_TEMPLATES.liveStart));
		expect(noticeOfLiveStart()).toBeNull();
	});

	it("点「保持我的」→ 文案一个字不动,提示也消失", async () => {
		// 提示消失靠的是账本被记上。不记的话主人每次打开这页都被问一遍同一件事。
		mount(globalsWith((d) => (d.templates.liveStart = "我自己写的")));
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
		fireEvent.click(screen.getByText("保持我的"));
		await waitFor(() => expect(noticeOfLiveStart()).toBeNull());
		expect(liveStartInput().value).toBe("我自己写的");
	});
});

/** liveStart 字段上的「恢复默认」按钮(没有就 null)。 */
function resetBtnOfLiveStart(): Element | null {
	// 定位锚是外层的 `data-field-reset`,点击目标是里面那个真按钮 —— 点外层的
	// 包装元素不会触发按钮的 onClick(事件只往上冒,不往下传)。
	return document.querySelector('[data-code="templates.liveStart"] [data-field-reset] button');
}

describe("恢复默认按钮", () => {
	it("改过的文案旁边有「恢复默认」,点了还原成当前默认", async () => {
		// 这个按钮跟「有更新」的提示是两件事:它常驻,管的是「我改坏了想还原」。
		mount(
			globalsWith((d) => {
				d.templates.liveStart = "我自己写的";
				// 记上账本,把「有更新」的提示排除掉 —— 这条只验恢复按钮。
				d.templateDefaultsSeen = { liveStart: templateFingerprint(DEFAULT_TEMPLATES.liveStart) };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(resetBtnOfLiveStart()).not.toBeNull());
		fireEvent.click(resetBtnOfLiveStart() as Element);
		await waitFor(() => expect(liveStartInput().value).toBe(DEFAULT_TEMPLATES.liveStart));
	});

	it("值本来就是默认 → 不显示按钮,点了也没意义", async () => {
		mount(globalsWith(() => {}));
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput()).toBeTruthy());
		expect(resetBtnOfLiveStart()).toBeNull();
	});
});
