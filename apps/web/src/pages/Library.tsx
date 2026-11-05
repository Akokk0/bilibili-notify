import { GlassPanel, Icon, Picker } from "@bilibili-notify/ui";
import { useState } from "react";
import { HeroStrip } from "../components/hero-strip";
import { LibraryBrowser } from "../components/library/library-browser";
import type { LibraryKind } from "../components/library/library-data";
import { useT } from "../i18n";
export default function Library() {
	const t = useT();
	const [kind, setKind] = useState<LibraryKind>("images");
	return (
		<div className="grid gap-5">
			<HeroStrip
				icon={<Icon.library size={26} />}
				title={t("library.title")}
				subtitle={
					<>
						<span className="block">{t("library.subtitle")}</span>
						<span className="mt-1 block text-bn-xs">{t("library.scopeHint")}</span>
					</>
				}
			/>
			<GlassPanel>
				<div className="mb-4">
					<Picker
						value={kind}
						onChange={(value) => setKind(value as LibraryKind)}
						options={[
							{ value: "images", label: t("library.imagesTitle") },
							{ value: "fonts", label: t("library.fontsTitle") },
						]}
					/>
				</div>
				<LibraryBrowser key={kind} kind={kind} />
			</GlassPanel>
		</div>
	);
}
