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
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { UpdateSection } from "../update-section";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const SETTINGS = { channel: "stable", autoDownload: true, mirrors: [] };

function serve(state: UpdateStatusDTO["state"], over: Partial<UpdateStatusDTO> = {}) {
	const status: UpdateStatusDTO = {
		currentVersion: "0.8.0",
		rollbackTarget: null,
		state,
		...over,
	};
	vi.mocked(api.get).mockImplementation(async (path: string) =>
		path === "/api/update" ? status : { update: SETTINGS },
	);
	return status;
}

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<UpdateSection />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.mocked(api.post).mockResolvedValue({});
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("UpdateSection —— 报错的归因", () => {
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
