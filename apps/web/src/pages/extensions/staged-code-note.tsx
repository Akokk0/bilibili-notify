/**
 * 「新版等着换上」那块提示(ADR-0012 决策 47)—— 装完那句话与详情页头卡**共用**。
 *
 * 盘上换了代码,而这个进程早就 import 过这个拓展的另一份:ESM 按 URL 认模块,同一个进程里
 * 干净地换不掉(决策 10)。出口有两个,**并排摆给主人选**,各自的代价写在各自旁边:
 * - 「重启 BN」—— 最干净,代价是所有推送与直播监听断几秒。这台机器拉不起自己(开发版 / 裸跑)
 *   就不给按钮,换成为什么(ADR-0005 决策 22)。
 * - 「只重载这个拓展」—— 别的都不断;代价是旧模块回收不掉、以及拓展没交给 BN 管的副作用可能
 *   还在跑。**只在真有新代码时出现**:生产上不给随手漏模块的口子,那道闸在服务端(没有新代码
 *   时 409),这里靠调用方只在 `staged` 在时才画它。
 *
 * ⛔ 那颗重启按钮仍然**不是常驻的**:它只在这件确实需要它的事旁边出现。
 */

import type { ExtensionDTO, RestartAbility, RestartResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, HintNote, LoadingBlock } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
	DEFAULT_RESTART_WAIT,
	type RestartWait,
	useRestartStore,
} from "../../components/update/restart";
import {
	EXTENSIONS_QUERY_KEY,
	extensionBotsKey,
	extensionStatusKey,
} from "../../hooks/useExtensions";
import { api } from "../../services/api";
import { PARAGRAPH_CLS, reasonOf } from "./shared";

/** 重启回不来的那两档各自的出路不一样,所以不能合成一句「不支持」。 */
function whyNoButton(reason: "source-run" | "unsupervised"): string {
	return reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了 tsx watch 只等文件变,没人把它拉起来 —— 随便改一行代码存一下,那本来就是一次重启。"
		: "这个进程退了没人拉(既没跑在桌面外壳里,也不在容器里)—— 自己在终端里停掉再起一次。";
}

/**
 * 那句话。三档说的是三件不同的事实:
 * - 旧的照跑、版本号不同 —— 盘上与跑着的各是哪一版;
 * - 旧的照跑、版本号相同 —— 代码换了而版本号没动(开发时最常见),别印出「换成了 v1、跑的还是
 *   v1」这种自相矛盾的话;
 * - 不知道 / 没在跑它 —— 只说得出盘上那一版装好了而换不上。
 */
function headlineOf(stagedVersion: string, runningVersion: string | undefined): string {
	if (runningVersion === undefined) {
		return `v${stagedVersion} 装好了,但这个进程早就认下了它的另一份代码,换不上。`;
	}
	if (runningVersion === stagedVersion) {
		return "盘上的代码换过了(版本号没变),这里跑的还是原来那份。";
	}
	return `盘上换成了 v${stagedVersion},这里跑的还是 v${runningVersion}。`;
}

/**
 * 从拓展表那一行读出这块提示要的两个版本号。没有 `staged` 就是 `null` —— 那时**不许**画这块
 * (生产上不给随手重载的口子)。
 *
 * 两种样子(契约 `ExtensionDTO.staged`):跑着的那一行 `version` 是旧的、`staged.version` 是
 * 新的;`state: "staged"` 那一行开着却没跑,`version` 已经是新的,没有「跑着的」那一版可说。
 */
export function stagedFactsOf(
	ext: ExtensionDTO,
): { stagedVersion: string; runningVersion?: string } | null {
	if (!ext.staged) return null;
	return ext.state === "running" && ext.version !== undefined
		? { stagedVersion: ext.staged.version, runningVersion: ext.version }
		: { stagedVersion: ext.staged.version };
}

/**
 * 「只重载」的代价,写在按钮旁边(决策 47)。三句各有出处:别的不断是它比重启好的地方;内存那句
 * 是 ESM 模块缓存删不掉(桥实测每换一次约 2~3 MB);后台那句是决策 10 的承重条件 —— 拓展绕过
 * ctx 自己起的定时器 / 连接,收摊收不到。主人是照着这几句选的,少一句就是替他选了。
 */
const SWAP_COST =
	"别的推送与直播监听都不断;旧代码占的内存要等下次重启 BN 才还回来(每换一次约几 MB,反复换会一直累加);" +
	"拓展要是有没交给 BN 管的定时器或连接,旧的那份可能还在后台跑。";

