// @vitest-environment jsdom
/**
 * 拓展页上的「传一个包上来装」。
 *
 * 🔴 这一块最要紧的是**装完那句话**。三种结局的出路完全不同:热装好了(什么都不用做)、
 * 盖掉了一份已经跑着的(得重启一次,而这台机器给不给按钮还要看)、包不合规(哪里不对)。
 * 说错任何一种,主人要么白等、要么以为新代码已经在跑 —— 后者最难查。
 *
 * ⛔ 那颗重启按钮**只在这里、只在这一刻**出现(ADR-0005 决策 22):面板上没有常驻的
 * 重启入口,重启是刚做完的这件事的后果。
 */

import type { ExtensionInstallResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class ApiError extends Error {
		constructor(
			public readonly status: number,
			public readonly body: unknown,
			message: string,
		) {
			super(message);
		}
	},
}));

import { useRestartStore } from "../../../components/update/restart";
import { ApiError, api } from "../../../services/api";
import { ExtensionInstallSlot } from "../install-slot";

const OK: ExtensionInstallResponse = {
	id: "bridge",
	name: "机器人框架桥接",
	version: "1.1.0",
	needsRestart: false,
	enabled: false,
	restart: { can: true, how: "container" },
};

function renderSlot() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ExtensionInstallSlot />
		</QueryClientProvider>,
	);
}

/** 挑一个文件 —— `AddFileButton` 藏的是一个 sr-only 的 input。 */
async function pick(container: HTMLElement): Promise<void> {
	const input = container.querySelector('input[type="file"]');
	if (!input) throw new Error("没有文件输入框");
	await userEvent.upload(input as HTMLInputElement, new File(["zip"], "bridge.zip"));
}

beforeEach(() => {
	useRestartStore.getState().dismiss();
	vi.mocked(api.get).mockResolvedValue({ version: "0.10.1", startedAt: "OLD" });
	vi.mocked(api.post).mockResolvedValue({ restarting: true, startedAt: "OLD", version: "0.10.1" });
});

afterEach(() => {
	useRestartStore.getState().dismiss();
	cleanup();
	vi.clearAllMocks();
});

describe("传包装拓展", () => {
	it("挑一个 zip → 发上去,包确实交上去了,不提重启", async () => {
		vi.mocked(api.upload).mockResolvedValue(OK);
		const { container } = renderSlot();

		await pick(container);

		await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
		const [path, form] = vi.mocked(api.upload).mock.calls[0] as [string, FormData];
		expect(path).toBe("/api/ext/install");
		expect((form.get("file") as File).name).toBe("bridge.zip");
		expect(await screen.findByText(/装好了/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /重启/ })).toBeNull();
	});

	/**
	 * 🔴 **头一回装进来的拓展开关是关着的**(`enabled` 缺失即关,`isExtensionEnabled`
	 * 只认 `=== true`),而这句话从前一律说「已经在跑」—— 主人转头在卡片上看到
	 * 「已停用」,两句话直接打架。原先那条断言写成 `/已经在跑|装好了/`,两种说法
	 * 都能过,所以它从来不会红。
	 */
	it("头一回装进来(开关还关着)→ 不许说在跑,要指路去拨开关", async () => {
		vi.mocked(api.upload).mockResolvedValue(OK);
		const { container } = renderSlot();

		await pick(container);

		const note = await screen.findByText(/装好了/);
		expect(note.textContent).toMatch(/还关着/);
		expect(note.textContent).toMatch(/拨开/);
		expect(note.textContent).not.toMatch(/已经在跑/);
	});

	/** 重装一份从前开过的(配置里 `enabled` 还留着)→ 它是真在跑,那就照说。 */
	it("装完开关就是开的 → 说它已经在跑", async () => {
		vi.mocked(api.upload).mockResolvedValue({ ...OK, enabled: true });
		const { container } = renderSlot();

		await pick(container);

		const note = await screen.findByText(/装好了/);
		expect(note.textContent).toMatch(/已经在跑/);
		expect(note.textContent).not.toMatch(/还关着/);
	});

	it("盖掉一份已经装着的 → 说得清「得重启一次」,并就地给那一颗按钮", async () => {
		vi.mocked(api.upload).mockResolvedValue({ ...OK, needsRestart: true });
		const { container } = renderSlot();

		await pick(container);

		// 那句话要说清「为什么」——「重启一次」四个字本身不解释任何东西。
		expect(await screen.findByText(/换不掉/)).toBeTruthy();
		await userEvent.click(await screen.findByRole("button", { name: /重启/ }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/system/restart", {}));
		expect(await screen.findByText(/正在重启/)).toBeTruthy();
	});

	/** 这台机器上按了也回不来,那就别给按钮 —— 但**要说为什么**,不然像功能坏了。 */
	it("要重启、可这台机器没人拉 → 不给按钮,把原因写出来", async () => {
		vi.mocked(api.upload).mockResolvedValue({
			...OK,
			needsRestart: true,
			restart: { can: false, reason: "source-run" },
		});
		const { container } = renderSlot();

		await pick(container);

		expect(await screen.findByText(/tsx/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /重启/ })).toBeNull();
	});

	it("包不合规 → 把服务端那几句逐条摆出来,别只说一句失败", async () => {
		vi.mocked(api.upload).mockRejectedValue(
			new ApiError(400, { errors: ["包里少了 index.mjs", "sneaky.mjs:拓展包里只能有…"] }, "400"),
		);
		const { container } = renderSlot();

		await pick(container);

		expect(await screen.findByText(/少了 index.mjs/)).toBeTruthy();
		expect(screen.getByText(/sneaky.mjs/)).toBeTruthy();
	});
});
