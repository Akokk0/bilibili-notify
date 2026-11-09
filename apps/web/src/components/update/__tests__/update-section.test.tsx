// @vitest-environment jsdom
/**
 * 系统页「应用内更新」一节。
 *
 * 这里的用例几乎全在守**措辞的归因**:同样是升不上去,连不上代理站、我们自己发错
 * 了清单、和有人在中间改包,是三件完全不同的事。全都渲染成红字警告的话,用户会被
 * 训练成忽略红字 —— 而真正该看那一次也就被忽略了。反过来,把验签失败说成「网络
 * 不太好」,则是把一次可能的攻击轻描淡写掉。
 */

import type { UpdateStatusView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
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

function serve(state: UpdateStatusView["state"], over: Partial<UpdateStatusView> = {}) {
	const status: UpdateStatusView = {
		currentVersion: "0.8.0",
		rollbackTarget: null,
		pinnedVersion: null,
		state,
		...over,
	};
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/system/update") return status;
		if (path === "/api/health") return health.next();
		return { core: { update: SETTINGS } };
	});
	// `POST /apply` 的回话:服务端说要换掉的是哪个进程(startedAt)、换到哪(target / mode)。
	vi.mocked(api.post).mockImplementation(async (path: string) => {
		if (path !== "/api/system/update/apply") return {};
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
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.mocked(api.post).mockResolvedValue({});
	vi.mocked(api.patch).mockResolvedValue({});
	health = healthScript("offline");
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("UpdateSection —— 报错的归因", () => {
	describe.each([
		[
			"en",
			"plain",
			[
				"The update signature could not be verified. The downloaded content is not signed by our keys. Nothing was installed. Remove any download proxy and try again; if verification still fails, do not apply this update.",
				"The update manifest could not be read. This is a release packaging problem, not a local settings issue. Try again later.",
				"The update server is unreachable. Choose a download proxy below, or use the release link to download it yourself.",
				"The update manifest is older than one seen previously and was rejected. A proxy may have cached an old copy. Try another proxy or connect directly.",
				"The downloaded package failed its checksum check and was discarded; nothing was left on disk. The download may have been cut short. Try again.",
				"The manifest was retrieved, but the package could not be downloaded. Try another download proxy, or use the release link to download it yourself.",
				"The package passed verification, but could not be written to the data directory. Check available disk space and directory permissions.",
				"This is already the earliest available version. There is no earlier version to roll back to.",
			],
		],
		[
			"ja",
			"plain",
			[
				"更新の署名を検証できませんでした。取得した内容は、こちらの鍵で署名されたものではありません。インストールは行っていません。ダウンロード用プロキシを外して再試行し、それでも検証できない場合は適用しないでください。",
				"更新マニフェストを読み取れません。リリースのパッケージ作成側の問題で、ローカル設定の問題ではありません。しばらくしてから再試行してください。",
				"更新サーバーに接続できません。下でダウンロード用プロキシを選ぶか、リリースページから手動でダウンロードしてください。",
				"以前取得したものより古い更新マニフェストのため、受け付けませんでした。プロキシが古い内容をキャッシュしている可能性があります。別のプロキシまたは直接接続を試してください。",
				"ダウンロードしたパッケージのチェックサムが一致しないため破棄しました。ディスクには何も残していません。途中でダウンロードが切れた可能性があります。再試行してください。",
				"マニフェストは取得できましたが、パッケージをダウンロードできませんでした。別のプロキシを試すか、リリースページから手動でダウンロードしてください。",
				"パッケージの検証には成功しましたが、データディレクトリーへの書き込みに失敗しました。ディスクの空き容量とディレクトリーの書き込み権限を確認してください。",
				"すでに利用可能な最も古いバージョンです。ロールバックできる前のバージョンはありません。",
			],
		],
		[
			"zh-TW",
			"plain",
			[
				"更新套件的簽章驗證失敗，取得的內容並非由我們的金鑰簽署。已停止，沒有安裝任何內容。若有設定下載代理站，請移除後再試；仍然失敗就先不要套用。",
				"無法讀取更新資訊清單。這是發行套件製作時的問題，與本機設定無關，請稍後再試。",
				"無法連上更新伺服器。可在下方選擇下載代理站，或從發行頁面自行下載。",
				"更新資訊清單比先前取得的版本舊，已拒絕使用。可能是代理站快取了舊檔案，請更換代理站或改用直接連線。",
				"下載套件的總和檢查碼不符，已捨棄，磁碟上沒有留下檔案。可能是下載途中遭截斷，請再試一次。",
				"已取得資訊清單，但無法下載套件。請更換下載代理站，或從發行頁面自行下載。",
				"套件已通過驗證，但寫入資料目錄失敗。請檢查磁碟可用空間及目錄寫入權限。",
				"目前已是可用的最舊版本，沒有更早的版本可回復。",
			],
		],
		[
			"ja",
			"maid",
			[
				"ご主人様、更新の署名を検証できませんでした。取得した内容はこちらの鍵で署名されたものではないので、何もインストールせずに止めましたよ。ダウンロード用プロキシを設定していたら外して再試行し、それでも検証できない場合は適用しないでくださいね。",
				"ご主人様、更新マニフェストを読み取れませんでした。こちらのリリース作成時の問題で、ご主人様の設定のせいではありませんよ。しばらくしてから再試行してくださいね。",
				"ご主人様、更新サーバーに接続できませんよ。下でダウンロード用プロキシを選ぶか、リリースページから手動でダウンロードしてくださいね。",
				"ご主人様、以前見たものより古い更新マニフェストだったので、受け付けませんでしたよ。プロキシが古い内容をキャッシュしているかもしれません。別のプロキシか直接接続を試してくださいね。",
				"ご主人様、パッケージのチェックサムが一致しなかったので、破棄しましたよ。ディスクには何も残していません。ダウンロードが途中で切れたかもしれないので、もう一度試してくださいね。",
				"ご主人様、マニフェストは取得できましたが、パッケージをダウンロードできませんでした。別のダウンロード用プロキシを試すか、リリースページから手動でダウンロードしてくださいね。",
				"ご主人様、パッケージの検証は通りましたが、データディレクトリーに書き込めませんでした。ディスクの空き容量と書き込み権限を確認してくださいね。",
				"ご主人様、すでに利用可能な最も古いバージョンなので、戻せる前のバージョンはありませんよ。",
			],
		],
		[
			"zh-TW",
			"maid",
			[
				"主人，更新套件的簽章驗證失敗，取得的內容並非由我們的金鑰簽署，已停止且未安裝任何內容喔。若有設定下載代理站，請移除後再試；仍然失敗就先不要套用。",
				"主人，無法讀取更新資訊清單，這是發行套件製作時的問題，與主人的設定無關喔，請稍後再試。",
				"主人，連不上更新伺服器，可以在下方選擇下載代理站，或從發行頁面自行下載喔。",
				"主人，更新資訊清單比先前取得的版本舊，已拒絕使用喔。可能是代理站快取了舊檔案，請更換代理站或改用直接連線。",
				"主人，下載套件的總和檢查碼不符，已捨棄，磁碟上沒有留下檔案喔。可能是下載途中遭截斷，請再試一次。",
				"主人，已取得資訊清單，但套件沒能下載成功。請更換下載代理站，或從發行頁面自行下載喔。",
				"主人，套件已通過驗證，但寫入資料目錄失敗，請檢查磁碟可用空間及目錄寫入權限喔。",
				"主人，目前已是可用的最舊版本，沒有更早的版本可以回復囉。",
			],
		],
	] as const)("%s %s localized failure causes", (locale, voice, messages) => {
		it.each(
			(
				[
					"untrusted",
					"malformed",
					"unreachable",
					"stale_manifest",
					"checksum_mismatch",
					"download_failed",
					"install_failed",
					"nothing_to_roll_back",
				] as const
			).map((code, index) => ({ code, message: messages[index] })),
		)("$code explains the cause; only signature failures are alerts", async ({ code, message }) => {
			i18n.set({ locale, voice });
			serve({ phase: "error", code, checkedAt: "2026-10-27T00:00:00Z" });
			renderSection();
			await screen.findByText(message);
			if (code === "untrusted") expect(screen.getByRole("alert").textContent).toBe(message);
			else expect(screen.queryByRole("alert")).toBeNull();
			expect(api.post).not.toHaveBeenCalled();
		});
	});

	it("清单带了更新说明 → 显示出来(发版侧写的那句话不该一路带到服务端就没了)", async () => {
		serve({
			phase: "available",
			target: "0.9.0",
			releaseUrl: "https://x",
			notes: "修了直播断流误报。",
			checkedAt: "2026-10-27T00:00:00.000Z",
		});
		renderSection();

		await screen.findByText("修了直播断流误报。");
	});

	it("盘上有钉子 → 说明一句,免得用户纳闷为什么打开面板不再自动查", async () => {
		serve({ phase: "idle" }, { pinnedVersion: "0.8.0" });
		renderSection();

		// 对整句断言，版本号由占位符原样填入。
		await waitFor(() => expect(document.body.textContent).toMatch(/钉在 0\.8\.0/));
	});

	it("验签失败才是红字 —— 那是唯一可能真有人动了手脚的一条", async () => {
		serve({ phase: "error", code: "untrusted", checkedAt: "2026-10-27T00:00:00.000Z" });
		renderSection();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("签名验不过");
	});

	it("连不上不是红字 —— 代理站抽风被渲染成安全警告,只会训练用户忽略红字", async () => {
		serve({
			phase: "error",
			code: "unreachable",
			helpUrl: "https://x/releases",
			checkedAt: "2026-10-27T00:00:00.000Z",
		});
		renderSection();

		expect(await screen.findByText(/连不上更新服务器/)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("清单读不出来时明说是我们的锅,别让用户去查自己的网络", async () => {
		serve({ phase: "error", code: "malformed", checkedAt: "2026-10-27T00:00:00.000Z" });
		renderSection();

		expect(await screen.findByText(/我们发版时出的岔子/)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("校验和对不上时要说清『盘上没留东西』", async () => {
		// 用户最怕的是「装了一半」。这句话省不得 —— 它决定他要不要去手动清理。
		serve({ phase: "error", code: "checksum_mismatch", checkedAt: "2026-10-27T00:00:00.000Z" });
		renderSection();

		expect(await screen.findByText(/盘上没留东西/)).toBeTruthy();
	});

	it("下不动时给得出一条自己去下载的路", async () => {
		serve({
			phase: "error",
			code: "download_failed",
			helpUrl: "https://github.com/o/r/releases/tag/v0.9.0",
			checkedAt: "2026-10-27T00:00:00.000Z",
		});
		renderSection();

		const link = await screen.findByRole("link", { name: "打开发布页" });
		expect(link.getAttribute("href")).toBe("https://github.com/o/r/releases/tag/v0.9.0");
	});
});

describe("UpdateSection —— 按钮该在什么时候出现", () => {
	it.each([
		{
			locale: "ja",
			state: { phase: "disabled", reason: "dev-build" },
			message:
				"ご主人様、いま動いているのは開発版の仮バージョンですよ。公開版より小さい番号なので、アプリ内更新の確認も通知もしません。エラーではありませんよ。",
			check: "更新を確認",
		},
		{
			locale: "ja",
			state: { phase: "disabled", reason: "no-keys" },
			message:
				"ご主人様、このビルドには更新署名の公開鍵が含まれていないので、アプリ内更新は無効ですよ。エラーではありません。自分でビルドした場合は、これまでと同じ方法で更新してくださいね。",
			check: "更新を確認",
		},
		{
			locale: "ja",
			state: {
				phase: "needs-image-pull",
				target: "0.9.0",
				releaseUrl: "https://example.invalid/release",
				checkedAt: "2026-10-27T00:00:00Z",
			},
			message:
				"ご主人様、このバージョンには新しい実行環境も必要ですよ。Nodeやブラウザーはイメージ側にあるため、アプリ内では入れ替えられません。新しいイメージかインストーラーを取得してくださいね。",
			check: "更新を確認",
		},
		{
			locale: "zh-TW",
			state: { phase: "disabled", reason: "dev-build" },
			message:
				"主人，目前執行的是開發版的預留版本號，比所有已發行版本都小，因此不會檢查或提示應用程式內更新，這不是錯誤喔。",
			check: "檢查更新",
		},
		{
			locale: "zh-TW",
			state: { phase: "disabled", reason: "no-keys" },
			message:
				"主人，此建置沒有內建更新簽章的公開金鑰，因此已停用應用程式內更新，這不是錯誤喔。自行建置的版本請沿用原本的方式升級。",
			check: "檢查更新",
		},
		{
			locale: "zh-TW",
			state: {
				phase: "needs-image-pull",
				target: "0.9.0",
				releaseUrl: "https://example.invalid/release",
				checkedAt: "2026-10-27T00:00:00Z",
			},
			message:
				"主人，這個版本需要更新的執行環境；Node 與瀏覽器都來自映像檔，無法在應用程式內更換，請重新拉取映像檔或下載新的安裝程式喔。",
			check: "檢查更新",
		},
	] as const)(
		"$locale $state 女仆禁用和新镜像说明不启动更新",
		async ({ locale, state, message, check }) => {
			i18n.set({ locale, voice: "maid" });
			serve(state);
			renderSection();
			expect(await screen.findByText(message)).toBeTruthy();
			if (state.phase === "disabled")
				expect(screen.getByRole("button", { name: check })).toHaveProperty("disabled", true);
			else expect(document.querySelector('a[href="https://example.invalid/release"]')).toBeTruthy();
			expect(api.post).not.toHaveBeenCalled();
		},
	);

	it("没东西可应用时不给「立即重启」按钮 —— 白白重启一次最像功能坏了", async () => {
		serve({ phase: "up-to-date", checkedAt: "2026-10-27T00:00:00.000Z" });
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
		serve({
			phase: "available",
			target: "0.9.0",
			releaseUrl: "https://x/t",
			checkedAt: "2026-10-27T00:00:00.000Z",
		});
		renderSection();

		expect(await screen.findByRole("button", { name: "下载这一版" })).toBeTruthy();
	});

	it("没有可退的版本 → 回退按钮是灰的,而且写明为什么", async () => {
		// 一颗按了没反应的按钮比一颗灰按钮更让人怀疑整个功能。
		serve({ phase: "up-to-date", checkedAt: "2026-10-27T00:00:00.000Z" });
		renderSection();

		const btn = await screen.findByRole("button", { name: "没有可退的版本" });
		expect(btn).toHaveProperty("disabled", true);
	});

	it("有上一版时按钮写出退到哪一版", async () => {
		serve(
			{ phase: "up-to-date", checkedAt: "2026-10-27T00:00:00.000Z" },
			{ rollbackTarget: "0.7.0" },
		);
		renderSection();

		const btn = await screen.findByRole("button", { name: "退回 0.7.0" });
		expect(btn).toHaveProperty("disabled", false);
	});

	it("功能没启用 → 说明这是关着的、不是出错,检查按钮也别留", async () => {
		serve({ phase: "disabled", reason: "no-keys" });
		renderSection();

		expect(await screen.findByText(/没有内置更新签名的公钥/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "检查更新" })).toHaveProperty("disabled", true);
	});

	it("开发版 → 明说开发版不参与应用内更新,检查按钮同样灰", async () => {
		serve({ phase: "disabled", reason: "dev-build" }, { currentVersion: "0.0.0-dev" });
		renderSection();

		expect(await screen.findByText(/正在跑的是开发版/)).toBeTruthy();
		expect(screen.getByText("开发版,不检查更新")).toBeTruthy();
		expect(screen.queryByText(/没有内置更新签名的公钥/)).toBeNull();
		expect(screen.getByRole("button", { name: "检查更新" })).toHaveProperty("disabled", true);
	});

	it("需要新镜像 → 明说在线换不了,并给那一版的发布页", async () => {
		serve({
			phase: "needs-image-pull",
			target: "0.9.0",
			releaseUrl: "https://x/tag/v0.9.0",
			checkedAt: "2026-10-27T00:00:00.000Z",
		});
		renderSection();

		expect(await screen.findByText(/没法在线换/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "打开发布页" })).toBeTruthy();
	});
});

describe("UpdateSection —— 设置", () => {
	it.each([
		[
			"en",
			"In-app updates · update",
			"Loading update status…",
			"Apply updates here without pulling a new image or downloading an installer.",
			"Open release page",
			"Check for updates",
			"Download this version",
			"Restart and apply",
			"No earlier version",
			"Stable",
			"Prerelease",
			"Update channel",
			"Auto-download",
			"Auto-download new versions",
			"Downloads only.",
			"You decide when to restart and apply the update.",
		],
		[
			"ja",
			"アプリ内更新 · update",
			"更新状況を読み込み中…",
			"新しいイメージやインストーラーを使わずに、ここから更新できます。",
			"リリースページを開く",
			"更新を確認",
			"このバージョンをダウンロード",
			"再起動して適用",
			"戻せるバージョンがありません",
			"安定版",
			"プレリリース版",
			"更新チャンネル",
			"自動ダウンロード",
			"新しいバージョンを自動ダウンロード",
			"ダウンロードのみ行います。",
			"再起動して適用するタイミングは自分で選べます。",
		],
		[
			"zh-TW",
			"應用程式內更新 · update",
			"正在讀取更新狀態…",
			"直接在這裡更新，不必重新拉取映像檔或下載安裝程式。",
			"開啟發行頁面",
			"檢查更新",
			"下載這個版本",
			"重新啟動並套用",
			"沒有可回復的版本",
			"正式版",
			"預先發行版",
			"更新管道",
			"自動下載",
			"自動下載新版本",
			"僅下載更新套件。",
			"重新啟動並套用的時機由你決定。",
		],
	] as const)(
		"%s translates loading, controls and download choices without changing actions",
		async (locale, heading, loading, subtitle, release, check, download, apply, noRollback, stable, prerelease, channel, auto, autoLabel, onlyDownload, manualApply) => {
			i18n.set({ locale, voice: "plain" });
			const initial = serve({
				phase: "available",
				target: "0.9.0",
				releaseUrl: "https://example.invalid/v0.9.0",
				checkedAt: "2026-10-27T00:00:00Z",
				notes: "Original release notes 原文",
			});
			let finish: (value: UpdateStatusView) => void = () => {
				throw new Error("status query not started");
			};
			vi.mocked(api.get).mockImplementation(async (path: string) =>
				path === "/api/system/update"
					? new Promise((resolve) => {
							finish = resolve;
						})
					: { core: { update: SETTINGS } },
			);
			renderSection();
			expect(await screen.findByText(loading)).toBeTruthy();
			expect(screen.getByText(heading)).toBeTruthy();
			finish(initial);
			await screen.findByRole("button", { name: download });
			expect(screen.getByText(subtitle)).toBeTruthy();
			expect(screen.getByText("Original release notes 原文")).toBeTruthy();
			expect(screen.getByRole("link", { name: release }).getAttribute("href")).toBe(
				"https://example.invalid/v0.9.0",
			);
			expect(screen.getByRole("button", { name: noRollback })).toHaveProperty("disabled", true);
			expect(screen.queryByRole("button", { name: apply })).toBeNull();
			expect(screen.getByText(channel)).toBeTruthy();
			expect(screen.getByText(auto)).toBeTruthy();
			expect(document.body.textContent).toContain(onlyDownload);
			expect(document.body.textContent).toContain(manualApply);
			expect(screen.getByRole("button", { name: stable }).getAttribute("aria-pressed")).toBe(
				"true",
			);
			await userEvent.click(screen.getByRole("button", { name: prerelease }));
			await waitFor(() =>
				expect(api.patch).toHaveBeenCalledWith("/api/settings", {
					core: { update: { channel: "prerelease" } },
				}),
			);
			await userEvent.click(screen.getByRole("button", { name: autoLabel }));
			await waitFor(() =>
				expect(api.patch).toHaveBeenCalledWith("/api/settings", {
					core: { update: { autoDownload: false } },
				}),
			);
			vi.mocked(api.post).mockResolvedValueOnce({
				...initial,
				state: { phase: "ready", target: "0.9.0", releaseUrl: "https://example.invalid/v0.9.0" },
			});
			await userEvent.click(screen.getByRole("button", { name: download }));
			await screen.findByRole("button", { name: apply });
			expect(api.post).toHaveBeenCalledWith("/api/system/update/download", {});
			expect(screen.getByRole("button", { name: check })).toBeTruthy();
		},
	);

	it("改设置立刻落盘,不等页面那颗保存按钮", async () => {
		// 服务端检查更新时读的是**已落盘**的设置。跟着页面草稿走的话,用户改完
		// 加速前缀直接点「检查更新」仍会失败 —— 而他刚刚明明改过。
		serve({ phase: "idle" });
		renderSection();
		await screen.findByText("还没查过");

		await userEvent.click(screen.getByRole("button", { name: "预发布" }));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith("/api/settings", {
				core: {
					update: { channel: "prerelease" },
				},
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

	/**
	 * jsdom 也没有 ResizeObserver。这个替身只记下回调,由用例自己决定「页面高度变了」
	 * 什么时候发生 —— 断了(disconnect)之后就不该再响,和真家伙一样。
	 */
	class FakeRO {
		static last: FakeRO | undefined;
		private live = true;
		constructor(private readonly cb: () => void) {
			FakeRO.last = this;
		}
		observe(): void {}
		disconnect(): void {
			this.live = false;
		}
		fire(): void {
			if (this.live) this.cb();
		}
	}

	beforeEach(() => {
		scrollIntoView.mockClear();
		Element.prototype.scrollIntoView = scrollIntoView;
		FakeRO.last = undefined;
		vi.stubGlobal("ResizeObserver", FakeRO);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
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

	it("落点躲开吸顶的顶栏 —— 锚点的 scroll-margin 绑在顶栏实测高上,不是写死的小值", async () => {
		// 顶栏 sticky 在 top-0、有七八十像素高,`block: "start"` 会把这一节的标题塞到它
		// 底下。写死一个小 margin(原先是 scroll-mt-4 = 1rem)挡不住,得跟着 --bn-header-h。
		serve({ phase: "idle" });
		const { container } = renderSection("/system#update");
		await screen.findByText("还没查过");
		const anchor = container.firstElementChild as HTMLElement;
		expect(anchor.getAttribute("style")).toContain("--bn-header-h");
	});

	it("上面几节晚一步撑开、把这一节顶下去 → 跟着重滚一次", async () => {
		// 这一页排在前面的分区各自异步,滚完才撑开。`scrollIntoView` 只在调用那一刻
		// 算一次落点、不跟着元素走,少了这次重滚,人就停在这一节上方 —— 主人报的正是它。
		serve({ phase: "idle" });
		renderSection("/system#update");
		await screen.findByText("还没查过");
		scrollIntoView.mockClear();
		FakeRO.last?.fire();
		expect(scrollIntoView).toHaveBeenCalled();
	});

	it("数据比追焦窗口来得晚 → 到齐时照样滚一次,不能就把人扔在这一节上方", async () => {
		// 追焦有个时间窗(冷启动 1.2s)。可冷启动慢的时候,这一节从骨架换成整张卡恰恰
		// 发生在窗口关掉之后 —— 撑开的正是那一下,而那一下没人再滚。旧写法把「数据到齐」
		// 当重触发条件,慢多久都不漏;时间窗不能把它替掉,只能加在它旁边。
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const status: UpdateStatusView = {
			currentVersion: "0.8.0",
			rollbackTarget: null,
			pinnedVersion: null,
			state: { phase: "idle" },
		};
		vi.mocked(api.get).mockImplementation(async (path: string) => {
			if (path === "/api/system/update") {
				await gate;
				return status;
			}
			if (path === "/api/health") return health.next();
			return { core: { update: SETTINGS } };
		});

		renderSection("/system#update");
		// 骨架期先滚了一次;把窗口熬过去,追焦已经撒手。
		await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
		FakeRO.last?.disconnect();
		scrollIntoView.mockClear();

		release();
		await screen.findByText("还没查过");
		expect(scrollIntoView).toHaveBeenCalled();
	});

	it("人自己动手滚了 → 立刻撒手,不再跟着重滚", async () => {
		serve({ phase: "idle" });
		renderSection("/system#update");
		await screen.findByText("还没查过");
		window.dispatchEvent(new Event("wheel"));
		scrollIntoView.mockClear();
		FakeRO.last?.fire();
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
		expect(api.post).toHaveBeenCalledWith("/api/system/update/apply", {});
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
			expect(vi.mocked(api.get).mock.calls.filter(([p]) => p === "/api/system/update").length).toBe(
				2,
			),
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
			new Error("连接中断，POST /api/system/update/apply 没有拿到服务器响应"),
		);
		renderSection("/system", QUICK);

		await userEvent.click(await screen.findByRole("button", { name: /立即重启/ }));

		const note = await screen.findByText(/没能发出重启指令/);
		expect(note.textContent).toContain("连接中断");
		expect(screen.queryByText(/正在重启/)).toBeNull();
		expect(reload).not.toHaveBeenCalled();
	});
});

describe.each([
	{
		locale: "en",
		voice: "plain",
		pinned:
			"Version 0.8.0 is pinned after a rollback. Opening the dashboard will not automatically check for updates. Choosing “Check for updates” explicitly opts back in; installing a newer version removes the pin.",
		warning:
			"Applying this update restarts the service. Push delivery will pause briefly and live monitoring will reconnect. For containers, enable the restart policy so the process starts again after exiting. On desktop, the launcher restarts the service and the dashboard refreshes automatically.",
		error: "Could not request a restart: Original apply diagnostic 原文",
		waiting: "Restarting to apply 0.9.0",
		hint: "This page will refresh when the service returns. Push delivery pauses briefly and live monitoring reconnects automatically.",
		fallback:
			"Restart complete, but version 0.8.0 is running instead of 0.9.0. The target version probably failed to start and the launcher fell back automatically. Look for the [boot] line in the logs for the reason.",
		timeout:
			"The service has not returned after 1 second. For containers, check the restart policy; without it, the process must be started manually. On desktop, check the launcher log.",
		retry: "Wait again",
		check: "Check for updates",
		apply: "Restart and apply",
	},
	{
		locale: "ja",
		voice: "plain",
		pinned:
			"ロールバックによりバージョン0.8.0に固定されています。ダッシュボードを開いても自動で更新を確認しません。「更新を確認」を選ぶと再び更新を探し、新しいバージョンをインストールすると固定が解除されます。",
		warning:
			"適用するとサービスが再起動します。通知の配信が数秒中断し、ライブ監視は再接続します。コンテナーでは、終了後に再び起動するようrestartポリシーを有効にしてください。デスクトップ版ではランチャーがサービスを起動し直し、ダッシュボードも自動で再読み込みします。",
		error: "再起動を要求できませんでした：Original apply diagnostic 原文",
		waiting: "0.9.0を適用するため再起動中",
		hint: "サービスが戻ると、このページは自動で再読み込みされます。通知の配信は数秒中断し、ライブ監視は自動で再接続します。",
		fallback:
			"再起動は完了しましたが、0.9.0ではなく0.8.0で動作しています。対象バージョンを起動できず、ランチャーが自動で元に戻した可能性があります。理由はログの[boot]行を確認してください。",
		timeout:
			"1秒待ってもサービスが戻りません。コンテナーのrestartポリシーを確認してください。無効の場合は手動で起動する必要があります。デスクトップ版ではランチャーのログを確認してください。",
		retry: "もう少し待つ",
		check: "更新を確認",
		apply: "再起動して適用",
	},
	{
		locale: "zh-TW",
		voice: "plain",
		pinned:
			"先前回復版本後，目前固定在 0.8.0。開啟面板不會自動檢查更新。選擇「檢查更新」會重新尋找新版本，安裝新版後便會解除固定。",
		warning:
			"套用更新會重新啟動服務，推送會中斷幾秒，直播監聽會重新連線。容器部署請啟用 restart 策略，讓程序結束後能再次啟動；桌面版會由啟動器重新啟動服務，面板也會自動重新整理。",
		error: "無法送出重新啟動要求：Original apply diagnostic 原文",
		waiting: "正在重新啟動以套用 0.9.0",
		hint: "服務恢復後，此頁面會自動重新整理。推送會中斷幾秒，直播監聽會自動重新連線。",
		fallback:
			"重新啟動完成，但目前使用的是 0.8.0，而非 0.9.0。可能是目標版本無法啟動，啟動器已自動回復。請查看日誌中以 [boot] 開頭的那一行了解原因。",
		timeout:
			"已等待 1 秒，服務仍未恢復。請確認容器的 restart 策略；若未啟用，必須手動啟動。桌面版請查看啟動器日誌。",
		retry: "再等一下",
		check: "檢查更新",
		apply: "重新啟動並套用",
	},
	{
		locale: "ja",
		voice: "maid",
		pinned:
			"ご主人様、以前のロールバックで0.8.0に固定されていますよ。ダッシュボードを開いても自動で更新を確認しません。「更新を確認」を選ぶと再び新版を探し、インストールすると固定が解除されます。",
		warning:
			"ご主人様、適用するとサービスが再起動しますよ。通知の配信は数秒中断し、ライブ監視は再接続します。コンテナーではrestartポリシーを有効にしてくださいね。無効だと終了後に自動で起動しません。デスクトップ版ではランチャーが起動し直し、画面も自動で再読み込みします。",
		error: "ご主人様、再起動の指示を送れませんでした：Original apply diagnostic 原文",
		hint: "ご主人様、サービスが戻ったら、このページは自動で再読み込みしますよ。通知の配信は数秒中断し、ライブ監視は自動で再接続します。",
		fallback:
			"ご主人様、再起動は完了しましたが、0.9.0ではなく0.8.0で動いていますよ。対象バージョンを起動できず、ランチャーが自動で元に戻した可能性があります。理由はログの[boot]で始まる行を確認してくださいね。",
		timeout:
			"ご主人様、1秒待ってもサービスが戻りませんよ。コンテナーのrestartポリシーを確認してくださいね。無効の場合は手動で起動する必要があります。デスクトップ版ではランチャーのログを確認してください。",
		waiting: "0.9.0を適用するため再起動中",
		retry: "もう少し待つ",
		check: "更新を確認",
		apply: "再起動して適用",
	},
	{
		locale: "zh-TW",
		voice: "maid",
		pinned:
			"主人，先前回復版本後，目前固定在 0.8.0；開啟面板不會自動檢查更新喔。點選「檢查更新」會重新尋找新版本，安裝新版後便會解除固定。",
		warning:
			"主人，套用時會重新啟動服務，推播會中斷幾秒，直播監聽會重新連線喔。容器部署請確認已啟用 restart 策略，否則程序結束後不會自動啟動；桌面版由啟動器重新啟動，面板也會自動重新整理。",
		error: "主人，沒能送出重新啟動指令：Original apply diagnostic 原文",
		hint: "主人，服務恢復後，此頁面會自動重新整理喔。推播會中斷幾秒，直播監聽會自動重新連線。",
		fallback:
			"主人，重新啟動完成，但目前使用的是 0.8.0，而非 0.9.0。可能是目標版本無法啟動，啟動器已自動回復，請查看日誌中以 [boot] 開頭的那一行了解原因喔。",
		timeout:
			"主人，重新啟動後已等待 1 秒，服務仍未恢復。請確認容器的 restart 策略；若未啟用，需要手動啟動。桌面版請查看啟動器日誌喔。",
		waiting: "正在重新啟動以套用 0.9.0",
		retry: "再等一下",
		check: "檢查更新",
		apply: "重新啟動並套用",
	},
] as const)("$locale $voice restart explanations", (expected) => {
	let reload: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		i18n.set({ locale: expected.locale, voice: expected.voice });
		useRestartStore.getState().dismiss();
		sessionStorage.clear();
		reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
	});
	afterEach(() => {
		reload.mockRestore();
		useRestartStore.getState().dismiss();
	});
	const READY = {
		phase: "ready",
		target: "0.9.0",
		releaseUrl: "https://example.invalid/release",
	} as const;
	it("explains the pinned version, restart impact and raw apply failure as complete messages", async () => {
		const status = serve(READY, { pinnedVersion: "0.8.0" });
		renderSection();
		await screen.findByText(expected.pinned);
		expect(screen.getByText(expected.warning)).toBeTruthy();
		vi.mocked(api.post).mockRejectedValueOnce(new Error("Original apply diagnostic 原文"));
		await userEvent.click(screen.getByRole("button", { name: expected.apply }));
		await screen.findByText(expected.error);
		expect(reload).not.toHaveBeenCalled();
		expect(screen.queryByRole("status")).toBeNull();
		expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/system/update/apply", {});
		expect(status.pinnedVersion).toBe("0.8.0");
	});
	it("shows waiting then fallback with the actual and requested versions and original log prefix", async () => {
		serve(READY);
		health.set("offline");
		renderSection("/system", { restartWait: { intervalMs: 10, timeoutMs: 1000 } });
		await userEvent.click(await screen.findByRole("button", { name: expected.apply }));
		await screen.findByText(`${expected.waiting}…`);
		expect(screen.getByText(expected.hint)).toBeTruthy();
		expect(screen.getByRole("button", { name: expected.check })).toHaveProperty("disabled", true);
		health.set({ version: "0.8.0", startedAt: NEW.startedAt });
		await screen.findByText(expected.fallback);
		expect(reload).not.toHaveBeenCalled();
		expect(sessionStorage.getItem("bn.update.restarted")).toBeNull();
	});
	it("reports a one-second timeout and retries through the existing restart flow", async () => {
		serve(READY);
		health.set("offline");
		renderSection("/system", { restartWait: { intervalMs: 10, timeoutMs: 1000 } });
		await userEvent.click(await screen.findByRole("button", { name: expected.apply }));
		await screen.findByText(expected.timeout, {}, { timeout: 3000 });
		expect(reload).not.toHaveBeenCalled();
		health.set(NEW);
		await userEvent.click(screen.getByRole("button", { name: expected.retry }));
		await waitFor(() => expect(reload).toHaveBeenCalledExactlyOnceWith());
	});
});
