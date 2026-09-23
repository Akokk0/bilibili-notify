// @vitest-environment jsdom

/**
 * 声明式设置表单(ADR-0019 决策 17 / 30):照清单里的设置项画,改完按「保存」才写。
 *
 * 值得钉的:
 * - **只发改了的那几格**。设置是 JSON Merge Patch,整份发出去的话,别处刚改的会被这一发按回旧值;
 *   清掉一格可选的要发 `null`(`undefined` 在 JSON 里表达不出来)。
 * - 🔴 **密钥不回传**:遮住的那一格从来没进过输入框,没按「换一份」重填就一个字都不发 —— 发回去
 *   的只可能是屏幕上那串点。
 * - 🔴 **屏幕上生成的那一把就是存下去的那一把**(ADR-0009 决策 21 的同一条)。
 * - 服务端照清单校验不过(400)时,那句话落在**那一格**底下,不是页顶一句笼统的「保存失败」。
 */

import type { ExtensionScalarField } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, api } from "../../../../services/api";
import { SettingsForm } from "../settings-form";

vi.mock("../../../../services/api", async (importOriginal) => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	// 面板按 `instanceof ApiError` 认服务端的错 —— 用真的那个类,替身比它宽松的话测的就不是那条路。
	ApiError: (await importOriginal<typeof import("../../../../services/api")>()).ApiError,
}));

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const COOKIE = "sessionid=0123456789abcdef;uid_tt=d41c";
const TOKEN = "0123456789abcdef0123456789abcdef";

const FIELDS: ExtensionScalarField[] = [
	{
		key: "cookie",
		type: "string",
		label: "Cookie",
		required: true,
		secret: true,
		multiline: true,
		description: "从已登录抖音网页版的浏览器里复制整段 cookie。",
	},
	{
		key: "interval",
		type: "number",
		label: "检查间隔",
		min: 30,
		max: 600,
		unit: "秒",
		default: 60,
	},
	{
		key: "quality",
		type: "enum",
		label: "图片清晰度",
		options: [
			{ value: "origin", label: "原图" },
			{ value: "lite", label: "省流量" },
		],
		default: "origin",
	},
	{ key: "note", type: "string", label: "备注", placeholder: "随便写点" },
	{ key: "userAgent", type: "string", label: "UA", monospace: true },
	{ key: "live", type: "boolean", label: "盯开播", default: true },
	{
		key: "bridgeKind",
		type: "enum",
		label: "哪一种桥",
		options: [
			{ value: "koishi", label: "koishi", icon: PNG },
			{ value: "astrbot", label: "AstrBot" },
		],
		default: "koishi",
	},
	{ key: "token", type: "string", label: "token", secret: true, generate: true },
];

/** 服务端存着的那份设置 —— `api.patch` 照 Merge Patch 改它,`api.get` 读它。 */
let stored: Record<string, unknown>;

/**
 * 服务端眼下的整份 globals。GET 回它;PATCH 回的也是它(合并之后的那份,与 GET 同形 ——
 * `routes/globals.ts` 两边都过 `redactGlobals`)。
 */
function servedGlobals() {
	return { extensions: { douyin: { enabled: false, settings: { ...stored } } } };
}

function mergePatch(body: unknown) {
	const settings = (body as { extensions: { douyin: { settings: Record<string, unknown> } } })
		.extensions.douyin.settings;
	for (const [key, value] of Object.entries(settings)) {
		if (value === null) delete stored[key];
		else stored[key] = value;
	}
}

function renderForm(fields: ExtensionScalarField[] = FIELDS) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<SettingsForm extensionId="douyin" fields={fields} />
		</QueryClientProvider>,
	);
	return Object.assign(view, { qc });
}

/** 那一格(标题 + 控件 + 说明 + 它自己的错)。 */
function field(key: string): HTMLElement {
	const el = document.querySelector(`[data-setting="${key}"]`);
	if (!el) throw new Error(`没有 ${key} 那一格`);
	return el as HTMLElement;
}

