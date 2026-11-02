/** ADR-0035: every target keeps its connection identity, including missing connections. */
import { PlatformIcon, type TSelectOption } from "@bilibili-notify/ui";
import type { Connection, PushTarget } from "../types/domain";
import { DescriptorIcon } from "./platform-meta";

/** Shared by labels and TSelect options; names never become selection values. */
export function targetDisplay(
	target: PushTarget,
	connections: readonly Connection[],
): TSelectOption {
	const connection = connections.find((entry) => entry.id === target.connectionId);
	return {
		value: target.id,
		label: target.name || target.id,
		description: connection?.name || target.connectionId,
		icon: connection?.platformSnapshot ? (
			<DescriptorIcon descriptor={connection.platformSnapshot} size={14} />
		) : (
			<PlatformIcon platform={connection?.platform ?? ""} size={14} />
		),
	};
}

export function TargetLabel({
	target,
	connections,
}: {
	target: PushTarget;
	connections: readonly Connection[];
}) {
	const display = targetDisplay(target, connections);
	return (
		<span
			className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-left"
			title={`${display.label} · ${display.description}`}
		>
			<span aria-hidden="true" className="shrink-0">
				{display.icon}
			</span>
			<span className="min-w-0">
				<span className="block truncate font-semibold">{display.label}</span>
				<span className="block truncate text-bn-xs font-normal text-bn-text-tertiary">
					{display.description}
				</span>
			</span>
		</span>
	);
}
