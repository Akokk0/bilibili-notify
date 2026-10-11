import type {
	ConnectionAuthBeginResponse,
	ConnectionAuthDraftResponse,
	ConnectionAuthStateResponse,
} from "@bilibili-notify/contract";
import { Btn, ErrorNote, ModalShell, Pill, QrPanel } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../services/api";

/**
 * QQ 官方机器人「扫码连接 / 创建」—— 连接表单里 appId/appSecret 的旁路入口。
 * 不只能新建:腾讯 H5 里也能重选之前通道建的 bot 重发 secret,凭据直接回填。
 *
 * 走适配器的 `connectionAuth` 三个口(server 端 `routes/adapters.ts`、`platforms/qq-bind.ts`):
 * 发起 `POST /api/adapters/:adapterKey/auth`;问询 `GET …/auth/:taskId`(只有状态,不带凭据);
 * 状态到 `logged-in` 之后 `POST …/auth/:taskId/draft` 取走凭据(取走即清)。扫码进的是腾讯 H5,
 * 建 bot 全程在腾讯页面里发生;凭据回填**表单草稿**,保存仍走用户点保存的既有链路 —— 这里绝不直写配置。
 * 通道属实验性(预期消费者是 OpenClaw,可能哪天收紧),失效时手填 appid/secret 是永远在的降级路径。
 *
 * ⚠️ 取回来的 `appSecret` 只在 `claimDraft` 里的局部变量里停留,直接交给 `onCredentials`:
 * 不进组件状态、不进日志、不进任何会被持久化的地方。
 */

type Phase = "closed" | "starting" | "waiting" | "expired" | "error";

/** 缺失 / 不是数的时候按 server 当前的口径来。 */
const POLL_FALLBACK_SEC = 2;
const POLL_MIN_SEC = 1;
const POLL_MAX_SEC = 60;

/**
 * 把 server 给的秒数夹成能用的毫秒。
 *
 * **不夹会出事**:`0` 或字段缺失(`undefined * 1000 = NaN`,setTimeout 当 0 处理)
 * 都会让浏览器以网络极限速度重发 `GET /api/adapters/:adapterKey/auth/:taskId`,而每一发服务端都转成
 * 一次对腾讯的请求,一路持续到任务 10 分钟 TTL 到期。上限那头则是防呆:上游多写
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

export function QQQrBindButton({
	adapterKey,
	onCredentials,
}: {
	/** 发起扫码的适配器键(取自当前连接的 `adapterKey`)。 */
	adapterKey: string;
	onCredentials: (creds: { appId: string; appSecret: string }) => void;
}) {
	const [phase, setPhase] = useState<Phase>("closed");
	const [session, setSession] = useState<Session | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	// 「正在取回凭据」:刻意不是 Phase —— 新增阶段值会让问询的 effect 重跑,旧闭包的 alive 变假,
	// 而取草稿的请求已经发出、服务端已经清了草稿,回来的凭据就被丢掉(必现)。
	const [retrieving, setRetrieving] = useState(false);
	const [err, setErr] = useState<string | null>(null);
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
			setErr(`创建绑定任务失败:${(e as Error).message}`);
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
				const { appId, appSecret } = r.settings;
				if (
					typeof appId === "string" &&
					appId !== "" &&
					typeof appSecret === "string" &&
					appSecret !== ""
				) {
					setRetrieving(false);
					onCredentialsRef.current({ appId, appSecret });
					setPhase("closed");
					return;
				}
				setRetrieving(false);
				setErr("扫码成功了，但回来的凭据不完整，请手动填写");
				setPhase("error");
			} catch (e) {
				if (!alive) return;
				if (e instanceof ApiError && e.code === "not_found") {
					setRetrieving(false);
					setErr("绑定结果已经不在了（可能已被取走或超时），请重新扫码");
					setPhase("error");
					return;
				}
				if (e instanceof ApiError && e.code === "conflict") {
					setRetrieving(false);
					setErr(e.message);
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
						setErr(s.message);
						setPhase("error");
						return;
					default: {
						const unhandled: never = s;
						setErr(`未知的绑定状态:${JSON.stringify(unhandled)}`);
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

	const open = phase !== "closed";
	return (
		<div className="flex items-center gap-2">
			<Btn variant="outline" size="sm" onClick={() => void start()}>
				扫码连接 / 创建
			</Btn>
			<Pill subtle size="sm">
				实验性
			</Pill>
			{open ? (
				<ModalShell
					width={400}
					onCancel={() => setPhase("closed")}
					title="扫码连接 / 创建机器人"
					description="手机 QQ 扫码,在腾讯页面里重选已建的机器人回填凭据,或新建一个(每个 QQ 号最多 5 个)"
				>
					<QrPanel
						variant="bare"
						src={phase === "waiting" && !retrieving ? qr : null}
						alt="QQ 机器人绑定二维码"
						loading={
							phase === "starting"
								? "正在创建绑定任务"
								: phase === "waiting" && retrieving
									? "正在取回凭据"
									: undefined
						}
					>
						{phase === "expired" ? (
							<div className="text-bn-sm text-bn-text-secondary">二维码已过期</div>
						) : null}
						{phase === "error" && err ? <ErrorNote>{err}</ErrorNote> : null}
						{phase === "expired" || phase === "error" ? (
							<Btn variant="outline" size="sm" onClick={() => void start()}>
								重新生成
							</Btn>
						) : null}
						{/* 只留能力注意这一段(2026-08-30 主人拍板砍掉 OpenClaw/通道失效说明,嫌话多) */}
						<div className="text-bn-xs text-bn-text-tertiary">
							注意:此通道创建的机器人能力有限,目前<b>限创建者私聊与创建者当群主的群</b>
							(以腾讯当前政策为准)。要更宽的能力请手动填写正式注册的机器人凭据。
						</div>
					</QrPanel>
				</ModalShell>
			) : null}
		</div>
	);
}
