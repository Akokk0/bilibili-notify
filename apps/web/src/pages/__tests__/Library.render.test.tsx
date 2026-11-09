// @vitest-environment jsdom

import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import Library from "../Library";

const clients: QueryClient[] = [];
beforeAll(() => sessionStorage.setItem("bn.desktopToken", "r5-download-fixture"));
afterAll(() => sessionStorage.removeItem("bn.desktopToken"));
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

it("资源库接入共用页面入场动效，分类切换保留同一页面容器", async () => {
	mount("/library?category=fonts");
	await screen.findByText("示例字体.woff2");
	const page = screen.getByText("资源库", { exact: true }).closest(".bn-anim-page-in");
	expect(page).not.toBeNull();
	expect(page?.classList.contains("motion-reduce:animate-none!")).toBe(true);
	await userEvent.click(screen.getByRole("button", { name: "图片" }));
	expect(screen.getByText("资源库", { exact: true }).closest(".bn-anim-page-in")).toBe(page);
	expect(await screen.findByText("还没有图片")).toBeTruthy();
});

it("字体分类链接直接展示字体，保留原有管理操作", async () => {
	mount("/library?category=fonts");
	expect(await screen.findByText("示例字体.woff2")).toBeTruthy();
	expect(screen.getByRole("button", { name: "删除字体 示例字体.woff2" })).toBeTruthy();
	expect(screen.queryByText("还没有图片")).toBeNull();
});

it("字体原文件经下载接口导出，保留文件名，失败可见", async () => {
	const create = vi.fn(() => "blob:download");
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = create;
			static revokeObjectURL = vi.fn();
		},
	);
	const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
	const id = `${"a".repeat(32)}.woff2`;
	let fail = false;
	mount("/library?category=fonts", (path) =>
		path === `/api/library/fonts/${id}?download=1`
			? fail
				? Response.json(
						{ code: "unavailable", message: "下载暂时不可用", issues: [{ message: "请稍后重试" }] },
						{ status: 503 },
					)
				: new Response(new Uint8Array([119, 79, 70, 50]), {
						headers: { "content-type": "font/woff2" },
					})
			: undefined,
	);
	await userEvent.click(await screen.findByRole("button", { name: "导出字体 示例字体.woff2" }));
	await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
	expect(click.mock.instances[0]).toHaveProperty("download", "示例字体.woff2");
	expect(create).toHaveBeenCalledTimes(1);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "导出字体 示例字体.woff2" })).toHaveProperty(
			"disabled",
			false,
		),
	);
	fail = true;
	await userEvent.click(screen.getByRole("button", { name: "导出字体 示例字体.woff2" }));
	expect(await screen.findByText(/下载暂时不可用.*请稍后重试/)).toBeTruthy();
	expect(click).toHaveBeenCalledTimes(1);
});

it.each([
	["dashboard-skins", "/api/dashboard/skins/sakura/export"],
	["card-skins", "/api/cards/skins/default/export"],
])("%s ZIP 下载使用同一鉴权门，令牌不进URL", async (category, path) => {
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = vi.fn(() => "blob:zip");
			static revokeObjectURL = vi.fn();
		},
	);
	const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
	mount(`/library?category=${category}`, (url) =>
		url === path ? new Response(new Uint8Array([80, 75])) : undefined,
	);
	await userEvent.click((await screen.findAllByRole("button", { name: "导出" }))[0]);
	await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
	const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === path);
	expect(new Headers(request?.[1]?.headers).get("x-bn-desktop-token")).toBe("r5-download-fixture");
	expect(String(request?.[0])).not.toContain("desktopToken");
});

it("字体先预览再确认，取消不上传；失败保留预览并展示逐项原因，可重试", async () => {
	const writes: string[] = [];
	let attempts = 0;
	mount("/library?category=fonts", (path, init) => {
		if (init?.method !== "POST") return undefined;
		writes.push(path);
		if (path.endsWith("/import-preview"))
			return Response.json({ ok: true, name: "示例字体.woff2", warnings: [], conflict: true });
		attempts++;
		return attempts === 1
			? Response.json(
					{ code: "conflict", message: "导入未完成", issues: [{ message: "请重新检查这份文件" }] },
					{ status: 409 },
				)
			: Response.json({ ok: true, id: "new-font", name: "示例字体.woff2" });
	});
	await screen.findByText("示例字体.woff2");
	const input = screen.getByLabelText("上传字体");
	const file = new File(["font"], "示例字体.woff2");
	fireEvent.change(input, { target: { files: [file] } });
	let dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByText(/原件不变/)).toBeTruthy();
	expect(writes).toEqual(["/api/library/fonts/import-preview"]);
	await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(attempts).toBe(0);
	fireEvent.change(input, { target: { files: [file] } });
	dialog = await screen.findByRole("dialog");
	await userEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
	expect(await within(dialog).findByText(/请重新检查这份文件/)).toBeTruthy();
	expect(within(dialog).getByText("示例字体.woff2")).toBeTruthy();
	await userEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(attempts).toBe(2);
});

