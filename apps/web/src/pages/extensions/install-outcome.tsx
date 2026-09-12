/**
 * 「装完那句话」—— 传包装与从市场装**共用**这一块(装完的回答是同一个形状)。
 *
 * 三种结局的出路完全不同:热装好了(什么都不用做)、盖掉了一份已经跑着的(得重启一次,而
 * 这台机器给不给按钮还要看)、装失败(原因由调用方另行摆出来,不在这里)。
 *
 * ⛔ **那颗重启按钮只在这里、只在这一刻出现**(ADR-0005 决策 22):面板上没有常驻的重启
 * 入口 —— 重启是**刚做完这件事**的后果,不是一个随时可按的动作。这台机器上按了回不来
 * (开发版 / 裸跑)就不给按钮,但要把原因写出来。
 */

import type { ExtensionInstallResponse, RestartResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, HintNote, LoadingBlock } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
	DEFAULT_RESTART_WAIT,
	type RestartWait,
	useRestartStore,
} from "../../components/update/restart";
import { api } from "../../services/api";

/** 重启回不来的那两档各自的出路不一样,所以不能合成一句「不支持」。 */
function whyNoButton(reason: "source-run" | "unsupervised"): string {
	return reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了 tsx watch 只等文件变,没人把它拉起来 —— 随便改一行代码存一下,那本来就是一次重启。"
		: "这个进程退了没人拉(既没跑在桌面外壳里,也不在容器里)—— 自己在终端里停掉再起一次。";
}

/**
 * 装完这一刻该把人往哪儿引。**凭的是服务端拆包时答好的 `done.docs`,不猜** —— 挂一颗
 * 「看看说明」点进去却什么都没有,比不挂更糟。
 *
 * 刚盖掉一份跑着的,最想知道的是「这次改了啥」,那是 CHANGELOG 不是 README。
 */
function docsLabel(done: ExtensionInstallResponse): string | null {
	// 🔴 `?.` 不是摆设:这个 app 能应用内自更新,面板与服务端在那几秒里版本可能对不上。
	// 少一格就把整块「装好了」炸掉,代价远大于少一颗钮。缺了当没有,与 `isExtensionEnabled`
	// 那条「缺失 = 关着」同一个路子。
	const docs = done.docs as ExtensionInstallResponse["docs"] | undefined;
	if (!docs) return null;
	if (done.needsRestart && docs.changelog) return "看看更新了什么";
	if (docs.readme) return "看看说明";
	if (docs.changelog) return "看看更新日志";
	return null;
}

function DocsLink({ done }: { done: ExtensionInstallResponse }) {
	const label = docsLabel(done);
	if (!label) return null;
	return (
		<Link
			to={`/extensions/${done.id}`}
			className="shrink-0 font-bold text-bn-pink underline decoration-from-font underline-offset-2"
		>
			{label}
		</Link>
	);
}

export interface ExtensionInstallOutcomeProps {
	done: ExtensionInstallResponse | null;
	/** 等待参数,只有测试会给。 */
	wait?: RestartWait;
}

export function ExtensionInstallOutcome({
	done,
	wait = DEFAULT_RESTART_WAIT,
}: ExtensionInstallOutcomeProps) {
	const { view, begin } = useRestartStore();
	const restart = useMutation({
		mutationFn: () => api.post<RestartResponse>("/api/system/restart", {}),
		onSuccess: ({ startedAt, version }) =>
			begin({ before: startedAt, target: version, mode: "restart" }, wait),
	});
	const waiting = view?.intent.mode === "restart" && view.kind === "waiting";

	return (
		<>
			{done && !done.needsRestart ? (
				<HintNote
					tone={done.enabled ? "success" : "neutral"}
					className="flex flex-wrap items-center gap-x-2 gap-y-1"
				>
					<span>
						<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
						{done.enabled
							? "装好了,已经在跑 —— 开关在它自己那张卡上。"
							: "装好了,还关着 —— 到它那张卡上把开关拨开才会跑。"}
					</span>
					<DocsLink done={done} />
				</HintNote>
			) : null}

			{done?.needsRestart ? (
				<HintNote tone="neutral" className="flex flex-wrap items-center gap-2">
					<span>
						<strong className="text-bn-text-secondary">{done.name}</strong> 换成了 {done.version}
						,但这个进程早就认下了旧的那一份、换不掉 ——{" "}
						<strong className="text-bn-text-secondary">重启一次</strong>才会用上新的。
						{done.restart.can ? "" : ` ${whyNoButton(done.restart.reason)}`}
					</span>
					<DocsLink done={done} />
					{done.restart.can ? (
						<Btn
							variant="outline"
							size="sm"
							disabled={restart.isPending || waiting}
							onClick={() => restart.mutate()}
						>
							重启一次
						</Btn>
					) : null}
				</HintNote>
			) : null}

			{waiting ? (
				<LoadingBlock variant="inset" label="正在重启" hint="服务回来后这一页会自动刷新。" />
			) : null}

			{restart.isError ? (
				<ErrorNote size="sm">没能发出重启指令:{restart.error.message}</ErrorNote>
			) : null}
		</>
	);
}
