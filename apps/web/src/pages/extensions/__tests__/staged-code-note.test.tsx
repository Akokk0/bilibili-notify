// @vitest-environment jsdom

/**
 * 盘上换了代码、这个进程干净地换不上时的那块提示(ADR-0012 决策 47)。装完那句话与详情页头卡
 * 共用它。
 *
 * 值得钉的:
 * - **两个出口并排**:「重启 BN」最干净;「只重载这个拓展」别的都不断,但代价要写在它旁边 ——
 *   主人是照着那几句话选的,少一句就是替他选了。
 * - 这台机器拉不起自己时不给「重启 BN」,换成**为什么**(不然像功能坏了);只重载照给。
 * - 只重载打的是 `/api/ext/<id>/swap`,成了要刷新拓展表与它的状态;失败摆服务端那句原话。
 */

import type { RestartAbility } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({ api: { post: vi.fn() } }));

import { useRestartStore } from "../../../components/update/restart";
import { api } from "../../../services/api";
import { StagedCodeNote, type StagedCodeNoteProps } from "../staged-code-note";

const CAN: RestartAbility = { can: true, how: "container" };

function show(over: Partial<StagedCodeNoteProps> = {}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	render(
		<QueryClientProvider client={qc}>
			<StagedCodeNote
				id="bridge"
				stagedVersion="2.0.0"
				runningVersion="1.0.0"
				swappable
				restart={CAN}
				// 按了重启之后那段等待走得飞快,别让一条用例的等待漏进下一条。
				wait={{ intervalMs: 5, timeoutMs: 20 }}
				{...over}
			/>
		</QueryClientProvider>,
	);
	return { invalidate };
}

beforeEach(() => {
	vi.mocked(api.post).mockReset();
});
afterEach(() => {
	cleanup();
	useRestartStore.getState().dismiss();
});

describe("新版等着换上的那块提示", () => {
	it("旧的照跑:说清盘上与跑着的各是哪一版,并排给两条路,只重载旁边写明代价", () => {
		show();
		expect(screen.getByText(/盘上换成了 v2\.0\.0,这里跑的还是 v1\.0\.0/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "重启 BN" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
		const cost = document.body.textContent ?? "";
		expect(cost).toMatch(/别的推送与直播监听都不断/);
		expect(cost).toMatch(/旧代码占的内存要等下次重启 BN 才还回来/);
		expect(cost).toMatch(/反复换会一直累加/);
		expect(cost).toMatch(/没交给 BN 管的定时器或连接/);
	});

	/** 版本号没变却换了代码(开发时最常见):别印出「盘上换成了 v1,跑的还是 v1」这种自相矛盾的话。 */
	it("版本号一样:说代码换过了", () => {
		show({ stagedVersion: "1.0.0", runningVersion: "1.0.0" });
		expect(screen.getByText(/盘上的代码换过了\(版本号没变\),这里跑的还是原来那份/)).toBeTruthy();
		expect(screen.queryByText(/盘上换成了/)).toBeNull();
	});

	it("没在跑它:说装好了,但这个进程换不上", () => {
		show({ runningVersion: undefined });
		expect(
			screen.getByText(/v2\.0\.0 装好了,但这个进程早就认下了它的另一份代码,换不上/),
		).toBeTruthy();
	});

	/** 按了回不来(开发版 / 裸跑)就不给按钮 —— 但**要说为什么**;只重载与它无关,照给。 */
	it("这台机器拉不起自己:不给「重启 BN」,写出原因;「只重载」照给", () => {
		show({ restart: { can: false, reason: "source-run" } });
		expect(screen.queryByRole("button", { name: "重启 BN" })).toBeNull();
		expect(screen.getByText(/tsx/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
	});

	/**
	 * 🔴 关着的那一行也带着「等着换上」(ADR-0012 决策 47),可「只重载」按下去就是把它跑起来 ——
	 * 那是开关的活。只给「重启 BN」,并说清只重载为什么不在。
	 */
	it("关着的:只给「重启 BN」,不给「只重载」,说清要先拨开", () => {
		show({ runningVersion: undefined, swappable: false });
		expect(screen.getByRole("button", { name: "重启 BN" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
		expect(screen.getByText(/开关关着/)).toBeTruthy();
		// 只重载那几句代价跟着按钮走 —— 没有按钮就不说。
		expect(document.body.textContent).not.toMatch(/别的推送与直播监听都不断/);
	});

	it("按「只重载这个拓展」→ POST 它自己那一口;成了就刷新拓展表、它的状态与 bot 名单", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true });
		const { invalidate } = show();

		await userEvent.click(screen.getByRole("button", { name: "只重载这个拓展" }));

		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/ext/bridge/swap", {}));
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extensions"] }));
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extension-status", "bridge"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extension-bots", "bridge"] });
		expect(api.post).not.toHaveBeenCalledWith("/api/system/restart", {});
	});

	/**
	 * 🔴 **换上了,这块就不再说「换不上」。** 装完那句话里的这一块不随拓展表刷新消失(它挂在装的
	 * 那一刻的回答上),成了之后还摆着「换不上」与两颗钮的话,三句话自相矛盾,再按一下只换来一个
	 * 409。只留一句「重载完了」,起没起来去看卡。
	 */
	it("只重载成了 → 只留「重载完了」:不再说换不上,两颗钮收起", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true });
		show();

		await userEvent.click(screen.getByRole("button", { name: "只重载这个拓展" }));

		expect(await screen.findByText(/重载完了/)).toBeTruthy();
		expect(screen.queryByText(/跑的还是/)).toBeNull();
		expect(screen.queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
		expect(screen.queryByRole("button", { name: "重启 BN" })).toBeNull();
	});

	/** 「换不上」的原因只有服务端知道(盘上那份读不出来 / 已经没什么可换)—— 原话摆出来。 */
	it("换不上 → 服务端那句原话摆出来", async () => {
		vi.mocked(api.post).mockRejectedValue(new Error("bridge 盘上那份现在装不起来,换不上"));
		show();

		await userEvent.click(screen.getByRole("button", { name: "只重载这个拓展" }));

		expect(await screen.findByText(/盘上那份现在装不起来/)).toBeTruthy();
	});

	it("按「重启 BN」→ 发重启指令,不碰只重载那一口", async () => {
		vi.mocked(api.post).mockResolvedValue({
			restarting: true,
			startedAt: "2026-09-22T00:00:00.000Z",
			version: "0.12.0",
		});
		show();

		await userEvent.click(screen.getByRole("button", { name: "重启 BN" }));

		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/system/restart", {}));
		expect(api.post).not.toHaveBeenCalledWith("/api/ext/bridge/swap", {});
	});
});
