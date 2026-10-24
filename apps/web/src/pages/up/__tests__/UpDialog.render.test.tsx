// @vitest-environment jsdom

/**
 * UpDialog 渲染回归:QQ 官方机器人不支持 @全体(后端 best-effort 跳过 at-all),
 * 故其 per-target「+ @全体」开关须禁用并显示不支持说明(能力表里 atAll 是「不支持」);onebot / webhook 不受影响。
 */

import type { ConnectionCapabilitiesMap } from "@bilibili-notify/contract";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Connection,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "../../../types/domain";
import { UpDialog } from "../UpDialog";

const UNSUPPORTED_NOTE = /QQ 官方.*@全体.*发送时会自动跳过/;

const noop = () => {};

function targetFor(platform: string): PushTarget {
	const base = {
		id: `${platform}-1`,
		name: `${platform} 目标`,
		connectionId: "a-1",
		enabled: true,
	};
	if (platform === "onebot") return { ...base, kind: "session", scope: "group", address: "" };
	if (platform === "qq-official") return { ...base, kind: "session", scope: "group", address: "" };
	return { ...base, kind: "endpoint" };
}

/**
 * routing 仅含 dynamic → 该 target「routing 不完整」= 自定义模式,矩阵直接展开(无需
 * 点击),dynamic 行下方挂出 per-target「+ @全体」开关。per-UP 的 atAllPost=true 让
 * 「若平台支持则默认会 @全体」,以验证 QQ 官方仍被强制禁用。
 */
function customSubFor(targetId: string): Subscription {
	const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
	sub.routing.post = [targetId];
	sub.overrides = { features: { extras: { atAllPost: true } } };
	return sub;
}

/** 照真适配器的回答:官机 @全体 不支持,别的支持。 */
function capabilitiesFor(platform: string): ConnectionCapabilitiesMap {
	const unknown = { state: "unknown" } as const;
	const atAll =
		platform === "qq-official"
			? ({
					state: "unsupported",
					reason: "QQ 官方机器人在群里 @全体 要特殊权限，适配器会丢掉 @全体 段",
					checkedAt: 1,
				} as const)
			: ({ state: "supported", checkedAt: 1 } as const);
	return { "a-1": { atAll, inbound: unknown, nativeShare: unknown } };
}

function renderDialog(platform: string) {
	// 平台只在连接上:目标自己不带,按 platform 造目标,再造一条同平台的连接挂着它。
	const target = targetFor(platform);
	return render(
		<UpDialog
			sub={customSubFor(target.id)}
			targets={[target]}
			connections={[
				{
					id: target.connectionId,
					adapterKey: platform,
					platform,
					enabled: true,
				} as Connection,
			]}
			capabilities={capabilitiesFor(platform)}
			onClose={noop}
			onSave={noop}
			onDelete={noop}
			saving={false}
		/>,
	);
}

afterEach(cleanup);

describe("UpDialog · QQ 官方 @全体 提示", () => {
	it("QQ 官方 target 的 @全体 开关被禁用并显示不支持说明", () => {
		renderDialog("qq-official");

		const note = screen.getByText(UNSUPPORTED_NOTE);
		expect(note).toBeTruthy();

		// note 与开关同处一个 wrapper;wrapper 内唯一的 button 即被禁用的 @全体 Toggle
		// (不支持时不渲染 reset 按钮)。
		const wrapper = note.parentElement as HTMLElement;
		const toggle = within(wrapper).getAllByRole("button")[0] as HTMLButtonElement;
		expect(toggle.disabled).toBe(true);
	});

	it("onebot target 不显示不支持说明", () => {
		renderDialog("onebot");
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});

	it("webhook 那一族的 target 不显示不支持说明", () => {
		renderDialog("feishu");
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});
});

/** B 站订阅的头部:「UID xxx」读的是订阅的身份(外部 id 就是 uid)。 */
describe("UpDialog · B 站订阅的头部", () => {
	it("写「UID xxx」", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			cachedProfile: { name: "UP甲", followers: 1, refreshedAt: "t" },
		};
		render(
			<UpDialog
				sub={sub}
				targets={[]}
				connections={[]}
				onClose={noop}
				onSave={noop}
				onDelete={noop}
				saving={false}
			/>,
		);
		expect(screen.getByText("UID 100")).toBeTruthy();
	});
});
