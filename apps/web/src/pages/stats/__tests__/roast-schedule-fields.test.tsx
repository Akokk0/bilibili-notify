// @vitest-environment jsdom
/**
 * 周报排程表单的「发送到」—— 与链接解析白名单共用同一个目标选择器、同一条规矩:
 * 停用的目标**照列照勾**并标「已停用」(主人定的:两处行为一致,停用是暂停不是消失)。
 * 以前这里把停用的目标过滤掉,用户看不出它还勾在配置里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushTarget } from "../../../types/domain";
import { RoastScheduleFields, type RoastScheduleValue } from "../RoastScheduleFields";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const T_ON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_OFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function target(id: string, name: string, enabled: boolean): PushTarget {
	return {
		id,
		name,
		adapterId: "11111111-1111-4111-8111-111111111111",
		scope: "group",
		enabled,
		platform: "onebot",
		session: { groupId: "123" },
	} as PushTarget;
}

const VALUE: RoastScheduleValue = {
	enabled: true,
	cron: "0 9 * * 1",
	days: 7,
	targets: [T_ON],
	approval: false,
	notifyOnError: true,
};

function renderFields(onChange = vi.fn()) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/targets") return [target(T_ON, "群 A", true), target(T_OFF, "群 B", false)];
		if (path === "/api/globals") return { master: {} };
		throw new Error(`unexpected GET ${path}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<RoastScheduleFields value={VALUE} onChange={onChange} noun="周报" />
		</QueryClientProvider>,
	);
	return onChange;
}

afterEach(cleanup);

describe("RoastScheduleFields — 发送到", () => {
	it("停用的目标也列出来并标「已停用」,点它照样勾进 targets", async () => {
		const onChange = renderFields();
		const chip = await screen.findByRole("button", { name: /群 B/ });
		expect(within(chip).getByText("已停用")).toBeTruthy();
		fireEvent.click(chip);
		expect(onChange).toHaveBeenCalledWith({ ...VALUE, targets: [T_ON, T_OFF] });
	});

	it("再点已勾的目标 → 从 targets 里去掉", async () => {
		const onChange = renderFields();
		fireEvent.click(await screen.findByRole("button", { name: /群 A/ }));
		expect(onChange).toHaveBeenCalledWith({ ...VALUE, targets: [] });
	});
});
