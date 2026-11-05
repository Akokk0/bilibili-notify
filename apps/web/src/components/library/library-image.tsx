import { HintNote, Icon, IconButton } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { useAssetObjectUrl } from "../../pages/cards/useAssetObjectUrl";

export function LibraryImage({ id, alt }: { id: string; alt: string }) {
	const url = useAssetObjectUrl(id);
	return url ? (
		<img src={url} alt={alt} className="h-full w-full object-cover" />
	) : (
		<span className="grid h-full w-full place-items-center bg-bn-surface-muted text-bn-text-tertiary">
			<Icon.image size={20} />
		</span>
	);
}
export function LibraryOrderBadge({
	missing = false,
	children,
}: {
	missing?: boolean;
	children: ReactNode;
}) {
	return (
		<span
			className={`absolute left-1 top-1 grid h-5 min-w-5 place-items-center rounded-md px-1 text-bn-micro font-bold text-bn-on-solid ${missing ? "bg-bn-danger-text" : "bg-bn-pink"}`}
		>
			{children}
		</span>
	);
}
export function MissingLibraryImage({ order, onRemove }: { order: number; onRemove: () => void }) {
	const t = useT();
	return (
		<HintNote
			tone="danger"
			className="relative grid aspect-[16/10] w-24 shrink-0 place-items-center rounded-lg text-bn-2xs"
		>
			<span
				data-testid="gallery-ghost"
				className="contents"
				title={t("library.images.missingHint")}
			>
				<LibraryOrderBadge missing>{order + 1}</LibraryOrderBadge>
				{t("library.images.missing")}
				<IconButton
					icon={<Icon.close size={11} />}
					label={t("library.images.removeMissing")}
					tone="danger"
					size="sm"
					className="absolute right-1 top-1"
					onClick={onRemove}
				/>
			</span>
		</HintNote>
	);
}
