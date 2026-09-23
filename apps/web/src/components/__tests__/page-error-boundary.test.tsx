// @vitest-environment jsdom

/**
 * 一页渲染时抛了错,**只丢这一页**:顶栏还在、还能点去别的页;这一页说一句出了什么错、带上
 * 报错原文,给重试与回首页。没有这层边界时,React 会把整棵树卸掉 —— 面板整个白屏。
 *
 * 渲染的是真的 `App`(边界摆在哪儿正是要钉的事:包到顶栏外面去,一页炸了顶栏也跟着没)。
 * 顶栏与角落里那几块换成桩:它们各自拖着一串查询与 WS,而这里要看的只是「它们还在不在」。
 * 各页也换成桩 —— 首页与订阅页由这里决定炸不炸。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { crash } = vi.hoisted(() => ({ crash: { home: false, subs: false } }));

vi.mock("../AuthGate", () => ({
	AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../header", () => ({
	GlassHeader: () => (
		<header data-testid="shell-header">
			<Link to="/subs">订阅</Link>
		</header>
	),
}));
vi.mock("../ai-chat", () => ({ AiChatDock: () => null, CHAT_PATH: "/chat" }));
vi.mock("../alert-shell", () => ({ AlertShell: () => null }));
vi.mock("../draft-island", () => ({ DraftIsland: () => null }));
vi.mock("../skin-preview-bar", () => ({ SkinPreviewBar: () => null }));
vi.mock("../toast-shell", () => ({ ToastShell: () => null }));
vi.mock("../onboarding/tour-companion", () => ({ TourCompanion: () => null }));
vi.mock("../../hooks/useAlertChannel", () => ({ useAlertChannel: () => {} }));
vi.mock("../../hooks/useAuthChannel", () => ({ useAuthChannel: () => {} }));
vi.mock("../../hooks/useAuthHydrate", () => ({ useAuthHydrate: () => {} }));
vi.mock("../../hooks/usePushEventsChannel", () => ({ usePushEventsChannel: () => {} }));
vi.mock("../../hooks/useStateChannel", () => ({ useStateChannel: () => {} }));
vi.mock("../../hooks/useUpdateCheckOnOpen", () => ({ useUpdateCheckOnOpen: () => {} }));
vi.mock("../../hooks/useUpdateTransitionNotice", () => ({
	useUpdateTransitionNotice: () => {},
}));
// 开发期那块 devtools 药丸(`import.meta.env.DEV` 在测试里是真)同样换桩 —— 它自己拖着查询。
vi.mock("../../devtools/dock", () => ({ DevDock: () => null }));
vi.mock("../../services/api", () => ({
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/health") return { status: "ok", uptime: 1 };
			throw new Error(`没有这个口:${url}`);
		}),
	},
	ApiError: class extends Error {},
}));

vi.mock("../../pages/Dashboard", () => ({
	default: () => {
		if (crash.home) throw new TypeError("Cannot read properties of undefined (reading 'map')");
		return <p>首页内容</p>;
	},
}));
vi.mock("../../pages/Subs", () => ({
	default: () => {
		if (crash.subs) throw new Error("订阅页炸了");
		return <p>订阅页内容</p>;
	},
}));
vi.mock("../../pages/About", () => ({ default: () => null }));
vi.mock("../../pages/Ai", () => ({ default: () => null }));
vi.mock("../../pages/CardSkinEditor", () => ({ default: () => null }));
vi.mock("../../pages/Cards", () => ({ default: () => null }));
vi.mock("../../pages/Chat", () => ({ default: () => null }));
vi.mock("../../pages/ExtensionDetail", () => ({ default: () => null }));
vi.mock("../../pages/Extensions", () => ({ default: () => null }));
vi.mock("../../pages/History", () => ({ default: () => null }));
vi.mock("../../pages/Logs", () => ({ default: () => null }));
vi.mock("../../pages/Rules", () => ({ default: () => null }));
vi.mock("../../pages/Stats", () => ({ default: () => null }));
vi.mock("../../pages/System", () => ({ default: () => null }));
vi.mock("../../pages/Targets", () => ({ default: () => null }));

import App from "../../App";

function renderAt(path: string) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[path]}>
				<App />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	crash.home = false;
	crash.subs = false;
	// React 把接住的渲染错误往 console.error 打一大串(连组件栈)—— 这里是故意的,静音;断言照写。
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("一页渲染抛错", () => {
	it("顶栏还在;这一页说出了错、带报错原文", async () => {
		crash.home = true;
		renderAt("/");
		const note = await screen.findByRole("alert");
		expect(screen.getByTestId("shell-header")).toBeTruthy();
		expect(note.textContent).toMatch(/这一页没能画出来/);
		// 原文(连错误的种类)要看得见 —— 吞成一句「出错了」等于让人对着黑盒猜。
		expect(note.textContent).toContain(
			"TypeError: Cannot read properties of undefined (reading 'map')",
		);
	});

	it("点「重试」重新画这一页,好了就回来", async () => {
		crash.home = true;
		renderAt("/");
		await screen.findByRole("alert");
		crash.home = false;
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(await screen.findByText("首页内容")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("点「回首页」去首页", async () => {
		crash.subs = true;
		renderAt("/subs");
		await screen.findByRole("alert");
		fireEvent.click(screen.getByRole("button", { name: "回首页" }));
		expect(await screen.findByText("首页内容")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("首页自己炸了就不给「回首页」—— 那一下和重试是同一件事", async () => {
		crash.home = true;
		renderAt("/");
		await screen.findByRole("alert");
		expect(screen.queryByRole("button", { name: "回首页" })).toBeNull();
	});

	it("从顶栏换一页,那一页照常画 —— 错误不跟着走", async () => {
		crash.home = true;
		renderAt("/");
		await screen.findByRole("alert");
		fireEvent.click(screen.getByRole("link", { name: "订阅" }));
		expect(await screen.findByText("订阅页内容")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
