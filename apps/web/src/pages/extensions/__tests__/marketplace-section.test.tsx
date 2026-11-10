// @vitest-environment jsdom
/**
 * 拓展页上的「拓展市场」一节(ADR-0013)。
 *
 * 🔴 每条条目那颗钮画什么、能不能按,全看服务端算好的 `state` —— 前端不再自己比版本、
 * 不再猜「装没装」。官方条目一键装;第三方条目**装之前先确认**(它会在 BN 进程里跑代码,
 * BN 不担保);源拿不到时那句原因原样摆出来。
 */

import type { MarketplaceResponse } from "@bilibili-notify/contract";
import { ErrorNote } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPostMock: vi.fn(),
	apiPatchMock: vi.fn(),
}));

// `ApiError` 用**真的**那个类:失败的话怎么念(`message` + 逐条 `issues`)是它构造时从响应体里读的。
vi.mock("../../../services/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/api")>()),
	api: { get: apiGetMock, post: apiPostMock, patch: apiPatchMock, upload: vi.fn() },
}));

import { i18n } from "../../../i18n";
import { type CardMotion, useCardMotionStore } from "../card-motion";
import { ExtensionInstallOutcome } from "../install-outcome";
import {
	MarketplaceInstallConfirm,
	MarketplaceSection,
	useMarketplaceInstall,
} from "../marketplace-section";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const MARKET: MarketplaceResponse = {
	available: true,
	fetchedAt: "2026-10-27T00:00:00.000Z",
	sources: [
		{ id: "official", name: "BN 官方拓展", official: true, ok: true },
		{
			id: "s1",
			name: "alice",
			official: false,
			url: "https://alice.example/m.json",
			namespace: "alice",
			ok: true,
		},
	],
	extensions: [
		{
			source: "official",
			official: true,
			id: "bridge",
			name: "机器人框架桥接",
			description: "借机器人",
			version: "0.0.2",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			state: "installable",
		},
		{
			source: "official",
			official: true,
			id: "foo",
			name: "Foo",
			description: "",
			version: "0.2.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "0.1.0", source: "official" },
			state: "updatable",
		},
		{
			source: "official",
			official: true,
			id: "bar",
			name: "Bar",
			description: "",
			version: "1.0.0",
			apiVersion: 3,
			prerelease: false,
			size: 1000,
			state: "incompatible",
		},
		{
			source: "official",
			official: true,
			id: "baz",
			name: "Baz",
			description: "",
			version: "1.0.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "0.9.0" },
			state: "installed-elsewhere",
		},
		{
			source: "official",
			official: true,
			id: "qux",
			name: "Qux",
			description: "",
			version: "1.0.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "1.0.0", source: "official" },
			state: "revoked",
		},
		{
			// 装着那版被撤回了,但市场里有能换过去的新版 —— 照 `updatable` 给,红字靠 `installed.revoked`。
			source: "official",
			official: true,
			id: "quux",
			name: "Quux",
			description: "",
			version: "1.1.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "1.0.0", source: "official", revoked: true },
			state: "updatable",
		},
		{
			source: "s1",
			official: false,
			id: "alice.douyin",
			name: "抖音订阅",
			description: "第三方的",
			version: "1.0.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			state: "installable",
		},
	],
};

const GLOBALS = {
	marketplace: { sources: [{ id: "s1", name: "alice", url: "https://alice.example/m.json" }] },
};

/**
 * 与拓展页同构的宿主:`installer` 是**页面**那一份,「装完那句话」、失败那几句与第三方
 * 那道确认框都由页面画,市场那一节只出卡与钮。
 *
 * 🔴 这里不许让 `MarketplaceSection` 自己起一份 installer:那条路生产里不存在
 * (`Extensions.tsx` 永远传),照着它写的测试钉住的是一条没人走的路 —— 真路上画不出
 * 那几句话也照样全绿。
 */
function Host() {
	const installer = useMarketplaceInstall();
	return (
		<>
			{installer.errors.length > 0 ? (
				<ErrorNote size="sm">
					{installer.action === "update" ? "更新不了:" : "装不了:"}
					{installer.errors.join(";")}
				</ErrorNote>
			) : null}
			<ExtensionInstallOutcome done={installer.done} />
			<MarketplaceSection installer={installer} />
			<MarketplaceInstallConfirm installer={installer} />
		</>
	);
}

