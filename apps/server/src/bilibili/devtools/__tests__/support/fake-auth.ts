import { type AuthState, ok, type SourceAccount } from "@bilibili-notify/internal";
import type { BilibiliSourceAuth } from "../../../auth/index.js";

/** 假的真登录口(`BilibiliSourceAuth`):状态与账号可指定,发起 / 退出什么都不做。 */
export function fakeAuth(
	state: AuthState = { status: "logged-out" },
	account: SourceAccount | null = null,
): BilibiliSourceAuth {
	return {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => state,
		account: () => account,
		onChange: () => ({ dispose() {} }),
	};
}
