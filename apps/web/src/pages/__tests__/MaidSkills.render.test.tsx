// @vitest-environment jsdom

/**
 * 「女仆技能」编辑器。
 *
 * 这一层要钉的四件事:
 * ① **内置改不动。** 摊开给主人看(照着抄),但一个字都写不进去。
 * ② **改名发的是旧名字。** 服务端认路径上那个名字,从草稿里取会把请求发到一条
 *    还不存在的技能上,换回一个 404 —— 而界面上看起来只是「保存失败」。
 * ③ **一眼可见的错在本地就拦。** 名字不合法不该跑一趟服务端。
 * ④ **盘上读不进来的要显出来。** 主人手放的文件写错了,得让他看得见。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MaidSkills } from "../ai/MaidSkills";

// vi.mock 的工厂被提升到文件顶部,所以它引用的东西也得先于它存在 —— 一律进
// vi.hoisted,别在外面留 const(那会是 "Cannot access before initialization")。
const H = vi.hoisted(() => ({
	list: [] as unknown[],
	problems: [] as unknown[],
	tools: ["list_subscriptions", "get_creator_profile", "web_search"],
	toolLabels: {
		list_subscriptions: "列出订阅",
		get_creator_profile: "查看创作者资料",
		web_search: "联网搜索",
	},
}));

const M = vi.hoisted(() => ({
	create: vi.fn(async (_skill: Record<string, unknown>) => ({ ok: true as const })),
	update: vi.fn(async (_name: string, _skill: Record<string, unknown>) => ({ ok: true as const })),
	remove: vi.fn(async (_name: string) => ({ ok: true as const })),
	preview: vi.fn(),
	export: vi.fn(),
}));

vi.mock("../../services/maidSkill", () => ({
	maidSkillsQueryKey: ["ai", "skills"],
	listMaidSkills: vi.fn(async () => ({
		list: H.list,
		problems: H.problems,
		tools: H.tools,
		toolLabels: H.toolLabels,
	})),
	createMaidSkill: M.create,
	updateMaidSkill: M.update,
	deleteMaidSkill: M.remove,
	previewMaidSkill: M.preview,
	exportMaidSkill: M.export,
}));

const skill = (over: Record<string, unknown> = {}) => ({
	name: "weekly-report",
	description: "评选本周鸽王",
	disableModelInvocation: false,
	body: "先列订阅",
	builtin: true,
	...over,
});

function mount() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MaidSkills />
		</QueryClientProvider>,
	);
}

/** 技能切换用Tab，新建仍是独立动作。 */
const pick = (label: string | RegExp) =>
	fireEvent.click(
		screen.queryByRole("tab", { name: label }) ?? screen.getByRole("button", { name: label }),
	);

const nameBox = () => screen.getByPlaceholderText("weekly-report") as HTMLInputElement;
const descBox = () => screen.getByPlaceholderText("一句话说清这条技能干什么") as HTMLInputElement;
const bodyBox = () => screen.getByLabelText("正文 · 做事的步骤") as HTMLTextAreaElement;

beforeEach(() => {
	H.list = [
		skill(),
		skill({ name: "my-skill", description: "我写的", builtin: false, body: "步骤" }),
	];
	H.problems = [];
	H.tools = ["list_subscriptions", "get_creator_profile", "web_search"];
	M.create.mockClear();
	M.update.mockClear();
	M.remove.mockClear();
	M.preview.mockReset();
	M.export.mockReset();
});

afterEach(cleanup);

