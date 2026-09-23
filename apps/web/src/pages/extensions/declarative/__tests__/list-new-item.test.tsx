// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://192.168.1.20:8787/extensions/bridge"}

/**
 * 声明式列表的新建弹窗(ADR-0019 决策 21 / 29 / 30):照项里的格画,停用那一格不画(新建的一律
 * 按清单默认值)。
 *
 * 值得钉的:
 * - 🔴 **屏幕上生成的那一把就是存下去的那一把**(ADR-0009 决策 21)。显示一把、存下另一把是这类
 *   界面的经典错法,症状是主人照着屏幕填进对面,对面收到 401,而面板上一切正常。
 * - 🔴 **要填到对面去的几样成对摆着、都能复制**(`newItemCopy`):分开摆的话,主人填完一样就走了。
 * - 项的 `id` 由服务端生成(决策 29):发出去的 `add` 不带 id,回来的那一个就是这一条的身份。
 * - 没成时弹窗不关、草稿留着:版本号对不上(409)重读一遍再按;校验不过(400)那句话落在那一格底下。
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
	HOME,
	LINKS_FIELD,
	renderList,
	sentOps,
	sentWrite,
	servedSettings,
	settingsReads,
} from "./list-harness";

const ADDRESS = "ws://192.168.1.20:8787/ext/bridge";
const HEX32 = /^[0-9a-f]{32}$/;

/** 带一格数字的列表 —— 夹具里的桥没有数字格。 */
const WITH_RETRY: ExtensionListField = {
	...LINKS_FIELD,
	newItemCopy: undefined,
	fields: [
		...LINKS_FIELD.fields,
		{ key: "retry", type: "number", label: "重试", unit: "次", min: 0, max: 10 },
	],
};

/** 开弹窗:有卡时按标题行那颗,没卡时按空态那颗。 */
async function openDialog(opts: { field?: ExtensionListField; items?: unknown[] } = {}) {
	const items = opts.items ?? [HOME];
	renderList({
		ext: opts.field ? { ...BRIDGE, settings: { fields: [opts.field] } } : BRIDGE,
		items,
	});
	await userEvent.click(
		await screen.findByRole("button", { name: items.length > 0 ? "新建接入" : "新建第一条接入" }),
	);
	return screen.findByRole("dialog");
}

/** 弹窗里那格生成值的明文(只读的等宽框)。 */
function shownToken(dialog: HTMLElement): string {
	const box = dialog.querySelector('[data-generated="token"]');
	if (!box?.textContent) throw new Error("弹窗里没有生成的那一格");
	return box.textContent;
}

/**
 * 新建那一发里的那一项 —— 一步 `add`,只此一步。
 *
 * 🔴 **不带 `id`**:项的 id 由服务端生成(决策 29),面板生成的会被拒。
 */
function created(call = 0): Record<string, unknown> {
	const ops = sentOps(call);
	if (ops.length !== 1 || ops[0]?.op !== "add" || ops[0].list !== "links") {
		throw new Error(`不是一步 add:${JSON.stringify(ops)}`);
	}
	return ops[0].item;
}

async function typeName(dialog: HTMLElement, name: string) {
	await userEvent.type(within(dialog).getByRole("textbox", { name: "名字" }), name);
}

async function create(dialog: HTMLElement) {
	await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
	await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.patch).mockImplementation(answerPatch);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, "execCommand");
});

