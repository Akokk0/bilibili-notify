// @vitest-environment jsdom
/**
 * 「连上多久了」。
 *
 * 🔴 这是一条**字段断在某一跳**的守卫:桥一直在 `publishStatus` 里报 `connectedAt`,
 * 类型里也有这一格,面板收下之后**从没画出来** —— 类型、测试、构建全绿,只有人看着
 * 界面才发现少了东西(仓里同一个死法已经咬过好几次)。
 *
 * 而这一格在这一页有实际用处:「刚刚连上」与「连了三天」区分的是「它刚重连过」和
 * 「它一直好好的」,那正是主人查桥的时候要问的第一件事。
 */

import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { renderPanel } from "./bridge-harness";

const LINKS = [
	{
		id: "c1",
		name: "家里那台",
		enabled: true,
		token: "0123456789abcdef0123456789abcdef",
		bridgeKind: "koishi",
	},
	{
		id: "c2",
		name: "机房那台",
		enabled: true,
		token: "ffffffffffffffffffffffffffffffff",
		bridgeKind: "astrbot",
	},
];

function renderSince(connectedAt: number) {
	return renderPanel({
		links: LINKS,
		status: {
			sessions: [
				{
					linkId: "c1",
					connected: true,
					kind: "koishi",
					name: "客厅那台",
					version: "0.1.0",
					connectedAt,
					bots: [],
				},
				{ linkId: "c2", connected: false, bots: [] },
			],
		},
	});
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("连上多久了", () => {
	it("连着的那条印得出「多久前连上」", async () => {
		renderSince(Date.now() - 12 * 60_000);
		await screen.findByText("家里那台");
		expect(screen.getByText(/12 分钟前连上/)).toBeTruthy();
	});

	it("刚重连过的说「刚刚」—— 那是「它刚断过」的信号,不该跟「连了三天」长一个样", async () => {
		renderSince(Date.now() - 5_000);
		await screen.findByText("家里那台");
		expect(screen.getByText(/刚刚连上/)).toBeTruthy();
	});

	it("没连上的那条不说这句 —— 它压根没有「连上的那一刻」", async () => {
		renderSince(Date.now() - 12 * 60_000);
		const card = (await screen.findByText("机房那台")).closest("[data-link-card]");
		expect(card).toBeTruthy();
		if (!card) throw new Error("没有这张卡");
		// 状态那句「没连上」里也有「连上」两个字 —— 问的是「多久前连上」那一句
		expect(within(card as HTMLElement).queryByText(/(前|刚刚)连上/)).toBeNull();
	});
});
