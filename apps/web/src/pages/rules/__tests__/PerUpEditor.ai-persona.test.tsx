// @vitest-environment jsdom
/**
 * per-UP「AI 人格」—— 这里只负责**挑一份**已有人格。
 *
 * 人格一律在「智能女仆」页里写,所以这一块没有「继承全局」(关掉开关就是继承,
 * 再摆一个同义的选项是多此一举),也没有「完全自定义」(想要专属人格就去那边
 * 新建一份,回来挑它)。
 *
 * 真正要钉的是**老配置**那一头。盘上会有三种指不着人格的值:当年那档
 * `'inherit'`、当年那档 `'custom'`(还带着一整套写死的 persona)、以及指向一份
 * 后来被删掉的人格。它们在 `resolveAI` 眼里的行为都是完整继承全局 —— 界面就得
 * 照实显示成「关」,否则就是「界面说覆盖着、实际跟着全局走」的两张皮。而主人真
 * 去开它时,写回磁盘的必须是干净的新对象:把已经失效的 persona 原样搬回去,等于
 * 让鬼配置在盘上又活一轮。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import type { GlobalDefaults } from "../../../types/globals";
import { PerUpEditor } from "../PerUpEditor";
import { makeDefaults } from "./fixtures";

vi.mock("../../../services/api", () => ({
	api: { patch: vi.fn(async () => ({})) },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const PERSONA = {
	name: "小绫",
	addressUser: "主人",
	addressSelf: "小绫",
	traits: "温柔",
	catchphrase: "请主人慢用~",
	baseRole: "",
	extraSystemPrompt: "",
};

/** 两份已有人格 —— 「挑一份」这件事至少要有两份才谈得上。 */
function defaultsWithPresets(): GlobalDefaults {
	const d = makeDefaults();
	d.ai.presets = [
		{ id: "gentle-maid", label: "温柔女仆", persona: PERSONA },
		{ id: "tsundere", label: "傲娇毒舌", persona: { ...PERSONA, name: "阿绫" } },
	];
	return d;
}

function mount(overridesAi?: Subscription["overrides"]["ai"]) {
	const sub = makeEmptySubscription("123456");
	if (overridesAi) sub.overrides.ai = overridesAi;
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<PerUpEditor sub={sub} defaults={defaultsWithPresets()} section="ai" />
		</QueryClientProvider>,
	);
}

/** 头部那颗开关 —— 未开启时它是整块里唯一的按钮。 */
function headerToggle(container: HTMLElement): Element {
	const el = container.querySelector("button");
	if (!el) throw new Error("找不到开关");
	return el;
}

/** 灵动岛此刻记下的改动路径。 */
function diffCodes(): string[] {
	return useDraftStore.getState().current?.diff.map((d) => d.code) ?? [];
}

/**
 * 保存,并取出真正写回磁盘的那个 `overrides.ai`。
 *
 * 不看灵动岛的 diff path:`overrides.ai` 从「没有」变成「有」时,`walkTreeDiff`
 * 把整只桶当**一个叶子**吐出来,路径只有一个光秃秃的 `ai` —— 拿它去断言
 * 「不含 ai.persona」会一路假绿,因为那种路径压根不会出现。
 */
async function saveAndReadAi(): Promise<Record<string, unknown> | null | undefined> {
	await act(async () => {
		useDraftStore.getState().current?.onSave();
	});
	await waitFor(() => expect(vi.mocked(api.patch)).toHaveBeenCalled());
	const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
		string,
		{ overrides?: { ai?: Record<string, unknown> | null } },
	];
	return body.overrides?.ai;
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetStore();
});

describe("per-UP AI 人格 — 只能挑已有的那几份", () => {
	it("选项就是已有人格,没有「继承全局」也没有「完全自定义」", async () => {
		const { container } = mount();
		fireEvent.click(headerToggle(container));

		const picker = await screen.findByText("温柔女仆");
		const group = picker.closest("[data-code]") ?? container;
		expect(within(group as HTMLElement).queryByText("继承全局")).toBeNull();
		expect(within(group as HTMLElement).queryByText("完全自定义")).toBeNull();
		expect(within(group as HTMLElement).getByText("傲娇毒舌")).toBeTruthy();
	});

	it("关着就是继承 —— 不再拿一个同义的选项表示同一件事", () => {
		mount();
		expect(screen.getByText(/跟着全局那份人格走/)).toBeTruthy();
		expect(screen.queryByText("温柔女仆")).toBeNull();
	});

	it("一打开就落到第一份人格,而不是停在一个没选中任何人格的空档", async () => {
		const { container } = mount();
		fireEvent.click(headerToggle(container));
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));
		expect(screen.getByText(/这个 UP 用「温柔女仆」/)).toBeTruthy();
		expect(await saveAndReadAi()).toEqual({ preset: "gentle-maid" });
	});
});

describe("per-UP AI 人格 — 指不着人格的老值一律显示成「继承」", () => {
	// 三种老值在 resolveAI 眼里都是完整继承全局(见 schema/resolve.ts)。
	// 界面若显示成「覆盖中」,就是在报告一件根本没发生的事。
	for (const [label, preset] of [
		["当年那档「继承全局」", "inherit"],
		["当年那档「完全自定义」", "custom"],
		["指向一份已被删掉的人格", "deleted-preset-id"],
	] as const) {
		it(`${preset} —— ${label}`, () => {
			mount({ preset });
			expect(screen.getByText(/跟着全局那份人格走/)).toBeTruthy();
		});
	}
});

describe("per-UP AI 人格 — 老的自定义残留不许被写回磁盘", () => {
	const STALE = {
		preset: "custom",
		persona: { ...PERSONA, name: "老名字" },
		dynamicPrompt: "老的动态模板",
		liveSummaryPrompt: "老的总结模板",
	} as const;

	/*
	 * 三个残留字段发的是**显式 `null`**,不是「不提」。
	 *
	 * PATCH 是 JSON Merge Patch:键缺席 = 这个字段不改,于是旧值原封不动留在盘上。
	 * 要真把它们抹掉,只能显式发 null。这个坑在本仓反复复发过(见 patch.ts 的开头),
	 * 所以这里钉的是「清除哨兵确实发出去了」,而不只是「没被原样带回去」。
	 */
	it("从残留态打开覆盖 → 挑哪份写哪份,persona 与两段 prompt 显式清除", async () => {
		const { container } = mount({ ...STALE });
		fireEvent.click(headerToggle(container));
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		expect(await saveAndReadAi()).toEqual({
			preset: "gentle-maid",
			persona: null,
			dynamicPrompt: null,
			liveSummaryPrompt: null,
		});
	});

	it("与人格无关的 temperature 照旧留着 —— 它不在撤掉之列", async () => {
		const { container } = mount({ ...STALE, temperature: 1.5 });
		fireEvent.click(headerToggle(container));
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		expect(await saveAndReadAi()).toEqual({
			preset: "gentle-maid",
			temperature: 1.5,
			persona: null,
			dynamicPrompt: null,
			liveSummaryPrompt: null,
		});
	});

	it("关掉覆盖 → 整块显式清除,而不是留一个空壳继续占着位子", async () => {
		const { container } = mount({ preset: "tsundere" });
		fireEvent.click(headerToggle(container));
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		expect(await saveAndReadAi()).toBeNull();
	});
});
