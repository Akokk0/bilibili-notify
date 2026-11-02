import { OnboardingReopenSection } from "../../components/onboarding/reopen-section";
import { UpdateSection } from "../../components/update/update-section";
import { BackupSection } from "../backup/BackupSection";

export function MaintenanceSection() {
	return (
		<>
			<BackupSection />
			<UpdateSection />
			<OnboardingReopenSection />
		</>
	);
}
