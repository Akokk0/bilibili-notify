// @vitest-environment jsdom
/**
 * 订阅抽屉里目标的平台**取自它挂着的连接**,不读目标自己那一格;@全体 开关置不置灰读的是这条连接的
 * `atAll` 能力(适配器的回答):
 * - 不支持 → 置灰,提示用能力里的原因 + 「,发送时会自动跳过」;
 * - 还不知道 / 能力表没回来 / 表里没这条 → 不拦,开关照已存的值显示、可点,没有提示;
 * - 连接不在(被删)→ 不知道平台 = 置灰并说清楚;连接列表还没回来 = 不下结论,开关照已存的值显示。
 */

import type { ConnectionCapabilitiesMap } from "@bilibili-notify/contract";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Connection,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "../../../types/domain";
import { makeSource } from "../../rules/__tests__/fixtures";
import { subscriptionPlatformOf } from "../subscription-source";
import { UpDialog } from "../UpDialog";

const QQ_REASON = "QQ 官方机器人在群里 @全体 要特殊权限，适配器会丢掉 @全体 段";
const UNSUPPORTED_NOTE = `${QQ_REASON}，发送时会自动跳过`;
const MISSING_NOTE = "连接不在了,没法判断能不能 @全体";
const CONN = "11111111-1111-4111-8111-111111111111";

const noop = () => {};

function connection(platform: string): Connection {
	return { id: CONN, adapterKey: platform, platform, enabled: true } as Connection;
}

/** 目标自己不带平台:平台只在连接上。 */
function target(): PushTarget {
	return {
		id: "t-1",
		name: "目标一",
		connectionId: CONN,
		enabled: true,
		kind: "session",
		scope: "group",
		address: "",
	} as PushTarget;
}

/** routing 只含 post → 自定义模式,矩阵直接展开,post 行下挂出「+ @全体」开关。 */
function customSub(): Subscription {
	const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
	sub.routing.post = ["t-1"];
	sub.overrides = { features: { extras: { atAllPost: true } } };
	return sub;
}

const UNKNOWN = { state: "unknown" } as const;

/** 能力表里 CONN 这条连接的 atAll 是给定的那一格。 */
function capsWith(atAll: ConnectionCapabilitiesMap[string]["atAll"]): ConnectionCapabilitiesMap {
	return { [CONN]: { atAll, inbound: UNKNOWN, nativeShare: UNKNOWN } };
}
const QQ_CAPS = capsWith({
	state: "unsupported",
	reason: QQ_REASON,
	checkedAt: "2026-10-26T00:00:00.000Z",
});
const OB_CAPS = capsWith({ state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" });

function renderDialog(
	t: PushTarget,
	connections: Connection[] | undefined,
	capabilities?: ConnectionCapabilitiesMap,
) {
	return render(
		<UpDialog
			platform={subscriptionPlatformOf({ sourceKey: "bilibili" }, [makeSource()])}
			sub={customSub()}
			targets={[t]}
			connections={connections}
			capabilities={capabilities}
			onClose={noop}
			onSave={noop}
			onDelete={noop}
			saving={false}
		/>,
	);
}

function atAllToggle(): HTMLButtonElement {
	return screen.getAllByRole("button", { name: /^@全体 · 目标一/ })[0] as HTMLButtonElement;
}

afterEach(cleanup);

describe("UpDialog · 平台取自连接", () => {
	it("连接的 atAll 能力是不支持(QQ 官方)→ @全体置灰", () => {
		renderDialog(target(), [connection("qq-official")], QQ_CAPS);
		expect(screen.getByText(UNSUPPORTED_NOTE)).toBeTruthy();
		const toggle = atAllToggle();
		expect(toggle.disabled).toBe(true);
	});

	it("连接的 atAll 能力是支持(OneBot)→ 可点", () => {
		renderDialog(target(), [connection("onebot")], OB_CAPS);
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
		expect(atAllToggle().disabled).toBe(false);
	});

	it("连接不在 → @全体置灰,提示说连接不在了,不冤枉 QQ 官方", () => {
		renderDialog(target(), [], QQ_CAPS);
		expect(atAllToggle().disabled).toBe(true);
		expect(screen.getByText(MISSING_NOTE)).toBeTruthy();
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});

	it("连接列表还没回来 → 不下结论:没有提示,开关照已存的值显示且可点", () => {
		renderDialog(target(), undefined);
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
		expect(screen.queryByText(MISSING_NOTE)).toBeNull();
		const toggle = atAllToggle();
		expect(toggle.disabled).toBe(false);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
	});

	it("能力不支持 → 提示是能力里的原因 + 「,发送时会自动跳过」", () => {
		renderDialog(target(), [connection("qq-official")], QQ_CAPS);
		expect(screen.getByText(UNSUPPORTED_NOTE)).toBeTruthy();
		expect(screen.queryByText(MISSING_NOTE)).toBeNull();
	});

	it("能力是「还不知道」→ 不置灰、没有提示,开关照已存的值显示", () => {
		renderDialog(
			target(),
			[connection("onebot")],
			capsWith({ state: "unknown", reason: "桥没报这一项" }),
		);
		expect(screen.queryByText(/发送时会自动跳过/)).toBeNull();
		const toggle = atAllToggle();
		expect(toggle.disabled).toBe(false);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
	});

	it("能力表还没回来 / 表里没这条连接 → 同样当「还不知道」:不置灰、没有提示", () => {
		for (const caps of [undefined, {}] as const) {
			const view = renderDialog(target(), [connection("qq-official")], caps);
			expect(screen.queryByText(/发送时会自动跳过/)).toBeNull();
			expect(atAllToggle().disabled).toBe(false);
			view.unmount();
		}
	});

	it("图标的平台取自连接:连接是 onebot → 徽标首字是 o;连接不在 → 没有字", () => {
		const badges = () =>
			Array.from(document.body.querySelectorAll("span.font-extrabold")).map((e) => e.textContent);
		const first = renderDialog(target(), [connection("onebot")]);
		expect(badges()).toContain("o");
		expect(badges()).not.toContain("f");
		first.unmount();
		renderDialog(target(), []);
		expect(badges()).not.toContain("f");
		expect(badges()).not.toContain("o");
	});
});