/** 第 `call` 发写回里的设置补丁。 */
function sentSettings(call = 0): Record<string, unknown> {
	const args = vi.mocked(api.patch).mock.calls[call];
	if (!args) throw new Error(`没有第 ${call + 1} 发写回`);
	const [url, body] = args as [string, { extensions: Record<string, { settings: unknown }> }];
	expect(url).toBe("/api/globals");
	// 补丁只带自己这一个拓展的一格设置,别的拓展、开关都不碰。
	expect(Object.keys(body)).toEqual(["extensions"]);
	expect(Object.keys(body.extensions)).toEqual(["douyin"]);
	expect(Object.keys(body.extensions.douyin)).toEqual(["settings"]);
	return body.extensions.douyin.settings as Record<string, unknown>;
}

const save = () => screen.getByRole("button", { name: "保存" });
const revert = () => screen.getByRole("button", { name: "还原" });

beforeEach(() => {
	stored = { cookie: COOKIE, interval: 90, note: "旧备注", token: TOKEN };
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/globals") return servedGlobals();
		throw new Error(`没有这个口:${url}`);
	});
	vi.mocked(api.patch).mockImplementation(async (_url: string, body?: unknown) => {
		mergePatch(body);
		return servedGlobals();
	});
});
afterEach(() => {
	cleanup();
});

