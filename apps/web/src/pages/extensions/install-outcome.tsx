/**
 * 「装完那句话」—— 传包装与从市场装**共用**这一块(装完的回答是同一个形状)。
 *
 * 三种结局的出路完全不同:热装好了(什么都不用做)、盖掉了一份这个进程跑过的(新版等着换上,
 * 出口有两个 —— 重启 BN 或只重载这个拓展,ADR-0012 决策 47)、装失败(原因由调用方另行摆出来,
 * 不在这里)。
 *
 * ⛔ **那颗重启按钮只在确实需要它的这件事旁边出现**(ADR-0005 决策 22):面板上没有常驻的重启
 * 入口 —— 重启是**刚做完这件事**的后果,不是一个随时可按的动作。这台机器上按了回不来
 * (开发版 / 裸跑)就不给按钮,但要把原因写出来。那一整块与详情页头卡共用(`StagedCodeNote`)。
 */

import type { ExtensionInstallResponse } from "@bilibili-notify/contract";
import { HintNote, MonoChip, WarnNote } from "@bilibili-notify/ui";
import { Link } from "react-router-dom";
import { DEFAULT_RESTART_WAIT, type RestartWait } from "../../components/update/restart";
import { i18n, useT } from "../../i18n";
import { StagedCodeNote } from "./staged-code-note";

/**
 * 装完这一刻该把人往哪儿引。**凭的是服务端拆包时答好的 `done.docs`,不猜** —— 挂一颗
 * 「看看说明」点进去却什么都没有,比不挂更糟。
 *
 * 刚盖掉一份跑着的,最想知道的是「这次改了啥」,那是 CHANGELOG 不是 README。
 */
function docsLabel(done: ExtensionInstallResponse): string | null {
	// 🔴 契约里这一格是**可选**的:应用内自更新那几秒,面板与服务端的版本可能对不上,
	// 老服务端的回应里没有它。缺了当没有,与 `isExtensionEnabled` 那条「缺失 = 关着」
	// 同一个路子 —— 少一颗钮是小事,把整块「装好了」炸掉是大事。
	const docs = done.docs;
	if (!docs) return null;
	if (done.staged && docs.changelog) return i18n.t("panelUi.pages.extensions.install-outcome.1");
	if (docs.readme) return i18n.t("panelUi.pages.extensions.install-outcome.2");
	if (docs.changelog) return i18n.t("panelUi.pages.extensions.install-outcome.3");
	return null;
}

function DocsLink({ done }: { done: ExtensionInstallResponse }) {
	const label = docsLabel(done);
	if (!label) return null;
	/*
	 * 🔴 **等着换上那一档另开一页。** 这块提示整个住在调用方的一个局部 `useState` 里,路由
	 * 一跳就卸载。详情页头卡上虽然也有同一块两条出路(决策 47),但「刚装的是哪个包、装成了
	 * 什么」这句话就没了,读完更新日志回来面对的是一页没头没尾的提示。新装那一档没有待办
	 * 事项,丢了也不可惜,就地跳更顺手。
	 */
	const keepThisPage = done.staged;
	return (
		<Link
			to={`/extensions/${done.id}`}
			{...(keepThisPage ? { target: "_blank", rel: "noopener" } : {})}
			className="shrink-0 self-start font-bold text-bn-pink underline decoration-from-font underline-offset-2"
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

/**
 * 包里被跳过的语言文件(ADR-0037 决策 14):长得像语言码、BN 语言表里却没有的 `locales/*.json`,
 * 照装但没写进盘 —— 装的人得知道,否则他会以为那份译文在用。**有才出现**,三种结局都可能带。
 */
function SkippedLocalesNote({ done }: { done: ExtensionInstallResponse }) {
	const t = useT();
	// 🔴 契约里这一格是**可选**的(老服务端没有),缺了与空数组一样:不画。
	const files = done.skippedLocales ?? [];
	if (files.length === 0) return null;
	return (
		<WarnNote size="sm">
			<div>{t("extension.install.skippedLocales")}</div>
			<ul className="mt-1 flex flex-wrap gap-1.5">
				{files.map((file) => (
					<li key={file}>
						<MonoChip>{file}</MonoChip>
					</li>
				))}
			</ul>
		</WarnNote>
	);
}

export function ExtensionInstallOutcome(props: ExtensionInstallOutcomeProps) {
	if (!props.done) return null;
	return (
		<>
			<InstallOutcomeBody {...props} />
			<SkippedLocalesNote done={props.done} />
		</>
	);
}

function InstallOutcomeBody({ done, wait = DEFAULT_RESTART_WAIT }: ExtensionInstallOutcomeProps) {
	const tx = useT();

	if (!done) return null;
	/*
	 * 🔴 老服务端(应用内自更新那几秒)回的是 `needsRestart` 而没有 `staged` —— 缺了就落到
	 * 「装好了」那一句,不去读它没给的东西。少一块提示是小事,整块炸掉是大事。
	 */
	if (done.staged && !done.enabled) {
		/*
		 * 关着装进去的,而这个进程跑过它别的代码(决策 47):拨开也只会停在「新版等着换上」。
		 * 现在就说,但**不给**那两颗钮 —— 「只重载」只在开着时给(按下去等于替主人把开关拨开),
		 * 重启指去它那一页(那一行也带着 `staged`,头卡里有同一块)。
		 */
		return (
			<HintNote tone="neutral" className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span>
					<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
					{tx("panelUi.pages.extensions.install-outcome.4")}
				</span>
				<DocsLink done={done} />
			</HintNote>
		);
	}
	if (done.staged) {
		return (
			<StagedCodeNote
				id={done.id}
				name={done.name}
				stagedVersion={done.version}
				// 走到这儿的都开着(关着的上面那一支接走了)—— 只重载给。
				swappable
				restart={done.restart}
				wait={wait}
			>
				{/* 排在两条出路之后:先看见要做的那件事,再看见可以顺便读的那份。 */}
				<DocsLink done={done} />
			</StagedCodeNote>
		);
	}
	return (
		<HintNote
			tone={done.enabled ? "success" : "neutral"}
			className="flex flex-wrap items-center gap-x-2 gap-y-1"
		>
			<span>
				<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
				{done.enabled
					? tx("panelUi.pages.extensions.install-outcome.5")
					: tx("panelUi.pages.extensions.install-outcome.6")}
			</span>
			<DocsLink done={done} />
		</HintNote>
	);
}
