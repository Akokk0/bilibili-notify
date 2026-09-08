// @vitest-environment jsdom

/**
 * 桥驮进来的平台在目标弹窗里配得出来。
 *
 * `target.platform` 是**开放词表** —— 桥上装了 telegram 插件就有 telegram,那条平台
 * 我们自己一行代码都不需要写。可弹窗里原先有两处写死了「onebot 或 qq-official」:
 * 「会话信息」整节按平台名决定渲不渲染,里头的字段函数末尾又 `return null`。合起来的
 * 效果是:一个 telegram 会话目标**连地址栏都没有** —— 建得出、存得下、发的时候才发现
 * 地址是空的,而且**没有编译错、没有测试红**。
 *
 * 判据现在按**形态**走(`kind === "session"` 就要填地址),称呼从平台注册表取、认不出
 * 就用通用说法。这个文件钉的就是这两件事。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connection, PushTarget } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

/** 今天连接侧还是闭集,所以桥那一支借一条 onebot 连接来演 —— 要紧的是**目标**的平台。 */
const CONNECTION = {
	id: CONNECTION_ID,
	name: "桥",
	enabled: true,
	kind: "direct",
	connector: "http",
	platform: "onebot",
	config: { transport: "http", baseUrl: "http://127.0.0.1:5700", accessToken: "" },
} as unknown as Connection;

const TELEGRAM_TARGET = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "电报群",
	connectionId: CONNECTION_ID,
	kind: "session",
	platform: "telegram",
	scope: "group",
	enabled: true,
	address: "-1001234567890",
} as unknown as PushTarget;

function renderPage() {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/connections") return [CONNECTION];
		if (url === "/api/targets") return [TELEGRAM_TARGET];
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Targets />
		</QueryClientProvider>,
	);
}

async function openTargetEditor(): Promise<HTMLElement> {
	renderPage();
	// 连接行也有一颗「配置」,目标行那颗在后面 —— 点完拿弹窗标题确认开对了。
	const buttons = await screen.findAllByRole("button", { name: "配置" });
	fireEvent.click(buttons[buttons.length - 1]);
	await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("配置推送目标"));
	return screen.getByRole("dialog");
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("认不出的平台的会话目标", () => {
	it("列表里的摘要用通用称呼报地址", async () => {
		renderPage();
		expect(await screen.findByText("→ 群 -1001234567890")).toBeTruthy();
	});

	it("弹窗里有「会话信息」这一节 —— 判据是形态,不是平台名", async () => {
		const dialog = await openTargetEditor();
		expect(within(dialog).getByText("会话信息")).toBeTruthy();
	});

	it("地址那一格填得进去,标签走通用称呼", async () => {
		const dialog = await openTargetEditor();
		expect(within(dialog).getByText("群地址")).toBeTruthy();
		expect(within(dialog).getByDisplayValue("-1001234567890")).toBeTruthy();
	});

	it("会话种类给全三档 —— 不知道它有没有频道,就别替主人少给一档", async () => {
		const dialog = await openTargetEditor();
		for (const label of ["群组", "私聊", "频道"]) {
			expect(within(dialog).getByRole("button", { name: label })).toBeTruthy();
		}
	});
});