it("图片不能解码时给出预览失败说明，不露出坏图标", async () => {
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = vi.fn(() => "blob:preview");
			static revokeObjectURL = vi.fn();
		},
	);
	mount("/library?category=images", (path) =>
		path.endsWith("/import-preview")
			? Response.json({ ok: true, name: "sample.png", warnings: [], conflict: false })
			: undefined,
	);
	await screen.findByText("还没有图片");
	fireEvent.change(screen.getByLabelText("上传图片"), {
		target: { files: [new File(["broken"], "sample.png", { type: "image/png" })] },
	});
	const dialog = await screen.findByRole("dialog");
	fireEvent.error(await within(dialog).findByRole("img", { name: "待导入图片" }));
	expect(await within(dialog).findByText(/无法显示图片预览/)).toBeTruthy();
	expect(within(dialog).queryByRole("img", { name: "待导入图片" })).toBeNull();
});

it("personality editing and discard confirmation translate while user content stays original", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing builtin fixture");
	mount("/library?category=personas", (path) =>
		path === "/api/ai/personas"
			? Response.json({
					revision: "v1",
					entries: [
						{ ...builtin, id: "local", label: "我的性格", builtin: false, usedBy: [] },
						{ ...builtin, builtin: true, usedBy: [] },
					],
					removedBuiltins: [],
				})
			: undefined,
	);
	fireEvent.change(await screen.findByRole("textbox", { name: "性格名称" }), {
		target: { value: "未保存的名字" },
	});
	await userEvent.click(screen.getByRole("tab", { name: builtin.label }));
	for (const [locale, save, confirm, hint] of [
		[
			"en",
			"Save personality",
			"Confirm action",
			"Switching or reloading discards the current draft. Deleting removes the personality.",
		],
		[
			"ja",
			"性格を保存",
			"操作の確認",
			"切り替えや再読み込みを行うと、現在の下書きは失われます。削除するとこの性格が一覧から消えます。",
		],
		["zh-TW", "儲存性格", "確認操作", "切換或重新讀取會放棄目前草稿；刪除會移除此性格。"],
	] as const) {
		act(() => i18n.set({ locale }));
		await screen.findByRole("button", { name: save });
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(confirm)).toBeTruthy();
		expect(within(dialog).getByText(hint)).toBeTruthy();
		expect(screen.getByDisplayValue("未保存的名字")).toBeTruthy();
		expect(screen.getByDisplayValue(builtin.dynamicPrompt ?? "")).toBeTruthy();
		expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
	}
	await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.getByRole("tab", { name: "我的性格" }).getAttribute("aria-selected")).toBe("true");
	expect(screen.getByDisplayValue("未保存的名字")).toBeTruthy();
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

it("切换语言后重新读取内置性格，当前参照内容与副本同步更新", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing fixture");
	mount("/library?category=personas", (path) => {
		if (path !== "/api/ai/personas") return undefined;
		const english = i18n.state().locale === "en";
		return Response.json({
			revision: english ? "en-v1" : "zh-v1",
			entries: [
				{
					...builtin,
					label: english ? "Gentle maid" : "温柔女仆",
					persona: { ...builtin.persona, name: english ? "Aya" : "语言参照" },
					builtin: true,
					usedBy: [],
				},
			],
			removedBuiltins: [],
		});
	});
	await screen.findByDisplayValue("语言参照");
	act(() => i18n.set({ locale: "en" }));
	expect(await screen.findByDisplayValue("Aya")).toHaveProperty("disabled", true);
	await userEvent.click(screen.getByRole("button", { name: i18n.t("personas.copy") }));
	expect(screen.getByDisplayValue("Aya")).toHaveProperty("disabled", false);
});

