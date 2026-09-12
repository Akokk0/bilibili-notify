// @vitest-environment jsdom

/**
 * 连接配置表单的**刻画测试** —— 三个平台各摆哪几栏、随连法怎么增减、标签与提示写什么。
 *
 * 写它是因为这张表单此前**几乎没有覆盖**:只有平台胶囊与 OneBot 连法胶囊那两排被钉过,
 * 底下十来栏(超时三档、重试两档、握手头、官机五栏、webhook 两栏)一栏都没有。而它正要
 * 从「每个平台一段手写 JSX」改成「一张声明式字段表 + 一个通用渲染器」,重构期间没有这层
 * 网,漏掉一栏、把一栏挂到错的 config 键上、或者让某栏在不该出现的连法下冒出来,
 * 都不会有任何东西报。
 *
 * 判据取 `Field` 的 `data-code` —— 它本来就是每栏全局唯一的身份(字段默认值广播、导览
 * 聚光灯都按它找),比按标签文本找稳:文案改了不该让这个文件红,少了一栏才该。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PlatformMetaRoot } from "../../components/platform-meta";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

beforeEach(() => {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/connections") return [];
		if (url === "/api/targets") return [];
		return [];
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function openNewConnection(): Promise<HTMLElement> {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<PlatformMetaRoot>
				<Targets />
			</PlatformMetaRoot>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: /新建连接/ }));
	await waitFor(() => screen.getByRole("dialog"));
	return screen.getByRole("dialog");
}

/** 弹窗里按出现顺序列出的字段 code —— 只看 `config.*` 那些,基本信息那几栏不在这次范围。 */
function configCodes(dialog: HTMLElement): string[] {
	return [...dialog.querySelectorAll("[data-code]")]
		.map((el) => el.getAttribute("data-code") ?? "")
		.filter((code) => code.startsWith("config."));
}

function click(dialog: HTMLElement, name: string | RegExp): void {
	fireEvent.click(within(dialog).getByRole("button", { name }));
}

/** 某一栏里的那个输入框。 */
function control(dialog: HTMLElement, code: string): HTMLElement {
	const row = dialog.querySelector(`[data-code="${code}"]`);
	if (!row) throw new Error(`没有这一栏:${code}`);
	const el = row.querySelector("input, select, textarea");
	if (!el) throw new Error(`这一栏里没有输入控件:${code}`);
	return el as HTMLElement;
}