describe("照清单画", () => {
	it("标题是「新建{整格的名字}」,说明是清单那句,停用那一格不画", async () => {
		const dialog = await openDialog();
		expect(within(dialog).getByText("新建桥接入")).toBeTruthy();
		expect(within(dialog).getByText(LINKS_FIELD.description as string)).toBeTruthy();
		expect(within(dialog).getByText("哪一种桥")).toBeTruthy();
		expect(within(dialog).getByText("名字")).toBeTruthy();
		// 每格的说明挂在它底下
		expect(within(dialog).getByText(/只影响面板怎么称呼它/)).toBeTruthy();
		expect(within(dialog).getByText(/只在这一刻看得到全文/)).toBeTruthy();
		expect(within(dialog).queryByText("启用")).toBeNull();
		expect(within(dialog).queryByRole("switch")).toBeNull();
		expect(
			(within(dialog).getByRole("textbox", { name: "名字" }) as HTMLInputElement).placeholder,
		).toBe("比如「家里那台 koishi」");
	});

	/** 格标题与设置表单同一副样子:必填的后面一颗星(读屏器不念它,必填由「创建」按不动来说)。 */
	it("必填的格标题带星,可选的不带", async () => {
		const dialog = await openDialog();
		const stars = within(dialog).getAllByText("*");
		expect(stars).toHaveLength(1);
		expect(stars[0]?.previousElementSibling?.textContent).toBe("名字");
		expect(stars[0]?.getAttribute("aria-hidden")).toBe("true");
	});

	/** 带图标的枚举是两张一排的可选卡(决策 30);默认选中清单的默认值。 */
	it("带图标的枚举:可选的卡,默认选中清单默认值,点别的换过去", async () => {
		const dialog = await openDialog();
		const kinds = within(within(dialog).getByRole("group", { name: "哪一种桥" }));
		const pressed = () => kinds.getAllByRole("button", { pressed: true });
		expect(pressed().map((b) => b.textContent)).toEqual(["koishi"]);
		expect(kinds.getByRole("button", { name: /koishi/ }).querySelector("img")).toBeTruthy();
		await userEvent.click(kinds.getByRole("button", { name: /AstrBot/ }));
		expect(pressed().map((b) => b.textContent)).toEqual(["AstrBot"]);
		await typeName(dialog, "家里那台");
		await create(dialog);
		expect(created().bridgeKind).toBe("astrbot");
	});

	it("清单没给默认值就选第一个", async () => {
		const field: ExtensionListField = {
			...LINKS_FIELD,
			fields: LINKS_FIELD.fields.map((sub) =>
				sub.type === "enum"
					? { ...sub, default: undefined, options: [...sub.options].reverse() }
					: sub,
			),
		};
		const dialog = await openDialog({ field });
		const kinds = within(within(dialog).getByRole("group", { name: "哪一种桥" }));
		expect(kinds.getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual([
			"AstrBot",
		]);
	});

	it("没图标的枚举、数字、开关、别的字也照清单画、照填的存", async () => {
		const field: ExtensionListField = {
			...LINKS_FIELD,
			newItemCopy: undefined,
			fields: [
				...LINKS_FIELD.fields,
				{
					key: "mode",
					type: "enum",
					label: "模式",
					options: [
						{ value: "fast", label: "快" },
						{ value: "safe", label: "稳" },
					],
					default: "safe",
				},
				{ key: "retry", type: "number", label: "重试", unit: "次", default: 3 },
				{ key: "loud", type: "boolean", label: "大声" },
				{ key: "memo", type: "string", label: "备注", default: "默认备注" },
				{ key: "remark", type: "string", label: "附言" },
			],
		};
		const dialog = await openDialog({ field });
		const mode = within(within(dialog).getByRole("group", { name: "模式" }));
		expect(mode.getByRole("button", { name: "稳" }).getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(mode.getByRole("button", { name: "快" }));
		const retry = within(dialog).getByLabelText("重试") as HTMLInputElement;
		expect(retry.value).toBe("3");
		await userEvent.clear(retry);
		await userEvent.type(retry, "5");
		expect(within(dialog).getByText("次")).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "大声" }));
		expect((within(dialog).getByRole("textbox", { name: "备注" }) as HTMLInputElement).value).toBe(
			"默认备注",
		);
		await typeName(dialog, "家里那台");
		await create(dialog);
		const item = created();
		expect(item).toMatchObject({ mode: "fast", retry: 5, loud: true, memo: "默认备注" });
		// 没填的可选格不写 —— 拓展那份 zod 按「没设过」补
		expect("remark" in item).toBe(false);
	});

	/** 🔴 密钥格(不是生成的那种)按密码框画,全文不上屏;多行的是等宽的文本框。 */
	it("密钥格:单行是密码框,多行是等宽的文本框;monospace 的字等宽", async () => {
		const field: ExtensionListField = {
			...LINKS_FIELD,
			newItemCopy: undefined,
			fields: [
				...LINKS_FIELD.fields,
				{ key: "secretKey", type: "string", label: "密", secret: true },
				{ key: "secretBlock", type: "string", label: "密块", secret: true, multiline: true },
				{ key: "memo", type: "string", label: "备注", monospace: true },
			],
		};
		const dialog = await openDialog({ field });
		const key = within(dialog).getByLabelText("密") as HTMLInputElement;
		expect(key.type).toBe("password");
		expect(key.className).toContain("font-mono");
		const block = within(dialog).getByRole("textbox", { name: "密块" });
		expect(block.tagName).toBe("TEXTAREA");
		expect(block.className).toContain("font-mono");
		expect(within(dialog).getByRole("textbox", { name: "备注" }).className).toContain("font-mono");
		expect(within(dialog).getByRole("textbox", { name: "名字" }).className).not.toContain(
			"font-mono",
		);
		await userEvent.type(key, "k1");
		await userEvent.type(block, "b1");
		await typeName(dialog, "家里那台");
		await create(dialog);
		expect(created()).toMatchObject({ secretKey: "k1", secretBlock: "b1" });
	});
});

