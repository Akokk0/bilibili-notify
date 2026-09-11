// @vitest-environment jsdom
/**
 * 拓展被关着的时候这一页长什么样(设计稿 V1 的「B · 模块被关着」)。
 *
 * 🔴 关掉拓展与「拓展崩了」在这一页此前**长得一模一样** —— 两者都只有一句「没跑起来」。
 * 可它们要主人做的事完全相反:前者是他自己刚拨的开关,后者要他去查日志。
 *
 * ⚠️ V1 那张黄盒里还有第三句「期间发往桥的推送一律失败并记『桥接模块已关闭』」。
 * **那个字符串今天不存在**(全仓查过),所以只写查得到的:配置全留、重开会自己连回来。
 */

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { LINK, renderPanel } from "./bridge-harness";

// 关着的拓展没跑起来 —— `/status` 是 404(不给 status 就是那一档),与「崩了」一模一样
function renderOff(enabled: boolean, links: unknown[] = [LINK]) {
	return renderPanel({ links, enabled });
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("拓展被关着", () => {
	it("说的是「是你关的」,不是「它没跑起来」", async () => {
		renderOff(false);
		const lead = await screen.findByText(/拓展关着,桥都被断开了/);
		const note = lead.closest('[data-bn~="note"]');
		expect(note?.textContent).toMatch(/配置一样不动/);
		expect(note?.textContent).toMatch(/重新打开/);
		// 「没跑起来」那句是给「崩了」用的,这时候不该出现 —— 两句一起等于没说
		expect(screen.queryByText(/没跑起来/)).toBeNull();
	});

	it("关着就不去问状态 —— 问了也是 404,还会闪一下「没跑起来」", async () => {
		renderOff(false);
		await screen.findByText(/拓展关着/);
		expect(api.get).not.toHaveBeenCalledWith("/api/ext/bridge/status");
	});

	it("接入压暗成一行一条,说「已随拓展断开」—— 不是一张张还在等连接的卡", async () => {
		renderOff(false);
		expect(await screen.findByText("家里那台")).toBeTruthy();
		const list = document.querySelector("[data-links-dimmed]");
		expect(list).toBeTruthy();
		expect(list?.textContent).toMatch(/已随拓展断开/);
		// 关着的时候没有「没连上」这回事 —— 那是开着时才成立的判断
		expect(screen.queryByText("没连上")).toBeNull();
		expect(screen.queryByRole("button", { name: /新建接入/ })).toBeNull();
	});

	/**
	 * 🔴 关着的时候那句「新建第一条接入」是**做不成的事**:建完也不会连上,拓展还关着。
	 * 黄盒说「是你关的」、底下同时请人去新建,两句话互相打架。
	 */
	it("关着且一条接入都没有时,不请人去新建 —— 该做的是先把拓展打开", async () => {
		renderOff(false, []);
		expect(await screen.findByText(/拓展关着/)).toBeTruthy();
		expect(screen.queryByText(/还没有桥接入/)).toBeNull();
		expect(screen.queryByRole("button", { name: /新建第一条接入/ })).toBeNull();
	});

	it("开着而 /status 还是拿不到 → 那才是「没跑起来」", async () => {
		renderOff(true);
		expect(await screen.findByText(/没跑起来/)).toBeTruthy();
		expect(screen.queryByText(/拓展关着,桥都被断开了/)).toBeNull();
		expect(document.querySelector("[data-links-dimmed]")).toBeNull();
		// 崩了的时候接入照样是整张卡 —— 配置还得改得动
		expect(screen.getByRole("button", { name: "删除 家里那台" })).toBeTruthy();
	});
});
