import type { UpdateStatusView } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { newerVersionOf, noticeBody, phaseLabel, updateRefetchInterval } from "../status";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

function status(state: UpdateStatusView["state"]): UpdateStatusView {
	return { currentVersion: "0.8.0", rollbackTarget: null, pinnedVersion: null, state };
}

describe("newerVersionOf —— 「有一版比现在新」这件事只在一处判", () => {
	it("有新版 / 正在下 / 已就绪 / 要新镜像:都算有新版,给版本号", () => {
		const t = (state: UpdateStatusView["state"]) => newerVersionOf(status(state));
		expect(
			t({
				phase: "available",
				target: "0.9.0",
				releaseUrl: "https://x",
				checkedAt: "2026-10-27T00:00:00.000Z",
			}),
		).toBe("0.9.0");
		expect(t({ phase: "downloading", target: "0.9.0", releaseUrl: "https://x" })).toBe("0.9.0");
		expect(t({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" })).toBe("0.9.0");
		expect(
			t({
				phase: "needs-image-pull",
				target: "0.9.0",
				releaseUrl: "https://x",
				checkedAt: "2026-10-27T00:00:00.000Z",
			}),
		).toBe("0.9.0");
	});

	it("回退目标不是「新版」—— 它比现在旧,别把它当更新去提示", () => {
		expect(newerVersionOf(status({ phase: "rolled-back", target: "0.7.0" }))).toBeNull();
	});

	it("没查过 / 最新 / 关着 / 出错:没有", () => {
		expect(newerVersionOf(status({ phase: "idle" }))).toBeNull();
		expect(
			newerVersionOf(status({ phase: "up-to-date", checkedAt: "2026-10-27T00:00:00.000Z" })),
		).toBeNull();
		expect(newerVersionOf(status({ phase: "disabled", reason: "no-keys" }))).toBeNull();
		expect(
			newerVersionOf(
				status({ phase: "error", code: "unreachable", checkedAt: "2026-10-27T00:00:00.000Z" }),
			),
		).toBeNull();
	});
});

describe("phaseLabel", () => {
	it.each([
		[
			"en",
			[
				"Development build; update checks are disabled",
				"Not enabled in this build",
				"Not checked yet",
				"Up to date",
				"Update available: 0.9.0",
				"Downloading 0.9.0",
				"0.9.0 is ready",
				"0.9.0 requires a new image",
				"Rollback to 0.7.0 is queued",
				"Update failed",
			],
			[
				"Downloading in the background. You will be notified when it is ready.",
				"The download is ready. Restart from System to apply it.",
				"This version requires a new container image or installer; it cannot be applied in the app.",
				"Download it from System. You decide when to restart and apply it.",
			],
		],
		[
			"ja",
			[
				"開発版のため更新を確認しません",
				"このビルドでは無効です",
				"まだ確認していません",
				"最新です",
				"新しいバージョン：0.9.0",
				"0.9.0をダウンロード中",
				"0.9.0の準備ができました",
				"0.9.0には新しいイメージが必要です",
				"0.7.0へのロールバックを予約済み",
				"更新に失敗しました",
			],
			[
				"バックグラウンドでダウンロードしています。完了したら通知します。",
				"ダウンロードが完了しました。「システム」から再起動すると適用されます。",
				"このバージョンには新しいコンテナーイメージまたはインストーラーが必要です。アプリ内では適用できません。",
				"「システム」からダウンロードしてください。再起動して適用するタイミングは自分で選べます。",
			],
		],
		[
			"zh-TW",
			[
				"開發版，不檢查更新",
				"此建置未啟用",
				"尚未檢查",
				"已是最新版本",
				"有新版本 0.9.0",
				"正在下載 0.9.0",
				"0.9.0 已就緒",
				"0.9.0 需要新映像檔",
				"已排程回復至 0.7.0",
				"更新失敗",
			],
			[
				"正在背景下載，完成後會再次通知。",
				"下載已完成，到「系統」重新啟動即可套用。",
				"這個版本需要新的容器映像檔或安裝程式，無法在應用程式內套用。",
				"請到「系統」下載，重新啟動並套用的時機由你決定。",
			],
		],
	] as const)(
		"%s describes update phases without changing versions, release notes or polling",
		(locale, labels, lines) => {
			i18n.set({ locale, voice: "plain" });
			const checkedAt = "2026-10-27T00:00:00.000Z";
			const release = {
				target: "0.9.0",
				releaseUrl: "https://example.invalid/release",
				notes: "Original release notes 原文",
			};
			const states: UpdateStatusView["state"][] = [
				{ phase: "disabled", reason: "dev-build" },
				{ phase: "disabled", reason: "no-keys" },
				{ phase: "idle" },
				{ phase: "up-to-date", checkedAt },
				{ phase: "available", ...release, checkedAt },
				{ phase: "downloading", ...release },
				{ phase: "ready", ...release },
				{ phase: "needs-image-pull", ...release, checkedAt },
				{ phase: "rolled-back", target: "0.7.0" },
				{ phase: "error", code: "unreachable", checkedAt },
			];
			expect(states.map((state) => phaseLabel(status(state)))).toEqual(labels);
			for (const [index, line] of [
				[5, lines[0]],
				[6, lines[1]],
				[7, lines[2]],
				[4, lines[3]],
			] as const) {
				expect(noticeBody(status(states[index]))).toBe(`Original release notes 原文\n${line}`);
			}
			expect(
				noticeBody(status({ phase: "ready", target: "0.9.0", releaseUrl: release.releaseUrl })),
			).toBe(lines[1]);
			expect(newerVersionOf(status(states[6]))).toBe("0.9.0");
			expect(updateRefetchInterval(status(states[5]))).toBe(2000);
			expect(updateRefetchInterval(status(states[6]))).toBe(false);
		},
	);

	it("每个阶段都有一句人话,而且带版本号的阶段把版本号说出来", () => {
		expect(
			phaseLabel(status({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" })),
		).toContain("0.9.0");
		expect(phaseLabel(status({ phase: "idle" }))).toBe("还没查过");
	});

	it("功能关着的两种理由说法不同:没公钥是「未启用」,开发版是「不检查更新」", () => {
		expect(phaseLabel(status({ phase: "disabled", reason: "no-keys" }))).toBe("本构建未启用");
		expect(phaseLabel(status({ phase: "disabled", reason: "dev-build" }))).toBe(
			"开发版,不检查更新",
		);
	});
});

describe("updateRefetchInterval", () => {
	it("正在下载时轮询,别的阶段不轮询,没数据也不轮询", () => {
		// 后台自动下载期间进系统页会卡在「正在下载」:没有轮询、窗口聚焦也不刷新、
		// 也没有 WS 频道推这件事 —— 不按检查更新它就永远不动。
		expect(
			updateRefetchInterval(
				status({ phase: "downloading", target: "0.9.0", releaseUrl: "https://x" }),
			),
		).toBe(2_000);
		expect(
			updateRefetchInterval(status({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" })),
		).toBe(false);
		expect(updateRefetchInterval(status({ phase: "idle" }))).toBe(false);
		expect(updateRefetchInterval(undefined)).toBe(false);
	});
});
