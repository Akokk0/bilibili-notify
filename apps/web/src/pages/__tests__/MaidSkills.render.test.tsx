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
import { i18n } from "../../i18n";
import { MaidSkills } from "../ai/MaidSkills";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

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
	H.toolLabels = {
		list_subscriptions: "列出订阅",
		get_creator_profile: "查看创作者资料",
		web_search: "联网搜索",
	};
	M.create.mockClear();
	M.update.mockClear();
	M.remove.mockClear();
	M.preview.mockReset();
	M.export.mockReset();
});

afterEach(cleanup);

it.each([
	[
		"ja",
		"ご主人様、何も選ばなければ制限しません。選んだ場合、このスキルはそのツールだけを使いますよ。",
		"未選択なら制限しません。選択すると、このスキルが使えるのは指定したツールだけになります。",
		"ご主人様、1件のスキルを読み取れません：",
	],
	[
		"zh-TW",
		"主人，全部不勾選就不限制；勾選後，這項技能只會使用選取的工具喔。",
		"全部不勾選表示不限制；勾選後，此技能僅可使用所選工具。",
		"主人，有 1 份技能無法讀取：",
	],
] as const)(
	"%s maid skill hints preserve edited Markdown, selected tools and original diagnostics",
	async (locale, maid, plain, problems) => {
		H.problems = [{ dir: "broken-skill", reason: "Original error 原文 {name}" }];
		mount();
		fireEvent.click(await screen.findByRole("tab", { name: "my-skill" }));
		const body = bodyBox();
		fireEvent.change(body, { target: { value: "Original steps 原文 {name}" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "联网搜索" }));
		for (const [voice, expected] of [
			["maid", maid],
			["plain", plain],
		] as const) {
			act(() => i18n.set({ locale, voice }));
			expect(screen.getByText(expected)).toBeTruthy();
			expect(screen.getByDisplayValue("Original steps 原文 {name}")).toBe(body);
			expect(screen.getByRole("checkbox", { name: "联网搜索" })).toHaveProperty("checked", true);
			expect(screen.getByText(/broken-skill\(Original error 原文 \{name\}\)/)).toBeTruthy();
			if (voice === "maid") expect(screen.getByText(problems, { exact: false })).toBeTruthy();
			expect(M.create).not.toHaveBeenCalled();
			expect(M.update).not.toHaveBeenCalled();
			expect(M.remove).not.toHaveBeenCalled();
		}
	},
);

