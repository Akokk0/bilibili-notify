import { GlassPanel, Icon, SectionNav } from "@bilibili-notify/ui";
import { useSearchParams } from "react-router-dom";
import { HeroStrip } from "../components/hero-strip";
import { LibraryBrowser } from "../components/library/library-browser";
import type { ResourceCategory } from "../components/library/library-data";
import { useT } from "../i18n";
import { MaidSkills } from "./ai/MaidSkills";
import { PersonaLibrary } from "./ai/PersonaLibrary";
import { CardSkinSection } from "./cards/CardSkinSection";
import { SkinSection } from "./skins/SkinSection";
export default function Library() {
	const t = useT();
	const [params, setParams] = useSearchParams();
	const requested = params.get("category");
	const kind: ResourceCategory =
		requested === "fonts" ||
		requested === "dashboard-skins" ||
		requested === "card-skins" ||
		requested === "skills" ||
		requested === "personas"
			? requested
			: "images";
	const categories = [
		{
			id: "images",
			label: t("library.imagesTitle"),
			desc: t("library.imagesDescription"),
			icon: <Icon.image size={15} />,
		},
		{
			id: "fonts",
			label: t("library.fontsTitle"),
			desc: t("library.fontsDescription"),
			icon: <Icon.list size={15} />,
		},
		{
			id: "skills",
			label: t("library.skillsTitle"),
			desc: t("library.skillsDescription"),
			icon: <Icon.sparkle size={15} />,
		},
		{
			id: "personas",
			label: t("library.personasTitle"),
			desc: t("library.personasDescription"),
			icon: <Icon.user size={15} />,
		},
		{
			id: "dashboard-skins",
			label: t("library.dashboardSkinsTitle"),
			desc: t("library.dashboardSkinsDescription"),
			icon: <Icon.palette size={15} />,
		},
		{
			id: "card-skins",
			label: t("library.cardSkinsTitle"),
			desc: t("library.cardSkinsDescription"),
			icon: <Icon.eye size={15} />,
		},
	];
	const category = categories.find((item) => item.id === kind);
	return (
		<div className="bn-anim-page-in motion-reduce:animate-none! grid min-w-0 grid-cols-1 gap-5">
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
			<div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-bn-rail">
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
				{kind === "personas" ? (
					<PersonaLibrary />
				) : kind === "skills" ? (
					<MaidSkills />
				) : kind === "dashboard-skins" ? (
					<SkinSection mode="manage" />
				) : kind === "card-skins" ? (
					<CardSkinSection mode="manage" />
				) : (
					<GlassPanel title={category?.label} subtitle={category?.desc}>
						<LibraryBrowser key={kind} kind={kind} />
					</GlassPanel>
				)}
			</div>
		</div>
	);
}
