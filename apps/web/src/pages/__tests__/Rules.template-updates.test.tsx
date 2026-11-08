// @vitest-environment jsdom

/**
 * 「默认文案有更新」的逐字段小标记 + 账本的写法。
 *
 * 文字模板设置里只存主人改过的(ADR-0037 决策 10),没存的跟当前语言的出厂走。这套提示只对存着的那几条有意义:
 * 主人第一次改某条时,面板记下那一刻**简体**出厂原文的指纹;之后简体出厂文案变了才亮灯。判定本身是纯函数
 * (`@bilibili-notify/internal/template-defaults`),这里只管界面接线接对没有 —— 标记该亮时亮、
 * 两个动作各自改对了东西、账本不留脏条目。
 */

import { DEFAULT_LOCALE } from "@bilibili-notify/internal/i18n";
import { templateFingerprint } from "@bilibili-notify/internal/template-defaults";
import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import type { GlobalSettings } from "../../types/globals";
import Rules from "../Rules";
import { makeAi, makeDefaults, makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const FACTORY_TEMPLATES = templateDefaultsFor(DEFAULT_LOCALE);
const FP_LIVE_START = templateFingerprint(FACTORY_TEMPLATES.liveStart);
const FP_GUARD = templateFingerprint(FACTORY_TEMPLATES.membership);
const GUARD_PATH = "membership.guard.default.template";

/**
 * 造一份 globals,起点是新装的形状:一条文字都没存、账本空;`mutate` 里摆主人存着的文字(`d.templates`)
 * 与账本(`top.templatesSeen`,在核心设置顶层,不在 defaults 里)。
 */
function globalsWith(
	mutate: (
		d: ReturnType<typeof makeDefaults>,
		top: { templatesSeen: Record<string, string> },
	) => void = () => {},
): GlobalSettings {
	const defaults = makeDefaults();
	defaults.templates = { wordcloudStopWords: "", membership: {} } as never;
	const top = { templatesSeen: {} as Record<string, string> };
	mutate(defaults, top);
	return {
		logging: {},
		master: {},
		defaults,
		ai: makeAi(),
		templatesSeen: top.templatesSeen,
	} as unknown as GlobalSettings;
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function mount(g: GlobalSettings) {
	vi.mocked(api.get).mockImplementation((url: string) =>
		Promise.resolve(
			url === "/api/sources"
				? { sources: [makeSource()] }
				: url.includes("/api/subscriptions")
					? []
					: { core: JSON.parse(JSON.stringify(g)) },
		),
	);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Rules />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

/** 切到「直播消息版式」那一节 —— liveStart 住在那儿。 */
async function gotoLiveMsg(): Promise<void> {
	await waitFor(() => expect(screen.getAllByText("直播消息版式").length).toBeGreaterThan(0));
	fireEvent.click(screen.getAllByText("直播消息版式")[0]);
}

/** liveStart 字段上的提示条(没有就 null)。 */
function noticeOfLiveStart(): Element | null {
	return document.querySelector('[data-code="templates.liveStart"] [data-template-update]');
}

/** liveStart 的输入框。 */
function liveStartInput(): HTMLTextAreaElement | HTMLInputElement {
	const el = document.querySelector(
		'[data-code="templates.liveStart"] textarea, [data-code="templates.liveStart"] input',
	);
	if (!el) throw new Error("liveStart 输入框没找到");
	return el as HTMLTextAreaElement | HTMLInputElement;
}

/** liveStart 字段上的「恢复默认」按钮(没有就 null)。 */
function resetBtnOfLiveStart(): Element | null {
	// 定位锚是外层的 `data-field-reset`,点击目标是里面那个真按钮 —— 点外层的
	// 包装元素不会触发按钮的 onClick(事件只往上冒,不往下传)。
	return document.querySelector('[data-code="templates.liveStart"] [data-field-reset] button');
}

const diffCodes = (): string[] => useDraftStore.getState().current?.diff.map((x) => x.code) ?? [];

/** 点保存(灵动岛触发的那条路),返回下发给 `/api/settings` 的 body。 */
async function saveAndGetBody(): Promise<{
	defaults: { templates?: Record<string, unknown> };
	templatesSeen?: Record<string, unknown>;
}> {
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("rules"));
	const onSave = useDraftStore.getState().current?.onSave as (() => Promise<void>) | undefined;
	await onSave?.();
	expect(api.patch).toHaveBeenCalledWith("/api/settings", expect.anything());
	return (vi.mocked(api.patch).mock.calls.at(-1) as [string, { core: never }])[1].core;
}

describe("默认文案有更新的小标记", () => {
	it("存着、账本里有、指纹是旧简体的 → 该字段亮标记", async () => {
		mount(
			globalsWith((d, top) => {
				d.templates.liveStart = "我自己写的";
				top.templatesSeen = { liveStart: templateFingerprint("上一版的开播文案") };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
	});

	it("没存的 → 不亮,哪怕账本里躺着旧指纹", async () => {
		mount(
			globalsWith((_d, top) => {
				top.templatesSeen = { liveStart: templateFingerprint("上一版的开播文案") };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		expect(noticeOfLiveStart()).toBeNull();
	});

	it("存着但账本里没有这条 → 不亮", async () => {
		mount(globalsWith((d) => (d.templates.liveStart = "我自己写的")));
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe("我自己写的"));
		expect(noticeOfLiveStart()).toBeNull();
	});

	it("存着、账本指纹等于当前简体 → 不亮(这一版他见过了)", async () => {
		// 手写过文案的主人,值**永远**不等于默认。若这条不成立,提示会一直挂着不灭。
		mount(
			globalsWith((d, top) => {
				d.templates.liveStart = "我自己写的";
				top.templatesSeen = { liveStart: FP_LIVE_START };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe("我自己写的"));
		expect(noticeOfLiveStart()).toBeNull();
	});
});

/** 账本过期的一条自己写的开播文案:提示亮着。 */
const staleLiveStart = () =>
	globalsWith((d, top) => {
		d.templates.liveStart = "我自己写的";
		top.templatesSeen = { liveStart: templateFingerprint("上一版的开播文案") };
	});

describe("两个动作与账本", () => {
	it("点「用新默认」→ 删键 + 删账本那一条:输入框回到默认、提示消失,保存两处都下发 null", async () => {
		mount(staleLiveStart());
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
		fireEvent.click(screen.getByText("用新默认"));
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		expect(noticeOfLiveStart()).toBeNull();
		const body = await saveAndGetBody();
		expect(body.defaults.templates?.liveStart).toBeNull();
		expect(body.templatesSeen).toEqual({ liveStart: null });
	});

	it("点「保持我的」→ 文案一个字不动,账本记新的简体指纹,提示消失", async () => {
		mount(staleLiveStart());
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
		fireEvent.click(screen.getByText("保持我的"));
		await waitFor(() => expect(noticeOfLiveStart()).toBeNull());
		expect(liveStartInput().value).toBe("我自己写的");
		const body = await saveAndGetBody();
		expect(body.templatesSeen).toEqual({ liveStart: FP_LIVE_START });
		expect(body.defaults).not.toHaveProperty("templateDefaultsSeen");
	});

	it("「保持我的」点完保存条会亮(账本变了算脏),刷新(重读)后提示不再出现", async () => {
		const g = staleLiveStart();
		mount(g);
		await gotoLiveMsg();
		await waitFor(() => expect(noticeOfLiveStart()).not.toBeNull());
		fireEvent.click(screen.getByText("保持我的"));
		await waitFor(() => expect(diffCodes()).toContain("templatesSeen.liveStart"));
		cleanup();
		resetStore();
		// 服务端回来的就是存好的账本。
		mount({ ...g, templatesSeen: { liveStart: FP_LIVE_START } } as GlobalSettings);
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput()).toBeTruthy());
		expect(noticeOfLiveStart()).toBeNull();
	});

	it("「恢复默认」= 删键 + 删账本那一条:保存两处都下发 null", async () => {
		mount(
			globalsWith((d, top) => {
				d.templates.liveStart = "我自己写的";
				top.templatesSeen = { liveStart: FP_LIVE_START };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(resetBtnOfLiveStart()).not.toBeNull());
		fireEvent.click(resetBtnOfLiveStart() as Element);
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		const body = await saveAndGetBody();
		expect(body.defaults.templates?.liveStart).toBeNull();
		expect(body.templatesSeen).toEqual({ liveStart: null });
	});

	it("值本来就是默认(没存)→ 没有「恢复默认」按钮", async () => {
		mount(globalsWith());
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput()).toBeTruthy());
		expect(resetBtnOfLiveStart()).toBeNull();
	});
});

describe("账本在第一次改某条时记", () => {
	it("没存 → 改成别的一句:存下这一句,账本记下此刻简体出厂原文的指纹", async () => {
		mount(globalsWith());
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		fireEvent.change(liveStartInput(), { target: { value: "我自己写的" } });
		await waitFor(() => expect(diffCodes()).toContain("templatesSeen.liveStart"));
		const body = await saveAndGetBody();
		expect(body.defaults.templates?.liveStart).toBe("我自己写的");
		expect(body.templatesSeen).toEqual({ liveStart: FP_LIVE_START });
	});

	it("改了又改回默认 → 草稿与基线没有差别:账本不留脏条目,什么都不发", async () => {
		mount(globalsWith());
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		fireEvent.change(liveStartInput(), { target: { value: "随手改的" } });
		await waitFor(() => expect(diffCodes()).toContain("templatesSeen.liveStart"));
		fireEvent.change(liveStartInput(), { target: { value: FACTORY_TEMPLATES.liveStart } });
		await waitFor(() => expect(diffCodes()).not.toContain("templates.liveStart"));
		expect(diffCodes()).not.toContain("templatesSeen.liveStart");
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("没保存就离开(丢弃)→ 账本回到基线", async () => {
		mount(globalsWith());
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		fireEvent.change(liveStartInput(), { target: { value: "随手改的" } });
		await waitFor(() => expect(diffCodes()).toContain("templatesSeen.liveStart"));
		useDraftStore.getState().current?.onDiscard();
		await waitFor(() => expect(liveStartInput().value).toBe(FACTORY_TEMPLATES.liveStart));
		await waitFor(() => expect(diffCodes()).toEqual([]));
	});

	it("已经存着的再改一句 → 账本不动(旧指纹留着,提示才能继续问)", async () => {
		mount(staleLiveStart());
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe("我自己写的"));
		fireEvent.change(liveStartInput(), { target: { value: "我又改了一句" } });
		await waitFor(() => expect(diffCodes()).toContain("templates.liveStart"));
		expect(diffCodes()).not.toContain("templatesSeen.liveStart");
		const body = await saveAndGetBody();
		expect(body.defaults.templates?.liveStart).toBe("我又改了一句");
		// 账本原样带着(旧指纹没被换成新的)
		expect(body.templatesSeen).toEqual({ liveStart: templateFingerprint("上一版的开播文案") });
	});

	it("编辑到与默认一字不差 → 键没了,账本那一条也跟着没", async () => {
		mount(
			globalsWith((d, top) => {
				d.templates.liveStart = "我自己写的";
				top.templatesSeen = { liveStart: FP_LIVE_START };
			}),
		);
		await gotoLiveMsg();
		await waitFor(() => expect(liveStartInput().value).toBe("我自己写的"));
		fireEvent.change(liveStartInput(), { target: { value: FACTORY_TEMPLATES.liveStart } });
		await waitFor(() => expect(diffCodes()).toContain("templates.liveStart"));
		const body = await saveAndGetBody();
		expect(body.defaults.templates?.liveStart).toBeNull();
		expect(body.templatesSeen).toEqual({ liveStart: null });
	});
});

describe("上舰文案的体系默认也接上「默认文案有更新」", () => {
	const GUARD_DEFAULT = `templates.${GUARD_PATH}`;

	/** 打开自定义会员提示;`template` 不给 = 体系默认那一句没存。 */
	function withGuard(template?: string, seen?: Record<string, string>) {
		return globalsWith((d, top) => {
			d.templates.membership = {
				guard: {
					enabled: true,
					...(template === undefined ? {} : { default: { template, imageUrl: "" } }),
					tiers: {},
				},
			} as never;
			if (seen) top.templatesSeen = seen;
		});
	}

	async function gotoGuard(): Promise<void> {
		await waitFor(() => expect(screen.getAllByText("会员提示").length).toBeGreaterThan(0));
		fireEvent.click(screen.getAllByText("会员提示")[0]);
		await waitFor(() =>
			expect(document.querySelector(`[data-code="${GUARD_DEFAULT}"]`)).not.toBeNull(),
		);
	}

	const noticeOfGuard = () =>
		document.querySelector(`[data-code="${GUARD_DEFAULT}"] [data-template-update]`);
	const guardInput = () =>
		document.querySelector(
			`[data-code="${GUARD_DEFAULT}"] input, [data-code="${GUARD_DEFAULT}"] textarea`,
		) as HTMLInputElement;

	it("存着、账本是旧简体 → 亮标记", async () => {
		mount(withGuard("我的上舰文案", { [GUARD_PATH]: templateFingerprint("上一版的上舰文案") }));
		await gotoGuard();
		await waitFor(() => expect(noticeOfGuard()).not.toBeNull());
	});

	it("体系默认那一句没存 → 不亮,输入框显示出厂句", async () => {
		mount(withGuard(undefined, { [GUARD_PATH]: templateFingerprint("上一版的上舰文案") }));
		await gotoGuard();
		expect(noticeOfGuard()).toBeNull();
		expect(guardInput().value).toBe(FACTORY_TEMPLATES.membership);
	});

	it("点「用新默认」→ 删键 + 删账本,体系默认回到出厂句,提示消失", async () => {
		mount(withGuard("我的上舰文案", { [GUARD_PATH]: templateFingerprint("上一版的上舰文案") }));
		await gotoGuard();
		await waitFor(() => expect(noticeOfGuard()).not.toBeNull());
		fireEvent.click(screen.getByText("用新默认"));
		await waitFor(() => expect(noticeOfGuard()).toBeNull());
		expect(guardInput().value).toBe(FACTORY_TEMPLATES.membership);
		const body = await saveAndGetBody();
		expect(body.templatesSeen).toEqual({ [GUARD_PATH]: null });
	});

	it("第一次改体系默认那一句 → 账本记简体出厂句的指纹", async () => {
		mount(withGuard());
		await gotoGuard();
		fireEvent.change(guardInput(), { target: { value: "我自己的上舰文案" } });
		await waitFor(() => expect(diffCodes()).toContain(`templatesSeen.${GUARD_PATH}`));
		const body = await saveAndGetBody();
		expect(body.templatesSeen).toEqual({ [GUARD_PATH]: FP_GUARD });
	});
});
