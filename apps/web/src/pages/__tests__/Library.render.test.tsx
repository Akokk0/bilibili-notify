// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import Library from "../Library";

const clients: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

function LocationControls() {
	const location = useLocation(),
		navigate = useNavigate();
	return (
		<>
			<output aria-label="当前位置">
				{location.pathname}
				{location.search}
			</output>
			<button type="button" onClick={() => navigate(-1)}>
				后退
			</button>
		</>
	);
}

function mount(path: string) {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			if (String(input) === "/api/library/fonts")
				return Response.json({
					ok: true,
					fonts: [{ id: `${"a".repeat(32)}.woff2`, name: "示例字体.woff2", size: 1024 }],
				});
			if (String(input) === "/api/library/images") return Response.json({ ok: true, ids: [] });
			throw new Error(`Unexpected request: ${input}`);
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<LocationControls />
				<Library />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

it("字体分类链接直接展示字体，保留原有管理操作", async () => {
	mount("/library?category=fonts");
	expect(await screen.findByText("示例字体.woff2")).toBeTruthy();
	expect(screen.getByRole("button", { name: "删除字体 示例字体.woff2" })).toBeTruthy();
	expect(screen.queryByText("还没有图片")).toBeNull();
});

it("切换分类更新可分享地址，保留其他参数并支持后退", async () => {
	mount("/library?category=images&from=cards");
	await screen.findByText("还没有图片");
	await userEvent.click(screen.getAllByRole("button", { name: /^字体/ })[0] as HTMLElement);
	await screen.findByText("示例字体.woff2");
	expect(screen.getByLabelText("当前位置").textContent).toBe("/library?category=fonts&from=cards");
	await userEvent.click(screen.getByRole("button", { name: "后退" }));
	expect(await screen.findByText("还没有图片")).toBeTruthy();
	expect(screen.getByLabelText("当前位置").textContent).toBe("/library?category=images&from=cards");
});

it("未知分类仍可浏览图片，不展示未接入的资源管理", async () => {
	mount("/library?category=skills");
	expect(await screen.findByText("还没有图片")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /女仆技能/ })).toBeNull();
});