/** `strict`:照 `main.tsx` 那样套一层 StrictMode(effect 先拆一次再装回来)。 */
function renderSection(
	market: MarketplaceResponse | Promise<MarketplaceResponse> = MARKET,
	{ strict = false } = {},
) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url.startsWith("/api/ext/marketplace")) return market;
		if (url === "/api/settings") return { core: GLOBALS };
		if (url === "/api/system/restart") return { version: "0.10.1", startedAt: "OLD" };
		throw new Error(`没有这一口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	const view = render(
		<QueryClientProvider client={qc}>
			<Host />
		</QueryClientProvider>,
		{ reactStrictMode: strict },
	);
	return { ...view, invalidate };
}

it("language changes reread host explanations and refresh updates the visible language cache", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	const response = (message: string): MarketplaceResponse => ({
		...MARKET,
		sources: [
			{
				id: "official",
				name: "Original source 原文",
				official: true,
				ok: false,
				code: "unavailable",
				message,
			},
		],
		extensions: [],
	});
	renderSection(response("Original English explanation"));
	await screen.findByText(/Original English explanation/);
	const previous = apiGetMock.getMockImplementation();
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext/marketplace?refresh=1") return response("更新した説明");
		if (url === "/api/ext/marketplace") return response("現在の日本語の説明");
		return previous?.(url);
	});
	act(() => i18n.set({ locale: "ja", voice: "plain" }));
	await screen.findByText("配布元「Original source 原文」：現在の日本語の説明");
	expect(screen.queryByText(/Original English explanation/)).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "インデックスを再取得" }));
	await screen.findByText("配布元「Original source 原文」：更新した説明");
	expect(apiGetMock).toHaveBeenCalledWith("/api/ext/marketplace?refresh=1");
	expect(apiPostMock).not.toHaveBeenCalled();
	expect(apiPatchMock).not.toHaveBeenCalled();
});

async function cardOf(name: string): Promise<HTMLElement> {
	const card = (await screen.findByText(name)).closest(".bn-glass");
	if (!card) throw new Error(`「${name}」不在一张卡上`);
	return card as HTMLElement;
}

beforeEach(() => {
	apiGetMock.mockReset();
	apiPostMock.mockReset();
	apiPatchMock.mockReset();
	apiPatchMock.mockResolvedValue({});
	apiPostMock.mockResolvedValue({
		id: "bridge",
		name: "机器人框架桥接",
		version: "0.0.2",
		staged: false,
		restart: { can: true, how: "container" },
	});
});

afterEach(() => {
	cleanup();
});

describe("拓展市场", () => {
	it.each([
		[
			"ja",
			"third-party",
			"ご主人様、これはBN公式ではなく「alice」からの拡張機能ですよ。BNは、その配布元が指定したパッケージをそのまま保存することだけを保証し、動作内容は審査しません。インストールするとBNのプロセス内でコードが動きます。",
			"インストール",
			"キャンセル",
		],
		[
			"ja",
			"no-official",
			"ご主人様、このビルドには信頼する公開鍵が組み込まれていないので、公式配布元がありませんよ。フォークして自分でビルドした場合も同じです。「配布元」でサードパーティの配布元を追加できます。",
			"インストール",
			"キャンセル",
		],
		[
			"zh-TW",
			"third-party",
			"主人，這個拓展來自「alice」，並非 BN 發行喔。BN 只保證安裝到磁碟的是該來源指定的套件，不審查它的行為；安裝後，它會在 BN 程序內執行程式碼。",
			"安裝",
			"取消",
		],
		[
			"zh-TW",
			"no-official",
			"主人，此建置沒有內建信任的公開金鑰，因此沒有官方來源喔；自行 fork 後建置也會如此。可以到「來源」新增第三方來源。",
			"安裝",
			"取消",
		],
	] as const)(
		"%s %s 女仆说明不隐藏来源事实或自动安装",
		async (locale, kind, hint, install, cancel) => {
			renderSection(
				kind === "no-official"
					? { ...MARKET, available: false, sources: [], extensions: [] }
					: MARKET,
			);
			if (kind === "third-party") await cardOf("抖音订阅");
			act(() => i18n.set({ locale, voice: "maid" }));
			if (kind === "third-party") {
				await userEvent.click(
					within(await cardOf("抖音订阅")).getByRole("button", { name: install }),
				);
				expect(await within(screen.getByRole("dialog")).findByText(hint)).toBeTruthy();
				expect(screen.getByRole("dialog").textContent).toContain("抖音订阅");
				await userEvent.click(screen.getByRole("button", { name: cancel }));
				expect(screen.queryByRole("dialog")).toBeNull();
			} else expect(await screen.findByText(hint)).toBeTruthy();
			expect(apiPostMock).not.toHaveBeenCalled();
			expect(apiPatchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"ja",
			"ご主人様、配布元ごとにmarketplace.jsonがあり、そこにインストールできる拡張機能が並んでいますよ。公式配布元は組み込みですが、自分で追加した配布元の内容は、そのアドレスの管理者が決めます。",
			"ご主人様、BNはサードパーティの配布元にある内容を審査しませんよ。インストールすると、その作者のコードがBNのプロセス内で動きます。信頼できる配布元だけを追加してくださいね。",
			"インデックスのURL",
			"閉じる",
		],
		[
			"zh-TW",
			"主人，每個來源都有一份 marketplace.json，列出可安裝的拓展喔。官方來源是內建的，自行新增來源的內容則由該網址的管理者決定。",
			"主人，BN 不審查第三方來源的內容喔；安裝其中的拓展，就等於讓來源作者在 BN 程序內執行程式碼，請只新增可信任的來源。",
			"索引網址",
			"關閉",
		],
	] as const)(
		"%s 女仆来源说明保留信任边界和未提交地址",
		async (locale, intro, risk, label, close) => {
			renderSection();
			await userEvent.click(await screen.findByRole("button", { name: "市场源 · 1" }));
			await screen.findByRole("button", { name: "删掉 alice" });
			const input = screen.getByRole("textbox", { name: "索引地址" }) as HTMLInputElement;
			await userEvent.type(input, " https://pending.example/marketplace.json ");
			act(() => i18n.set({ locale, voice: "maid" }));
			expect(screen.getByText(intro)).toBeTruthy();
			expect(screen.getByText(risk)).toBeTruthy();
			expect(screen.getByRole("textbox", { name: label })).toBe(input);
			expect(input.value).toBe(" https://pending.example/marketplace.json ");
			expect(apiPostMock).not.toHaveBeenCalled();
			expect(apiPatchMock).not.toHaveBeenCalled();
			await userEvent.click(screen.getByRole("button", { name: close }));
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(apiPatchMock).not.toHaveBeenCalled();
		},
	);

	it("source save failures translate without retrying a write and removal submits only the remaining list", async () => {
		let reject!: (error: Error) => void;
		apiPatchMock.mockReturnValueOnce(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "市场源 · 1" }));
		await screen.findByRole("button", { name: "删掉 alice" });
		await userEvent.type(
			screen.getByRole("textbox", { name: "索引地址" }),
			" https://new.example/marketplace.json ",
		);
		for (const [locale, field] of [
			["en", "Index URL"],
			["ja", "インデックスのURL"],
			["zh-TW", "索引網址"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect((screen.getByRole("textbox", { name: field }) as HTMLInputElement).value).toBe(
				" https://new.example/marketplace.json ",
			);
			expect(apiPatchMock).not.toHaveBeenCalled();
		}
		await userEvent.click(screen.getByRole("button", { name: "加入" }));
		expect(apiPatchMock).toHaveBeenCalledExactlyOnceWith("/api/settings", {
			core: {
				marketplace: {
					sources: [
						{ id: "s1", name: "alice", url: "https://alice.example/m.json" },
						{ id: expect.any(String), url: "https://new.example/marketplace.json" },
					],
				},
			},
		});
		for (const [locale, add] of [
			["en", "Add"],
			["ja", "追加"],
			["zh-TW", "加入"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect((screen.getByRole("button", { name: add }) as HTMLButtonElement).disabled).toBe(true);
			expect(apiPatchMock).toHaveBeenCalledOnce();
		}
		await act(async () => reject(new Error("只读磁盘 / EACCES")));
		for (const [locale, failure] of [
			["en", "Could not save: 只读磁盘 / EACCES"],
			["ja", "保存できませんでした：只读磁盘 / EACCES"],
			["zh-TW", "無法儲存：只读磁盘 / EACCES"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(await screen.findByText(failure)).toBeTruthy();
			expect(apiPatchMock).toHaveBeenCalledOnce();
		}
		await userEvent.click(screen.getByRole("button", { name: "移除 alice" }));
		await waitFor(() => expect(apiPatchMock).toHaveBeenCalledTimes(2));
		expect(apiPatchMock).toHaveBeenLastCalledWith("/api/settings", {
			core: { marketplace: { sources: [] } },
		});
	});

	it("source management translates its risk and validation while retaining the typed URL and original source names", async () => {
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "市场源 · 1" }));
		await screen.findByRole("button", { name: "删掉 alice" });
		await userEvent.type(
			screen.getByRole("textbox", { name: "索引地址" }),
			"http://invalid.example/marketplace.json",
		);
		await userEvent.click(screen.getByRole("button", { name: "加进来" }));
		for (const [
			locale,
			title,
			hint,
			verified,
			remove,
			addTitle,
			risk,
			field,
			add,
			invalid,
			close,
		] of [
			[
				"en",
				"Extension marketplace sources",
				"Each source is a marketplace.json listing the extensions it provides. The official source is built in; a custom source is controlled by the owner of its address.",
				"Built in · signature verified",
				"Remove alice",
				"Add a source",
				"BN does not review third-party extensions. Installing them lets their authors run code inside the BN process. Only add sources you trust.",
				"Index URL",
				"Add",
				"The index URL must start with https://",
				"Close",
			],
			[
				"ja",
				"拡張機能マーケットの配布元",
				"各配布元のmarketplace.jsonに、提供する拡張機能が記載されています。公式の配布元は組み込みです。自分で追加する配布元の内容は、そのアドレスの所有者が管理します。",
				"組み込み · 署名検証済み",
				"aliceを削除",
				"配布元を追加",
				"BNはサードパーティの拡張機能を審査していません。インストールすると、作者のコードがBNのプロセス内で実行されます。信頼できる配布元だけを追加してください。",
				"インデックスのURL",
				"追加",
				"インデックスのURLはhttps://で始まる必要があります",
				"閉じる",
			],
			[
				"zh-TW",
				"拓展市場來源",
				"每個來源是一份 marketplace.json，列出其提供的拓展。官方來源為內建；自行加入的來源由該網址的擁有者管理。",
				"內建 · 已驗證簽章",
				"移除 alice",
				"加入來源",
				"BN 不審查第三方拓展；安裝後，作者的程式碼會在 BN 程序內執行。請只加入信任的來源。",
				"索引網址",
				"加入",
				"索引網址必須以 https:// 開頭",
				"關閉",
			],
		] as const) {
			act(() => i18n.set({ locale }));
			const dialog = within(screen.getByRole("dialog"));
			expect(dialog.getByText(title)).toBeTruthy();
			expect(dialog.getByText(hint)).toBeTruthy();
			expect(dialog.getByText(verified)).toBeTruthy();
			expect(dialog.getByText(addTitle)).toBeTruthy();
			expect(dialog.getByText(risk)).toBeTruthy();
			expect(dialog.getByText(invalid)).toBeTruthy();
			expect(dialog.getByText("BN 官方拓展")).toBeTruthy();
			expect(dialog.getByRole("button", { name: remove })).toBeTruthy();
			expect(dialog.getByRole("button", { name: add })).toBeTruthy();
			expect(dialog.getByRole("button", { name: close })).toBeTruthy();
			expect((dialog.getByRole("textbox", { name: field }) as HTMLInputElement).value).toBe(
				"http://invalid.example/marketplace.json",
			);
		}
		await userEvent.clear(screen.getByRole("textbox", { name: "索引網址" }));
		await userEvent.type(
			screen.getByRole("textbox", { name: "索引網址" }),
			"https://alice.example/m.json",
		);
		await userEvent.click(screen.getByRole("button", { name: "加入" }));
		for (const [locale, duplicate] of [
			["en", "This URL has already been added"],
			["ja", "このURLはすでに追加されています"],
			["zh-TW", "此網址已加入"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(duplicate)).toBeTruthy();
		}
		expect(apiPatchMock).not.toHaveBeenCalled();
	});

	it("third-party installation translates its confirmation and pending state without resending", async () => {
		let reject!: (error: Error) => void;
		apiPostMock.mockReturnValue(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		renderSection();
		await cardOf("抖音订阅");
		for (const [locale, install, title, confirm, cancel] of [
			["en", "Install", "Install third-party extension “抖音订阅”?", "Install anyway", "Cancel"],
			[
				"ja",
				"インストール",
				"サードパーティの拡張機能「抖音订阅」をインストールしますか？",
				"インストールを続行",
				"キャンセル",
			],
			["zh-TW", "安裝", "安裝第三方拓展「抖音订阅」？", "仍要安裝", "取消"],
		] as const) {
			act(() => i18n.set({ locale }));
			await userEvent.click(
				within(await cardOf("抖音订阅")).getByRole("button", { name: install }),
			);
			expect(screen.getByText(title)).toBeTruthy();
			expect(screen.getByRole("button", { name: confirm })).toBeTruthy();
			expect(within(screen.getByRole("dialog")).getByText(/alice/)).toBeTruthy();
			expect(apiPostMock).not.toHaveBeenCalled();
			await userEvent.click(screen.getByRole("button", { name: cancel }));
			expect(screen.queryByRole("dialog")).toBeNull();
		}
		await userEvent.click(within(await cardOf("抖音订阅")).getByRole("button", { name: "安裝" }));
		await userEvent.click(screen.getByRole("button", { name: "仍要安裝" }));
		for (const [locale, pending, install] of [
			["en", "Installing…", "Install"],
			["ja", "インストール中…", "インストール"],
			["zh-TW", "正在安裝…", "安裝"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(
				(
					within(await cardOf("抖音订阅")).getByRole("button", {
						name: pending,
					}) as HTMLButtonElement
				).disabled,
			).toBe(true);
			expect(
				(
					within(await cardOf("机器人框架桥接")).getByRole("button", {
						name: install,
					}) as HTMLButtonElement
				).disabled,
			).toBe(true);
			expect(apiPostMock).toHaveBeenCalledExactlyOnceWith("/api/ext/marketplace/install", {
				source: "s1",
				id: "alice.douyin",
			});
		}
		await act(async () => reject(new Error("Original install failure")));
		expect(await screen.findByText(/Original install failure/)).toBeTruthy();
		expect(apiPostMock).toHaveBeenCalledOnce();
	});

	it.each(["read-failed", "source-failed", "no-official", "empty", "all-installed"] as const)(
		"%s market feedback translates without changing the reported source or turning failures into an empty market",
		async (result) => {
			let finish!: (market: MarketplaceResponse) => void;
			let fail!: (error: Error) => void;
			const pending = new Promise<MarketplaceResponse>((resolve, reject) => {
				finish = resolve;
				fail = reject;
			});
			renderSection(pending);
			await screen.findByText("正在拉市场索引…");
			for (const [locale, loading] of [
				["en", "Reading marketplace index…"],
				["ja", "マーケットのインデックスを読み込んでいます…"],
				["zh-TW", "正在讀取市場索引…"],
			] as const) {
				act(() => i18n.set({ locale }));
				expect(screen.getByText(loading)).toBeTruthy();
			}
			await act(async () => {
				if (result === "read-failed") fail(new Error("索引离线 / EHOST"));
				else
					finish({
						...MARKET,
						available: result !== "no-official",
						sources:
							result === "source-failed"
								? [
										{
											id: "official",
											name: "原来源 / Original",
											official: true,
											ok: false,
											code: "unauthorized",
											message: "签名不符 / raw signature",
										},
									]
								: [],
						extensions:
							result === "all-installed"
								? MARKET.extensions.filter((entry) => entry.state === "updatable")
								: [],
					});
			});
			for (const [
				locale,
				title,
				refresh,
				sources,
				readFailed,
				sourceFailed,
				noOfficial,
				empty,
				allInstalled,
			] of [
				[
					"en",
					"Extension marketplace",
					"Refresh index",
					"Marketplace sources",
					"Could not reach the marketplace: 索引离线 / EHOST",
					"Source “原来源 / Original”: 签名不符 / raw signature",
					"This build has no official source because it has no built-in trust key. This is expected for self-built forks. You can add a third-party source in “Sources”.",
					"No extensions are currently available to install.",
					"All marketplace extensions are installed.",
				],
				[
					"ja",
					"拡張機能マーケット",
					"インデックスを再取得",
					"マーケットの配布元",
					"マーケットに接続できません：索引离线 / EHOST",
					"配布元「原来源 / Original」：签名不符 / raw signature",
					"このビルドには信頼する公開鍵が組み込まれていないため、公式の配布元はありません。フォークを自分でビルドした場合はこの状態になります。「配布元」でサードパーティの配布元を追加できます。",
					"現在インストールできる拡張機能はありません。",
					"マーケットの拡張機能はすべてインストール済みです。",
				],
				[
					"zh-TW",
					"拓展市場",
					"重新讀取索引",
					"市場來源",
					"無法連線至市場：索引离线 / EHOST",
					"來源「原来源 / Original」：签名不符 / raw signature",
					"此版本沒有官方來源，因為未內建信任公鑰；自行編譯的分支會是此狀態。可在「來源」加入第三方來源。",
					"市場目前沒有可安裝的拓展。",
					"市場中的拓展已全部安裝。",
				],
			] as const) {
				act(() => i18n.set({ locale }));
				expect(screen.getByText(title)).toBeTruthy();
				expect(screen.getByRole("button", { name: refresh })).toBeTruthy();
				expect(screen.getByRole("button", { name: sources })).toBeTruthy();
				expect(
					await screen.findByText(
						result === "read-failed"
							? readFailed
							: result === "source-failed"
								? sourceFailed
								: result === "no-official"
									? noOfficial
									: result === "empty"
										? empty
										: allInstalled,
					),
				).toBeTruthy();
				if (result === "read-failed" || result === "source-failed")
					expect(screen.queryByText(empty)).toBeNull();
			}
			expect(apiPostMock).not.toHaveBeenCalled();
			expect(apiPatchMock).not.toHaveBeenCalled();
		},
	);

	it("marketplace card translations retain source metadata and never offer installation for incompatible or revoked entries", async () => {
		const base = MARKET.extensions[0];
		if (!base) throw new Error("Missing marketplace fixture");
		renderSection({
			...MARKET,
			extensions: MARKET.extensions
				.map((entry) =>
					entry.id === "bridge"
						? { ...entry, prerelease: true, notes: "发布说明 / Original" }
						: entry,
				)
				.concat([
					{
						...base,
						id: "revision",
						name: "Revision / Original",
						apiVersion: 3,
						apiRevision: 8,
						state: "incompatible",
					},
				]),
		});
		await cardOf("机器人框架桥接");
		for (const [locale, official, from, install, prerelease, incompatible, revision, revoked] of [
			[
				"en",
				"Official",
				"From alice",
				"Install",
				"v0.0.2 · Prerelease",
				"Requires host contract v3, which does not match this BN version",
				"Requires host contract v3 revision 8, which does not match this BN version",
				"This release has been revoked",
			],
			[
				"ja",
				"公式",
				"配布元：alice",
				"インストール",
				"v0.0.2 · プレリリース",
				"ホスト契約v3が必要ですが、このBNのバージョンとは一致しません",
				"ホスト契約v3のリビジョン8が必要ですが、このBNのバージョンとは一致しません",
				"このリリースは撤回されています",
			],
			[
				"zh-TW",
				"官方",
				"來自 alice",
				"安裝",
				"v0.0.2 · 預先發行版",
				"需要宿主契約 v3，與此版 BN 不相容",
				"需要宿主契約 v3 修訂 8，與此版 BN 不相容",
				"此版本已撤回",
			],
		] as const) {
			act(() => i18n.set({ locale }));
			const bridge = await cardOf("机器人框架桥接");
			expect(within(bridge).getByText(official)).toBeTruthy();
			expect(within(bridge).getByText(prerelease)).toBeTruthy();
			expect(within(bridge).getByText("借机器人")).toBeTruthy();
			expect(within(bridge).getByText("发布说明 / Original")).toBeTruthy();
			expect(within(bridge).getByRole("button", { name: install })).toBeTruthy();
			expect(within(await cardOf("抖音订阅")).getByText(from)).toBeTruthy();
			for (const [name, warning] of [
				["Bar", incompatible],
				["Revision / Original", revision],
				["Qux", revoked],
			]) {
				const card = await cardOf(name);
				expect(within(card).getByText(warning)).toBeTruthy();
				expect(within(card).queryByRole("button")).toBeNull();
			}
			expect(screen.queryByText("Foo")).toBeNull();
			expect(screen.queryByText("Baz")).toBeNull();
			expect(screen.queryByText("Quux")).toBeNull();
		}
		expect(apiPostMock).not.toHaveBeenCalled();
	});

	it("没装的各画各的:装 / 契约不匹配 / 已撤回;官方与来源标清", async () => {
		renderSection();
		const bridge = await cardOf("机器人框架桥接");
		expect(within(bridge).getByText("官方")).toBeTruthy();
		expect(within(bridge).getByRole("button", { name: "安装" })).toBeTruthy();

		expect((await cardOf("Bar")).textContent).toContain("要宿主契约 v3，与这版 BN 不匹配");
		expect((await cardOf("Bar")).textContent).not.toContain("先升级");
		expect(within(await cardOf("Bar")).queryByRole("button")).toBeNull();
		expect(within(await cardOf("Qux")).getByText(/已被撤回/)).toBeTruthy();

		const douyin = await cardOf("抖音订阅");
		expect(within(douyin).getByText("来自 alice")).toBeTruthy();
		expect(within(douyin).queryByText("官方")).toBeNull();
	});

	/** 档位对、要的契约小号高(ADR-0019 决策 59):保留请求小号;视图没有宿主范围,卡片不推断升级方向。 */
	it("要更高契约小号的条目:标灰那句带上要几号", async () => {
		renderSection({
			...MARKET,
			extensions: MARKET.extensions.map((e) =>
				e.id === "bar" ? { ...e, apiVersion: 1, apiRevision: 1 } : e,
			),
		});
		expect((await cardOf("Bar")).textContent).toContain("要宿主契约 v1 小号 1，与这版 BN 不匹配");
		expect((await cardOf("Bar")).textContent).not.toContain("先升级");
		expect(within(await cardOf("Bar")).queryByRole("button")).toBeNull();
	});

	it.each([undefined, 0])("缺省或零小号(%s)仍只给要求档位的中性事实", async (apiRevision) => {
		renderSection({
			...MARKET,
			extensions: MARKET.extensions.map((e) => (e.id === "bar" ? { ...e, apiRevision } : e)),
		});
		expect((await cardOf("Bar")).textContent).toContain("要宿主契约 v3，与这版 BN 不匹配");
		expect((await cardOf("Bar")).textContent).not.toContain("小号");
		expect((await cardOf("Bar")).textContent).not.toContain("先升级");
	});

	/**
	 * 🔴 **装了的不在市场里露面**。它已经在上面那一排「已装」的卡里了,同一件东西画两遍
	 * 会让人以为装了两份。更新也没丢:「有新版 vX」+「更新」钮长在已装那张卡上
	 * (`Extensions.tsx`),数据同样来自这份索引。装着那版被撤回、又有新版可换的那条也一样:
	 * 红字跟着更新钮长在已装卡上,这里再画一张就是同一件事说两遍。
	 */
	it.each([
		["已装的", "Foo"],
		["别处装的", "Baz"],
		["装着那版被撤回、有新版可换的", "Quux"],
	])("%s不出现在市场里", async (_label, name) => {
		renderSection();
		// 等市场画完再断言「没有」—— 没等的话空 DOM 也会让它过。
		await cardOf("机器人框架桥接");
		expect(screen.queryByText(name)).toBeNull();
	});

	it("官方条目一键装:POST source+id,装完那句话与传包装的同一段,列表与市场都重取", async () => {
		const { invalidate } = renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "official",
				id: "bridge",
			}),
		);
		expect(await screen.findByText(/装好了/)).toBeTruthy();
		// 拓展表那个键与拓展页、详情页、推送目标页读的是同一个 —— 失效一次,四处都换脸。
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extensions"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["marketplace"] });
	});

	/**
	 * 装成了要演一段**传送**,起点是市场里那张卡 —— 它装完当场从市场消失,不演的话看起来像
	 * 「点了一下什么都没发生」。动画本身由页面照那一格去演(`card-motion-stage.tsx`)。
	 */
	it("装成了 → 放一段传送,从市场那张卡起飞", async () => {
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});
		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);

		await waitFor(() => expect(played).toHaveLength(1));
		unsubscribe();
		expect(played[0]).toMatchObject({ kind: "install", id: "bridge" });
		expect(played[0]?.from).toBeTruthy();
	});

	it("第三方条目装之前先确认 —— 取消就不发,确认才发", async () => {
		renderSection();
		await userEvent.click(within(await cardOf("抖音订阅")).getByRole("button", { name: "安装" }));
		const confirm = await screen.findByRole("dialog");
		expect(within(confirm).getByText(/在 BN 进程里跑代码/)).toBeTruthy();
		await userEvent.click(within(confirm).getByRole("button", { name: "取消" }));
		expect(apiPostMock).not.toHaveBeenCalled();

		await userEvent.click(within(await cardOf("抖音订阅")).getByRole("button", { name: "安装" }));
		await userEvent.click(await screen.findByRole("button", { name: /照样装/ }));
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "s1",
				id: "alice.douyin",
			}),
		);
	});

	/**
	 * 「页面还在」那个标记要经得起 StrictMode(`main.tsx` 就套着):它会把 effect 先拆一次再装
	 * 回来,标记要是只在初值里给真,拆那一下就永远是假 —— 开发版里一段动画都不放,而且不报错。
	 */
	it("StrictMode 下装成了照样放传送", async () => {
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});
		renderSection(MARKET, { strict: true });
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);

		await waitFor(() => expect(played).toHaveLength(1));
		unsubscribe();
		expect(played[0]).toMatchObject({ kind: "install", id: "bridge" });
	});

	/** 起飞位置跟着**这一发**走:第三方那条隔着一道确认框,确认时带着的得是当初点的那张卡。 */
	it("第三方条目确认装成 → 传送从当初点的那张卡起飞", async () => {
		apiPostMock.mockImplementation(async (_url: string, input: { id: string }) => ({
			id: input.id,
			name: "抖音订阅",
			version: "1.0.0",
			staged: false,
			restart: { can: true, how: "container" },
		}));
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});
		renderSection();
		await userEvent.click(within(await cardOf("抖音订阅")).getByRole("button", { name: "安装" }));
		await userEvent.click(await screen.findByRole("button", { name: /照样装/ }));

		await waitFor(() => expect(played).toHaveLength(1));
		unsubscribe();
		expect(played[0]).toMatchObject({ kind: "install", id: "alice.douyin" });
		expect(played[0]?.from).toBeTruthy();
	});

	/**
	 * 🔴 装到一半切走:请求的回调挂在 mutation 上,页面拆了照样会跑。装成那一刻页面已经不在的话,
	 * 放进那一格的传送没人演、也没人收,回到拓展页就从一个早就不在的起点再飞一遍。
	 */
	it("装到一半页面拆了 → 装成了也不往那一格里放动画", async () => {
		let answer: (value: unknown) => void = () => {};
		apiPostMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
		const { unmount, invalidate } = renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});

		unmount();
		answer({
			id: "bridge",
			name: "机器人框架桥接",
			version: "0.0.2",
			staged: false,
			restart: { can: true, how: "container" },
		});

		// 装成那一段回调确实跑过了(拓展表照样作废 —— 列表得是新的),只是不放动画。
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extensions"] }));
		unsubscribe();
		expect(played).toEqual([]);
	});

	it("装成了、有语言文件被跳过 → 装完那句后面点到每个文件名;没跳过就没有这句", async () => {
		apiPostMock.mockResolvedValueOnce({
			id: "bridge",
			name: "机器人框架桥接",
			version: "0.0.2",
			staged: false,
			enabled: true,
			restart: { can: true, how: "container" },
			skippedLocales: ["ko.json", "fr.json"],
		});
		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		await screen.findByText(/没有写进去/);
		expect(screen.getByText("ko.json")).toBeTruthy();
		expect(screen.getByText("fr.json")).toBeTruthy();
	});

	it("装不了 → 服务端那句原样摆出来", async () => {
		const { ApiError } = await import("../../../services/api");
		const message = "下载到的包校验和与索引写的对不上";
		apiPostMock.mockRejectedValueOnce(new ApiError(400, { code: "invalid", message }, message));
		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		expect(await screen.findByText(/校验和/)).toBeTruthy();
	});

	/**
	 * 🔴 装与更新走同一发请求,失败那句话却不是同一句。一律说「更新不了」的话,从市场装
	 * 一个**没装过**的拓展失败了,主人会去找一个根本不存在的旧版本;反过来一律说「装不了」,
	 * 更新失败时又会让人以为已装的那份也没了。
	 */
	/** 「更新不了」那一半搬去了 `Extensions.render.test.tsx` —— 更新钮现在只长在已装卡上。 */
	it("装砸了说「装不了」", async () => {
		const { ApiError } = await import("../../../services/api");
		apiPostMock.mockRejectedValue(
			new ApiError(400, { code: "unavailable", message: "下不动" }, "下不动"),
		);

		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		expect(await screen.findByText(/装不了:下不动/)).toBeTruthy();
	});

	it("源拿不到 → 那句原因原样摆出来;没有官方源的构建说清楚、还能加源", async () => {
		renderSection({
			...MARKET,
			sources: [
				{
					id: "official",
					name: "官方源",
					official: true,
					ok: false,
					code: "unauthorized",
					message: "官方索引的签名验不过 —— 内容被改过,或不是我们签的",
				},
			],
			extensions: [],
		});
		expect(await screen.findByText(/签名验不过/)).toBeTruthy();
		cleanup();
		renderSection({
			available: false,
			fetchedAt: "2026-10-27T00:00:00.000Z",
			sources: [],
			extensions: [],
		});
		expect(await screen.findByText(/没有官方源/)).toBeTruthy();
		expect(screen.getByRole("button", { name: /市场源/ })).toBeTruthy();
	});
});

describe("源", () => {
	it("弹窗列官方(不可删)与第三方(可删,名字是索引报的);加源只填地址、先看见风险提示,存的是整份名单", async () => {
		const { invalidate } = renderSection();
		await userEvent.click(await screen.findByRole("button", { name: /市场源/ }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("BN 官方拓展")).toBeTruthy();
		// 名字从市场那一口(索引里的 name)来,不是用户起的。
		expect(within(dialog).getByText("alice")).toBeTruthy();
		expect(within(dialog).queryByLabelText("源的名字")).toBeNull();
		expect(within(dialog).getByText("https://alice.example/m.json")).toBeTruthy();
		expect(within(dialog).getByText(/不审核/)).toBeTruthy();

		await userEvent.type(
			within(dialog).getByLabelText("索引地址"),
			"https://bob.example/marketplace.json",
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "加进来" }));
		await waitFor(() => expect(apiPatchMock).toHaveBeenCalledOnce());
		const [path, { core: body }] = apiPatchMock.mock.calls[0] as [
			string,
			{ core: { marketplace: { sources: { id: string; name?: string; url: string }[] } } },
		];
		expect(path).toBe("/api/settings");
		expect(body.marketplace.sources.map((s) => s.url)).toEqual([
			"https://alice.example/m.json",
			"https://bob.example/marketplace.json",
		]);
		expect(body.marketplace.sources[1]?.id).toBeTruthy();
		expect(body.marketplace.sources[1]?.name).toBeUndefined();
		// 源换了,市场那一口得重取 —— 不然新加的源要等切页才露面。
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["marketplace"] }));
	});

	/**
	 * 「重新拉索引」是把强制重拉的那一份**写进市场那一节读的同一个键** —— 写进别的键的话,
	 * 请求照样发、服务端照样重拉,画着的还是旧的那份,而且不会有任何报错。
	 */
	it("「重新拉索引」→ 带 refresh=1 重拉,拉回来的那份当场画上", async () => {
		renderSection();
		await screen.findByText("机器人框架桥接");
		const base = MARKET.extensions[0];
		if (!base) throw new Error("夹具里至少得有一条");
		const fresh: MarketplaceResponse = {
			...MARKET,
			extensions: [...MARKET.extensions, { ...base, id: "fresh", name: "新来的" }],
		};
		const served = apiGetMock.getMockImplementation();
		apiGetMock.mockImplementation(async (url: string) =>
			url === "/api/ext/marketplace?refresh=1" ? fresh : served?.(url),
		);

		await userEvent.click(screen.getByRole("button", { name: "重新拉索引" }));

		expect(apiGetMock).toHaveBeenCalledWith("/api/ext/marketplace?refresh=1");
		expect(await screen.findByText("新来的")).toBeTruthy();
	});

	it("http 地址不收;删掉一个源存的是剩下的名单", async () => {
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: /市场源/ }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.type(within(dialog).getByLabelText("索引地址"), "http://bob.example/m.json");
		await userEvent.click(within(dialog).getByRole("button", { name: "加进来" }));
		expect(await within(dialog).findByText(/必须是 https/)).toBeTruthy();
		expect(apiPatchMock).not.toHaveBeenCalled();

		await userEvent.click(within(dialog).getByRole("button", { name: /删掉 alice/ }));
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/settings", {
				core: { marketplace: { sources: [] } },
			}),
		);
	});
});