it("导入先预览，默认保留同名原件；确认冲突后可改名重试，原编辑草稿保留", async () => {
	M.preview.mockResolvedValue({
		ok: true,
		skill: {
			name: "my-skill",
			description: "导入的技能",
			body: "导入正文",
			allowedTools: ["web_search"],
			disableModelInvocation: true,
		},
	});
	M.create.mockRejectedValueOnce(new Error("这个名字已被占用"));
	mount();
	await screen.findByDisplayValue("weekly-report");
	const file = new File(["skill"], "SKILL.md", { type: "text/markdown" });
	fireEvent.change(screen.getByLabelText("导入 SKILL.md"), { target: { files: [file] } });
	const dialog = await screen.findByRole("dialog");
	expect(M.preview).toHaveBeenCalledWith(file);
	expect(M.create).not.toHaveBeenCalled();
	const name = within(dialog).getByRole("textbox", { name: "导入后名称" }) as HTMLInputElement;
	expect(name.value).toBe("my-skill-copy");
	expect(within(dialog).getByText("导入正文")).toBeTruthy();
	fireEvent.change(name, { target: { value: "my-skill" } });
	fireEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
	expect(await within(dialog).findByText("这个名字已被占用")).toBeTruthy();
	expect(M.update).not.toHaveBeenCalled();
	fireEvent.change(name, { target: { value: "my-skill-copy" } });
	fireEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(M.create).toHaveBeenLastCalledWith(
		expect.objectContaining({
			name: "my-skill-copy",
			body: "导入正文",
			allowedTools: ["web_search"],
			disableModelInvocation: true,
		}),
	);
	expect(nameBox().value).toBe("weekly-report");
	expect(bodyBox().value).toBe("先列订阅");
});

it("错误或超限文件不修改库，取消预览保留当前编辑草稿", async () => {
	M.preview.mockRejectedValueOnce(new Error("文件没有frontmatter"));
	mount();
	await screen.findByDisplayValue("weekly-report");
	const input = screen.getByLabelText("导入 SKILL.md");
	fireEvent.change(input, { target: { files: [new File(["bad"], "SKILL.md")] } });
	expect(await screen.findByText(/文件没有frontmatter/)).toBeTruthy();
	M.preview.mockClear();
	fireEvent.change(input, { target: { files: [new File(["x".repeat(262145)], "SKILL.md")] } });
	expect(await screen.findByText(/技能文件超过 256 KB/)).toBeTruthy();
	expect(M.preview).not.toHaveBeenCalled();
	M.preview.mockResolvedValue({
		ok: true,
		skill: {
			name: "import-test",
			description: "导入",
			body: "正文",
			disableModelInvocation: false,
		},
	});
	fireEvent.change(input, { target: { files: [new File(["skill"], "SKILL.md")] } });
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(M.create).not.toHaveBeenCalled();
	expect(bodyBox().value).toBe("先列订阅");
});

it("导入预览的键盘焦点留在弹窗中，Escape取消不改当前技能", async () => {
	M.preview.mockResolvedValue({
		ok: true,
		skill: {
			name: "import-test",
			description: "导入",
			body: "正文",
			disableModelInvocation: false,
		},
	});
	mount();
	await screen.findByDisplayValue("weekly-report");
	fireEvent.change(screen.getByLabelText("导入 SKILL.md"), {
		target: { files: [new File(["skill"], "SKILL.md")] },
	});
	const dialog = await screen.findByRole("dialog");
	await waitFor(() =>
		expect(document.activeElement).toBe(
			within(dialog).getByRole("textbox", { name: "导入后名称" }),
		),
	);
	await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
	expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "确认导入" }));
	await userEvent.keyboard("{Tab}");
	expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "导入后名称" }));
	await userEvent.keyboard("{Escape}");
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(M.create).not.toHaveBeenCalled();
});

it("确认正在保存时仍将键盘焦点留在导入弹窗中", async () => {
	M.preview.mockResolvedValue({
		ok: true,
		skill: {
			name: "pending-import",
			description: "导入",
			body: "正文",
			disableModelInvocation: false,
		},
	});
	let finish = (_value: { ok: true }) => {};
	M.create.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	mount();
	await screen.findByDisplayValue("weekly-report");
	fireEvent.change(screen.getByLabelText("导入 SKILL.md"), {
		target: { files: [new File(["skill"], "SKILL.md")] },
	});
	const dialog = await screen.findByRole("dialog");
	await userEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
	await userEvent.tab();
	expect(dialog.contains(document.activeElement)).toBe(true);
	await act(async () => {
		finish({ ok: true });
	});
});

