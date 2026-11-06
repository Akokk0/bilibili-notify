import { GlassPanel, Icon, SectionNav } from "@bilibili-notify/ui";
import { useSearchParams } from "react-router-dom";
import { HeroStrip } from "../components/hero-strip";
import { LibraryBrowser } from "../components/library/library-browser";
import type { LibraryKind } from "../components/library/library-data";
import { useT } from "../i18n";
export default function Library() {
	const t = useT();
	const [params, setParams] = useSearchParams();
	const kind: LibraryKind = params.get("category") === "fonts" ? "fonts" : "images";
	const categories = [
		{
			id: "images",
			label: t("library.imagesTitle"),
			desc: t("library.imagesDescription"),
			icon: <Icon.image size={20} />,
		},
		{
			id: "fonts",
			label: t("library.fontsTitle"),
			desc: t("library.fontsDescription"),
			icon: <Icon.list size={20} />,
		},
	];
	const category = categories.find((item) => item.id === kind);
	return (
		<div className="grid min-w-0 grid-cols-1 gap-5">
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
			<div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-bn-rail">
				<SectionNav
					heading={t("library.categoriesTitle")}
					items={categories}
					activeId={kind}
					onPick={(id) => {
						if (id === kind) return;
						setParams((previous) => {
							const next = new URLSearchParams(previous);
							next.set("category", id);
							return next;
						});
					}}
				/>
				<GlassPanel title={category?.label} subtitle={category?.desc}>
					<LibraryBrowser key={kind} kind={kind} />
				</GlassPanel>
			</div>
		</div>
	);
}
