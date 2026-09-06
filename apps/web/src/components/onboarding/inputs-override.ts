import { create } from "zustand";
import type { OnboardingInputs } from "./derive";

/**
 * 新手指引判据的**输入**覆盖(devtools 用):装上一份假输入,`useOnboardingState` 就按它算,
 * 真查询照跑不看。只在开发期被写;生产里永远是 null。
 *
 * 覆盖的是输入不是结果:derive 那套纯函数照常跑,看到的每一步「该亮谁」都是真算出来的。
 */
export const useOnboardingInputsOverride = create<{
	inputs: OnboardingInputs | null;
	set: (inputs: OnboardingInputs | null) => void;
}>((set) => ({
	inputs: null,
	set: (inputs) => set({ inputs }),
}));
