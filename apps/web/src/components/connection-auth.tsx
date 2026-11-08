import type {
	ConnectionAuthBeginResponse,
	ConnectionAuthDraftResponse,
	ConnectionAuthStateResponse,
} from "@bilibili-notify/contract";
import { Btn, ErrorNote, ModalShell, Pill, QrPanel } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { ApiError, api } from "../services/api";

/**
 * 适配器授权入口：发起、轮询状态，再取走一次性设置草稿。
 * 说明与警告来自描述；草稿原样交给表单，不直写配置、不记日志。
 */

type Phase = "closed" | "starting" | "waiting" | "expired" | "error";

type AuthError =
	| { kind: "begin-failed" | "raw"; message: string }
	| { kind: "incomplete" | "missing" }
	| { kind: "unknown"; state: string };

/** 缺失 / 不是数的时候按 server 当前的口径来。 */
const POLL_FALLBACK_SEC = 2;
const POLL_MIN_SEC = 1;
const POLL_MAX_SEC = 60;

/**
 * 把 server 给的秒数夹成能用的毫秒。
 *
 * **不夹会出事**:`0` 或字段缺失(`undefined * 1000 = NaN`,setTimeout 当 0 处理)
 * 都会让浏览器以网络极限速度重发 `GET /api/adapters/:adapterKey/auth/:taskId`,而每一发服务端都转成
 * 一次对上游的请求,一路持续到任务 10 分钟 TTL 到期。上限那头则是防呆:上游多写
 * 一个零,弹窗看起来就跟死了一样。
 */
export function pollDelayMs(interval: unknown): number {
	const sec = Number(interval);
	if (!Number.isFinite(sec)) return POLL_FALLBACK_SEC * 1000;
	return Math.min(Math.max(sec, POLL_MIN_SEC), POLL_MAX_SEC) * 1000;
}

/** 一次扫码的会话:任务号与问询间隔。二维码另放,问询的 effect 不依赖它。 */
interface Session {
	taskId: string;
	pollIntervalSeconds: number;
}

