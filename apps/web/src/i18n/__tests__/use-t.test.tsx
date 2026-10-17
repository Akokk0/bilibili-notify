// @vitest-environment jsdom

/**
 * `useT()` —— 面板的译文第 4 期才收,眼下 `locales/*.json` 都是空的。公开的口只有 `i18n` 与 `useT()`,
 * 样例字典没法从口子递进去,所以这里照方案 `vi.mock` 掉 JSON 模块,测的仍是真 `i18n` 与真 `useT()` 的接线。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../locales/zh-CN.json", () => ({
	default: { greet: "你好 {name}", "item#other": "{count} 件" },
}));
vi.mock("../locales/zh-CN.maid.json", () => ({ default: { greet: "主人好 {name}～" } }));
vi.mock("../locales/en.json", () => ({
	default: { greet: "Hello {name}", "item#one": "{count} item", "item#other": "{count} items" },
}));
vi.mock("../locales/ja.json", () => ({ default: {} }));

import { i18n, useT } from "../index";

// 模块初值读浏览器(jsdom 下会猜成英文),所以每条用例先设回简中 + 女仆
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

afterEach(() => {
	cleanup();
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

function Probe() {
	const t = useT();
	// 样例键不在(空的)真字典的键类型里
	return (
		<p data-testid="line">
			{t("greet" as never, { name: "甲" })}|{t("item" as never, { count: 1 })}
		</p>
	);
}

describe("useT", () => {
	it("组件外调 i18n.set 之后,已经画出来的节点自己换字、不重新挂载", () => {
		render(<Probe />);
		const node = screen.getByTestId("line");
		expect(node.textContent).toBe("主人好 甲～|1 件");

		act(() => i18n.set({ locale: "en" }));
		expect(screen.getByTestId("line")).toBe(node);
		expect(node.textContent).toBe("Hello 甲|1 item");
	});

	it("换口吻也会重画", () => {
		render(<Probe />);
		const node = screen.getByTestId("line");
		act(() => i18n.set({ voice: "plain" }));
		expect(node.textContent).toBe("你好 甲|1 件");
		act(() => i18n.set({ voice: "maid" }));
		expect(node.textContent).toBe("主人好 甲～|1 件");
	});

	it("没变的 set 不重画:拿到的 t 引用不变", () => {
		const seen: unknown[] = [];
		function Capture() {
			seen.push(useT());
			return null;
		}
		render(<Capture />);
		act(() => i18n.set({ locale: "zh-CN", voice: "maid" }));
		expect(seen.length).toBe(1);
	});
});
