// @vitest-environment jsdom
/**
 * 周报「试一次」的结局文案 —— 停用而跳过的目标要单独说一句,不能混进「失败」,也不能
 * 悄悄从总数里少掉一个让人去查网络。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

import { OutcomeLine } from "../RoastRunNowBox";

const NAMES: Record<string, string> = { t1: "群 A", t2: "群 B", t3: "群 C" };
const targetName = (id: string) => NAMES[id] ?? id;

afterEach(cleanup);

describe("OutcomeLine", () => {
	it("全部成功、没有跳过 → 只说发到了几个", () => {
		render(
			<OutcomeLine
				outcome={{ kind: "sent", mode: "image", sent: 2, skipped: [], failed: [] }}
				targetName={targetName}
			/>,
		);
		expect(screen.getByText(/已发送到 2 个目标/)).toBeTruthy();
		expect(screen.queryByText(/跳过/)).toBeNull();
	});

	it("有停用而跳过的 → 追一句「跳过 N 个已停用」并点名,不算失败", () => {
		render(
			<OutcomeLine
				outcome={{ kind: "sent", mode: "text", sent: 1, skipped: ["t2"], failed: [] }}
				targetName={targetName}
			/>,
		);
		const line = screen.getByText(/已发送到 1 个目标/);
		expect(line.textContent).toContain("跳过 1 个已停用");
		expect(line.textContent).toContain("群 B");
		expect(screen.queryByText(/失败/)).toBeNull();
	});

	it("失败与跳过同时有 → 两件事分开说", () => {
		render(
			<OutcomeLine
				outcome={{
					kind: "sent",
					mode: "text",
					sent: 1,
					skipped: ["t3"],
					failed: [{ targetId: "t2", message: "机器人不在群里" }],
				}}
				targetName={targetName}
			/>,
		);
		const line = screen.getByText(/1 个失败/);
		expect(line.textContent).toContain("群 B 机器人不在群里");
		expect(line.textContent).toContain("跳过 1 个已停用");
		expect(line.textContent).toContain("群 C");
	});
});

it.each([
	[
		1,
		[],
		[],
		"✓ Sent to 1 target (text)",
		"✓ 1件の送信先に送信済み（テキスト）",
		"✓ 已發送至 1 個目標（文字）",
	],
	[
		2,
		[],
		[],
		"✓ Sent to 2 targets (text)",
		"✓ 2件の送信先に送信済み（テキスト）",
		"✓ 已發送至 2 個目標（文字）",
	],
	[
		1,
		["t3"],
		[{ targetId: "t2", message: "原始诊断" }],
		"Sent: 1; failed: 1 (text): 群 B 原始诊断; skipped 1 disabled target: 群 C",
		"送信成功: 1件、失敗: 1件（テキスト）: 群 B 原始诊断、無効な送信先1件をスキップ: 群 C",
		"1 個目標成功、1 個失敗（文字）：群 B 原始诊断；略過 1 個已停用目標：群 C",
	],
	[
		1,
		["t3", "t1"],
		[
			{ targetId: "t2", message: "原始诊断" },
			{ targetId: "t3", message: "原始诊断二" },
		],
		"Sent: 1; failed: 2 (text): 群 B 原始诊断; 群 C 原始诊断二; skipped 2 disabled targets: 群 C, 群 A",
		"送信成功: 1件、失敗: 2件（テキスト）: 群 B 原始诊断、群 C 原始诊断二、無効な送信先2件をスキップ: 群 C、群 A",
		"1 個目標成功、2 個失敗（文字）：群 B 原始诊断；群 C 原始诊断二；略過 2 個已停用目標：群 C、群 A",
	],
] as const)(
	"delivery outcomes translate success, failure and skip counts for %s deliveries",
	(sent, skipped, failed, en, ja, tw) => {
		i18n.set({ locale: "en", voice: "plain" });
		render(
			<OutcomeLine
				outcome={{ kind: "sent", mode: "text", sent, skipped: [...skipped], failed: [...failed] }}
				targetName={targetName}
			/>,
		);
		for (const [locale, text] of [
			["en", en],
			["ja", ja],
			["zh-TW", tw],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(text)).toBeTruthy();
		}
	},
);

it.each([
	[
		{ kind: "no-targets" },
		"No push targets configured; this run was skipped.",
		"送信先が未設定のため、今回の実行をスキップしました。",
		"尚未設定推播目標，本次已略過",
	],
	[
		{ kind: "gen-failed", code: "unavailable", message: "原始诊断" },
		"Generation failed: 原始诊断",
		"生成に失敗しました: 原始诊断",
		"產生失敗：原始诊断",
	],
	[
		{ kind: "pending-approval", draftId: "raw-17" },
		"✓ Generated and sent privately to the owner. Reply ‘y raw-17’ to send it to groups (not sent to groups yet).",
		"✓ 生成して管理者へ個別に送信しました。「y raw-17」と返信するとグループに送信します（まだ送信していません）。",
		"✓ 已產生並私訊給主人；回覆「y raw-17」才會發送到群組（尚未發送）",
	],
] as const)(
	"pending and skipped review outcomes retain the raw reason or approval command (%s)",
	(outcome, en, ja, tw) => {
		render(<OutcomeLine outcome={outcome} targetName={targetName} />);
		for (const [locale, text] of [
			["en", en],
			["ja", ja],
			["zh-TW", tw],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(text)).toBeTruthy();
		}
	},
);
