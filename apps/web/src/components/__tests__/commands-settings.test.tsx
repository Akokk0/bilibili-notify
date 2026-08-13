// @vitest-environment jsdom
/**
 * 「私聊指令」卡片的别名输入框 —— 本地留**原样文本**是为了打字时光标不跳
 * (打到一半的空格不能被解析吃掉),但这份文本必须随草稿走:
 *
 * 灵动岛点「放弃」后草稿回滚到基线,而这个组件不卸载 —— 本地 text 若还
 * 优先生效,界面就谎称放弃没生效,且下一次击键会把被放弃的文本重新 patch
 * 回草稿(审查抓到的 bug)。判据:原样文本只在「解析后与草稿当前值一致」
 * 时才可信,否则回落草稿的规范形态。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { GlobalConfig } from "../../types/globals";
import { CommandsSettings } from "../commands-settings";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const REGISTRY = {
	enabled: true,
	prefix: "/",
	commands: [
		{
			name: "mute",
			defaultAliases: ["静音"],
			aliases: ["静音"],
			usage: "",
			example: "",
			description: "",
			details: "",
		},
	],
};

function draftWith(aliases: Record<string, string[]>): GlobalConfig {
	return { commands: { enabled: true, prefix: "/", aliases } } as unknown as GlobalConfig;
}

/** 学真实父层的样子:onPatch 同步落进草稿并重渲(System 页就是这么干的)。 */
function mount(aliases: Record<string, string[]>) {
	vi.mocked(api.get).mockResolvedValue(JSON.parse(JSON.stringify(REGISTRY)));
	let current: Record<string, string[]> = { ...aliases };
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const ui = (a: Record<string, string[]>) => (
		<QueryClientProvider client={qc}>
			<CommandsSettings draft={draftWith(a)} onPatch={onPatch} />
		</QueryClientProvider>
	);
	function onPatch(delta: unknown): void {
		const incoming = (delta as { commands?: { aliases?: Record<string, string[] | null> } })
			.commands?.aliases;
		if (incoming) {
			for (const [name, list] of Object.entries(incoming)) {
				if (list === null) delete current[name];
				else current[name] = list;
			}
		}
		view.rerender(ui(current));
	}
	const view = render(ui(current));
	const rerenderWith = (next: Record<string, string[]>) => {
		current = { ...next };
		view.rerender(ui(current));
	};
	return { rerenderWith };
}

const aliasInput = async () => (await screen.findByPlaceholderText(/别名/)) as HTMLInputElement;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("CommandsSettings — 别名输入框与草稿的一致性", () => {
	it("编辑中保留原样文本(打到一半的空格不被吃掉)", async () => {
		mount({});
		const input = await aliasInput();
		fireEvent.change(input, { target: { value: "静音 " } });
		// 解析结果与草稿一致 → 原样文本(带尾空格)可信,光标不跳
		expect((await aliasInput()).value).toBe("静音 ");
	});

	it("草稿被外部回滚(灵动岛「放弃」)→ 输入框回落基线,不显示被放弃的文本", async () => {
		const { rerenderWith } = mount({});
		const input = await aliasInput();
		fireEvent.change(input, { target: { value: "安静 小声" } });
		expect(input.value).toBe("安静 小声");
		// 父层把草稿打回基线(aliases 清空),组件不卸载 —— 本地陈旧文本必须让位
		rerenderWith({});
		expect((await aliasInput()).value).toBe("静音");
	});
});
