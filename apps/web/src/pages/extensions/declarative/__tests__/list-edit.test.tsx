// @vitest-environment jsdom

/**
 * 列表项的编辑(ADR-0019 决策 37):卡头一颗「编辑」,复用新建弹窗、预填这一项现在的值。
 *
 * 为什么要有它:清单一收紧(决策 36),存着的某一项就可能不合规矩 —— 得有路把它改对,不能只剩
 * 「删了重建、重新配对」。
 *
 * 值得钉的:
 * - 🔴 **密钥 / 生成的那一格不在这里**:存下之后浏览器只有头尾(决策 38),要换走「重新生成」;
 *   `id` 不动。发出去的只有改了的那几格(`update` 是部分合并)。
 * - 没成时弹窗不关、草稿还在;校验不过的那句落在那一格底下。
 */

import type { ExtensionListField } from "@bilibili-notify/contract";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../../services/api", async (importOriginal) => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: (await importOriginal<typeof import("../../../../services/api")>()).ApiError,
}));

import { ApiError, api } from "../../../../services/api";
import {
	answerPatch,
	BRIDGE,
	changeBehindTheBack,
	findCard,
	HOME,
	LINKS_FIELD,
	OFFICE,
	renderList,
	sentOps,
	sentWrite,
	servedSettings,
	settingsReads,
	TOKEN,
} from "./list-harness";

/** 多一格可选的备注 —— 清空它要发 `null`。 */
const WITH_MEMO: ExtensionListField = {
	...LINKS_FIELD,
	fields: [...LINKS_FIELD.fields, { key: "memo", type: "string", label: "备注" }],
};

async function openEdit(opts: { field?: ExtensionListField; items?: unknown[] } = {}) {
	renderList({
		ext: opts.field ? { ...BRIDGE, settings: { fields: [opts.field] } } : BRIDGE,
		items: opts.items ?? [HOME, OFFICE],
	});
	await findCard("c1");
	await userEvent.click(screen.getByRole("button", { name: "编辑 家里那台" }));
	return screen.findByRole("dialog");
}

function nameBox(dialog: HTMLElement): HTMLInputElement {
	return within(dialog).getByRole("textbox", { name: "名字" }) as HTMLInputElement;
}

function saveButton(dialog: HTMLElement): HTMLButtonElement {
	return within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement;
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.patch).mockImplementation(answerPatch);
});
afterEach(() => {
	cleanup();
});

