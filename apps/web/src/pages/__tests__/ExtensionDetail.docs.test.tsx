// @vitest-environment jsdom

/**
 * 拓展详情页上那块「说明 / 更新日志」。
 *
 * 两件事值得钉:① 有就画、**没有就整块不画**(空盒子比没有更难看,也让人以为加载坏了);
 * ② 内容是第三方写的,走 `UNTRUSTED_MARKDOWN_COMPONENTS` 那副受限渲染,不是文档那副。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../services/api";
import ExtensionDetail from "../ExtensionDetail";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});

const { docs } = vi.hoisted(() => ({ docs: { value: {} as Record<string, unknown> } }));

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url.endsWith("/docs")) return docs.value;
			return {
				extensions: [
					{
						id: "bridge",
						name: "机器人框架桥接",
						description: "借 bot",
						version: "0.0.1",
						enabled: false,
						state: "disabled",
					},
				],
			};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

vi.mock("../extensions/bridge-panel", () => ({
	BridgeAddressRow: () => <div />,
	BridgeConnections: () => <div />,
}));

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter initialEntries={["/extensions/bridge"]}>
			<QueryClientProvider client={qc}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("详情页上的拓展文档", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("有 README → 画出来", async () => {
		docs.value = { readme: "# 桥接\n\n把 koishi 的 bot 借过来。" };
		renderDetail();
		expect(await screen.findByText(/把 koishi 的 bot 借过来/)).toBeTruthy();
	});

	it("有 CHANGELOG → 也看得到", async () => {
		docs.value = { changelog: "## [0.0.1]\n\n第一版。" };
		renderDetail();
		expect(await screen.findByText(/第一版/)).toBeTruthy();
	});

	/** 🔴 两份都没有就**整块不画** —— 空盒子会让人以为是加载坏了。 */
	it("两份都没有 → 连标题都不出现", async () => {
		docs.value = {};
		renderDetail();
		// 等这一条本身就够了 —— 名字在面包屑与标题里各有一份,拿它当信号会撞上两个节点。
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext/bridge/docs"));
		expect(screen.queryByText("说明")).toBeNull();
		expect(screen.queryByText("更新日志")).toBeNull();
	});
});

/**
 * 🔴 **这一组必须挂在详情页上,不能自己 new 一个 `<ReactMarkdown>` 来测。**
 *
 * 受限渲染是不是真的接在了这条路上,只有从**真调用点**量才算数:同样的三条断言写在
 * 组件的单测里(`components/__tests__/untrusted-markdown.test.tsx`),把 `docs-panel`
 * 换成 `dangerouslySetInnerHTML`(第三方 README 直进 DOM,最严重的那种回归)照样 8 条
 * 全绿 —— 因为那个文件从不 import `docs-panel`。仓里管这叫「接线要有自己的守卫」。
 *
 * 三条各钉一种回归:引了 `rehype-raw` / 改走 innerHTML / 换回站内文档那副映射
 * (那副没有 `img` 格、`a` 也无条件渲染 href)。
 */
describe("详情页画第三方内容时走的是受限渲染", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("README 里的裸 HTML 当字面文本,不变成节点", async () => {
		docs.value = { readme: '<img src=x onerror="alert(1)"> 后面还有字' };
		renderDetail();
		const para = await screen.findByText(/后面还有字/);
		expect(para.querySelector("img")).toBeNull();
		// 那段 HTML 得**原样念得出来**,否则它可能是被整段吞了而不是被转义了。
		expect(para.textContent).toContain("onerror");
	});

	it("README 里的 `javascript:` 链接不给 href —— 连 `<a>` 都不留", async () => {
		docs.value = { readme: "[点我](javascript:alert(1))" };
		renderDetail();
		const text = await screen.findByText(/点我/);
		// 只问「这段字在不在一个 <a> 里」—— 页面上本来就有面包屑等别的链接,
		// 拿 `document.querySelector("a")` 问会把它们一起抓进来。
		expect(text.closest("a")).toBeNull();
	});

	/** 相对路径脱离了源仓就拼不出地址,画出去是碎图、而且照样往面板自己身上发一次请求。 */
	it("README 里的相对路径图片退成占位,不渲染成 img", async () => {
		docs.value = { readme: "![流程图](docs/flow.png)" };
		renderDetail();
		// 占位是**看得见的字**;真画成 img 的话 alt 不算文本,这一句就找不着。
		const placeholder = await screen.findByText(/流程图 —— 见源站/);
		expect(placeholder.querySelector("img")).toBeNull();
	});
});
