// @vitest-environment jsdom

/**
 * LoadingBlock —— 「正在读取…」这类等待占位的唯一写法。
 *
 * 由来:数据统计 / 推送历史的等待态原本是一行裸文字直接坐在页面背景上,没有任何
 * 包装 —— 皮肤壁纸一开就是一行灰字飘在图上。占位也是页级容器,得跟别的卡一样
 * 有玻璃底(见 packages/ui/README.md「页级卡片容器一律玻璃底」)。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { LoadingBlock } from "../glass";

afterEach(cleanup);

describe("LoadingBlock", () => {
	it("提示语裹进玻璃卡 —— 页级容器不许裸坐在背景上", () => {
		const { container } = render(<LoadingBlock label="正在读取统计数据" />);
		const card = container.firstElementChild;
		expect(card?.className).toContain("bn-glass");
		expect(card?.textContent).toContain("正在读取统计数据");
	});

	it("读屏器也得知道在等 —— 转圈是纯视觉的,只有 role=status 会被念出来", () => {
		render(<LoadingBlock label="正在读取推送历史" />);
		expect(screen.getByRole("status").textContent).toContain("正在读取推送历史");
	});

	// 已经坐在 GlassBox / 玻璃卡里的位置(About 的更新日志、登录闸的白屏),再套一层
	// 玻璃就是玻璃叠玻璃 —— 主人明确嫌过这个观感。
	it("inset 变体不带玻璃底,只留转圈与文案", () => {
		const { container } = render(<LoadingBlock label="正在读取更新日志" variant="inset" />);
		const el = container.firstElementChild;
		expect(el?.className).not.toContain("bn-glass");
		expect(el?.className).not.toContain("shadow-bn");
		expect(screen.getByRole("status").textContent).toContain("正在读取更新日志");
	});

	it("第二行小字给了才渲染,不给不留空行", () => {
		const { rerender } = render(<LoadingBlock label="读取中" />);
		expect(screen.queryByText("女仆正在翻账本")).toBeNull();
		rerender(<LoadingBlock label="读取中" hint="女仆正在翻账本" />);
		expect(screen.getByText("女仆正在翻账本")).toBeTruthy();
	});
});
