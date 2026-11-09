// @vitest-environment jsdom
/**
 * 「装一个拓展」弹窗。
 *
 * 🔴 末尾那段「开发版不用自己动手」说的是 devtools —— 正式版里根本没有 devtools,这段话
 * 对用户就是一句指向不存在的东西的谜语(2026-09-11 主人问「这是只有开发版才有吗」,那时
 * 它对所有人都显示)。`import.meta.env.DEV` 是编译期常量,生产构建里这一枝整个折掉。
 *
 * 🔴「自己放进去」那条印的是服务端报的装载根:1.0 起数据在 `<dataDir>/generations/<序号>/` 里,
 * 照老说法放进 `<dataDir>/extensions/` 的包永远不会被装上,而序号主人自己猜不出来。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class ApiError extends Error {},
}));
vi.mock("../../../utils/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { i18n } from "../../../i18n";
import { api } from "../../../services/api";
import { copyToClipboard } from "../../../utils/clipboard";
import { ExtensionInstallDialog } from "../install-dialog";

const ROOT = "/srv/bn/generations/3/extensions";

function listed(over: Partial<ExtensionsResponse> = {}): ExtensionsResponse {
	return {
		extensions: [],
		restart: { can: false, code: "unsupervised", message: "这个进程退了没人拉" },
		...over,
	};
}

function renderDialog() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ExtensionInstallDialog onClose={() => {}} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	vi.mocked(api.get).mockResolvedValue(listed({ root: ROOT }));
});

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("装一个拓展", () => {
	it.each([
		[
			"ja",
			"ご主人様、拡張機能を使うと、KoishiやAstrBotのボットを送信先にするなど、BNに外部の機能を追加できますよ。本体とは別に、必要なものを選んでインストールしてくださいね。",
			"ご主人様、開発ビルドでは、左下のdevtoolsの「拓展」で、リポジトリーでビルドした dist をシンボリックリンクでインストールできますよ。インストール後すぐに一覧へ表示されます。コード変更後は「重载」を選べば、サーバー全体を再起動せずに読み込み直せますよ。",
		],
		[
			"zh-TW",
			"主人，拓展能替 BN 接上外部功能，例如借用 Koishi 或 AstrBot 中設定好的機器人作為推播目標。本體不附帶拓展，要不要安裝、安裝哪個，都由主人決定喔。",
			"主人，開發版可以使用左下角 devtools 的「拓展」分組，將儲存庫中已建置的 dist 透過符號連結安裝喔，安裝後立即出現在清單中；修改程式碼後還可以選擇「重载」，不必重新啟動整個伺服器喔。",
		],
	] as const)(
		"%s maid install instructions retain reported paths and actual devtool names without installing",
		async (locale, description, dev) => {
			vi.stubEnv("DEV", true);
			i18n.set({ locale: "zh-CN", voice: "plain" });
			renderDialog();
			const path = await screen.findByText(ROOT);
			for (const voice of ["maid", "plain", "maid"] as const) {
				act(() => i18n.set({ locale, voice }));
				if (voice === "maid") {
					expect(screen.getByText(description)).toBeTruthy();
					expect(
						screen.getByText("dist").closest("[data-bn]")?.textContent?.replace(/\s+/g, " ").trim(),
					).toBe(dev);
				}
				expect(screen.getByText(ROOT)).toBe(path);
				expect(screen.getByText("extension.json")).toBeTruthy();
				expect(screen.getByText("index.mjs")).toBeTruthy();
				expect(screen.getByText("「拓展」").tagName).toBe("STRONG");
				expect(screen.getByText("「重载」").tagName).toBe("STRONG");
				expect(api.post).not.toHaveBeenCalled();
				expect(api.upload).not.toHaveBeenCalled();
			}
		},
	);

	it("development guidance translates its explanation while retaining the actual untranslated devtools control names", () => {
		vi.stubEnv("DEV", true);
		i18n.set({ locale: "zh-CN", voice: "plain" });
		renderDialog();
		for (const [locale, group, reload, sentence] of [
			[
				"en",
				"“拓展”",
				"“重载”",
				"In development builds, open the bottom-left devtools “拓展” group to symlink the repository’s built dist into the extension directory; it appears in the list immediately after installation. After changing code, choose “重载” without restarting the whole server.",
			],
			[
				"ja",
				"「拓展」",
				"「重载」",
				"開発ビルドでは、左下のdevtoolsの「拓展」で、リポジトリーでビルドした dist をシンボリックリンクでインストールできます。インストール後すぐに一覧へ表示されます。コード変更後は「重载」を選ぶと、サーバー全体を再起動せずに読み込み直せます。",
			],
			[
				"zh-TW",
				"「拓展」",
				"「重载」",
				"開發版可使用左下角 devtools 的「拓展」分組，將儲存庫中已建置的 dist 透過符號連結安裝，安裝後立即出現在清單中；修改程式碼後還可以選擇「重载」，不需重新啟動整個伺服器。",
			],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(group).tagName).toBe("STRONG");
			expect(screen.getByText(reload).tagName).toBe("STRONG");
			expect(
				screen.getByText("dist").closest("[data-bn]")?.textContent?.replace(/\s+/g, " ").trim(),
			).toBe(sentence);
			expect(api.post).not.toHaveBeenCalled();
			expect(api.upload).not.toHaveBeenCalled();
		}
	});

	it.each(["server-root", "legacy-root"] as const)(
		"%s installation instructions translate without changing the reported directory or installing anything",
		async (kind) => {
			vi.stubEnv("DEV", false);
			i18n.set({ locale: "zh-CN", voice: "plain" });
			const root = "C:\\BN\\generations\\9\\extensions";
			vi.mocked(api.get).mockResolvedValue(listed(kind === "server-root" ? { root } : {}));
			renderDialog();
			await screen.findByText(kind === "server-root" ? root : "<dataDir>/extensions/<拓展 id>/");
			for (const [
				locale,
				title,
				upload,
				available,
				manual,
				server,
				packageLine,
				copy,
				fallbackPath,
				disabled,
				noRestart,
				close,
			] of [
				[
					"en",
					"Install an extension",
					"① Upload a package",
					"Available immediately",
					"② Place a directory manually",
					"For server deployments",
					"Prepare the extension package (a directory containing extension.json and index.mjs)",
					"Copy extension directory",
					"<dataDir>/extensions/<extension id>/",
					"disabled by default",
					"(Uploading with ① needs no restart; it appears immediately after installation.)",
					"Close",
				],
				[
					"ja",
					"拡張機能をインストール",
					"① パッケージをアップロード",
					"すぐに反映",
					"② ディレクトリーを手動で配置",
					"サーバーでの利用向け",
					"拡張機能のパッケージを用意します（extension.json と index.mjsを含むディレクトリー）",
					"拡張機能のディレクトリーをコピー",
					"<dataDir>/extensions/<拡張機能ID>/",
					"初期状態は無効です",
					"（①でアップロードした場合は再起動不要で、インストール後すぐに表示されます）",
					"閉じる",
				],
				[
					"zh-TW",
					"安裝拓展",
					"① 上傳拓展套件",
					"立即生效",
					"② 手動放入目錄",
					"適用於伺服器",
					"準備拓展套件（一個目錄，包含 extension.json 與 index.mjs）",
					"複製拓展目錄",
					"<dataDir>/extensions/<拓展 ID>/",
					"預設為關閉",
					"（透過①上傳不需重新啟動，安裝後立即出現）",
					"關閉",
				],
			] as const) {
				act(() => i18n.set({ locale }));
				for (const text of [title, upload, available, manual, server, disabled, close])
					expect(screen.getByText(text)).toBeTruthy();
				expect(screen.getByText(noRestart, { exact: false })).toBeTruthy();
				expect(
					screen
						.getByText("extension.json")
						.closest("li")
						?.textContent?.replace(/\s+/g, " ")
						.trim(),
				).toBe(packageLine);
				if (kind === "server-root") {
					expect(screen.getByText(root)).toBeTruthy();
					expect(screen.getByRole("button", { name: copy })).toBeTruthy();
				} else {
					expect(screen.getByText(fallbackPath)).toBeTruthy();
					expect(screen.queryByRole("button", { name: copy })).toBeNull();
				}
			}
			if (kind === "server-root") {
				fireEvent.click(screen.getByRole("button", { name: "複製拓展目錄" }));
				expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(root);
			}
			expect(api.upload).not.toHaveBeenCalled();
			expect(api.post).not.toHaveBeenCalled();
		},
	);

	it("开发版:末尾有「开发版不用自己动手」那段", () => {
		vi.stubEnv("DEV", true);
		renderDialog();
		expect(screen.getByText(/开发版不用自己动手/)).toBeTruthy();
	});

	it("正式版:那段整个不渲染 —— 正式版里没有 devtools,别让用户去找左下角", () => {
		vi.stubEnv("DEV", false);
		renderDialog();
		expect(screen.queryByText(/开发版不用自己动手/)).toBeNull();
	});

	it("传包的虚线框是圆角矩形,与 AddCard 同一档(rounded-xl),不是方的", () => {
		vi.stubEnv("DEV", true);
		renderDialog();
		// 弹窗经 portal 挂在 body 上,别从 render 的 container 里找。
		const slot = document.body.querySelector('[data-bn="add-slot"]');
		expect(slot).not.toBeNull();
		expect(slot?.className).toMatch(/\brounded-xl\b/);
	});

	it("「自己放进去」印的是服务端报的装载根,复制下去的就是那一串", async () => {
		renderDialog();

		expect(await screen.findByText(ROOT)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "复制拓展目录" }));
		expect(copyToClipboard).toHaveBeenCalledWith(ROOT);
	});

	it("服务端没报装载根(回退到老版本时)→ 照老说法写 <dataDir>/extensions/,不给复制", async () => {
		vi.mocked(api.get).mockResolvedValue(listed());
		renderDialog();

		expect(await screen.findByText("<dataDir>/extensions/<拓展 id>/")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "复制拓展目录" })).toBeNull();
	});
});
