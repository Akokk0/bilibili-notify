/** The field stays in its original form; selection is staged in the shared library dialog. */

import { useLibrary } from "../../components/library/library-data";
import {
	LibraryImage,
	LibraryOrderBadge,
	MissingLibraryImage,
} from "../../components/library/library-image";
import { LibraryPicker } from "../../components/library/library-picker";
import { useT } from "../../i18n";
import { removeFromGallery } from "./gallery-ops";

export function GalleryPicker({
	value,
	onChange,
	onAssetDeleted,
	emptyHint,
	singleHint,
}: {
	value: string[];
	onChange: (next: string[]) => void;
	onAssetDeleted?: (id: string) => void;
	emptyHint?: string;
	singleHint?: string;
}) {
	const t = useT(),
		list = useLibrary("images");
	const known = list.isSuccess && !list.isError;
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-end">
				<LibraryPicker
					kind="images"
					value={value}
					onChange={onChange}
					onAssetDeleted={(id) => {
						onChange(removeFromGallery(value, id));
						onAssetDeleted?.(id);
					}}
				/>
			</div>
			<div className="flex flex-wrap gap-2">
				{value.map((id, index) =>
					known && !list.entries.some((entry) => entry.id === id) ? (
						<MissingLibraryImage
							key={id}
							order={index}
							onRemove={() => onChange(removeFromGallery(value, id))}
						/>
					) : (
						<span
							key={id}
							className="relative aspect-[16/10] w-24 overflow-hidden rounded-lg border border-bn-border-subtle"
						>
							<LibraryImage id={id} alt={t("library.images.image")} />
							<LibraryOrderBadge>{index + 1}</LibraryOrderBadge>
						</span>
					),
				)}
			</div>
			<p className="text-bn-2xs text-bn-text-tertiary">
				{value.length === 0
					? (emptyHint ?? t("library.images.empty"))
					: value.length === 1
						? (singleHint ?? t("library.images.single"))
						: t("library.images.rotation", { count: value.length })}
			</p>
		</div>
	);
}
