// @vitest-environment jsdom
/**
 * 周报「试一次」的结局文案 —— 停用而跳过的目标要单独说一句,不能混进「失败」,也不能
 * 悄悄从总数里少掉一个让人去查网络。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
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
					failed: [{ targetId: "t2", err: "机器人不在群里" }],
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