describe("OneBot 连接", () => {
	it("默认 HTTP:摆的是 baseUrl 那一套", async () => {
		const dialog = await openNewConnection();
		expect(configCodes(dialog)).toEqual([
			"config.transport",
			"config.baseUrl",
			"config.accessToken",
			"config.timeoutMs",
			"config.imageMinTimeoutMs",
			"config.forwardMinTimeoutMs",
			"config.retryTimes",
			"config.retryIntervalMs",
			"config.headers",
		]);
	});

	it("切正向 WS:baseUrl 换成 url,别的照旧", async () => {
		const dialog = await openNewConnection();
		click(dialog, "正向 WS");
		const codes = configCodes(dialog);
		expect(codes).toContain("config.url");
		expect(codes).not.toContain("config.baseUrl");
		expect(codes).toContain("config.headers");
	});

	it("切反向 WS:换成监听端口,而且**没有**握手头那一栏(端口那头没有请求头可发)", async () => {
		const dialog = await openNewConnection();
		click(dialog, "反向 WS");
		const codes = configCodes(dialog);
		expect(codes).toContain("config.port");
		expect(codes).not.toContain("config.url");
		expect(codes).not.toContain("config.baseUrl");
		expect(codes).not.toContain("config.headers");
	});

	/**
	 * 🔴 **地址要印出来**(issue #49)。反向 WS 是 bot 主动连进来,那条地址只活在用户脑子里:
	 * 面板从前只让填一个端口号,于是从 koishi 转过来的人(那边的默认推荐是
	 * `ws://127.0.0.1:5140/onebot`)以为路径没地方写,只好另开一个服务端改走正向 WS。
	 * 路径其实一直是自由的 —— `WebSocketServer({ port })` 不带 `path`,什么路径都收。
	 */
	it("反向 WS 把 bot 该连的完整地址印出来,并说明路径随便填", async () => {
		const dialog = await openNewConnection();
		click(dialog, "反向 WS");

		const row = dialog.querySelector('[data-code="config.reverseAddress"]') as HTMLElement;
		expect(row).not.toBeNull();
		// 主机取浏览器地址栏那一个,端口取这一栏填的那个(不是主端口)。
		expect(row.textContent).toContain(`ws://${window.location.hostname}:9797/onebot`);
		expect(row.textContent).toMatch(/路径/);
		expect(within(row).getByRole("button", { name: /复制/ })).toBeTruthy();
	});

	it("超时那一栏的标签随连法变 —— HTTP 是请求超时,WS 是等 echo 的响应超时", async () => {
		const dialog = await openNewConnection();
		expect(within(dialog).getByText("请求超时")).toBeTruthy();
		click(dialog, "正向 WS");
		expect(within(dialog).getByText("响应超时")).toBeTruthy();
	});

	it("反向 WS 的 accessToken 要提醒端口裸开", async () => {
		const dialog = await openNewConnection();
		click(dialog, "反向 WS");
		const row = dialog.querySelector('[data-code="config.accessToken"]') as HTMLElement;
		expect(row.textContent).toContain("裸开");
	});

	it("改了一栏就存进草稿 —— 键没挂错", async () => {
		const dialog = await openNewConnection();
		const input = control(dialog, "config.baseUrl");
		fireEvent.change(input, { target: { value: "http://napcat:9999" } });
		expect((control(dialog, "config.baseUrl") as HTMLInputElement).value).toBe(
			"http://napcat:9999",
		);
	});

	it("换连法是整份换掉 config,但共用字段留着", async () => {
		const dialog = await openNewConnection();
		fireEvent.change(control(dialog, "config.timeoutMs"), { target: { value: "20000" } });
		click(dialog, "正向 WS");
		expect((control(dialog, "config.timeoutMs") as HTMLInputElement).value).toBe("20000");
		// 切过去之后地址是那一档自己的初值,不是上一档留下的残字段。
		expect((control(dialog, "config.url") as HTMLInputElement).value).toMatch(/^ws:\/\//);
	});
});

describe("QQ 官方机器人连接", () => {
	it("五栏齐,外加扫码建号那一行", async () => {
		const dialog = await openNewConnection();
		click(dialog, "QQ 官方机器人");
		expect(configCodes(dialog)).toEqual([
			"config.appId",
			"config.appSecret",
			"config.botType",
			"config.sandbox",
			"config.logReconnects",
		]);
		expect(within(dialog).getByText(/扫码在腾讯页面一键创建/)).toBeTruthy();
	});

	it("机器人域是公域 / 私域二选一", async () => {
		const dialog = await openNewConnection();
		click(dialog, "QQ 官方机器人");
		const row = dialog.querySelector('[data-code="config.botType"]') as HTMLElement;
		expect(row.textContent).toContain("公域");
		expect(row.textContent).toContain("私域");
	});
});

describe("webhook 那一族", () => {
	it("URL / Secret / 自定义请求头三栏,占位符与提示按平台走", async () => {
		const dialog = await openNewConnection();
		click(dialog, /飞书机器人/);
		expect(configCodes(dialog)).toEqual(["config.url", "config.secret", "config.headers"]);
		expect((control(dialog, "config.url") as HTMLInputElement).placeholder).toContain(
			"open.feishu.cn",
		);
		const secretRow = dialog.querySelector('[data-code="config.secret"]') as HTMLElement;
		expect(secretRow.textContent).toContain("飞书签名密钥");
	});

	it("自建端点那档也是同样三栏 —— 四家统一,不按平台增减", async () => {
		const dialog = await openNewConnection();
		click(dialog, /未指明的 HTTP 端点/);
		expect(configCodes(dialog)).toEqual(["config.url", "config.secret", "config.headers"]);
	});

	it("换成钉钉:同样三栏,提示换成钉钉那份", async () => {
		const dialog = await openNewConnection();
		click(dialog, /钉钉机器人/);
		expect(configCodes(dialog)).toEqual(["config.url", "config.secret", "config.headers"]);
		const secretRow = dialog.querySelector('[data-code="config.secret"]') as HTMLElement;
		expect(secretRow.textContent).toContain("加签密钥");
	});
});
