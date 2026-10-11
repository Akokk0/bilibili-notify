import { type AuthState, ok, type SourceAccount, type SourceAuth } from "@bilibili-notify/internal";

/** 假的真登录口(`Required<SourceAuth>`):状态与账号可指定,发起 / 退出什么都不做。 */
export function fakeAuth(
	state: AuthState = { status: "logged-out" },
	account: SourceAccount | null = null,
): Required<SourceAuth> {
	return {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => state,
		account: () => account,
		onChange: () => ({ dispose() {} }),
	};
}
