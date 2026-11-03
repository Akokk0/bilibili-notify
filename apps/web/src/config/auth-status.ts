import type { SourceAuthState } from "../hooks/use-source-auth";
import { i18n } from "../i18n";

/** 登录状态的六种取值各自的标签与强调色 —— 穷尽的表,`AuthState` 多一种取值这里不补就编译不过。 */
type AuthStatus = SourceAuthState["status"];

export const AUTH_STATUS_LABELS: Record<AuthStatus, string> = {
	get "logged-out"() {
		return i18n.t("panelUi.config.auth-status.1");
	},
	get "awaiting-scan"() {
		return i18n.t("panelUi.config.auth-status.2");
	},
	get confirming() {
		return i18n.t("panelUi.config.auth-status.3");
	},
	get "logged-in"() {
		return i18n.t("panelUi.config.auth-status.4");
	},
	get expired() {
		return i18n.t("panelUi.config.auth-status.5");
	},
	get error() {
		return i18n.t("panelUi.config.auth-status.6");
	},
};

export const AUTH_STATUS_ACCENT: Record<AuthStatus, string> = {
	"logged-out": "var(--color-bn-inactive)",
	"awaiting-scan": "var(--color-bn-warning)",
	confirming: "var(--color-bn-blue)",
	"logged-in": "var(--color-bn-success)",
	expired: "var(--color-bn-danger)",
	error: "var(--color-bn-danger)",
};

/** 状态带话的取话(服务端给的 `message`),没有就空串。`confirming` 的 `message` 可选。 */
export function authMessageOf(state: SourceAuthState): string {
	switch (state.status) {
		case "confirming":
			return state.message ?? "";
		case "expired":
		case "error":
			return state.message;
		case "logged-out":
		case "awaiting-scan":
		case "logged-in":
			return "";
		default: {
			const exhausted: never = state;
			return exhausted;
		}
	}
}