describe("生成的那一格", () => {
	/** 🔴 存下去的就是屏幕上那一把,不是另生成的。 */
	it("明文 32 位,存下去的就是这一把", async () => {
		const dialog = await openDialog();
		const shown = shownToken(dialog);
		expect(shown).toMatch(HEX32);
		await typeName(dialog, "家里那台");
		await create(dialog);
		expect(created().token).toBe(shown);
	});

	it("在弹窗里换一把,存下去的跟着换", async () => {
		const dialog = await openDialog();
		const first = shownToken(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "重新生成 token" }));
		const second = shownToken(dialog);
		expect(second).toMatch(HEX32);
		expect(second).not.toBe(first);
		await typeName(dialog, "家里那台");
		await create(dialog);
		expect(created().token).toBe(second);
	});

	it("每次打开都是新的一把", async () => {
		const first = shownToken(await openDialog());
		await userEvent.click(screen.getByRole("button", { name: "取消" }));
		await userEvent.click(screen.getByRole("button", { name: "新建接入" }));
		expect(shownToken(await screen.findByRole("dialog"))).not.toBe(first);
	});
});

describe("要填到对面去的那几样", () => {
	/** 🔴 成对摆着、都能复制 —— 地址在浏览器里现算(决策 28),token 是屏幕上这一把。 */
	it("BN 地址与 token 成对,两样都能复制", async () => {
		const dialog = await openDialog();
		const box = dialog.querySelector("[data-new-item-copy]") as HTMLElement;
		expect(box).toBeTruthy();
		const token = shownToken(dialog);
		// 一个字都不多:标题 + 两行,没有别的注脚
		expect(box.textContent).toBe(`把这两样填到对面去BN 地址${ADDRESS}token${token}`);
		const inBox = within(box);
		expect(inBox.getByRole("button", { name: "复制 BN 地址" })).toBeTruthy();
		expect(inBox.getByRole("button", { name: "复制 token" })).toBeTruthy();
	});

	it("换了一把,这里跟着换", async () => {
		const dialog = await openDialog();
		await userEvent.click(within(dialog).getByRole("button", { name: "重新生成 token" }));
		const box = dialog.querySelector("[data-new-item-copy]") as HTMLElement;
		expect(box.textContent).toContain(shownToken(dialog));
	});

	it("复制的是全文;非安全上下文也复制到", async () => {
		const execCommand = vi.fn().mockReturnValue(true);
		vi.stubGlobal("navigator", {
			...navigator,
			clipboard: undefined,
			userAgent: navigator.userAgent,
		});
		Object.defineProperty(document, "execCommand", {
			value: execCommand,
			configurable: true,
			writable: true,
		});
		const dialog = await openDialog();
		await userEvent.click(within(dialog).getByRole("button", { name: "复制 BN 地址" }));
		await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(1));
		await userEvent.click(within(dialog).getByRole("button", { name: "复制 token" }));
		await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(2));
	});

	it("几样就说几样;没声明就没有这一块", async () => {
		const three: ExtensionListField = {
			...LINKS_FIELD,
			newItemCopy: [...(LINKS_FIELD.newItemCopy ?? []), { field: "name" }],
		};
		const dialog = await openDialog({ field: three });
		expect(within(dialog).getByText("把这三样填到对面去")).toBeTruthy();
		cleanup();
		const none = await openDialog({ field: { ...LINKS_FIELD, newItemCopy: undefined } });
		expect(none.querySelector("[data-new-item-copy]")).toBeNull();
	});
});

