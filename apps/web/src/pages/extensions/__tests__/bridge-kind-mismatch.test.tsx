// @vitest-environment jsdom
/**
 * 「连上了,但对不上」—— 这条接入配的是 koishi,连进来的桥却自报 astrbot。
 *
 * 🔴 **这不是个假想的态**:两条接入的 token 长得一模一样(都是 32 位十六进制),把
 * token 填到另一头那个插件里去是最容易犯的错。而它**收发一切照常** —— BN 对两种桥的
 * 处理完全相同 —— 所以除了面板上的名字一直对不上,没有任何别的症状。
 *
 * 此前配置里的种类与桥自报的种类**两个值都在手上,就是没比过**:连上之后面板只印自报的
 * 那个,于是这个错被悄悄抹平,主人永远看不见。
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { LINK, renderPanel, savedLinks, TOKEN } from "./bridge-harness";

function renderMismatch(reportedKind: string) {
	return renderPanel({
		links: [LINK],
		status: {
			sessions: [
				{
					linkId: "c1",
					connected: true,
					kind: reportedKind,
					name: "机房那台",
					version: "0.2.1",
					connectedAt: Date.now() - 60_000,
					bots: [],
				},
			],
		},
	});
}

beforeEach(() => {
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("桥自报的种类和这条接入对不上", () => {
	it("说出来 —— 不是画成一切正常的「已连接」", async () => {
		renderMismatch("astrbot");
		expect(await screen.findByText(/连上了,但对不上/)).toBeTruthy();
	});

	/**
	 * 🔴 得说清**它其实是能用的**。不说的话,主人会以为推送坏了,跑去拆本来好好的配置 ——
	 * 而真正要改的只是面板上这一格叫什么。
	 */
	it("同时讲清楚:收发照常,要改的只是这一格", async () => {
		renderMismatch("astrbot");
		await screen.findByText(/连上了,但对不上/);
		const note = document.querySelector("[data-kind-mismatch-note]");
		expect(note?.textContent).toMatch(/收发照常/);
		// 说了「能用」还得说清**错在哪**,否则主人无从下手
		expect(note?.textContent).toMatch(/token 填到另一头的插件里/);
	});

	it("给一颗就地改过来的钮,按下去只改种类那一格、不碰 token", async () => {
		renderMismatch("astrbot");
		await userEvent.click(await screen.findByRole("button", { name: /改成 AstrBot/ }));
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		// 接入住桥的设置里:整份名单写回,改的只有种类那一格。
		const links = savedLinks();
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ id: "c1", bridgeKind: "astrbot", token: TOKEN });
	});

	it("对得上的时候什么都不说 —— 别把正常态也画成警告", async () => {
		renderMismatch("koishi");
		await screen.findByText("家里那台");
		expect(screen.queryByText(/对不上/)).toBeNull();
		expect(screen.queryByRole("button", { name: /改成/ })).toBeNull();
	});
});
