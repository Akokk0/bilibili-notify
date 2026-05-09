import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Btn } from "../components/atoms";
import { ApiError, api } from "../services/api";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus, type BiliLoginStatusValue } from "../types/auth";

const STATUS_LABELS: Record<BiliLoginStatusValue, string> = {
	[BiliLoginStatus.NOT_LOGIN]: "未登录",
	[BiliLoginStatus.LOADING_LOGIN_INFO]: "正在加载登录信息",
	[BiliLoginStatus.LOGIN_QR]: "等待扫码",
	[BiliLoginStatus.LOGGING_QR]: "正在登录",
	[BiliLoginStatus.LOGGED_IN]: "已登录",
	[BiliLoginStatus.LOGIN_FAILED]: "登录失败",
};

const STATUS_TONE: Record<BiliLoginStatusValue, string> = {
	[BiliLoginStatus.NOT_LOGIN]: "bg-gray-100 text-gray-700",
	[BiliLoginStatus.LOADING_LOGIN_INFO]: "bg-blue-50 text-blue-700",
	[BiliLoginStatus.LOGIN_QR]: "bg-amber-50 text-amber-700",
	[BiliLoginStatus.LOGGING_QR]: "bg-amber-50 text-amber-700",
	[BiliLoginStatus.LOGGED_IN]: "bg-emerald-50 text-emerald-700",
	[BiliLoginStatus.LOGIN_FAILED]: "bg-red-50 text-red-700",
};

function StatusPill({ status, msg }: { status: BiliLoginStatusValue; msg: string }) {
	return (
		<span
			className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${STATUS_TONE[status]}`}
		>
			<span className="h-1.5 w-1.5 rounded-full bg-current" />
			{STATUS_LABELS[status]}
			{msg ? <span className="text-current/70">· {msg}</span> : null}
		</span>
	);
}

function QrCard({ data, msg }: { data: unknown; msg: string }) {
	const src = typeof data === "string" && data.length > 0 ? data : null;
	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-6">
			{src ? (
				<img alt="登录二维码" className="h-56 w-56 rounded bg-white p-2 shadow-sm" src={src} />
			) : (
				<div className="flex h-56 w-56 items-center justify-center rounded bg-white text-sm text-gray-400">
					二维码加载中…
				</div>
			)}
			<div className="text-sm text-amber-800">使用 Bilibili 手机客户端扫码登录</div>
			{msg ? <div className="text-xs text-amber-700">{msg}</div> : null}
		</div>
	);
}

export default function Auth() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const cookiesRefreshedAt = useAuthStore((s) => s.cookiesRefreshedAt);
	const qc = useQueryClient();
	const [actionError, setActionError] = useState<string | null>(null);

	const status: BiliLoginStatusValue = snapshot?.status ?? BiliLoginStatus.LOADING_LOGIN_INFO;
	const msg = snapshot?.msg ?? "";
	const isQrPhase = status === BiliLoginStatus.LOGIN_QR || status === BiliLoginStatus.LOGGING_QR;

	function wrap<T>(action: () => Promise<T>): () => Promise<T | undefined> {
		return async () => {
			setActionError(null);
			try {
				return await action();
			} catch (err) {
				setActionError(err instanceof ApiError ? err.message : String(err));
				return undefined;
			}
		};
	}

	const startQr = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/qr")),
	});
	const refresh = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/cookies/refresh")),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
	});
	const reset = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/cookies/reset")),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
	});
	const logout = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/logout")),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
	});

	return (
		<div className="space-y-5">
			<div className="flex items-center justify-between">
				<div className="space-y-1">
					<h2 className="text-base font-medium">账号登录</h2>
					<p className="text-xs text-gray-500">
						通过扫码登录获取 Cookie；登录态由后端通过 WebSocket 实时同步。
					</p>
				</div>
				<StatusPill status={status} msg={msg} />
			</div>

			{actionError ? (
				<div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
					操作失败：{actionError}
				</div>
			) : null}

			{isQrPhase ? <QrCard data={snapshot?.data} msg={msg} /> : null}

			{status === BiliLoginStatus.LOGGED_IN ? (
				<div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-5">
					<div className="text-sm text-emerald-900">
						账号已登录，业务核心可正常拉取动态 / 直播 / WBI 签名。
					</div>
					{cookiesRefreshedAt ? (
						<div className="text-xs text-emerald-800">
							最近一次 Cookie 刷新：{new Date(cookiesRefreshedAt).toLocaleString()}
						</div>
					) : null}
				</div>
			) : null}

			{status === BiliLoginStatus.LOGIN_FAILED ? (
				<div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
					{msg || "登录失败，可重试。"}
				</div>
			) : null}

			<div className="flex flex-wrap gap-2">
				<Btn
					variant="primary"
					disabled={
						startQr.isPending || isQrPhase || status === BiliLoginStatus.LOGGED_IN
					}
					onClick={() => startQr.mutate()}
				>
					{startQr.isPending ? "处理中…" : "发起扫码登录"}
				</Btn>
				<Btn
					variant="outline"
					disabled={refresh.isPending || status !== BiliLoginStatus.LOGGED_IN}
					onClick={() => refresh.mutate()}
				>
					{refresh.isPending ? "处理中…" : "刷新 Cookie"}
				</Btn>
				<Btn
					variant="danger"
					disabled={logout.isPending || status !== BiliLoginStatus.LOGGED_IN}
					onClick={() => logout.mutate()}
				>
					{logout.isPending ? "处理中…" : "退出登录"}
				</Btn>
				<Btn
					variant="danger"
					disabled={reset.isPending}
					onClick={() => reset.mutate()}
				>
					{reset.isPending ? "处理中…" : "重置密钥与 Cookie"}
				</Btn>
			</div>

			<details className="rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
				<summary className="cursor-pointer font-medium text-gray-700">原始登录快照</summary>
				<pre className="mt-2 overflow-auto leading-relaxed">
					{JSON.stringify(snapshot ?? { hint: "等待 /api/auth/status" }, null, 2)}
				</pre>
			</details>
		</div>
	);
}
