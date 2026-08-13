// @vitest-environment jsdom
/**
 * 侧栏设置弹层的成员清单 —— 「思考深度」搬进来之后,守住它真的在弹层里。
 * 档位行为、能力位、PATCH 载荷在 thinking-level-setting.test.tsx 里逐条守;
 * 这里只看集成:齿轮点开,主题色 / 玻璃质感 / 思考深度三节都在。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatSidebar } from "../sidebar";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function mountSidebar() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.activeProfile = "p1";
	g.defaults.ai.providers = {
		p1: {
			provider: "deepseek",
			label: "",
			apiKey: "k",
			baseUrl: "https://x",
			model: "m",
			apiFlavor: "chat",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	vi.mocked(api.get).mockResolvedValue(JSON.parse(JSON.stringify(g)));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ChatSidebar
				conversations={[]}
				activeId={null}
				onSelect={() => {}}
				onNew={() => {}}
				onDelete={() => {}}
				onCollapse={() => {}}
				theme="violet"
				onThemeChange={() => {}}
				userName="主人"
				aiName="伦伦"
				glassOpacity={0.5}
				onGlassOpacityChange={() => {}}
				glassClear={false}
				onGlassClearChange={() => {}}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ChatSidebar — 设置弹层", () => {
	it("齿轮点开 → 主题色 / 玻璃质感 / 思考深度三节都在", async () => {
		mountSidebar();
		fireEvent.click(screen.getByRole("button", { name: "聊天设置" }));
		expect(screen.getByText("主题色")).toBeTruthy();
		expect(screen.getByText("玻璃质感")).toBeTruthy();
		expect(await screen.findByText("思考深度")).toBeTruthy();
	});
});
