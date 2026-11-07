import type { ResourceImportPreviewResponse } from "@bilibili-notify/contract";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorTextOf, issueTextsOf } from "../../services/error-text";

type Preview = Extract<ResourceImportPreviewResponse, { ok: true }>;

/** 只管理文件→只读检查→确认→原安装口的生命周期，不注册资源类型或改选用指针。 */
export function useResourceImport<T>({
	previewFile,
	importFile,
	onImported,
}: {
	previewFile: (file: File) => Promise<ResourceImportPreviewResponse>;
	importFile: (file: File) => Promise<T>;
	onImported: (result: T) => unknown | Promise<unknown>;
}) {
	const [review, setReview] = useState<{ file: File; preview: Preview } | null>(null);
	const [error, setError] = useState<string | null>(null),
		[imported, setImported] = useState(false);
	const preview = useMutation({
		mutationFn: previewFile,
		onSuccess: (result, file) => {
			if (!result.ok) {
				setError([result.message, ...issueTextsOf(result)].join("；"));
				return;
			}
			setReview({ file, preview: result });
		},
		onError: (error) => setError(errorTextOf(error)),
	});
	const install = useMutation({
		mutationFn: importFile,
		onSuccess: async (result) => {
			await onImported(result);
			setError(null);
			setReview(null);
			setImported(true);
		},
		onError: (error) => setError(errorTextOf(error)),
	});
	return {
		review,
		error,
		imported,
		busy: preview.isPending || install.isPending,
		pick(file: File) {
			if (preview.isPending || install.isPending) return;
			setError(null);
			setImported(false);
			preview.mutate(file);
		},
		cancel() {
			if (!install.isPending) {
				setReview(null);
				setError(null);
			}
		},
		confirm() {
			if (review && !install.isPending) {
				setError(null);
				install.mutate(review.file);
			}
		},
	};
}
