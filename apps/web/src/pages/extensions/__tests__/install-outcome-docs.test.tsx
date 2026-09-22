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

/**
 * 盖掉了一份这个进程跑过的(ADR-0012 决策 47):装完那句话换成「新版等着换上」那一块 —— 与
 * 详情页头卡同一块,两个出口并排、代价写明。
 */
describe("装完、新版等着换上", () => {
	afterEach(cleanup);

	it("名字打头,说清装好了但换不上;「重启 BN」与「只重载这个拓展」并排", () => {
		show({ staged: true, enabled: true, docs: undefined });
		expect(screen.getByText("机器人框架桥接")).toBeTruthy();
		expect(screen.getByText(/v0\.0\.1 装好了,但这个进程早就认下了它的另一份代码/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "重启 BN" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
		// 「装好了,已经在跑」那句不能同时出现 —— 跑的还是旧的。
		expect(screen.queryByText(/已经在跑/)).toBeNull();
	});

	/**
	 * 关着装进去的,而这个进程跑过它别的代码:拨开开关也只会停在「新版等着换上」。现在就得说,
	 * 但**不给两颗钮** —— 它关着,「只重载」按下去等于替主人把开关拨开。
	 */
	it("关着、拨开也换不上 → 说清楚,指去它那一页;这里不给按钮", () => {
		show({ staged: true, enabled: false, docs: undefined });
		expect(screen.getByText("机器人框架桥接")).toBeTruthy();
		expect(screen.getByText(/装好了,还关着/)).toBeTruthy();
		expect(screen.getByText(/拨开开关也换不上/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "重启 BN" })).toBeNull();
		expect(screen.queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
	});

	it("没等着换上 → 没有这块,也没有「只重载」", () => {
		show({ staged: false, enabled: true, docs: undefined });
		expect(screen.getByText(/已经在跑/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
		expect(screen.queryByRole("button", { name: "重启 BN" })).toBeNull();
	});
});

describe("装完那句话后面的文档入口", () => {
	afterEach(cleanup);

	it("新装 + 包里有 README → 给一颗「看看说明」,指向它自己那一页", () => {
		show({ staged: false, docs: { readme: true, changelog: false } });
		const link = screen.getByRole("link", { name: /看看说明/ });
		expect(link.getAttribute("href")).toBe("/extensions/bridge");
	});

	/** 更新完最想知道的是「这次改了啥」—— 那是 CHANGELOG,不是 README。 */
	it("新版等着换上 + 包里有 CHANGELOG → 给的是「看看更新了什么」", () => {
		show({ staged: true, enabled: true, docs: { readme: true, changelog: true } });
		expect(screen.getByRole("link", { name: /看看更新了什么/ })).toBeTruthy();
	});

	/**
	 * 🔴 应用内自更新那几秒里,面板可能比服务端新一版 —— 回应里压根没有 `docs` 这一格。
	 * 少一颗钮是小事,把整块「装好了」炸掉是大事。
	 */
	it("服务端老得没有这一格 → 当没有,别炸掉整块提示", () => {
		show({ staged: false, docs: undefined });
		expect(screen.getByText(/装好了/)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	/**
	 * 🔴 **这一条挡的是「读完更新日志回来,这块提示没了」。**
	 *
	 * 那句话整块住在调用方的一个局部 `useState` 里,路由一跳就卸载。详情页头卡上虽然也有
	 * 同一块两条出路(ADR-0012 决策 47),但「刚装的是哪个包、装成了什么」那句就没了 ——
	 * 同一块提示里挂一条会离开本页的链接,等于让人读完回来对着一页没头没尾的提示。所以它
	 * 另开一页。
	 */
	it("新版等着换上时,文档链接另开一页 —— 别把这块提示与它的两颗钮点没了", () => {
		show({ staged: true, enabled: true, docs: { readme: true, changelog: true } });
		expect(screen.getByRole("link", { name: /看看更新了什么/ }).getAttribute("target")).toBe(
			"_blank",
		);
		expect(screen.getByRole("button", { name: "重启 BN" })).toBeTruthy();
	});

	/** 主次不能颠倒:先看见要做的那件事,再看见可以顺便读的那份。 */
	it("新版等着换上时,两颗钮都排在文档链接前面", () => {
		show({ staged: true, enabled: true, docs: { readme: false, changelog: true } });
		const btn = screen.getByRole("button", { name: "只重载这个拓展" });
		const link = screen.getByRole("link", { name: /看看更新了什么/ });
		// DOCUMENT_POSITION_FOLLOWING:link 排在 btn 之后。
		expect(btn.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("包里两份都没有 → 一颗钮都不挂", () => {
		show({ staged: false, docs: { readme: false, changelog: false } });
		expect(screen.queryByRole("link")).toBeNull();
	});
});
