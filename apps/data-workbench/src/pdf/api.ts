import {
  apiGet,
  apiPost,
  type ApiResult,
  type FileMapping,
  type Publication,
  type RuleResponse,
  type ScanResponse,
  type TaskResponse,
  type VuePreview,
} from "../lib/api";

export const pdfApi = {
  publications: () =>
    apiGet<{ success: boolean; publications: Publication[] }>(
      "/api/publications",
    ),

  createPublication: (
    publication: Pick<Publication, "code" | "name" | "type"> &
      Partial<Publication>,
  ) =>
    apiPost<{ success: boolean; publication: Publication }>(
      "/api/publications",
      publication,
    ),

  browseFolder: () =>
    apiPost<{ success: boolean; path: string }>("/api/browse-folder"),

  fetchDescription: (name: string) =>
    apiPost<{ success: boolean; description: string; source: string }>(
      "/api/fetch-baike",
      { name },
    ),

  scan: (sourceDir: string, publication: Publication) =>
    apiPost<ScanResponse>("/api/scan-files", {
      source_dir: sourceDir,
      pub_code: publication.code,
      pub_type: publication.type,
      pub_name: publication.name,
    }),

  applyRule: (
    rule: Record<string, unknown>,
    failedFiles: string[],
    publication: Publication,
  ) =>
    apiPost<RuleResponse>("/api/apply-custom-rule", {
      rule,
      failed_files: failedFiles,
      pub_type: publication.type,
    }),

  saveRule: (rule: Record<string, unknown>, publication: Publication) =>
    apiPost<ApiResult>("/api/save-custom-rule", {
      pub_code: publication.code,
      rule,
    }),

  iterateRule: (
    publication: Publication,
    successful: FileMapping[],
    remaining: FileMapping[],
  ) =>
    apiPost<{ success: boolean; ai_prompt: string }>(
      "/api/generate-iteration-prompt",
      {
        pub_type: publication.type,
        pub_name: publication.name,
        success_samples: successful,
        remaining_failed: remaining.map((item) => item.original),
      },
    ),

  stage: (
    sourceDir: string,
    publication: Publication,
    mapping: FileMapping[],
    isNew: boolean,
  ) =>
    apiPost<TaskResponse>("/api/start-staging", {
      source_dir: sourceDir,
      pub_code: publication.code,
      mapping,
      new_pub_config: isNew ? publication : null,
    }),

  commit: (stagingId: string, publication: Publication, isNew: boolean) =>
    apiPost<TaskResponse>("/api/commit-files", {
      staging_id: stagingId,
      pub_code: publication.code,
      new_pub_config: isNew ? publication : null,
    }),

  cancel: (stagingId: string, taskId?: string) =>
    apiPost<ApiResult>("/api/cancel-staging", {
      staging_id: stagingId,
      task_id: taskId,
      force_wait: true,
    }),

  previewVue: (publication: Publication, isNew: boolean) =>
    isNew
      ? apiPost<VuePreview>(
          `/api/publications/${publication.code}/generate-vue`,
          { pub_info: publication },
        )
      : apiPost<VuePreview>("/api/generate-vue-preview", {
          pub_code: publication.code,
        }),

  applyVue: (
    publication: Publication,
    preview: VuePreview,
    isNew: boolean,
    coverImageData?: string,
  ) => {
    if (isNew) {
      const files =
        preview.multi_file_diff?.files.map(({ filepath, new_code }) => ({
          filepath,
          new_code,
        })) || [];
      return apiPost<ApiResult>(
        `/api/publications/${publication.code}/apply-changes`,
        {
          files,
          pub_info: publication,
          image_data: coverImageData,
        },
      );
    }
    return apiPost<ApiResult>("/api/apply-vue-changes", {
      pub_code: publication.code,
      new_vue_code: preview.new_code,
    });
  },
};
