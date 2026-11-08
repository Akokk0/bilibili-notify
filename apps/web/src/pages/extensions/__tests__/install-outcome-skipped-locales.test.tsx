// @vitest-environment jsdom

/**
 * 装完那句话后面的「跳过了哪几份语言文件」(ADR-0037 决策 14):包里长得像语言码、BN 语言表里却没有的
 * 译文文件照装但没写进盘,装的人得知道。传包装与从市场装共用 `ExtensionInstallOutcome`,所以在这一块
 * 钉文字;两条路各有一条接线的用例(`install-slot.test.tsx` / `marketplace-section.test.tsx`)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import zhCN from "../../../i18n/locales/zh-CN.json";
import { ExtensionInstallOutcome } from "../install-outcome";

vi.mock("../../../services/api", () => ({ api: { post: vi.fn() } }));

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

const BASE = {
	id: "bridge",
	name: "机器人框架桥接",
	version: "0.0.1",
	enabled: true,
	restart: { can: true, how: "container" } as const,
};

/** 字典里那句(不带文件名),文件名在它下面逐个列出。 */
const LINE = (zhCN as Record<string, string>)["extension.install.skippedLocales"] as string;

function show(over: Record<string, unknown>) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<ExtensionInstallOutcome done={{ ...BASE, ...over } as never} />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("装完、有语言文件被跳过", () => {
	afterEach(cleanup);

	it("点到每个文件名", () => {
		show({ skippedLocales: ["ko.json", "fr.json"] });
		expect(screen.getByText(LINE)).toBeTruthy();
		expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"ko.json",
			"fr.json",
		]);
		// 「装好了」那句照旧在。
		expect(screen.getByText(/装好了/)).toBeTruthy();
	});

	it("等着换上的那一档也带着", () => {
		show({ staged: true, skippedLocales: ["ko.json"] });
		expect(screen.getByText(LINE)).toBeTruthy();
		expect(screen.getByText("ko.json")).toBeTruthy();
	});

	it("没有这一格 → 没有这句", () => {
		show({});
		expect(screen.queryByText(/没有写进去/)).toBeNull();
	});

	it("空数组 → 没有这句", () => {
		show({ skippedLocales: [] });
		expect(screen.queryByText(/没有写进去/)).toBeNull();
	});
});
