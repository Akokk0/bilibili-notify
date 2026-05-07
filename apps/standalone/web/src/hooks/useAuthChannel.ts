import { useEffect } from "react";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus, type LoginSnapshot } from "../types/auth";

/**
 * Subscribes to the WS `auth` channel and feeds `login-status-report` /
 * `cookies-refreshed` envelopes into the auth store. Mount this once near the
 * app root — the store is the read-side for any UI.
 */
export function useAuthChannel(): void {
	useEffect(() => {
		subscribeChannels(["auth"]);
		const off = onWsEvent((env) => {
			if (env.type !== "auth") return;
			if (env.event === "login-status-report" && env.data) {
				useAuthStore.getState().setSnapshot(env.data as LoginSnapshot);
				return;
			}
			if (env.event === "cookies-refreshed") {
				const refreshedAt =
					typeof (env.data as { refreshedAt?: unknown })?.refreshedAt === "string"
						? (env.data as { refreshedAt: string }).refreshedAt
						: env.ts;
				useAuthStore.getState().setCookiesRefreshed(refreshedAt);
				return;
			}
			if (env.event === "auth-lost") {
				useAuthStore
					.getState()
					.setSnapshot({ status: BiliLoginStatus.NOT_LOGIN, msg: "auth-lost" });
				return;
			}
		});
		return off;
	}, []);
}
