import type { AccountView, SourceEntry } from "@bilibili-notify/contract";
import { Avatar, Icon } from "@bilibili-notify/ui";
import { imageUrl } from "../../utils/image-url";
import { SourceIcon } from "../platform-meta";

export function accountSourceLabel(
	key: string,
	sources: readonly SourceEntry[] | undefined,
): string {
	return sources?.find((source) => source.key === key)?.descriptor.label ?? key;
}
export function accountPath(key?: string): string {
	return key === undefined
		? "/system#account"
		: `/system?account=${encodeURIComponent(key)}#account`;
}
export function accountRowId(key: string): string {
	return `source-account-${encodeURIComponent(key)}`;
}

export function AccountFace({
	account,
	source,
	size = 36,
}: {
	account?: AccountView;
	source?: SourceEntry;
	size?: number;
}) {
	const loggedIn = account?.state.status === "logged-in";
	const face = loggedIn ? account.account : undefined;
	return (
		<span
			className="relative flex shrink-0 items-center justify-center"
			style={{ width: size, height: size }}
		>
			{face?.avatar ? (
				<Avatar
					name={face.name}
					color={source?.descriptor.color ?? "var(--color-bn-blue)"}
					size={size}
					url={imageUrl(face.avatar)}
				/>
			) : (
				<span className="grid h-full w-full place-items-center rounded-full bg-bn-surface-muted text-bn-text-tertiary">
					<Icon.user size={size * 0.48} />
				</span>
			)}
			{source ? (
				<span className="absolute -bottom-0.5 -right-0.5 rounded bg-bn-surface p-0.5 leading-none">
					<SourceIcon source={source} size={10} />
				</span>
			) : null}
		</span>
	);
}
