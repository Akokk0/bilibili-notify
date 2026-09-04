// @vitest-environment jsdom
/**
 * 系统页「应用内更新」一节。
 *
 * 这里的用例几乎全在守**措辞的归因**:同样是升不上去,连不上代理站、我们自己发错
 * 了清单、和有人在中间改包,是三件完全不同的事。全都渲染成红字警告的话,用户会被
 * 训练成忽略红字 —— 而真正该看那一次也就被忽略了。反过来,把验签失败说成「网络
 * 不太好」,则是把一次可能的攻击轻描淡写掉。
 */

import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { browser, useRestartStore } from "../restart";
import { UpdateSection, type UpdateSectionProps } from "../update-section";
import { healthScript, NEW, OLD } from "./health-script";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const SETTINGS = { channel: "stable", autoDownload: true, mirrors: [] };

let health = healthScript("offline");

function serve(state: UpdateStatusDTO["state"], over: Partial<UpdateStatusDTO> = {}) {
	const status: UpdateStatusDTO = {
		currentVersion: "0.8.0",
		rollbackTarget: null,
		pinnedVersion: null,
		state,
		...over,
	};
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/update") return status;
		if (path === "/api/health") return health.next();
		return { update: SETTINGS };
	});
	// `POST /apply` 的回话:服务端说要换掉的是哪个进程(startedAt)、换到哪(target / mode)。
	vi.mocked(api.post).mockImplementation(async (path: string) => {
		if (path !== "/api/update/apply") return {};
		return {
			restarting: true,
			startedAt: OLD.startedAt,
			target: "target" in status.state ? status.state.target : status.currentVersion,
			mode: status.state.phase === "rolled-back" ? "rollback" : "update",
		};
	});
	return status;
}

