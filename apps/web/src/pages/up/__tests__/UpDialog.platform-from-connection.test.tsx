// @vitest-environment jsdom
/**
 * 订阅抽屉里目标的平台**取自它挂着的连接**,不读目标自己那一格:
 * @全体开关置不置灰、目标的图标,都跟着连接走;连接不在(被删 / 还没加载回来)= 不知道 = 置灰。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Connection,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "../../../types/domain";
import { UpDialog } from "../UpDialog";

const UNSUPPORTED_NOTE = /QQ 官方.*不支持.*@全体/;
const CONN = "11111111-1111-4111-8111-111111111111";

const noop = () => {};

function connection(platform: string): Connection {
	return { id: CONN, kind: "direct", platform, enabled: true } as Connection;
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

function renderDialog(t: PushTarget, connections: Connection[]) {
	return render(
		<UpDialog
			sub={customSub()}
			targets={[t]}
			connections={connections}
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
	it("目标挂在 QQ 官方连接上 → @全体置灰", () => {
		renderDialog(target(), [connection("qq-official")]);
		expect(screen.getByText(UNSUPPORTED_NOTE)).toBeTruthy();
		const toggle = atAllToggle();
		expect(toggle.disabled).toBe(true);
	});

	it("目标挂在 OneBot 连接上 → 可点", () => {
		renderDialog(target(), [connection("onebot")]);
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
		expect(atAllToggle().disabled).toBe(false);
	});

	it("连接不在 → 当作不支持:@全体置灰", () => {
		renderDialog(target(), []);
		expect(atAllToggle().disabled).toBe(true);
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