it("skill editor translations retain the draft, command and selected tools until explicit save", async () => {
	H.problems = [{ dir: "broken-skill", reason: "原始诊断" }];
	mount();
	fireEvent.click(await screen.findByRole("tab", { name: "my-skill" }));
	const name = nameBox(),
		body = bodyBox();
	fireEvent.change(name, { target: { value: "my-renamed-skill" } });
	fireEvent.change(descBox(), { target: { value: "自写用途原文" } });
	fireEvent.change(body, { target: { value: "自写步骤原文" } });
	fireEvent.click(screen.getByRole("checkbox", { name: "联网搜索" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "仅通过斜杠命令使用" }));
	for (const [locale, nameLabel, bodyLabel, manual] of [
		["en", "Name · Slash command", "Body · Steps", "Only invoke with a slash command"],
		["ja", "名前 · スラッシュコマンド", "本文 · 作業手順", "スラッシュコマンドからのみ実行"],
		["zh-TW", "名稱 · 斜線指令", "內容 · 工作步驟", "僅透過斜線指令使用"],
		["en", "Name · Slash command", "Body · Steps", "Only invoke with a slash command"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByRole("textbox", { name: nameLabel })).toBe(name);
		expect(screen.getByRole("textbox", { name: bodyLabel })).toBe(body);
		expect(name.value).toBe("my-renamed-skill");
		expect(body.value).toBe("自写步骤原文");
		expect(screen.getByDisplayValue("自写用途原文")).toBeTruthy();
		expect(screen.getByRole("checkbox", { name: manual })).toHaveProperty("checked", true);
		expect(screen.getByRole("checkbox", { name: "联网搜索" })).toHaveProperty("checked", true);
		expect(M.create).not.toHaveBeenCalled();
		expect(M.update).not.toHaveBeenCalled();
		expect(M.remove).not.toHaveBeenCalled();
	}
	expect(screen.getByText(/1 skill could not be read:/)).toBeTruthy();
	expect(screen.getByText(/broken-skill\(原始诊断\)/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(M.update).toHaveBeenCalledExactlyOnceWith("my-skill", {
			name: "my-renamed-skill",
			description: "自写用途原文",
			body: "自写步骤原文",
			allowedTools: ["web_search"],
			disableModelInvocation: true,
		}),
	);
});

it("skill tool names reload in the current language without replacing the edited body or tool choice", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	H.toolLabels = { ...H.toolLabels, web_search: "Web search" };
	mount();
	fireEvent.click(await screen.findByRole("tab", { name: "my-skill" }));
	const body = screen.getByRole("textbox", { name: "Body · Steps" });
	fireEvent.change(body, { target: { value: "尚未保存的步骤" } });
	const search = screen.getByRole("checkbox", { name: "Web search" });
	fireEvent.click(search);
	act(() => {
		H.toolLabels = { ...H.toolLabels, web_search: "ウェブ検索" };
		i18n.set({ locale: "ja" });
	});
	expect(await screen.findByRole("checkbox", { name: "ウェブ検索" })).toBe(search);
	expect(search).toHaveProperty("checked", true);
	expect(screen.getByDisplayValue("尚未保存的步骤")).toBe(body);
	expect(M.create).not.toHaveBeenCalled();
	expect(M.update).not.toHaveBeenCalled();
	expect(M.remove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await waitFor(() =>
		expect(M.update).toHaveBeenCalledExactlyOnceWith("my-skill", {
			name: "my-skill",
			description: "我写的",
			body: "尚未保存的步骤",
			allowedTools: ["web_search"],
			disableModelInvocation: false,
		}),
	);
});

it("skill import preview translates while preserving its raw content and the current editor draft", async () => {
	M.preview.mockResolvedValue({
		ok: true,
		skill: {
			name: "my-skill",
			description: "导入用途原文",
			body: "导入步骤原文",
			allowedTools: ["web_search"],
			disableModelInvocation: true,
		},
	});
	mount();
	fireEvent.click(await screen.findByRole("tab", { name: "my-skill" }));
	fireEvent.change(bodyBox(), { target: { value: "未保存的本地步骤" } });
	const file = new File(["skill"], "SKILL.md", { type: "text/markdown" });
	fireEvent.change(screen.getByLabelText("导入 SKILL.md"), { target: { files: [file] } });
	const dialog = await screen.findByRole("dialog");
	const name = within(dialog).getByRole("textbox", { name: "导入后名称" });
	fireEvent.change(name, { target: { value: "incoming-copy" } });
	for (const [locale, title, label, tools] of [
		["en", "Preview skill import", "Imported name", "Allowed tools: web_search"],
		["ja", "スキルのインポートをプレビュー", "インポート後の名前", "許可するツール: web_search"],
		["zh-TW", "技能匯入預覽", "匯入後名稱", "允許工具：web_search"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(within(dialog).getByText(title)).toBeTruthy();
		expect(within(dialog).getByRole("textbox", { name: label })).toBe(name);
		expect(name).toHaveProperty("value", "incoming-copy");
		expect(within(dialog).getByText(tools)).toBeTruthy();
		expect(within(dialog).getByText("导入用途原文")).toBeTruthy();
		expect(within(dialog).getByText("导入步骤原文")).toBeTruthy();
		expect(M.create).not.toHaveBeenCalled();
		expect(M.update).not.toHaveBeenCalled();
		expect(M.remove).not.toHaveBeenCalled();
	}
	fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.getByDisplayValue("未保存的本地步骤")).toBeTruthy();
	expect(M.preview).toHaveBeenCalledExactlyOnceWith(file);
});

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
