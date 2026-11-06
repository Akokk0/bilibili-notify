// @vitest-environment jsdom

import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
	vi.restoreAllMocks();
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

function mount(path: string, request?: (path: string, init?: RequestInit) => Response | undefined) {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const response = request?.(String(input), init);
			if (response) return response;
			if (String(input) === "/api/ai/skills")
				return Response.json({
					list: [
						{
							name: "weekly-report",
							description: "评选本周鸽王",
							body: "先列出订阅。",
							builtin: true,
							disableModelInvocation: false,
						},
					],
					problems: [],
					tools: [],
					toolLabels: {},
				});
			if (String(input) === "/api/cards/skins")
				return Response.json({
					skins: [
						{ id: "default", name: "默认卡片", builtin: true, updatedAt: 0 },
						{ id: "aurora", name: "极光", builtin: false, updatedAt: 1 },
					],
					active: "aurora",
					fallbacks: [],
				});
			if (String(input) === "/api/dashboard/skins")
				return Response.json({
					list: [{ id: "sakura", name: "樱花夜", modes: ["light", "dark"], hasWallpaper: true }],
					active: { light: null, dark: null },
				});
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

it("性格分类复用字段编辑器，内置只读，复制后独立保存而不选用", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing builtin fixture");
	const source = { ...builtin, builtin: true, usedBy: ["全局默认"] };
	const entries = [source];
	mount("/library?category=personas", (path) =>
		path === "/api/ai/personas"
			? Response.json({ revision: "version-1", entries, removedBuiltins: [] })
			: undefined,
	);
	expect((await screen.findAllByDisplayValue(source.persona.name))[0]).toHaveProperty(
		"disabled",
		true,
	);
	expect(screen.getByText("全局默认")).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "复制并编辑" }));
	expect(screen.getAllByDisplayValue(source.persona.name)[0]).toHaveProperty("disabled", false);
	expect(screen.queryByRole("button", { name: "设为默认" })).toBeNull();
	expect(screen.getByRole("button", { name: "保存性格" })).toBeTruthy();
});

it("性格保存只发送资源和版本，冲突保留输入，不写普通设置", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing builtin");
	const posts: unknown[] = [];
	let version = "version-1";
	mount("/library?category=personas", (path, init) => {
		if (path !== "/api/ai/personas") return undefined;
		if (init?.method === "POST") {
			posts.push(JSON.parse(String(init.body)));
			version = "version-2";
			return Response.json({ code: "conflict", message: "库中有更新，草稿保留" }, { status: 409 });
		}
		return Response.json({
			revision: version,
			entries: [{ ...builtin, id: "local-1", label: "我的性格", builtin: false, usedBy: [] }],
			removedBuiltins: [],
		});
	});
	const name = await screen.findByRole("textbox", { name: "性格名称" });
	await userEvent.clear(name);
	await userEvent.type(name, "修改后的草稿");
	await userEvent.click(screen.getByRole("button", { name: "保存性格" }));
	expect(await screen.findByText("库中有更新，草稿保留")).toBeTruthy();
	expect(await screen.findByRole("button", { name: "重新读取" })).toBeTruthy();
	expect(name).toHaveProperty("value", "修改后的草稿");
	expect(posts).toEqual([
		{
			op: "update",
			revision: "version-1",
			id: "local-1",
			content: {
				label: "修改后的草稿",
				persona: builtin.persona,
				dynamicPrompt: builtin.dynamicPrompt,
				liveSummaryPrompt: builtin.liveSummaryPrompt,
			},
		},
	]);
	await waitFor(() =>
		expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path) === "/api/settings")).toBe(
			false,
		),
	);
});

it("界面皮肤链接展示真实管理列表，选用仍由系统页负责", async () => {
	mount("/library?category=dashboard-skins");
	expect(await screen.findByText("樱花夜")).toBeTruthy();
	expect(screen.getByRole("button", { name: "调整" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "导出" })).toBeTruthy();
	expect(screen.queryByRole("group", { name: "浅色模式皮肤" })).toBeNull();
});

it("卡片皮肤链接提供原编辑、复制与导出，管理页不切换默认皮肤", async () => {
	mount("/library?category=card-skins");
	expect(await screen.findByText("极光")).toBeTruthy();
	expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "复制并编辑" })).toBeTruthy();
	expect(screen.getAllByRole("button", { name: "导出" })).toHaveLength(2);
	expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
});

it.each([
	["dashboard-skins", "/api/dashboard/skins", "樱花夜"],
	["card-skins", "/api/cards/skins", "极光"],
])("%s读取失败保留重试入口，不误报空库", async (category, endpoint, name) => {
	let failed = true;
	mount(`/library?category=${category}`, (path) =>
		path === endpoint && failed
			? Response.json({ code: "unavailable", message: "临时无法读取" }, { status: 503 })
			: undefined,
	);
	expect(await screen.findByText("皮肤列表暂时无法读取，请重试。")).toBeTruthy();
	expect(screen.queryByText(name)).toBeNull();
	failed = false;
	await userEvent.click(screen.getByRole("button", { name: "重试" }));
	expect(await screen.findByText(name)).toBeTruthy();
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
	mount("/library?category=unknown");
	expect(await screen.findByText("还没有图片")).toBeTruthy();
	expect(screen.getAllByRole("button", { name: /女仆性格/ }).length).toBeGreaterThan(0);
});

it("技能分类链接展示原技能编辑器，内置技能保持只读", async () => {
	mount("/library?category=skills");
	const body = await screen.findByRole("textbox", { name: "正文 · 做事的步骤" });
	expect((body as HTMLTextAreaElement).value).toBe("先列出订阅。");
	expect((body as HTMLTextAreaElement).disabled).toBe(true);
});

it("技能导出通过鉴权读取文件，以SKILL.md名称下载，不修改技能", async () => {
	const created = vi.fn(() => "blob:skill-export"),
		revoked = vi.fn();
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = created;
			static revokeObjectURL = revoked;
		},
	);
	const clicks: Array<{ href: string; name: string }> = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		clicks.push({ href: this.href, name: this.download });
	});
	mount("/library?category=skills", (path) =>
		path === "/api/ai/skills/weekly-report/export"
			? new Response("---\nname: weekly-report\n---\n", {
					headers: { "content-type": "text/markdown" },
				})
			: undefined,
	);
	await screen.findByRole("textbox", { name: "正文 · 做事的步骤" });
	await userEvent.click(screen.getByRole("button", { name: "导出 SKILL.md" }));
	expect(clicks).toEqual([{ href: "blob:skill-export", name: "weekly-report.SKILL.md" }]);
	const request = vi
		.mocked(fetch)
		.mock.calls.find(([path]) => String(path).endsWith("/weekly-report/export"));
	expect(request?.[1]?.credentials).toBe("include");
});
