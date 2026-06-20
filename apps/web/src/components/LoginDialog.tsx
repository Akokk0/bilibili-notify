import { useEffect, useRef, useState } from "react";
import { submitLogin } from "../services/session";
import { useSessionStore } from "../store/session";
import { Btn, Input } from "./atoms";

/**
 * Dashboard login card (Q5). Replaces the browser-native HTTP Basic popup.
 *
 * - Cold start (`variant="cold"`): centered card on the app gradient backdrop;
 *   the authed app is not mounted yet (so WS never connects pre-login).
 * - Mid-session expiry (`variant="overlay"`): same card floating on a blurred
 *   backdrop over the still-mounted (frozen) app — resume in place after
 *   re-login, with an explicit "session expired" hint.
 *
 * Submit logic lives in `services/session#submitLogin` (unit-tested in node
 * env); this component is the presentational shell + local form state.
 */
export function LoginDialog({ variant }: { variant: "cold" | "overlay" }) {
	const markAuthed = useSessionStore((s) => s.markAuthed);
	const setStatus = useSessionStore((s) => s.setStatus);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lockSec, setLockSec] = useState(0);
	const lockTimer = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (lockTimer.current) clearInterval(lockTimer.current);
		};
	}, []);

	function startLockCountdown(seconds: number): void {
		setLockSec(seconds);
		if (lockTimer.current) clearInterval(lockTimer.current);
		lockTimer.current = setInterval(() => {
			setLockSec((s) => {
				if (s <= 1) {
					if (lockTimer.current) clearInterval(lockTimer.current);
					lockTimer.current = null;
					return 0;
				}
				return s - 1;
			});
		}, 1000);
	}

	async function doSubmit(): Promise<void> {
		if (busy || lockSec > 0) return;
		setBusy(true);
		setError(null);
		const result = await submitLogin(username, password);
		setBusy(false);
		if (result.ok) {
			setPassword("");
			markAuthed();
			return;
		}
		// 后端权威告知未启用鉴权 —— 同步 store 让 AuthGate 关掉 dialog,
		// 而不是把一条用户无法处理的报错挂在表单上。
		if (result.kind === "auth_disabled") {
			setStatus({ authRequired: false, authed: true });
			return;
		}
		setError(result.message);
		if (result.kind === "rate_limited") startLockCountdown(result.retryAfterSec);
	}

	const disabled = busy || lockSec > 0;
	const expired = variant === "overlay";

	return (
		<div
			className={`fixed inset-0 z-50 flex items-center justify-center p-6 ${
				expired
					? "bg-black/30 backdrop-blur-sm"
					: "bg-gradient-to-br from-bn-pink/10 via-white to-bn-pink/5"
			}`}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void doSubmit();
				}}
				className="bn-glass-strong w-full max-w-sm rounded-2xl px-7 py-8 shadow-xl"
			>
				<div className="mb-1 flex items-center gap-2">
					<img alt="Bilibili Notify" src="/logo.png" className="h-9 w-auto object-contain" />
					<div className="text-[17px] font-bold tracking-tight text-bn-text-primary">
						女仆值班室登录
					</div>
				</div>
				<div className="mb-6 text-[12px] text-bn-text-secondary">
					{expired ? "会话已过期,请重新登录以继续。" : "请输入管理凭证进入控制台。"}
				</div>

				<div className="space-y-3">
					<Input value={username} onChange={setUsername} placeholder="用户名" full />
					<Input value={password} onChange={setPassword} placeholder="密码" type="password" full />
				</div>

				{error ? (
					<div className="mt-3 rounded-md bg-bn-danger-soft px-3 py-2 text-[12px] font-medium text-bn-danger-text">
						{lockSec > 0 ? `登录尝试过多,请 ${lockSec} 秒后再试` : error}
					</div>
				) : null}

				<div className="mt-6">
					<Btn type="submit" variant="primary" full disabled={disabled}>
						{busy ? "登录中…" : lockSec > 0 ? `请稍候 (${lockSec}s)` : "登录"}
					</Btn>
				</div>
			</form>
		</div>
	);
}