describe("创建", () => {
	/** 没名字的项在卡上什么都认不出 —— 「创建」要等必填的那一格填了才亮。 */
	it("必填的空着(只有空格也算空)按不动;存下去的去掉首尾空格", async () => {
		const dialog = await openDialog();
		const button = within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		await typeName(dialog, "   ");
		expect(button.disabled).toBe(true);
		await typeName(dialog, " 公司那台 ");
		expect(button.disabled).toBe(false);
		await create(dialog);
		expect(created().name).toBe("公司那台");
	});

	/**
	 * 一步 `add`:填的那几格 + 停用那一格的默认值(弹窗里没有它),**不带 id** —— id 归服务端生成
	 * (决策 29)。原来那几条碰都不碰。
	 */
	it("发一步 add:填的那几格 + 停用那一格的默认值,不带 id", async () => {
		const dialog = await openDialog();
		const token = shownToken(dialog);
		await typeName(dialog, "公司那台");
		await create(dialog);
		expect(created()).toEqual({ bridgeKind: "koishi", name: "公司那台", token, enabled: true });
		expect(servedSettings().links).toHaveLength(2);
		expect((servedSettings().links as unknown[])[0]).toEqual(HOME);
	});

	/** 回来的 id 就是新卡的身份:接着对它做什么(这里是停用),按的是服务端给的那一个。 */
	it("回来的 id 用得上:新卡按它挂、接着停用它发的就是它", async () => {
		const dialog = await openDialog();
		await typeName(dialog, "公司那台");
		await create(dialog);
		const answered = vi.mocked(api.patch).mock.results[0];
		if (!answered) throw new Error("没有那一发写");
		const { added } = (await answered.value) as { added: string[] };
		const id = added[0] as string;
		expect(id).toMatch(/^srv-/);
		await waitFor(() => expect(document.querySelector(`[data-list-card="${id}"]`)).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: "停用 公司那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		expect(sentOps(1)).toEqual([{ op: "update", list: "links", id, values: { enabled: false } }]);
	});

	it("停用那一格清单默认关着,新建的就是关着的", async () => {
		const field: ExtensionListField = {
			...LINKS_FIELD,
			fields: LINKS_FIELD.fields.map((sub) =>
				sub.key === "enabled"
					? { key: "enabled", type: "boolean", label: "启用", default: false }
					: sub,
			),
		};
		const dialog = await openDialog({ field });
		await typeName(dialog, "公司那台");
		await create(dialog);
		expect(created().enabled).toBe(false);
	});

	it("成了就关", async () => {
		const dialog = await openDialog();
		await typeName(dialog, "公司那台");
		await create(dialog);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	/**
	 * 🔴 数字格里填了不是数的东西:与设置表单同一把尺子(`clientErrorOf`),当场说,「创建」按不动。
	 * 否则那一格被悄悄丢掉,建出来的项里根本没有它,而弹窗上看着是填了的。
	 */
	it.each(["abc", "0x10"])("数字格填了「%s」:说「要填一个数字」,创建按不动", async (text) => {
		const dialog = await openDialog({ field: WITH_RETRY });
		await typeName(dialog, "公司那台");
		await userEvent.type(within(dialog).getByLabelText("重试"), text);
		expect(within(dialog).getByRole("alert").textContent).toBe("要填一个数字");
		const button = within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		await userEvent.click(button);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("数字格超出 min / max:当场说,创建按不动", async () => {
		const dialog = await openDialog({ field: WITH_RETRY });
		await typeName(dialog, "公司那台");
		await userEvent.type(within(dialog).getByLabelText("重试"), "11");
		expect(within(dialog).getByRole("alert").textContent).toBe("要在 0 到 10 之间");
		expect(
			(within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	/** 必填的空着由「创建」按不动来说 —— 一打开就满屏「这一格必填」只是吓人。 */
	it("一打开不说「这一格必填」", async () => {
		const dialog = await openDialog({ field: WITH_RETRY });
		expect(within(dialog).queryByRole("alert")).toBeNull();
	});

	it("取消什么都不发", async () => {
		const dialog = await openDialog();
		await typeName(dialog, "公司那台");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(api.patch).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	/** 🔴 存不下去时弹窗不关,「创建」按下去毫无反应 —— 原因得摆在按得到它的那一屏上。 */
	it("没成:弹窗不关,说「建不了这条接入」与原因", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		const dialog = await openDialog();
		await typeName(dialog, "公司那台");
		await create(dialog);
		expect(await within(dialog).findByText("建不了这条接入:配置文件是只读的")).toBeTruthy();
		expect(screen.getByText("这次没写进去:配置文件是只读的")).toBeTruthy();
	});

	it("写回途中「创建中…」,按不动第二下", async () => {
		vi.mocked(api.patch).mockReturnValue(new Promise(() => {}));
		const dialog = await openDialog();
		await typeName(dialog, "公司那台");
		await create(dialog);
		const busy = within(dialog).getByRole("button", { name: "创建中…" }) as HTMLButtonElement;
		expect(busy.disabled).toBe(true);
	});

	it("从空态那颗钮也开得出来", async () => {
		const dialog = await openDialog({ items: [] });
		await typeName(dialog, "第一台");
		await create(dialog);
		expect(created().name).toBe("第一台");
		expect(await screen.findByText("第一台")).toBeTruthy();
	});

	/**
	 * 校验不过(400):那句话落在**那一格**底下。新建那一项的 id 是服务端现生成的、面板不认识,
	 * 按格认 —— 弹窗那一发只有这一步。落不到某一格的整条说在弹窗里。
	 */
	it("400:那句话落在那一格底下,落不到的整条说在弹窗里;弹窗不关", async () => {
		vi.mocked(api.patch).mockRejectedValueOnce(
			new ApiError(
				400,
				{
					error: "validation_failed",
					message: "不合规矩",
					issues: [
						{ op: 0, path: ["links", "4f1c-新的", "name"], message: "名字里不许有空格" },
						{ path: ["links"], message: "最多十条" },
					],
				},
				"PATCH /api/ext/bridge/settings → 400",
			),
		);
		const dialog = await openDialog();
		await typeName(dialog, "公司 那台");
		await create(dialog);
		const name = dialog.querySelector('[data-dialog-field="name"]') as HTMLElement;
		expect((await within(name).findByRole("alert")).textContent).toBe("名字里不许有空格");
		const kind = dialog.querySelector('[data-dialog-field="bridgeKind"]') as HTMLElement;
		expect(within(kind).queryByRole("alert")).toBeNull();
		expect(within(dialog).getByText("建不了这条接入:桥接入:最多十条")).toBeTruthy();
		expect(screen.getByRole("dialog")).toBe(dialog);
	});

	/**
	 * 🔴 版本号对不上(别的标签页刚写过一笔):弹窗不关、**草稿还在**(填的名字、屏幕上那一把
	 * token),说清为什么,设置重读一遍;再按「创建」带的是新的版本号,存下去的还是这一把。
	 */
	it("409:弹窗不关、草稿还在,重读一遍;再按一次就建上了", async () => {
		const dialog = await openDialog();
		const token = shownToken(dialog);
		await typeName(dialog, "公司那台");
		changeBehindTheBack((settings) => {
			(settings.links as { name: string }[])[0].name = "家里那台(改过)";
		});
		const reads = settingsReads();
		await create(dialog);
		expect(
			await within(dialog).findByText(
				"建不了这条接入:设置在你打开之后被改过了 —— 已经重新读了一遍,看一眼现在的样子再改",
			),
		).toBeTruthy();
		await waitFor(() => expect(settingsReads()).toBe(reads + 1));
		expect((within(dialog).getByRole("textbox", { name: "名字" }) as HTMLInputElement).value).toBe(
			"公司那台",
		);
		expect(shownToken(dialog)).toBe(token);

		await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		expect(sentWrite(1).revision).not.toBe(sentWrite(0).revision);
		expect(created(1)).toMatchObject({ name: "公司那台", token });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText("家里那台(改过)")).toBeTruthy();
	});

	/** 🔴 拓展关着也能建(决策 32)。 */
	it("拓展关着也建得了", async () => {
		renderList({ ext: { ...BRIDGE, enabled: false, state: "disabled" }, items: [] });
		await userEvent.click(await screen.findByRole("button", { name: "新建第一条接入" }));
		const dialog = await screen.findByRole("dialog");
		await typeName(dialog, "第一台");
		await create(dialog);
		expect(created().name).toBe("第一台");
	});
});