export function ConnectionAuthButton({
	adapterKey,
	description,
	warning,
	experimental,
	onCredentials,
}: {
	/** 发起扫码的适配器键(取自当前连接的 `adapterKey`)。 */
	adapterKey: string;
	description?: string;
	warning?: string;
	experimental?: boolean;
	onCredentials: (settings: Record<string, unknown>) => void;
}) {
	const tx = useT();
	const [phase, setPhase] = useState<Phase>("closed");
	const [session, setSession] = useState<Session | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	// 「正在取回凭据」:刻意不是 Phase —— 新增阶段值会让问询的 effect 重跑,旧闭包的 alive 变假,
	// 而取草稿的请求已经发出、服务端已经清了草稿,回来的凭据就被丢掉(必现)。
	const [retrieving, setRetrieving] = useState(false);
	const [err, setErr] = useState<AuthError | null>(null);
	// 回调走 ref:轮询 effect 不因父组件每次渲染换回调而重启。
	const onCredentialsRef = useRef(onCredentials);
	onCredentialsRef.current = onCredentials;

	const authPath = `/api/adapters/${encodeURIComponent(adapterKey)}/auth`;

	async function start() {
		setPhase("starting");
		setErr(null);
		setSession(null);
		setQr(null);
		setRetrieving(false);
		try {
			const s = await api.post<ConnectionAuthBeginResponse>(authPath, {});
			setSession({ taskId: s.taskId, pollIntervalSeconds: s.pollIntervalSeconds });
			setQr(s.state.status === "awaiting-scan" ? s.state.qr.dataUrl : null);
			setPhase("waiting");
		} catch (e) {
			setErr({ kind: "begin-failed", message: (e as Error).message });
			setPhase("error");
		}
	}

	useEffect(() => {
		if (phase !== "waiting" || !session) return;
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		// session 换了 effect 就重跑,所以一轮问询期间间隔是定死的 —— 算一次就够
		const delay = pollDelayMs(session.pollIntervalSeconds);
		const taskPath = `${authPath}/${encodeURIComponent(session.taskId)}`;

		/**
		 * 状态已到 logged-in:取走凭据。在这同一个闭包里做完(见上面 retrieving 的注释)。
		 * 暂时失败只重试这一步 —— 草稿还在服务端,不回头问状态、不让主人重扫。
		 */
		const claimDraft = async (): Promise<void> => {
			setRetrieving(true);
			try {
				const r = await api.post<ConnectionAuthDraftResponse>(`${taskPath}/draft`, {});
				if (!alive) return;
				if (
					typeof r.settings === "object" &&
					r.settings !== null &&
					!Array.isArray(r.settings) &&
					Object.keys(r.settings).length > 0
				) {
					setRetrieving(false);
					onCredentialsRef.current(r.settings);
					setPhase("closed");
					return;
				}
				setRetrieving(false);
				setErr({ kind: "incomplete" });
				setPhase("error");
			} catch (e) {
				if (!alive) return;
				if (e instanceof ApiError && e.code === "not_found") {
					setRetrieving(false);
					setErr({ kind: "missing" });
					setPhase("error");
					return;
				}
				if (e instanceof ApiError && e.code === "conflict") {
					setRetrieving(false);
					setErr({ kind: "raw", message: e.message });
					setPhase("error");
					return;
				}
				// 暂时失败(unavailable / 断网):草稿还在服务端,过一拍再取。
				timer = setTimeout(() => void claimDraft(), delay);
			}
		};

		const tick = async () => {
			try {
				const r = await api.get<ConnectionAuthStateResponse>(taskPath);
				if (!alive) return;
				// 穷尽 switch 而不是 if 链:两端共用 AuthState,契约哪天多一个
				// status,default 里的 never 会让**前端编译不过** ——
				// if 链的话它会静静地落到「继续轮询」上,一个类型错误都没有。
				const s = r.state;
				switch (s.status) {
					case "awaiting-scan":
					case "confirming":
						// QQ 没有「已扫、等确认」,confirming 在这边没有产出者;真来了就接着问。
						break;
					case "logged-in":
						await claimDraft();
						return;
					case "expired":
					case "logged-out":
						// 码过期服务端报 error(走下面那支,带话和「重新生成」);这两个取值建连接的
						// 任务都不该出现,当成「这次作废了」请主人重开。
						setPhase("expired");
						return;
					case "error":
						setErr({ kind: "raw", message: s.message });
						setPhase("error");
						return;
					default: {
						const unhandled: never = s;
						setErr({ kind: "unknown", state: JSON.stringify(unhandled) });
						setPhase("error");
						return;
					}
				}
				timer = setTimeout(tick, delay);
			} catch (e) {
				if (!alive) return;
				if (e instanceof ApiError && e.code === "not_found") {
					// server 重启/任务超时被清,任务已不在 —— 当过期处理,请用户重开。
					setPhase("expired");
					return;
				}
				// 瞬时故障(网络抖动 / 上游 502,server 保留了任务)→ 下一轮接着问。
				timer = setTimeout(tick, delay);
			}
		};
		timer = setTimeout(tick, delay);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [phase, session, authPath]);

	function errorText(): string | null {
		if (!err) return null;
		switch (err.kind) {
			case "begin-failed":
				return tx("connectionAuth.connectionAuthButton.text1", { value0: err.message });
			case "incomplete":
				return tx("connectionAuth.connectionAuthButton.text2");
			case "missing":
				return tx("connectionAuth.connectionAuthButton.text3");
			case "unknown":
				return tx("connectionAuth.connectionAuthButton.text4", { value0: err.state });
			case "raw":
				return err.message;
		}
	}

	const open = phase !== "closed";
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Btn variant="outline" size="sm" onClick={() => void start()}>
				{tx("connectionAuth.connectionAuthButton.text5")}
			</Btn>
			{experimental ? (
				<Pill subtle size="sm">
					{tx("connectionAuth.connectionAuthButton.text6")}
				</Pill>
			) : null}
			{description ? (
				<span className="basis-full text-bn-xs text-bn-text-tertiary">{description}</span>
			) : null}
			{open ? (
				<ModalShell
					width={400}
					onCancel={() => setPhase("closed")}
					title={tx("connectionAuth.connectionAuthButton.text7")}
					description={description}
				>
					<QrPanel
						variant="bare"
						src={phase === "waiting" && !retrieving ? qr : null}
						alt={tx("connectionAuth.connectionAuthButton.text8")}
						loading={
							phase === "starting"
								? tx("connectionAuth.connectionAuthButton.text9")
								: phase === "waiting" && retrieving
									? tx("connectionAuth.connectionAuthButton.text10")
									: undefined
						}
					>
						{phase === "expired" ? (
							<div className="text-bn-sm text-bn-text-secondary">
								{tx("connectionAuth.connectionAuthButton.text11")}
							</div>
						) : null}
						{phase === "error" && err ? <ErrorNote>{errorText()}</ErrorNote> : null}
						{phase === "expired" || phase === "error" ? (
							<Btn variant="outline" size="sm" onClick={() => void start()}>
								{tx("connectionAuth.connectionAuthButton.text12")}
							</Btn>
						) : null}
						{warning ? <div className="text-bn-xs text-bn-text-tertiary">{warning}</div> : null}
					</QrPanel>
				</ModalShell>
			) : null}
		</div>
	);
}
