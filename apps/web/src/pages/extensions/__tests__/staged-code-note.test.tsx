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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({ api: { post: vi.fn() } }));

import { useRestartStore } from "../../../components/update/restart";
import { i18n } from "../../../i18n";
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
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.mocked(api.post).mockReset();
});
afterEach(() => {
	cleanup();
	useRestartStore.getState().dismiss();
});

describe("新版等着换上的那块提示", () => {
	it.each([
		[
			"ja",
			"ご主人様、再読み込みが完了しましたよ。起動したかどうかは、拡張機能のカードで確認してくださいね。",
		],
		["zh-TW", "主人，已重新載入囉，是否啟動請以拓展卡片的狀態為準。"],
	] as const)("%s 女仆重载结果保留运行状态待核对且不重发", async (locale, done) => {
		vi.mocked(api.post).mockResolvedValueOnce({ ok: true });
		show();
		await userEvent.click(screen.getByRole("button", { name: "只重载这个拓展" }));
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "只重载这个拓展" })).toBeNull(),
		);
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(done)).toBeTruthy();
		expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/ext/bridge/swap", {});
		expect(screen.queryByRole("button")).toBeNull();
	});

	it.each(["swap", "restart"] as const)(
		"%s results translate without repeating an action or enabling recovery while waiting",
		async (action) => {
			vi.mocked(api.post).mockRejectedValueOnce(new Error("原诊断 / EACCES"));
			show();
			await userEvent.click(
				screen.getByRole("button", { name: action === "swap" ? "只重载这个拓展" : "重启 BN" }),
			);
			await screen.findByText(/原诊断 \/ EACCES/);
			for (const [locale, failure] of [
				[
					"en",
					action === "swap"
						? "Could not load the new code: 原诊断 / EACCES"
						: "Could not send the restart request: 原诊断 / EACCES",
				],
				[
					"ja",
					action === "swap"
						? "新しいコードを読み込めませんでした：原诊断 / EACCES"
						: "再起動を要求できませんでした：原诊断 / EACCES",
				],
				[
					"zh-TW",
					action === "swap"
						? "無法載入新程式碼：原诊断 / EACCES"
						: "無法送出重新啟動要求：原诊断 / EACCES",
				],
			] as const) {
				act(() => i18n.set({ locale }));
				expect(screen.getByText(failure)).toBeTruthy();
				expect(api.post).toHaveBeenCalledExactlyOnceWith(
					action === "swap" ? "/api/ext/bridge/swap" : "/api/system/restart",
					{},
				);
			}
			if (action === "swap") {
				vi.mocked(api.post).mockResolvedValueOnce({ ok: true });
				await userEvent.click(screen.getByRole("button", { name: "只重新載入此拓展" }));
				for (const [locale, done] of [
					["en", "Reload complete. Check the extension card to see whether it is running."],
					[
						"ja",
						"再読み込みが完了しました。起動したかどうかは、拡張機能のカードで確認してください。",
					],
					["zh-TW", "已重新載入，是否啟動請以拓展卡片的狀態為準。"],
				] as const) {
					act(() => i18n.set({ locale }));
					expect(await screen.findByText(done)).toBeTruthy();
					expect(screen.queryByRole("button")).toBeNull();
					expect(api.post).toHaveBeenCalledTimes(2);
				}
			} else {
				vi.mocked(api.post).mockResolvedValueOnce({
					restarting: true,
					startedAt: "OLD",
					version: "test",
				});
				vi.useFakeTimers();
				try {
					await act(async () =>
						fireEvent.click(screen.getByRole("button", { name: "重新啟動 BN" })),
					);
					for (const [locale, pending, hint, restart, reload] of [
						[
							"en",
							"Restarting…",
							"This page refreshes automatically when the service returns.",
							"Restart BN",
							"Reload only this extension",
						],
						[
							"ja",
							"再起動しています…",
							"サービスが戻ると、このページを自動的に更新します。",
							"BNを再起動",
							"この拡張機能だけ再読み込み",
						],
						[
							"zh-TW",
							"正在重新啟動…",
							"服務恢復後，此頁面會自動重新整理。",
							"重新啟動 BN",
							"只重新載入此拓展",
						],
					] as const) {
						act(() => i18n.set({ locale }));
						expect(screen.getByText(pending)).toBeTruthy();
						expect(screen.getByText(hint)).toBeTruthy();
						expect(
							(screen.getByRole("button", { name: restart }) as HTMLButtonElement).disabled,
						).toBe(true);
						expect(
							(screen.getByRole("button", { name: reload }) as HTMLButtonElement).disabled,
						).toBe(true);
						expect(api.post).toHaveBeenCalledTimes(2);
					}
				} finally {
					cleanup();
					useRestartStore.getState().dismiss();
					vi.clearAllTimers();
					vi.useRealTimers();
				}
			}
		},
	);

	it.each(["different", "same", "unknown", "disabled", "unsupervised"] as const)(
		"%s staged code translations preserve the available recovery choices and their costs",
		(kind) => {
			show({
				runningVersion:
					kind === "same"
						? "2.0.0"
						: kind === "unknown" || kind === "disabled"
							? undefined
							: "1.0.0",
				swappable: kind !== "disabled",
				restart:
					kind === "unsupervised"
						? { can: false, code: "source_run", message: "原宿主诊断 / no supervisor" }
						: CAN,
			});
			for (const [
				locale,
				voice,
				different,
				same,
				unknown,
				restart,
				restartCost,
				reload,
				reloadCost,
				disabled,
			] of [
				[
					"en",
					"plain",
					"Code on disk is v2.0.0; v1.0.0 is still running.",
					"Code on disk has changed (same version); the original code is still running.",
					"v2.0.0 is installed, but this process has already loaded another copy of the extension and cannot replace it.",
					"Restart BN",
					"The cleanest way to switch: all push delivery and live monitoring are interrupted for a few seconds.",
					"Reload only this extension",
					"Other push delivery and live monitoring continue. Memory used by the old code is retained until BN restarts (a few MB per reload, accumulating with repeated reloads). Timers or connections the extension does not register with BN may keep running in the background.",
					"Reload is unavailable while the switch is off. Loading the code would start the extension; enable it first.",
				],
				[
					"ja",
					"plain",
					"ディスク上はv2.0.0ですが、稼働中なのはv1.0.0です。",
					"ディスク上のコードは変更されていますが（バージョン番号は同じ）、元のコードが稼働しています。",
					"v2.0.0はインストール済みですが、このプロセスではすでに別のコードを読み込んでいるため、置き換えられません。",
					"BNを再起動",
					"最も確実な切り替え方法です。すべての通知送信とライブ監視が数秒間中断します。",
					"この拡張機能だけ再読み込み",
					"ほかの通知送信とライブ監視は継続します。旧コードのメモリーはBNを再起動するまで解放されません（1回につき数MB程度で、繰り返すと累積します）。拡張機能がBNに登録していないタイマーや接続は、バックグラウンドで動き続ける可能性があります。",
					"スイッチがオフの間は再読み込みできません。読み込むと拡張機能が起動するため、先に有効にしてください。",
				],
				[
					"zh-TW",
					"plain",
					"磁碟上已換成 v2.0.0，目前仍執行 v1.0.0。",
					"磁碟上的程式碼已變更（版本號未變），目前仍執行原本的程式碼。",
					"v2.0.0 已安裝，但此程序先前已載入另一份程式碼，無法直接替換。",
					"重新啟動 BN",
					"最乾淨的切換方式：所有推播與直播監聽會中斷幾秒。",
					"只重新載入此拓展",
					"其他推播與直播監聽不會中斷。舊程式碼占用的記憶體要等 BN 下次重新啟動才會釋放（每次約數 MB，反覆載入會持續累積）；拓展未交由 BN 管理的計時器或連線，可能仍在背景執行。",
					"開關關閉時無法只重新載入，因為載入後就會啟動拓展；請先啟用拓展。",
				],
				[
					"ja",
					"maid",
					"ご主人様、ディスク上はv2.0.0ですが、いま動いているのはv1.0.0ですよ。",
					"ご主人様、ディスク上のコードは変わりましたが、バージョン番号は同じですよ。ここでは元のコードが動いています。",
					"ご主人様、v2.0.0はインストール済みですが、このプロセスには別のコードが読み込まれているので、そのままでは置き換えられませんよ。",
					"BNを再起動",
					"ご主人様、最も確実な切り替え方法ですよ。すべての通知送信とライブ監視が数秒間中断します。",
					"この拡張機能だけ再読み込み",
					"ご主人様、ほかの通知送信とライブ監視は続きますよ。ただし旧コードのメモリーはBNを再起動するまで解放されません。1回につき数MBほどで、繰り返すと累積します。拡張機能がBNに登録していないタイマーや接続は、バックグラウンドで動き続ける可能性もあります。",
					"ご主人様、スイッチがオフの間は再読み込みできませんよ。読み込むと拡張機能が起動するので、先に有効にしてくださいね。",
				],
				[
					"zh-TW",
					"maid",
					"主人，磁碟上已換成 v2.0.0，目前仍執行 v1.0.0 喔。",
					"主人，磁碟上的程式碼已變更，版本號沒有改，目前仍執行原本的程式碼喔。",
					"主人，v2.0.0 已安裝，但此程序先前已載入另一份程式碼，無法直接替換喔。",
					"重新啟動 BN",
					"主人，這是最乾淨的切換方式喔，所有推播與直播監聽會中斷幾秒。",
					"只重新載入此拓展",
					"主人，其他推播與直播監聽不會中斷喔。但舊程式碼占用的記憶體要等 BN 下次重新啟動才會釋放，每次約數 MB，反覆載入會持續累積；拓展未交由 BN 管理的計時器或連線，可能仍在背景執行。",
					"主人，開關關閉時無法只重新載入喔，因為載入後就會啟動拓展；請先啟用拓展，再選擇重新載入。",
				],
			] as const) {
				act(() => i18n.set({ locale, voice }));
				expect(
					screen.getByText(
						kind === "same"
							? same
							: kind === "unknown" || kind === "disabled"
								? unknown
								: different,
					),
				).toBeTruthy();
				if (kind === "unsupervised") {
					expect(screen.queryByRole("button", { name: restart })).toBeNull();
					expect(screen.getByText("原宿主诊断 / no supervisor")).toBeTruthy();
				} else {
					expect(screen.getByRole("button", { name: restart })).toBeTruthy();
					expect(screen.getByText(restartCost)).toBeTruthy();
				}
				if (kind === "disabled") {
					expect(screen.queryByRole("button", { name: reload })).toBeNull();
					expect(screen.getByText(disabled)).toBeTruthy();
				} else {
					expect(screen.getByRole("button", { name: reload })).toBeTruthy();
					expect(screen.getByText(reloadCost)).toBeTruthy();
				}
				expect(api.post).not.toHaveBeenCalled();
			}
		},
	);

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
		show({ restart: { can: false, code: "source_run", message: "服务端给的那句为什么" } });
		expect(screen.queryByRole("button", { name: "重启 BN" })).toBeNull();
		// 那句话是服务端按当前语言给的,面板原样显示、不另抄一份。
		expect(screen.getByText("服务端给的那句为什么")).toBeTruthy();
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