describe("每种设置项怎么画", () => {
	it("标题、必填的星、说明都在", async () => {
		renderForm();
		await screen.findByText("检查间隔");
		expect(within(field("cookie")).getByText("*")).toBeTruthy();
		expect(within(field("interval")).queryByText("*")).toBeNull();
		expect(
			within(field("cookie")).getByText("从已登录抖音网页版的浏览器里复制整段 cookie。"),
		).toBeTruthy();
	});

	it("string:单行输入框,占位字在;monospace 用等宽字", async () => {
		renderForm();
		const note = (await screen.findByLabelText("备注")) as HTMLInputElement;
		expect(note.value).toBe("旧备注");
		expect(note.placeholder).toBe("随便写点");
		expect(note.className).not.toContain("font-mono");
		expect((screen.getByLabelText("UA") as HTMLInputElement).className).toContain("font-mono");
	});

	it("number:输入框 + 单位,读的是存着的值", async () => {
		renderForm();
		const interval = (await screen.findByLabelText("检查间隔")) as HTMLInputElement;
		expect(interval.value).toBe("90");
		expect(within(field("interval")).getByText("秒")).toBeTruthy();
	});

	it("没存过的格显示清单里的默认值", async () => {
		renderForm();
		await screen.findByText("检查间隔");
		expect(screen.getByRole("button", { name: "原图" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "盯开播" }).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("enum 选项带图标 → 选项卡片,图当 <img> 画;不带 → 分段按钮", async () => {
		renderForm();
		const kinds = within(await screen.findByRole("group", { name: "哪一种桥" }));
		const koishi = kinds.getByRole("button", { name: /koishi/ });
		expect(koishi.querySelector("img")?.getAttribute("src")).toBe(PNG);
		expect(koishi.getAttribute("aria-pressed")).toBe("true");
		const quality = within(screen.getByRole("group", { name: "图片清晰度" }));
		expect(quality.getAllByRole("button").map((b) => b.textContent)).toEqual(["原图", "省流量"]);
		expect(quality.getByRole("button", { name: "省流量" }).querySelector("img")).toBeNull();
	});

	/** 🔴 密钥只露头尾各四位,全文不上屏 —— 连输入框的 value 里都没有。 */
	it("secret:只露头尾,全文哪儿都没有", async () => {
		const { container } = renderForm();
		await screen.findByText("检查间隔");
		expect(within(field("cookie")).getByText(/^sess•+d41c$/)).toBeTruthy();
		expect(container.innerHTML).not.toContain(COOKIE);
		for (const input of container.querySelectorAll("input, textarea")) {
			expect((input as HTMLInputElement).value).not.toContain("0123456789abcdef");
		}
		expect(within(field("cookie")).getByRole("button", { name: "换一份" })).toBeTruthy();
	});

	it("generate:只读、遮住,能复制、能重新生成", async () => {
		renderForm();
		await screen.findByText("检查间隔");
		const token = within(field("token"));
		expect(token.getByText(`0123${"•".repeat(24)}cdef`)).toBeTruthy();
		expect(token.getByRole("button", { name: "复制 token" })).toBeTruthy();
		expect(token.getByRole("button", { name: "重新生成 token" })).toBeTruthy();
		expect(token.queryByRole("textbox")).toBeNull();
	});

	/** 读不到那份设置时不许画成「全是默认值」—— 主人照着改完一存,就把真值覆盖掉了。 */
	it("读不到设置 → 说一句,不画表单", async () => {
		vi.mocked(api.get).mockRejectedValue(new Error("配置读不出来:500"));
		renderForm();
		expect((await screen.findByRole("alert")).textContent).toContain("配置读不出来:500");
		expect(screen.queryByLabelText("检查间隔")).toBeNull();
	});
});

describe("保存:只发改了的那几格", () => {
	it("没改过时「保存」与「还原」都按不了", async () => {
		renderForm();
		await screen.findByLabelText("检查间隔");
		expect(save()).toHaveProperty("disabled", true);
		expect(revert()).toHaveProperty("disabled", true);
	});

	it("改一格就只发那一格", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("检查间隔"), { target: { value: "120" } });
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ interval: 120 });
	});

	it("改回原样就不算改过", async () => {
		renderForm();
		const interval = await screen.findByLabelText("检查间隔");
		fireEvent.change(interval, { target: { value: "120" } });
		expect(save()).toHaveProperty("disabled", false);
		fireEvent.change(interval, { target: { value: "90" } });
		expect(save()).toHaveProperty("disabled", true);
	});

	/** 清空一格可选的字 = 删掉那个键 —— 线格式上只有 `null` 说得出这件事。 */
	it("清空可选的一格发 null", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "" } });
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ note: null });
	});

	it("开关、选项卡片、分段按钮各发自己那一格", async () => {
		renderForm();
		fireEvent.click(await screen.findByRole("button", { name: "盯开播" }));
		fireEvent.click(screen.getByRole("button", { name: /AstrBot/ }));
		fireEvent.click(screen.getByRole("button", { name: "省流量" }));
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ live: false, bridgeKind: "astrbot", quality: "lite" });
	});

	/**
	 * 🔴 存完显示的是**回应里**的那份(合并之后的整份),不等重读:WS 那一帧与 HTTP 回应走两条
	 * 连接,谁先到没保证,等重读就是把「保存中…」挂在一发不知道什么时候回来的请求上。回应里
	 * 别处刚改的(这里是检查间隔)也跟着到位。
	 */
	it("存完:显示的是回应里的那份,不等重读", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));
		vi.mocked(api.patch).mockImplementation(async (_url: string, body?: unknown) => {
			stored.interval = 120; // 别处刚存的,合并进了这一发的回应
			mergePatch(body);
			return servedGlobals();
		});
		fireEvent.click(save());
		await waitFor(() => expect(save()).toHaveProperty("disabled", true));
		expect((screen.getByLabelText("备注") as HTMLInputElement).value).toBe("新备注");
		expect((screen.getByLabelText("检查间隔") as HTMLInputElement).value).toBe("120");
	});

	/**
	 * 服务端在回 HTTP 之前就经 WS 发了「globals 变了」,面板已经在重读:回应本身就是写后的那份,
	 * 在飞的那一发取消掉、换成回应 —— 再读一遍是让服务端白读。
	 */
	it("存完:WS 已经在重读那份设置时,不再多读一遍", async () => {
		const { qc } = renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		const reads = () =>
			vi.mocked(api.get).mock.calls.filter(([url]) => url === "/api/globals").length;
		let release = () => {};
		vi.mocked(api.get).mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve(servedGlobals());
				}),
		);
		vi.mocked(api.patch).mockImplementation(async (_url: string, body?: unknown) => {
			mergePatch(body);
			void qc.invalidateQueries({ queryKey: ["globals"] }); // WS 那一帧
			return servedGlobals();
		});
		const before = reads();
		fireEvent.click(save());
		await waitFor(() => expect(reads()).toBe(before + 1));
		await new Promise((settle) => setTimeout(settle, 30));
		expect(reads()).toBe(before + 1);
		release();
		await waitFor(() => expect(save()).toHaveProperty("disabled", true));
		expect((screen.getByLabelText("备注") as HTMLInputElement).value).toBe("新备注");
	});

	it("存完回到「没改过」,显示的是存下去的值", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("检查间隔"), { target: { value: "120" } });
		fireEvent.click(save());
		await waitFor(() => expect(save()).toHaveProperty("disabled", true));
		expect((screen.getByLabelText("检查间隔") as HTMLInputElement).value).toBe("120");
	});

	it("还原:丢掉没存的改动", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("检查间隔"), { target: { value: "120" } });
		fireEvent.click(revert());
		expect((screen.getByLabelText("检查间隔") as HTMLInputElement).value).toBe("90");
		expect(save()).toHaveProperty("disabled", true);
	});
});