it("切换语言保留自建性格未保存草稿，新目录版本由主人重新读取", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing fixture");
	mount("/library?category=personas", (path) =>
		path === "/api/ai/personas"
			? Response.json({
					revision: i18n.state().locale === "en" ? "en-v1" : "zh-v1",
					entries: [{ ...builtin, id: "local", label: "我的性格", builtin: false, usedBy: [] }],
					removedBuiltins: [],
				})
			: undefined,
	);
	const name = await screen.findByRole("textbox", { name: "性格名称" });
	await userEvent.clear(name);
	await userEvent.type(name, "尚未保存的名字");
	act(() => i18n.set({ locale: "en" }));
	expect(await screen.findByRole("button", { name: i18n.t("personas.reload") })).toBeTruthy();
	expect(screen.getByDisplayValue("尚未保存的名字")).toBeTruthy();
	expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("性格使用二级Tab切换，编辑草稿仍受丢弃确认保护", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing fixture");
	mount("/library?category=personas", (path) =>
		path === "/api/ai/personas"
			? Response.json({
					revision: "v1",
					entries: [
						{ ...builtin, builtin: true, usedBy: [] },
						{ ...builtin, id: "custom", label: "自己的性格", builtin: false, usedBy: [] },
					],
					removedBuiltins: [],
				})
			: undefined,
	);
	expect(
		(await screen.findByRole("tab", { name: builtin.label })).getAttribute("aria-selected"),
	).toBe("true");
	await userEvent.click(screen.getByRole("tab", { name: "自己的性格" }));
	const name = screen.getByRole("textbox", { name: "性格名称" });
	await userEvent.clear(name);
	await userEvent.type(name, "未保存的草稿");
	await userEvent.click(screen.getByRole("tab", { name: builtin.label }));
	expect(await screen.findByRole("dialog")).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "取消" }));
	expect(screen.getByRole("tab", { name: "自己的性格" }).getAttribute("aria-selected")).toBe(
		"true",
	);
	expect(name).toHaveProperty("value", "未保存的草稿");
});