function renderSection(at = "/system", props: UpdateSectionProps = {}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter initialEntries={[at]}>
			<QueryClientProvider client={qc}>
				<UpdateSection {...props} />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	vi.mocked(api.post).mockResolvedValue({});
	vi.mocked(api.patch).mockResolvedValue({});
	health = healthScript("offline");
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("UpdateSection —— 报错的归因", () => {
	it("清单带了更新说明 → 显示出来(发版侧写的那句话不该一路带到服务端就没了)", async () => {
		serve({
			phase: "available",
			target: "0.9.0",
			releaseUrl: "https://x",
			notes: "修了直播断流误报。",
			checkedAt: 1,
		});
		renderSection();

		await screen.findByText("修了直播断流误报。");
	});

	it("盘上有钉子 → 说明一句,免得用户纳闷为什么打开面板不再自动查", async () => {
		serve({ phase: "idle" }, { pinnedVersion: "0.8.0" });
		renderSection();

		// 版本号包在 <strong> 里,是两个文本节点 —— 对整段文本断言。
		await waitFor(() => expect(document.body.textContent).toMatch(/钉在 0\.8\.0/));
	});

	it("验签失败才是红字 —— 那是唯一可能真有人动了手脚的一条", async () => {
		serve({ phase: "error", reason: "untrusted", checkedAt: 1 });
		renderSection();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("签名验不过");
	});

	it("连不上不是红字 —— 代理站抽风被渲染成安全警告,只会训练用户忽略红字", async () => {
		serve({ phase: "error", reason: "unreachable", helpUrl: "https://x/releases", checkedAt: 1 });
		renderSection();

		expect(await screen.findByText(/连不上更新服务器/)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("清单读不出来时明说是我们的锅,别让用户去查自己的网络", async () => {
		serve({ phase: "error", reason: "malformed", checkedAt: 1 });
		renderSection();

		expect(await screen.findByText(/我们发版时出的岔子/)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("校验和对不上时要说清『盘上没留东西』", async () => {
		// 用户最怕的是「装了一半」。这句话省不得 —— 它决定他要不要去手动清理。
		serve({ phase: "error", reason: "checksum-mismatch", checkedAt: 1 });
		renderSection();

		expect(await screen.findByText(/盘上没留东西/)).toBeTruthy();
	});

	it("下不动时给得出一条自己去下载的路", async () => {
		serve({
			phase: "error",
			reason: "download-failed",
			helpUrl: "https://github.com/o/r/releases/tag/v0.9.0",
			checkedAt: 1,
		});
		renderSection();

		const link = await screen.findByRole("link", { name: "打开发布页" });
		expect(link.getAttribute("href")).toBe("https://github.com/o/r/releases/tag/v0.9.0");
	});
});

describe("UpdateSection —— 按钮该在什么时候出现", () => {
	it("没东西可应用时不给「立即重启」按钮 —— 白白重启一次最像功能坏了", async () => {
		serve({ phase: "up-to-date", checkedAt: 1 });
		renderSection();

		await screen.findByText("已是最新");
		expect(screen.queryByRole("button", { name: /立即重启/ })).toBeNull();
	});

	it("装好了才给「立即重启」,并且**先把重启的代价说清楚**", async () => {
		serve({ phase: "ready", target: "0.9.0", releaseUrl: "https://x/t" });
		renderSection();

		expect(await screen.findByRole("button", { name: /立即重启/ })).toBeTruthy();
		// 容器没配 restart 策略的话,这一按下去服务就再也不会起来 —— 而容器内部
		// 读不到自己的重启策略,我们只能在按之前说。
		expect(screen.getByText(/restart/)).toBeTruthy();
		expect(screen.getByText(/推送会断几秒/)).toBeTruthy();
	});

	it("关掉自动下载时才出现「下载这一版」", async () => {
		serve({ phase: "available", target: "0.9.0", releaseUrl: "https://x/t", checkedAt: 1 });
		renderSection();

		expect(await screen.findByRole("button", { name: "下载这一版" })).toBeTruthy();
	});

	it("没有可退的版本 → 回退按钮是灰的,而且写明为什么", async () => {
		// 一颗按了没反应的按钮比一颗灰按钮更让人怀疑整个功能。
		serve({ phase: "up-to-date", checkedAt: 1 });
		renderSection();

		const btn = await screen.findByRole("button", { name: "没有可退的版本" });
		expect(btn).toHaveProperty("disabled", true);
	});

	it("有上一版时按钮写出退到哪一版", async () => {
		serve({ phase: "up-to-date", checkedAt: 1 }, { rollbackTarget: "0.7.0" });
		renderSection();

		const btn = await screen.findByRole("button", { name: "退回 0.7.0" });
		expect(btn).toHaveProperty("disabled", false);
	});

	it("功能没启用 → 说明这是关着的、不是出错,检查按钮也别留", async () => {
		serve({ phase: "disabled" });
		renderSection();

		expect(await screen.findByText(/没有内置更新签名的公钥/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "检查更新" })).toHaveProperty("disabled", true);
	});

	it("需要新镜像 → 明说在线换不了,并给那一版的发布页", async () => {
		serve({
			phase: "needs-image-pull",
			target: "0.9.0",
			releaseUrl: "https://x/tag/v0.9.0",
			checkedAt: 1,
		});
		renderSection();

		expect(await screen.findByText(/没法在线换/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "打开发布页" })).toBeTruthy();
	});
});

describe("UpdateSection —— 设置", () => {
	it("改设置立刻落盘,不等页面那颗保存按钮", async () => {
		// 服务端检查更新时读的是**已落盘**的设置。跟着页面草稿走的话,用户改完
		// 加速前缀直接点「检查更新」仍会失败 —— 而他刚刚明明改过。
		serve({ phase: "idle" });
		renderSection();
		await screen.findByText("还没查过");

		await userEvent.click(screen.getByRole("button", { name: "预发布" }));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith("/api/globals", {
				update: { channel: "prerelease" },
			}),
		);
	});

	it("动作按钮把返回的新状态直接接上,不用再查一次", async () => {
		serve({ phase: "idle" });
		vi.mocked(api.post).mockResolvedValue({
			currentVersion: "0.8.0",
			rollbackTarget: null,
			pinnedVersion: null,
			state: { phase: "ready", target: "0.9.0", releaseUrl: "https://x/t" },
		});
		renderSection();
		await screen.findByText("还没查过");

		await userEvent.click(screen.getByRole("button", { name: "检查更新" }));

		expect(await screen.findByText("0.9.0 已就绪")).toBeTruthy();
	});
});

describe("UpdateSection —— 头部与其他 section 同款", () => {
	it("版本号只套 GlassBox 自带的那一层淡色胶囊,不再自己包一层实心 Pill", async () => {
		// 皮肤 / 备份两节的 badge 传的是纯字符串,由 GlassBox 统一套成淡色小胶囊。
		// 这里曾多包了一层默认粉色实心的 Pill,变成胶囊套胶囊,和邻居长得不一样。
		serve({ phase: "idle" });
		renderSection();
		const version = await screen.findByText("0.8.0");
		const own = version.closest("[data-bn='badge']");
		expect(own).not.toBeNull();
		expect(own?.parentElement?.closest("[data-bn='badge']")).toBeNull();
	});
});

describe("UpdateSection —— 从别处「去更新」跳过来", () => {
	// jsdom 没有 scrollIntoView;这里只关心「有没有滚」。
	const scrollIntoView = vi.fn();
	beforeEach(() => {
		scrollIntoView.mockClear();
		Element.prototype.scrollIntoView = scrollIntoView;
	});

	it("带着 #update 进来 → 这一节滚进视口", async () => {
		serve({ phase: "idle" });
		renderSection("/system#update");
		await screen.findByText("还没查过");
		expect(scrollIntoView).toHaveBeenCalled();
	});

	it("正常打开系统页 → 不乱滚", async () => {
		serve({ phase: "idle" });
		renderSection("/system");
		await screen.findByText("还没查过");
		expect(scrollIntoView).not.toHaveBeenCalled();
	});
});

describe("UpdateSection —— 按下重启之后", () => {
	const READY = { phase: "ready", target: "0.9.0", releaseUrl: "https://x" } as const;
	// 测试把等待压到最短:探一次就睡 0ms,几十毫秒就算超时。
	const QUICK = { restartWait: { intervalMs: 0, timeoutMs: 40 } };

	let reload: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
		sessionStorage.clear();
		// 进度住在模块级 store 里,用例之间得手动归零。
		useRestartStore.getState().dismiss();
	});
	afterEach(() => {
		reload.mockRestore();
	});

	const button = (name: RegExp | string) =>
		screen.getByRole("button", { name }) as HTMLButtonElement;

	it("换成了 → 等到新进程再整页刷新,并留下记号;旧进程排空期间的回答不算", async () => {
		serve(READY);
		// 断了 → 旧进程还在排空(startedAt 没变)→ 新进程起来了。要换掉的是哪个进程由
		// /apply 的回话说,按下之前不再单独探一次。
		health.set("offline", OLD, NEW);
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
		expect(api.post).toHaveBeenCalledWith("/api/update/apply", {});
		expect(vi.mocked(api.get).mock.calls.filter(([p]) => p === "/api/health")).toHaveLength(3);
		expect(JSON.parse(sessionStorage.getItem("bn.update.restarted") ?? "null")).toEqual({
			target: "0.9.0",
			mode: "update",
		});
		// 刷新之前这一节一直是「正在重启」,动作按钮全灰 —— 别让人再按一次。
		expect(screen.getByText(/正在重启/)).toBeTruthy();
		expect(button(/立即重启/).disabled).toBe(true);
		expect(button("检查更新").disabled).toBe(true);
	});

	// 探针得带死线:一条挂着不回的连接不该拖住整个等待(1aee5390 那次「按了没反应」的教训)。
	it("等待期间每一次 /api/health 探针都带死线", async () => {
		serve(READY);
		health.set("offline", NEW);
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
		const probes = vi.mocked(api.get).mock.calls.filter(([path]) => path === "/api/health");
		expect(probes.length).toBeGreaterThanOrEqual(2);
		for (const [, opts] of probes) {
			expect((opts as { timeoutMs?: number } | undefined)?.timeoutMs).toBeGreaterThan(0);
		}
	});

	it("回退也走同一条路,记号写的是 rollback", async () => {
		serve({ phase: "rolled-back", target: "0.7.0" }, { rollbackTarget: "0.7.0" });
		health.set("offline", { version: "0.7.0", startedAt: NEW.startedAt });
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
		expect(JSON.parse(sessionStorage.getItem("bn.update.restarted") ?? "null")).toEqual({
			target: "0.7.0",
			mode: "rollback",
		});
	});

	it("起来了但版本没变 → 明说是回落了,不刷新,并把状态重新拉一次", async () => {
		serve(READY);
		health.set("offline", { version: "0.8.0", startedAt: NEW.startedAt });
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		const note = await screen.findByText(/跑起来的是/);
		expect(note.textContent).toContain("0.8.0");
		expect(note.textContent).toContain("0.9.0");
		expect(reload).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(vi.mocked(api.get).mock.calls.filter(([p]) => p === "/api/update").length).toBe(2),
		);
		expect(sessionStorage.getItem("bn.update.restarted")).toBeNull();
	});

	it("一直没回来 → 说明多半是没有 restart 策略,给「再等等」;再等到了照样刷新", async () => {
		serve(READY);
		health.set("offline");
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		const note = await screen.findByText(/还没等到服务回来/);
		expect(note.textContent).toContain("restart");
		expect(reload).not.toHaveBeenCalled();

		health.set(NEW);
		await userEvent.click(screen.getByRole("button", { name: "再等等" }));
		await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
	});

	it("等的时候离开系统页 → 等待照样进行,换成了照样刷新(离开那一页不等于没按过)", async () => {
		serve(READY);
		health.set("offline", NEW);
		const view = renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));
		await screen.findByText(/正在重启/);
		view.unmount();

		await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
	});

	it("重启指令本身没发出去 → 把原因摆出来,不进入等待", async () => {
		serve(READY);
		vi.mocked(api.post).mockRejectedValue(
			new Error("连接中断，POST /api/update/apply 没有拿到服务器响应"),
		);
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		const note = await screen.findByText(/没能发出重启指令/);
		expect(note.textContent).toContain("连接中断");
		expect(screen.queryByText(/正在重启/)).toBeNull();
		expect(reload).not.toHaveBeenCalled();
	});
});