describe("密钥", () => {
	/** 🔴 没按「换一份」的密钥一个字都不发 —— 改别的格时它不跟着走。 */
	it("改别的格时,密钥不跟着发", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).not.toHaveProperty("cookie");
		expect(sentSettings()).not.toHaveProperty("token");
	});

	it("换一份:给一个空的输入框,填了才发", async () => {
		renderForm();
		await screen.findByText("检查间隔");
		fireEvent.click(within(field("cookie")).getByRole("button", { name: "换一份" }));
		const input = within(field("cookie")).getByLabelText("Cookie") as HTMLTextAreaElement;
		expect(input.value).toBe("");
		// 按了「换一份」却什么都没填 —— 不算改过。
		expect(save()).toHaveProperty("disabled", true);
		fireEvent.change(input, { target: { value: "sessionid=new" } });
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ cookie: "sessionid=new" });
	});

	it("换一份之后反悔,回到遮住的样子", async () => {
		renderForm();
		await screen.findByText("检查间隔");
		fireEvent.click(within(field("cookie")).getByRole("button", { name: "换一份" }));
		fireEvent.click(within(field("cookie")).getByRole("button", { name: "不换了" }));
		expect(within(field("cookie")).getByText(/^sess•+d41c$/)).toBeTruthy();
	});

	/**
	 * 🔴 屏幕上那一把就是存下去的那一把:重新生成之后明文显示一次(主人要把它抄走),
	 * 按保存发出去的必须是同一串。
	 */
	it("重新生成:先问一句,新的明文显示一次,存下去的就是屏幕上那一串", async () => {
		renderForm();
		await screen.findByText("检查间隔");
		fireEvent.click(within(field("token")).getByRole("button", { name: "重新生成 token" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));
		const shown = within(field("token")).getByText(/^[0-9a-f]{32}$/).textContent as string;
		expect(shown).not.toBe(TOKEN);
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ token: shown });
	});

	/** 空值(脱敏备份恢复回来就是这样)没有旧钥匙可作废,直接生成,并用一句红字说明。 */
	it("generate 空着:红字提示,直接生成不问", async () => {
		stored = { ...stored, token: "" };
		renderForm();
		await screen.findByText("检查间隔");
		const token = within(field("token"));
		expect(token.getByText(/还没有 token/)).toBeTruthy();
		fireEvent.click(token.getByRole("button", { name: "重新生成 token" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(token.getByText(/^[0-9a-f]{32}$/)).toBeTruthy();
	});
});

describe("校验", () => {
	it("number 超出 min / max 当场说,保存按不了", async () => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("检查间隔"), { target: { value: "5" } });
		expect(within(field("interval")).getByRole("alert").textContent).toContain("30");
		expect(save()).toHaveProperty("disabled", true);
	});

	/**
	 * 🔴 数字格里打了不是数的东西:当场说,存不了,存着的值不动。`type="number"` 的框遇到这种输入
	 * `.value` 按规范给空串 —— 框里明明有字,交出来的却是「清空了」,可选格就发 `null` 把存着的值
	 * 删掉。
	 */
	it("数字格打了不是数的东西:当场说「要填一个数字」,保存不了,一发都不发", async () => {
		renderForm();
		const interval = (await screen.findByLabelText("检查间隔")) as HTMLInputElement;
		fireEvent.change(interval, { target: { value: "abc" } });
		expect(interval.value).toBe("abc");
		expect(within(field("interval")).getByRole("alert").textContent).toBe("要填一个数字");
		expect(save()).toHaveProperty("disabled", true);
		fireEvent.click(save());
		expect(api.patch).not.toHaveBeenCalled();
	});

	/**
	 * 只认数字框认的那种十进制写法。`Number()` 收得更宽 —— 十六进制、二进制、带正号、小数点
	 * 收尾的它都当成数,这里不收:写进去的与主人以为的对不上。`Infinity` 与中间带空格的一样不收。
	 */
	it.each(["0x10", "0b1", "+5", "5.", "Infinity", "1 000"])("「%s」不算一个数", async (text) => {
		renderForm();
		fireEvent.change(await screen.findByLabelText("检查间隔"), { target: { value: text } });
		expect(within(field("interval")).getByRole("alert").textContent).toBe("要填一个数字");
		expect(save()).toHaveProperty("disabled", true);
	});

	/** 负号要打得出来:打到一半的「-」留在框里(只是还不算数),接着打完就是一个负数。 */
	it("负号:打到一半的「-」留在框里,打完照常存", async () => {
		stored = {};
		renderForm([{ key: "offset", type: "number", label: "时差" }]);
		const offset = (await screen.findByLabelText("时差")) as HTMLInputElement;
		fireEvent.change(offset, { target: { value: "-" } });
		expect(offset.value).toBe("-");
		expect(save()).toHaveProperty("disabled", true);
		fireEvent.change(offset, { target: { value: "-8" } });
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ offset: -8 });
	});

	/** 照旧的那几样:小数、指数照常认;清空可选的数字格发 `null`。 */
	it.each([
		["-1.5", -1.5],
		[".5", 0.5],
		["2e3", 2000],
		["", null],
	])("「%s」照常发 %s", async (text, sent) => {
		stored = { offset: 3 };
		renderForm([{ key: "offset", type: "number", label: "时差" }]);
		fireEvent.change(await screen.findByLabelText("时差"), { target: { value: text } });
		fireEvent.click(save());
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentSettings()).toEqual({ offset: sent });
	});

	it("必填的清空了当场说", async () => {
		const fields: ExtensionScalarField[] = [
			{ key: "name", type: "string", label: "名字", required: true },
		];
		stored = { name: "抖音" };
		renderForm(fields);
		fireEvent.change(await screen.findByLabelText("名字"), { target: { value: "" } });
		expect(within(field("name")).getByRole("alert")).toBeTruthy();
		expect(save()).toHaveProperty("disabled", true);
	});

	/** 服务端照清单校验不过:那句话落在那一格底下,别的格不沾。 */
	it("400 的 issue 落到对应那一格", async () => {
		vi.mocked(api.patch).mockRejectedValue(
			new ApiError(
				400,
				{
					error: "validation_failed",
					scope: "globals",
					issues: [{ path: ["extensions", "douyin", "settings", "note"], message: "备注太长了" }],
				},
				"PATCH /api/globals → 400",
			),
		);
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		fireEvent.click(save());
		expect((await within(field("note")).findByRole("alert")).textContent).toContain("备注太长了");
		expect(within(field("interval")).queryByRole("alert")).toBeNull();
		// 改动还在,没被当成「存上了」丢掉。
		expect((screen.getByLabelText("备注") as HTMLInputElement).value).toBe("新备注");
	});

	/**
	 * 与列表那一节同一个口径:一条都拆不出来时说原话。什么都不显示的话,按钮弹回去、改动还在,
	 * 看上去就是「点了没反应」。
	 */
	it("400 却一条 issue 都没有:原话摆在表单顶上", async () => {
		vi.mocked(api.patch).mockRejectedValue(
			new ApiError(
				400,
				{ error: "validation_failed", scope: "globals", issues: [] },
				"PATCH /api/globals → 400",
			),
		);
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		fireEvent.click(save());
		expect((await screen.findByRole("alert")).textContent).toBe(
			"没存进去:PATCH /api/globals → 400",
		);
	});

	it("落不到某一格的 issue 与别的失败,说在表单顶上", async () => {
		vi.mocked(api.patch).mockRejectedValue(
			new ApiError(
				400,
				{
					error: "validation_failed",
					scope: "globals",
					issues: [{ path: ["extensions", "douyin", "settings", "links", 0], message: "少了 id" }],
				},
				"PATCH /api/globals → 400",
			),
		);
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		fireEvent.click(save());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("少了 id");
		expect(field("note").contains(alert)).toBe(false);
	});

	/**
	 * 🔴 设置项的 key 归拓展自己起,而草稿、错误表都是普通对象:`in` / `??` 一读就读到
	 * `Object.prototype` 上的同名函数。服务端会在清单那一步挡掉这些名字,但面板自己也得站得住。
	 */
	describe("key 撞上 Object.prototype 上的名字", () => {
		const PROTO_FIELDS: ExtensionScalarField[] = [
			{ key: "valueOf", type: "number", label: "次数", default: 5 },
			{ key: "toString", type: "string", label: "称呼" },
		];

		it("一上来是默认值 / 空框,不报错,也不算改过", async () => {
			stored = {};
			renderForm(PROTO_FIELDS);
			expect(((await screen.findByLabelText("次数")) as HTMLInputElement).value).toBe("5");
			expect((screen.getByLabelText("称呼") as HTMLInputElement).value).toBe("");
			expect(within(field("valueOf")).queryByRole("alert")).toBeNull();
			expect(within(field("toString")).queryByRole("alert")).toBeNull();
			expect(save()).toHaveProperty("disabled", true);
		});

		it("改一格就只发那一格", async () => {
			stored = {};
			renderForm(PROTO_FIELDS);
			fireEvent.change(await screen.findByLabelText("次数"), { target: { value: "7" } });
			fireEvent.click(save());
			await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
			expect(sentSettings()).toEqual({ valueOf: 7 });
		});

		it("generate 格叫 valueOf:存着的那把遮住,重新生成先问一句", async () => {
			stored = { valueOf: TOKEN };
			renderForm([{ key: "valueOf", type: "string", label: "钥匙", secret: true, generate: true }]);
			await screen.findByText("钥匙");
			const key = within(field("valueOf"));
			expect(key.getByText(`0123${"•".repeat(24)}cdef`)).toBeTruthy();
			fireEvent.click(key.getByRole("button", { name: "重新生成 钥匙" }));
			expect(await screen.findByRole("dialog")).toBeTruthy();
		});

		it("密钥格叫 toString:按了「换一份」,存别的格之后它还开着", async () => {
			stored = { toString: COOKIE, note: "旧备注" };
			renderForm([
				{ key: "toString", type: "string", label: "密", secret: true },
				{ key: "note", type: "string", label: "备注" },
			]);
			await screen.findByText("密");
			fireEvent.click(within(field("toString")).getByRole("button", { name: "换一份" }));
			fireEvent.change(screen.getByLabelText("备注"), { target: { value: "新备注" } });
			fireEvent.click(save());
			await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
			await waitFor(() => expect(save()).toHaveProperty("disabled", true));
			expect(sentSettings()).toEqual({ note: "新备注" });
			expect(within(field("toString")).getByRole("button", { name: "不换了" })).toBeTruthy();
		});

		it("400 落到叫 constructor 的那一格,不被同名函数吞掉", async () => {
			vi.mocked(api.patch).mockRejectedValue(
				new ApiError(
					400,
					{
						error: "validation_failed",
						scope: "globals",
						issues: [
							{ path: ["extensions", "douyin", "settings", "constructor"], message: "构造不对" },
						],
					},
					"PATCH /api/globals → 400",
				),
			);
			stored = { constructor: "旧" };
			renderForm([{ key: "constructor", type: "string", label: "构造" }]);
			const input = (await screen.findByLabelText("构造")) as HTMLInputElement;
			expect(input.value).toBe("旧");
			expect(within(field("constructor")).queryByRole("alert")).toBeNull();
			fireEvent.change(input, { target: { value: "新" } });
			fireEvent.click(save());
			expect((await within(field("constructor")).findByRole("alert")).textContent).toContain(
				"构造不对",
			);
		});
	});

	it("别的失败(只读盘 / 断网)原话摆出来", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置目录是只读的"));
		renderForm();
		fireEvent.change(await screen.findByLabelText("备注"), { target: { value: "新备注" } });
		fireEvent.click(save());
		expect((await screen.findByRole("alert")).textContent).toContain("配置目录是只读的");
	});
});