describe("三个编辑框的无障碍名", () => {
	it("按可见标题就能精确取到 —— 不是「标题+整段提示」的拼接", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));

		// 这三个此前包在 <label> 里,而 label 除标题外还含一整段提示文字:HTML-AAM 下
		// 无障碍名 = label 的全部 textContent,且**span 之间没有分隔**。实测念出来的是
		// 「名字 · 也是斜杠命令小写字母 / 数字 / 单个连字符。它同时是……」。
		// 精确匹配(非正则)取得到,就说明名字只剩标题本身。
		for (const [title, tag] of [
			["名字 · 也是斜杠命令", "INPUT"],
			["description · 技能用途", "INPUT"],
			["正文 · 做事的步骤", "TEXTAREA"],
		] as const) {
			expect(`${title}=${screen.getByLabelText(title).tagName}`).toBe(`${title}=${tag}`);
		}
	});
});

describe("内置技能", () => {
	it("复制并编辑只建立可修改草稿，确认保存前不改库", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "复制并编辑" }));
		expect(nameBox().disabled).toBe(false);
		expect(nameBox().value).toBe("weekly-report-copy");
		expect(bodyBox().value).toBe("先列订阅");
		expect(M.create).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() =>
			expect(M.create).toHaveBeenCalledWith(
				expect.objectContaining({ name: "weekly-report-copy", body: "先列订阅" }),
			),
		);
		expect(M.update).not.toHaveBeenCalled();
	});
	it("摊开给主人看,但一个字都改不动、也删不掉", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		expect(nameBox().disabled).toBe(true);
		expect(bodyBox().disabled).toBe(true);
		expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
		expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
	});
});

