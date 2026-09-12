// @vitest-environment jsdom

/**
 * 装完 / 更新完那一刻,说明就该在手边。
 *
 * 这是 AstrBot 那套里唯一真正被用到的一半(它装完自动弹 README、更新完自动弹 CHANGELOG,
 * 读的都是本地文件)。我们不弹模态框 —— 从市场装完紧接着有一段「传送」动画,糊一层遮罩
 * 上去会把收尾打断 —— 改成在那句话后面挂一颗钮,点进详情页。
 *
 * 🔴 **有没有那份文档是服务端拆包时就答好的**(`done.docs`),界面不猜:挂一颗「看看说明」
 * 结果点进去什么都没有,比不挂更糟。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ExtensionInstallOutcome } from "../install-outcome";

vi.mock("../../../services/api", () => ({ api: { post: vi.fn() } }));

const BASE = {
	id: "bridge",
	name: "机器人框架桥接",
	version: "0.0.1",
	enabled: false,
	restart: { can: true, how: "container" } as const,
};

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

describe("装完那句话后面的文档入口", () => {
	afterEach(cleanup);

	it("新装 + 包里有 README → 给一颗「看看说明」,指向它自己那一页", () => {
		show({ needsRestart: false, docs: { readme: true, changelog: false } });
		const link = screen.getByRole("link", { name: /看看说明/ });
		expect(link.getAttribute("href")).toBe("/extensions/bridge");
	});

	/** 更新完最想知道的是「这次改了啥」—— 那是 CHANGELOG,不是 README。 */
	it("盖掉了一份 + 包里有 CHANGELOG → 给的是「看看更新了什么」", () => {
		show({ needsRestart: true, docs: { readme: true, changelog: true } });
		expect(screen.getByRole("link", { name: /看看更新了什么/ })).toBeTruthy();
	});

	/**
	 * 🔴 应用内自更新那几秒里,面板可能比服务端新一版 —— 回应里压根没有 `docs` 这一格。
	 * 少一颗钮是小事,把整块「装好了」炸掉是大事。
	 */
	it("服务端老得没有这一格 → 当没有,别炸掉整块提示", () => {
		show({ needsRestart: false, docs: undefined });
		expect(screen.getByText(/装好了/)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("包里两份都没有 → 一颗钮都不挂", () => {
		show({ needsRestart: false, docs: { readme: false, changelog: false } });
		expect(screen.queryByRole("link")).toBeNull();
	});
});