describe("编辑弹窗", () => {
	it("卡头一颗「编辑」,字是中性的", async () => {
		renderList({ items: [HOME] });
		const edit = within(await findCard("c1")).getByRole("button", { name: "编辑 家里那台" });
		expect(edit.textContent).toBe("编辑");
	});

	/**
	 * 预填这一项现在的值;🔴 密钥 / 生成的那一格**不在这里**(浏览器只有头尾,决策 38),停用那一格
	 * 与「成对复制」也不在(那两样是新建才有的)。
	 */
	it("预填现在的值;没有 token 那一格、没有停用、没有成对复制", async () => {
		const dialog = await openEdit();
		expect(within(dialog).getByText("编辑「家里那台」")).toBeTruthy();
		expect(nameBox(dialog).value).toBe("家里那台");
		const kinds = within(within(dialog).getByRole("group", { name: "哪一种桥" }));
		expect(kinds.getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual([
			"koishi",
		]);
		expect(dialog.querySelector('[data-dialog-field="token"]')).toBeNull();
		expect(dialog.querySelector("[data-generated]")).toBeNull();
		expect(within(dialog).queryByText("token")).toBeNull();
		expect(within(dialog).queryByRole("switch")).toBeNull();
		expect(within(dialog).queryByText("启用")).toBeNull();
		expect(dialog.querySelector("[data-new-item-copy]")).toBeNull();
		expect(dialog.textContent).not.toContain(TOKEN);
	});

	it("什么都没改时「保存」按不动;改回原样也按不动", async () => {
		const dialog = await openEdit();
		expect(saveButton(dialog).disabled).toBe(true);
		await userEvent.type(nameBox(dialog), "2");
		expect(saveButton(dialog).disabled).toBe(false);
		await userEvent.type(nameBox(dialog), "{Backspace}");
		expect(saveButton(dialog).disabled).toBe(true);
	});

	/** 🔴 只发改了的那几格:不带 id、不带 token、不带没动的格 —— `update` 是部分合并。 */
	it("保存:一步 update 这一项,只带改了的那几格", async () => {
		const dialog = await openEdit();
		await userEvent.clear(nameBox(dialog));
		await userEvent.type(nameBox(dialog), "客厅那台");
		await userEvent.click(
			within(within(dialog).getByRole("group", { name: "哪一种桥" })).getByRole("button", {
				name: /AstrBot/,
			}),
		);
		await userEvent.click(saveButton(dialog));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{
				op: "update",
				list: "links",
				id: "c1",
				values: { name: "客厅那台", bridgeKind: "astrbot" },
			},
		]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(await screen.findByText("客厅那台")).toBeTruthy();
		// token 与别的项原样
		expect(servedSettings().links).toEqual([
			{ ...HOME, name: "客厅那台", bridgeKind: "astrbot" },
			OFFICE,
		]);
	});

	it("清空一格可选的:发 null(删掉那一格)", async () => {
		const dialog = await openEdit({ field: WITH_MEMO, items: [{ ...HOME, memo: "旧备注" }] });
		const memo = within(dialog).getByRole("textbox", { name: "备注" }) as HTMLInputElement;
		expect(memo.value).toBe("旧备注");
		await userEvent.clear(memo);
		await userEvent.click(saveButton(dialog));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([{ op: "update", list: "links", id: "c1", values: { memo: null } }]);
	});

	/**
	 * 决策 37 的来由:存着的这一项不合规矩(清单收紧了、手改过文件)—— 必填的那一格空着。弹窗照样
	 * 开得出来,填上才给存,发出去的就是补上的那一格。
	 */
	it("一项坏了(必填的空着):开得出来,填上才能存", async () => {
		const { name: _, ...nameless } = HOME;
		renderList({ items: [nameless] });
		const card = await findCard("c1");
		await userEvent.click(within(card).getByRole("button", { name: /^编辑/ }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("编辑这条接入")).toBeTruthy();
		expect(nameBox(dialog).value).toBe("");
		expect(saveButton(dialog).disabled).toBe(true);
		await userEvent.type(nameBox(dialog), "补上的名字");
		await userEvent.click(saveButton(dialog));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{ op: "update", list: "links", id: "c1", values: { name: "补上的名字" } },
		]);
	});

	/** 弹窗里一格都填不了(只有 token 与停用)的列表没有这颗钮 —— 开出来是个空框。 */
	it("没有能编辑的格:没有这颗钮", async () => {
		const { mark: _, ...unmarked } = LINKS_FIELD;
		const bare: ExtensionListField = {
			...unmarked,
			title: "token",
			fields: LINKS_FIELD.fields.filter((sub) => sub.key === "token" || sub.key === "enabled"),
		};
		renderList({ ext: { ...BRIDGE, settings: { fields: [bare] } }, items: [HOME] });
		const card = await findCard("c1");
		expect(within(card).queryByRole("button", { name: /^编辑/ })).toBeNull();
		expect(within(card).getByRole("button", { name: /^删除/ })).toBeTruthy();
	});

	it("取消什么都不发", async () => {
		const dialog = await openEdit();
		await userEvent.type(nameBox(dialog), "2");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("编辑完这一条再编辑那一条:不带着上一份的字", async () => {
		const dialog = await openEdit();
		await userEvent.type(nameBox(dialog), "2");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await userEvent.click(screen.getByRole("button", { name: "编辑 机房那台" }));
		expect(nameBox(await screen.findByRole("dialog")).value).toBe("机房那台");
	});
});

describe("编辑没成", () => {
	it("400:那句话落在那一格底下,弹窗不关", async () => {
		vi.mocked(api.patch).mockRejectedValueOnce(
			new ApiError(
				400,
				{
					error: "validation_failed",
					message: "不合规矩",
					issues: [{ op: 0, path: ["links", "c1", "name"], message: "名字重了" }],
				},
				"PATCH /api/ext/bridge/settings → 400",
			),
		);
		const dialog = await openEdit();
		await userEvent.clear(nameBox(dialog));
		await userEvent.type(nameBox(dialog), "机房那台");
		await userEvent.click(saveButton(dialog));
		const name = dialog.querySelector('[data-dialog-field="name"]') as HTMLElement;
		expect((await within(name).findByRole("alert")).textContent).toBe("名字重了");
		expect(screen.getByRole("dialog")).toBe(dialog);
		// 页面上那句照样点名是哪一条的哪一格
		expect(screen.getByText("这次没写进去:「家里那台」的 名字:名字重了")).toBeTruthy();
		// 一动手,上一发的那句就过时了
		await userEvent.type(nameBox(dialog), "2");
		expect(within(name).queryByRole("alert")).toBeNull();
	});

	/** 🔴 别处刚写过一笔:弹窗不关、草稿还在,重读一遍;再按一次带新的版本号。 */
	it("409:草稿还在,重读一遍,再按一次就存上了", async () => {
		const dialog = await openEdit();
		await userEvent.clear(nameBox(dialog));
		await userEvent.type(nameBox(dialog), "客厅那台");
		changeBehindTheBack((settings) => {
			(settings.links as { enabled: boolean }[])[0].enabled = false;
		});
		const reads = settingsReads();
		await userEvent.click(saveButton(dialog));
		expect(
			await within(dialog).findByText(
				"改不了这条接入:设置在你打开之后被改过了 —— 已经重新读了一遍,看一眼现在的样子再改",
			),
		).toBeTruthy();
		await waitFor(() => expect(settingsReads()).toBe(reads + 1));
		expect(nameBox(dialog).value).toBe("客厅那台");

		await userEvent.click(saveButton(dialog));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		expect(sentWrite(1).revision).not.toBe(sentWrite(0).revision);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// 别人拨的那一下还在:这一发只改了名字
		expect(servedSettings().links).toEqual([{ ...HOME, name: "客厅那台", enabled: false }, OFFICE]);
	});
});
