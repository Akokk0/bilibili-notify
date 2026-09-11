// @vitest-environment jsdom
/**
 * 能力三态**怎么画**,以及那排图例。
 *
 * 🔴 这条守卫有具体的出处:2026-09-10 主人看着面板问「onebot 怎么可能只能接收消息,
 * 肯定有问题」—— 当时「不支持」那几项被画成了**删除线**。删除线在这套界面里的意思是
 * 「作废 / 坏了」,不是「这个平台没有这项」,于是一张正常的能力表被读成了故障。
 *
 * 所以钉三件事:① 不支持**不许**再用删除线;② 三态的画法**两两不同**(合并任意两档,
 * 「不支持」与「还不知道」的区别就没了 —— 前者是结论,后者是「试试看,可能行」);
 * ③ 图例**必须在场** —— 没有图例,主人只能靠猜每个记号是什么意思,今天就是这么猜错的。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { BridgeConnections } from "../bridge-panel";

/** 接入住桥的设置里(`globals.extensions.bridge.settings.links`),不在连接表里。 */
function globalsWith(links: unknown[]) {
	return { extensions: { bridge: { enabled: true, settings: { links } } } };
}

const LINK = {
	id: "c1",
	name: "koishi 那台",
	enabled: true,
	token: "0123456789abcdef0123456789abcdef",
	bridgeKind: "koishi",
};

const STATUS = {
	sessions: [
		{
			linkId: "c1",
			connected: true,
			kind: "koishi",
			name: "客厅那台",
			version: "0.1.0",
			connectedAt: 1_700_000_000_000,
			bots: [
				{
					botId: "onebot:1",
					platform: "onebot",
					name: "阿库娅",
					selfId: "2854196310",
					capabilities: {
						atAll: "supported",
						inbound: "supported",
						forward: "supported",
						miniAppCard: "unknown",
						shareCardLinks: "unsupported",
						markdown: "unsupported",
					},
				},
			],
		},
	],
};

function renderPanel() {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/globals") return globalsWith([LINK]);
		if (path.startsWith("/api/ext/")) return STATUS;
		throw new Error("没有这个口");
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BridgeConnections extensionId="bridge" enabled />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** 一项能力那颗记号的画法 —— 记号本身,不含旁边那行字。 */
function markOf(label: string): Element {
	const chip = screen.getByTitle(new RegExp(`^${label}:`));
	const mark = chip.querySelector("[data-cap-mark]");
	if (!mark) throw new Error(`「${label}」没有记号`);
	return mark;
}

describe("能力三态怎么画", () => {
	it("「不支持」不许画成删除线 —— 那是「坏了」的意思,不是「没有这项」", async () => {
		renderPanel();
		await screen.findByText("阿库娅");
		for (const label of ["分享卡链接", "markdown"]) {
			const chip = screen.getByTitle(new RegExp(`^${label}:不支持`));
			expect(chip.className).not.toMatch(/line-through/);
			expect(chip.querySelector(".line-through")).toBeNull();
		}
	});

	it("三态的记号两两不同 —— 合并任意两档,「不支持」与「还不知道」就没区别了", async () => {
		renderPanel();
		await screen.findByText("阿库娅");
		const marks = [
			markOf("@全体").className, // supported
			markOf("分享卡链接").className, // unsupported
			markOf("小程序卡").className, // unknown
		];
		expect(new Set(marks).size).toBe(3);
	});

	it("图例在场 —— 三个记号各配一句话,不用猜", async () => {
		renderPanel();
		const legend = await screen.findByRole("list", { name: "能力图例" });
		for (const text of ["支持", "不支持", "还不知道"]) {
			expect(
				[...legend.querySelectorAll("li")].some((item) => item.textContent?.trim() === text),
			).toBe(true);
		}
	});
});
