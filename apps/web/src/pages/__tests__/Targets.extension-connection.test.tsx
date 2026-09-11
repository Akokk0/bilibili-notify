// @vitest-environment jsdom
/**
 * 拓展提供的连接(桥借来的一个 bot)上建推送目标。
 *
 * 🔴 此前点「新建推送目标」**没反应**:`makeEmptyTarget` 对拓展连接直接 `throw`(注释写着
 * 「眼下面板还建不出拓展连接,这条路不可达」—— 拓展页落地之后它可达了),异常抛在点击处理
 * 器里,界面上什么都不发生、控制台一行红。主人 2026-09-10 报的就是这个。
 *
 * 一条连接就是一个 bot(ADR-0012 决策 45):目标的平台跟着连接走,**这里不挑 bot** ——
 * 与直连同一套操作逻辑,目标只填名字 / 作用域 / 地址。挑 bot 是「新建连接」的事,守卫在
 * `Targets.new-extension-connection.test.tsx`。
 */

import { PlatformMetaProvider } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildPlatformTable } from "../../components/platform-meta";
import type { Connection } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

/** 桥借来的一个 telegram bot。config 归拓展自己定,这一层看不懂它。 */
const CONNECTION = {
	id: CONNECTION_ID,
	name: "小电视",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	platform: "telegram",
	config: { link: "link-home", botId: "telegram:7777" },
} as unknown as Connection;

function renderPage() {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/connections") return [CONNECTION];
		if (url === "/api/targets") return [];
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<PlatformMetaProvider value={buildPlatformTable([])}>
			<QueryClientProvider client={qc}>
				<Targets />
			</QueryClientProvider>
		</PlatformMetaProvider>,
	);
}

async function openNewTarget(): Promise<HTMLElement> {
	renderPage();
	await screen.findAllByText("小电视");
	// 右上那颗;空态卡上还有一颗同名的,按钮取第一颗
	fireEvent.click(screen.getAllByRole("button", { name: /新建推送目标/ })[0] as HTMLElement);
	return screen.findByRole("dialog");
}

beforeEach(() => {
	vi.mocked(api.post).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("拓展连接上建目标", () => {
	it("点「新建推送目标」弹窗真的打开 —— 不再在点击处理器里炸掉", async () => {
		const dialog = await openNewTarget();
		expect(dialog.textContent).toContain("新建推送目标");
	});

	it("目标只填名字 / 作用域 / 地址,平台跟着连接走 —— 与直连同一套", async () => {
		const dialog = await openNewTarget();
		// 没有「挑 bot」那一节:连接就是那个 bot
		expect(within(dialog).queryByText(/绑哪个 bot|挑一个 bot/)).toBeNull();
		fireEvent.change(within(dialog).getByPlaceholderText(/游戏交流群/), {
			target: { value: "电报群" },
		});
		// telegram 的会话地址(认不出的平台走通用称呼)
		fireEvent.change(within(dialog).getByPlaceholderText(/的 id/), {
			target: { value: "-1001234567890" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/targets");
		expect(body).toMatchObject({
			connectionId: CONNECTION_ID,
			kind: "session",
			platform: "telegram",
			scope: "group",
			address: "-1001234567890",
		});
		expect(body).not.toHaveProperty("botId");
	});

	/** 左栏那张连接卡画的是 **bot 的平台**的脸(认得的话),副标题说清是经谁借的。 */
	it("连接卡按 bot 的平台画脸,并说明是经拓展借来的", async () => {
		renderPage();
		const card = (await screen.findAllByText("小电视"))[0]?.closest("[data-bn]") as HTMLElement;
		expect(card).toBeTruthy();
	});
});