/** 一条出路:按钮(可能没有)+ 它的代价 / 为什么没有按钮。两条并排时各占一半。 */
function Way({ action, children }: { action: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-1 basis-56 flex-col items-start gap-1.5">
			{action}
			<span className="text-bn-2xs leading-[1.6] text-bn-text-tertiary">{children}</span>
		</div>
	);
}

export interface StagedCodeNoteProps {
	/** 拓展 id —— 「只重载」打的是 `POST /api/ext/<id>/swap`。 */
	id: string;
	/** 盘上那份(等着换上的)版本号。 */
	stagedVersion: string;
	/** 跑着的那份的版本号 —— 只有「旧的照跑」那一档有;不给 = 没在跑它 / 这一刻不知道。 */
	runningVersion?: string;
	/** 摆在那句话最前面的名字。装完那句话要;详情页的头卡标题已经是名字了,不给。 */
	name?: string;
	/** 这台机器上「重启 BN」按下去回不回得来(ADR-0005 决策 22)。 */
	restart: RestartAbility;
	/** 等待参数,只有测试会给。 */
	wait?: RestartWait;
	/** 两条出路之后顺带挂的东西(装完那句话的文档链接)—— 排在后面:先看见要做的事。 */
	children?: ReactNode;
}

export function StagedCodeNote({
	id,
	stagedVersion,
	runningVersion,
	name,
	restart,
	wait = DEFAULT_RESTART_WAIT,
	children,
}: StagedCodeNoteProps) {
	const qc = useQueryClient();
	const { view, begin } = useRestartStore();
	const restartNow = useMutation({
		mutationFn: () => api.post<RestartResponse>("/api/system/restart", {}),
		onSuccess: ({ startedAt, version }) =>
			begin({ before: startedAt, target: version, mode: "restart" }, wait),
	});
	/*
	 * 成了就把拓展表与它的状态都刷掉:跑的换了一份代码,那一行的版本 / 状态、它交的视图与 bot
	 * 都可能跟着变。换上去之后 `activate` 炸了也是 200 —— 那一行成了「加载失败」,原因在表里。
	 */
	const swap = useMutation({
		mutationFn: () => api.post<{ ok: true }>(`/api/ext/${id}/swap`, {}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
			void qc.invalidateQueries({ queryKey: extensionStatusKey(id) });
			void qc.invalidateQueries({ queryKey: extensionBotsKey(id) });
		},
	});
	const waiting = view?.intent.mode === "restart" && view.kind === "waiting";
	const busy = restartNow.isPending || swap.isPending || waiting;

	/*
	 * 换上了就只剩这一句。详情页那一块会随拓展表刷新消失,**装完那句话里的这一块不会**(它挂在
	 * 装的那一刻的回答上)—— 还摆着「换不上」与两颗钮的话三句话自相矛盾,再按一下只换来 409。
	 */
	if (swap.isSuccess) {
		return (
			<HintNote tone="neutral" className="flex flex-col gap-2.5">
				<p className={PARAGRAPH_CLS}>
					{name ? <strong className="text-bn-text-secondary">{name} </strong> : null}
					重载完了 —— 起没起来,以它那张卡上的状态为准。
				</p>
				{children}
			</HintNote>
		);
	}

	return (
		<HintNote tone="neutral" className="flex flex-col gap-2.5">
			<p className={PARAGRAPH_CLS}>
				{name ? <strong className="text-bn-text-secondary">{name} </strong> : null}
				{headlineOf(stagedVersion, runningVersion)}
			</p>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2.5">
				<Way
					action={
						restart.can ? (
							<Btn variant="primary" size="sm" disabled={busy} onClick={() => restartNow.mutate()}>
								重启 BN
							</Btn>
						) : null
					}
				>
					{restart.can ? "最干净的换法:所有推送与直播监听会断几秒。" : whyNoButton(restart.reason)}
				</Way>
				<Way
					action={
						<Btn variant="outline" size="sm" disabled={busy} onClick={() => swap.mutate()}>
							只重载这个拓展
						</Btn>
					}
				>
					{SWAP_COST}
				</Way>
			</div>
			{children}

			{waiting ? (
				<LoadingBlock variant="inset" label="正在重启" hint="服务回来后这一页会自动刷新。" />
			) : null}
			{restartNow.isError ? (
				<ErrorNote size="sm">没能发出重启指令:{reasonOf(restartNow.error)}</ErrorNote>
			) : null}
			{swap.isError ? <ErrorNote size="sm">没换上:{reasonOf(swap.error)}</ErrorNote> : null}
		</HintNote>
	);
}