describe("自己写的那些", () => {
	it("切过去就能改,保存发的是 update", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick("my-skill");
		await waitFor(() => expect(nameBox().value).toBe("my-skill"));
		expect(nameBox().disabled).toBe(false);

		fireEvent.change(bodyBox(), { target: { value: "换了个说法" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(M.update).toHaveBeenCalled());
		expect(M.update.mock.calls[0]?.[0]).toBe("my-skill");
		expect(M.update.mock.calls[0]?.[1]).toMatchObject({ body: "换了个说法" });
	});

	it("改名时发的是**旧**名字 —— 服务端认的是路径上那个", async () => {
		// 从草稿里取的话,请求会发到一条还不存在的技能上,换回一个 404,而界面上
		// 只显示「保存失败」,谁也想不到是改名这一步错了。
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick("my-skill");
		await waitFor(() => expect(nameBox().value).toBe("my-skill"));

		fireEvent.change(nameBox(), { target: { value: "renamed" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(M.update).toHaveBeenCalled());
		expect(M.update.mock.calls[0]?.[0]).toBe("my-skill");
		expect(M.update.mock.calls[0]?.[1]).toMatchObject({ name: "renamed" });
	});

	it("勾工具 → 进 allowed-tools;全取消 → 这个字段整个消失(= 不限)", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick("my-skill");
		await waitFor(() => expect(nameBox().value).toBe("my-skill"));

		fireEvent.click(screen.getByRole("checkbox", { name: "列出订阅" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(M.update).toHaveBeenCalled());
		expect(M.update.mock.calls[0]?.[1]).toMatchObject({
			allowedTools: ["list_subscriptions"],
		});

		fireEvent.click(screen.getByRole("checkbox", { name: "列出订阅" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(M.update).toHaveBeenCalledTimes(2));
		// 「一把都不给」是个静默的大收紧,不该是「取消勾选」的意思。
		expect(M.update.mock.calls[1]?.[1]).not.toHaveProperty("allowedTools");
	});

	it("删除 → 发 delete", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick("my-skill");
		await waitFor(() => expect(nameBox().value).toBe("my-skill"));
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		await waitFor(() => expect(M.remove).toHaveBeenCalled());
		expect(M.remove.mock.calls[0]?.[0]).toBe("my-skill");
	});
});

describe("新建", () => {
	it("填齐三样 → create", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick(/新建/);
		await waitFor(() => expect(nameBox().value).toBe(""));

		fireEvent.change(nameBox(), { target: { value: "my-new-one" } });
		fireEvent.change(descBox(), { target: { value: "干这个" } });
		fireEvent.change(bodyBox(), { target: { value: "步骤一二三" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(M.create).toHaveBeenCalled());
		expect(M.create.mock.calls[0]?.[0]).toMatchObject({
			name: "my-new-one",
			description: "干这个",
			body: "步骤一二三",
		});
		expect(M.update).not.toHaveBeenCalled();
	});

	it("名字不合法 → 本地就拦下,一趟服务端都不跑", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick(/新建/);
		await waitFor(() => expect(nameBox().value).toBe(""));

		fireEvent.change(nameBox(), { target: { value: "我的技能" } });
		fireEvent.change(descBox(), { target: { value: "干这个" } });
		fireEvent.change(bodyBox(), { target: { value: "步骤" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		expect(await screen.findByText(/只收小写字母/)).toBeTruthy();
		expect(M.create).not.toHaveBeenCalled();
	});

	it("正文空着 → 也拦下", async () => {
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick(/新建/);
		await waitFor(() => expect(nameBox().value).toBe(""));
		fireEvent.change(nameBox(), { target: { value: "ok-name" } });
		fireEvent.change(descBox(), { target: { value: "干这个" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		expect(await screen.findByText(/正文是空的/)).toBeTruthy();
		expect(M.create).not.toHaveBeenCalled();
	});
});

describe("盘上读不进来的", () => {
	it("显眼地报出来,带目录名与理由", async () => {
		// 静默不显示的话,主人手放的文件写错了,在界面上跟「我大概没放对地方」
		// 长得一模一样,他无从查起。
		H.problems = [{ dir: "broken", reason: "缺少 frontmatter" }];
		mount();
		expect(await screen.findByText(/broken/)).toBeTruthy();
		expect(screen.getByText(/缺少 frontmatter/)).toBeTruthy();
	});
});

describe("技能Tab与内置只读", () => {
	it("内置来源由Tab标明，默认选中的内容保持只读", async () => {
		H.list = [skill(), skill({ name: "live-copy", description: "转播直播间" })];
		mount();
		const tab = await screen.findByRole("tab", { name: /weekly-report.*内置/ });
		await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
		expect(bodyBox().disabled).toBe(true);
		expect(screen.getByRole("tab", { name: /live-copy.*内置/ }).getAttribute("aria-selected")).toBe(
			"false",
		);
	});
	it("切换Tab同步选中标记和编辑内容", async () => {
		H.list = [skill(), skill({ name: "live-copy", description: "转播直播间" })];
		mount();
		await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
		pick(/live-copy/);
		expect(nameBox().value).toBe("live-copy");
		expect(bodyBox().disabled).toBe(true);
		expect(screen.getByRole("tab", { name: /live-copy.*内置/ }).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(
			screen.getByRole("tab", { name: /weekly-report.*内置/ }).getAttribute("aria-selected"),
		).toBe("false");
	});
});

it("没有标签的工具回退原名，标签不会替换保存的工具 ID", async () => {
	H.tools = ["acme__echo"];
	mount();
	await waitFor(() => expect(nameBox().value).toBe("weekly-report"));
	pick("my-skill");
	fireEvent.click(screen.getByRole("checkbox", { name: "acme__echo" }));
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await waitFor(() => expect(M.update).toHaveBeenCalled());
	expect(M.update.mock.calls[0]?.[1]).toMatchObject({ allowedTools: ["acme__echo"] });
});
