import {
	BUILTIN_UPDATE_MIRRORS,
	isMirrorPrefix,
	type MirrorProbeResponse,
	type MirrorProbeResult,
} from "@bilibili-notify/contract";
import { Btn, Input, Pill, ToneChip } from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../services/api";

/**
 * 下载加速站的选择表 —— 照 OpenClash 的骨架砍到够用:直连打头、内置几个候选、末尾一行
 * 自定义;每行是 地址 | 延迟 | 通过它看到的清单版本 | 选用。
 *
 * **默认直连、只能选一个。** 选中的排链路最前,直连永远垫底(那条不变)。所以设置里
 * `mirrors` 要么空、要么一项 —— 结构没改,这块只是给它一个能测、能挑的壳。
 *
 * 「测一遍」走服务端:浏览器直接打代理站会被 CORS 挡,而且真正下载的是服务端那台机器,
 * 从它测才作数。
 */

export interface MirrorPickerProps {
	/** 正在用的前缀;空串 = 直连。 */
	active: string;
	onSelect: (prefix: string) => void;
	/** 功能关着(没内置公钥)时整块只看不动。 */
	disabled?: boolean;
}

const FAILURE_LABEL: Record<Extract<MirrorProbeResult, { ok: false }>["reason"], string> = {
	unreachable: "无法访问",
	// 唯一该让人警觉的一种 —— 别和「连不上」混成一句。
	untrusted: "签名验不过",
	malformed: "清单不成形",
	stale: "缓存了旧清单",
};

const isBuiltin = (p: string): boolean => BUILTIN_UPDATE_MIRRORS.includes(p);

function hostOf(prefix: string): string {
	try {
		return new URL(prefix).host;
	} catch {
		return prefix;
	}
}

export function MirrorPicker({ active, onSelect, disabled = false }: MirrorPickerProps) {
	// 在用的不是内置的,那它就是之前填的自定义 —— 预填回输入框。
	const [custom, setCustom] = useState(() => (active !== "" && !isBuiltin(active) ? active : ""));
	const [results, setResults] = useState<Record<string, MirrorProbeResult>>({});
	const probe = useMutation({
		mutationFn: (prefixes: string[]) =>
			api.post<MirrorProbeResponse>("/api/update/mirrors/probe", { prefixes }),
		onSuccess: (res) =>
			setResults(Object.fromEntries(res.results.map((r) => [r.prefix, r] as const))),
	});

	const customPrefix = custom.trim();
	const customValid = isMirrorPrefix(customPrefix);
	const prefixes = ["", ...BUILTIN_UPDATE_MIRRORS, ...(customValid ? [customPrefix] : [])];

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-bn-sm text-bn-text-secondary">下载加速</span>
				<Btn
					size="sm"
					variant="outline"
					disabled={disabled || probe.isPending}
					onClick={() => probe.mutate(prefixes)}
				>
					{probe.isPending ? "测速中…" : "测一遍"}
				</Btn>
				{probe.isError ? (
					<span className="text-bn-xs text-bn-danger">
						测不了:{String((probe.error as Error).message)}
					</span>
				) : null}
			</div>
			<span className="text-bn-xs text-bn-text-tertiary">
				连不上 GitHub 时选一个代理站:选中的先试,直连永远垫底。更新包有签名,代理站改不了内容 ——
				最多只能让这次下载失败。「版本」是通过那个站拿到的清单版本,比别家旧就是它缓存了。
			</span>
			<div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1.5">
				<MirrorRow
					prefix=""
					result={results[""]}
					active={active === ""}
					disabled={disabled}
					onSelect={onSelect}
				>
					<span className="text-bn-xs text-bn-text-primary">直连</span>
				</MirrorRow>
				{BUILTIN_UPDATE_MIRRORS.map((p) => (
					<MirrorRow
						key={p}
						prefix={p}
						result={results[p]}
						active={active === p}
						disabled={disabled}
						onSelect={onSelect}
					>
						<span className="truncate font-mono text-bn-xs text-bn-text-primary">{hostOf(p)}</span>
					</MirrorRow>
				))}
				<MirrorRow
					prefix={customPrefix}
					// 输入还空着时别和直连那行(空串)撞了身份。
					rowId={customPrefix === "" ? "custom" : customPrefix}
					result={customValid ? results[customPrefix] : undefined}
					active={customPrefix !== "" && active === customPrefix}
					disabled={disabled || !customValid}
					onSelect={onSelect}
				>
					<Input
						size="sm"
						full
						value={custom}
						onChange={setCustom}
						placeholder="https://ghproxy.example/"
					/>
				</MirrorRow>
			</div>
		</div>
	);
}

function MirrorRow({
	prefix,
	rowId = prefix,
	result,
	active,
	disabled,
	onSelect,
	children,
}: {
	prefix: string;
	/** 行的身份(测试与阅读用),缺省就是前缀本身。 */
	rowId?: string;
	result: MirrorProbeResult | undefined;
	active: boolean;
	disabled: boolean;
	onSelect: (prefix: string) => void;
	children: React.ReactNode;
}) {
	return (
		// `contents`:这一层只为给测试与阅读一个「行」的身份,四个格子仍直接落在网格里。
		<div className="contents" data-mirror={rowId}>
			{children}
			{result === undefined ? (
				<Dash />
			) : result.ok ? (
				<Pill subtle size="sm" color="var(--color-bn-success)">
					{result.ms} ms
				</Pill>
			) : (
				<Pill subtle size="sm" color="var(--color-bn-danger)">
					{FAILURE_LABEL[result.reason]}
				</Pill>
			)}
			{result?.ok ? (
				<Pill subtle size="sm" color="var(--color-bn-blue)">
					{result.version}
				</Pill>
			) : (
				<Dash />
			)}
			<ToneChip
				tone="var(--color-bn-pink)"
				active={active}
				disabled={disabled || active}
				onClick={() => onSelect(prefix)}
			>
				{active ? "使用中" : "选用"}
			</ToneChip>
		</div>
	);
}

function Dash() {
	return <span className="text-bn-xs text-bn-text-tertiary">—</span>;
}