it("性格导入预览保留原字段、初始焦点及取消语义，不写配置或资源", async () => {
	const builtin = builtinPresetsFor("zh-CN")[0];
	if (!builtin) throw new Error("missing fixture");
	const { label, persona, dynamicPrompt, liveSummaryPrompt } = builtin;
	mount("/library?category=personas", (path) => {
		if (path === "/api/ai/personas")
			return Response.json({
				revision: "v1",
				entries: [{ ...builtin, builtin: true, usedBy: ["全局默认"] }],
				removedBuiltins: [],
			});
		if (path.endsWith("/import-preview"))
			return Response.json({
				ok: true,
				content: { label, persona, dynamicPrompt, liveSummaryPrompt },
			});
		return undefined;
	});
	await screen.findByDisplayValue(label);
	fireEvent.change(screen.getByLabelText("导入 JSON"), {
		target: { files: [new File(["{}"], "persona.json")] },
	});
	const dialog = await screen.findByRole("dialog");
	const name = within(dialog).getByRole("textbox", { name: "性格名称" });
	expect(within(dialog).getByText(/库中已有同名资源.*原件不变/)).toBeTruthy();
	expect(document.activeElement).toBe(name);
	expect(within(dialog).getByRole("textbox", { name: "作品点评 prompt" })).toHaveProperty(
		"value",
		dynamicPrompt,
	);
	await userEvent.clear(name);
	await userEvent.type(name, "预览草稿");
	await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(
		vi
			.mocked(fetch)
			.mock.calls.filter(([, init]) => init?.method === "POST")
			.map(([path]) => String(path)),
	).toEqual(["/api/ai/personas/import-preview"]);
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

it("技能使用二级Tab，并保留新建独立技能的入口", async () => {
	mount("/library?category=skills");
	expect(
		(await screen.findByRole("tab", { name: /weekly-report/ })).getAttribute("aria-selected"),
	).toBe("true");
	await userEvent.click(screen.getByRole("button", { name: "+ 新建" }));
	expect(screen.getByRole("tab", { name: "新技能" }).getAttribute("aria-selected")).toBe("true");
	expect(screen.getByRole("textbox", { name: "名字 · 也是斜杠命令" })).toHaveProperty("value", "");
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

it.each([
	[
		"ja",
		"ご主人様、整理したリソースは対応するページで選んでくださいね。会話の添付ファイルとスキン同梱のファイルは、元の場所に残しておきますよ。",
		"フォント 示例字体.woff2 を削除",
		"ご主人様、削除すると元には戻せません。先に参照を確認し、使用中の素材は残しますね。",
		"削除は取り消せません。事前に参照を確認し、設定で使っているリソースは残します。",
	],
	[
		"zh-TW",
		"主人，整理好後再到對應頁面選用；對話附件與皮膚內附檔案仍保留在原處喔。",
		"刪除字型 示例字体.woff2",
		"主人，刪除後就無法復原了；刪除前會檢查引用，仍在使用的素材會保留喔。",
		"刪除後無法復原；刪除前會檢查引用，仍被設定使用的資源會保留。",
	],
] as const)(
	"%s maid library guidance preserves the file, category URL and unconfirmed deletion",
	async (locale, scope, remove, maid, plain) => {
		mount("/library?category=fonts&from=cards");
		const filename = await screen.findByText("示例字体.woff2");
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(scope)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: remove }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(maid)).toBeTruthy();
		act(() => i18n.set({ voice: "plain" }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(within(dialog).getByText(plain)).toBeTruthy();
		expect(within(dialog).getByText("示例字体.woff2")).toBeTruthy();
		expect(filename.isConnected).toBe(true);
		expect(screen.getByLabelText("当前位置").textContent).toBe(
			"/library?category=fonts&from=cards",
		);
		expect(
			vi.mocked(fetch).mock.calls.some(([, init]) => init?.method && init.method !== "GET"),
		).toBe(false);
	},
);

it("library navigation and deletion text translate while keeping the file and category address", async () => {
	mount("/library?category=fonts&from=cards");
	const filename = await screen.findByText("示例字体.woff2");
	for (const [locale, fonts, images, skills] of [
		["en", "Fonts", "Images", "Maid skills"],
		["ja", "フォント", "画像", "メイドスキル"],
		["zh-TW", "字型", "圖片", "女僕技能"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("button", { name: fonts }).getAttribute("aria-current")).toBe("true");
		expect(screen.getByRole("button", { name: images })).toBeTruthy();
		expect(screen.getByRole("button", { name: skills })).toBeTruthy();
		expect(screen.getByText("示例字体.woff2")).toBe(filename);
		expect(screen.getByLabelText("当前位置").textContent).toBe(
			"/library?category=fonts&from=cards",
		);
	}
	await userEvent.click(screen.getByRole("button", { name: "刪除字型 示例字体.woff2" }));
	const dialog = screen.getByRole("dialog");
	for (const [locale, title, remove] of [
		["en", "Delete this font?", "Delete"],
		["ja", "このフォントを削除しますか？", "削除"],
		["zh-TW", "刪除此字型？", "刪除"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(within(dialog).getByText(title)).toBeTruthy();
		expect(within(dialog).getByText("示例字体.woff2")).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: remove })).toBeTruthy();
		expect(
			vi.mocked(fetch).mock.calls.some(([, init]) => init?.method && init.method !== "GET"),
		).toBe(false);
	}
	await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.getByText("示例字体.woff2")).toBe(filename);
	expect(
		vi.mocked(fetch).mock.calls.some(([, init]) => init?.method && init.method !== "GET"),
	).toBe(false);
});

it("resource import preview translates without changing the file, raw warning or confirmation boundary", async () => {
	const writes: string[] = [];
	mount("/library?category=fonts", (path, init) => {
		if (init?.method !== "POST") return undefined;
		writes.push(path);
		if (path.endsWith("/import-preview"))
			return Response.json({
				ok: true,
				name: "主人原字体.woff2",
				warnings: ["原始诊断保留"],
				conflict: true,
			});
		throw new Error("unexpected write before confirmation");
	});
	await screen.findByText("示例字体.woff2");
	fireEvent.change(screen.getByLabelText("上传字体"), {
		target: { files: [new File(["font"], "主人原字体.woff2", { type: "font/woff2" })] },
	});
	const dialog = await screen.findByRole("dialog");
	for (const [locale, title, confirm, hint] of [
		["en", "Preview import", "Confirm import", "The original is unchanged."],
		["ja", "インポートのプレビュー", "インポートする", "元のリソースは変更しません。"],
		["zh-TW", "匯入預覽", "確認匯入", "原件不會變更。"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(within(dialog).getByText(title)).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: confirm })).toBeTruthy();
		expect(dialog.textContent).toContain(hint);
		expect(dialog.textContent).toContain("主人原字体.woff2");
		expect(dialog.textContent).toContain("原始诊断保留");
		expect(writes).toEqual(["/api/library/fonts/import-preview"]);
	}
	await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(writes).toEqual(["/api/library/fonts/import-preview"]);
});
