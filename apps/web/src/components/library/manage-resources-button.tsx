import { Btn, Icon } from "@bilibili-notify/ui";
import { useNavigate } from "react-router-dom";
import { useT } from "../../i18n";
import type { ResourceCategory } from "./library-data";

/** 用当前页面路由定位到对应分类，不提交选择窗中未确认的值。 */
export function ManageResourcesButton({
	category,
	label,
}: {
	category: ResourceCategory;
	label?: string;
}) {
	const t = useT();
	const navigate = useNavigate();
	return (
		<Btn
			size="sm"
			variant="outline"
			icon={<Icon.link size={14} />}
			title={t("library.manageResourcesHint")}
			onClick={() => navigate(`/library?category=${category}`)}
		>
			{label ?? t("library.manageResources")}
		</Btn>
	);
}
