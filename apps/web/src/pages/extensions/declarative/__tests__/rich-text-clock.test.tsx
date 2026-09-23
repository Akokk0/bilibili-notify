// @vitest-environment jsdom

/**
 * 富文本里的时刻(`{ time, suffix }`,桥的「N 分钟前连上」就是它)要**跟着走**:只在渲染那一刻算
 * 一次的话,页面开着不动,它就一直停在「刚刚」—— 而「刚刚连上」正是「它刚断过」的信号,一直这么
 * 挂着等于一直在报一次早就过去的重连。
 *
 * 值得钉的:① 过了一分钟会变;② 页上几处时刻**共用一个节拍**,不是每处一个定时器;③ 页面藏在
 * 后台时不走,回到前台当场补一次;④ 卸载时清掉;⑤ 没有时刻的字不起定时器。
 *
 * 🔴 这个文件用假定时器 —— 不许用 `waitFor` / `findBy*`(会死锁),全靠 `act` 同步推。
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RichText } from "../rich-text";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

let hidden = false;

function setHidden(next: boolean) {
	hidden = next;
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

function advance(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
	});
	vi.setSystemTime(NOW);
	hidden = false;
	// jsdom 的 `document.hidden` 恒为 false,换成可控的。
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("富文本里的时刻会走", () => {
	it("过了一分钟,「刚刚」变成「1 分钟前」", () => {
		const { container } = render(
			<RichText text={[{ time: NOW, suffix: "连上" }]} extensionId="bridge" />,
		);
		expect(container.textContent).toBe("刚刚连上");
		advance(60_000);
		expect(container.textContent).toBe("1 分钟前连上");
		advance(60_000);
		expect(container.textContent).toBe("2 分钟前连上");
	});

	it("页上几处时刻共用一个节拍", () => {
		render(
			<>
				<RichText text={[{ time: NOW, suffix: "连上" }]} extensionId="bridge" />
				<RichText text={["上次 ", { time: NOW - 5_000, suffix: "检查" }]} extensionId="douyin" />
				<RichText text={[{ time: NOW - 60_000, suffix: "连上" }]} extensionId="bridge" />
			</>,
		);
		expect(vi.getTimerCount()).toBe(1);
	});

	it("没有时刻的字不起定时器", () => {
		render(<RichText text={["cookie ", { b: "有效" }]} extensionId="douyin" />);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("页面藏在后台时不走;回到前台当场补上", () => {
		const { container } = render(
			<RichText text={[{ time: NOW, suffix: "连上" }]} extensionId="bridge" />,
		);
		setHidden(true);
		expect(vi.getTimerCount()).toBe(0);
		advance(5 * 60_000);
		expect(container.textContent).toBe("刚刚连上");
		setHidden(false);
		// 不等下一拍:回来的那一下就该是对的。
		expect(container.textContent).toBe("5 分钟前连上");
		expect(vi.getTimerCount()).toBe(1);
		advance(60_000);
		expect(container.textContent).toBe("6 分钟前连上");
	});

	it("卸载时清掉定时器", () => {
		const { unmount } = render(
			<RichText text={[{ time: NOW, suffix: "连上" }]} extensionId="bridge" />,
		);
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
