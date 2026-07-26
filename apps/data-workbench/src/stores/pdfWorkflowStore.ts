import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  FileMapping,
  Progress,
  Publication,
  StagingResult,
} from "../lib/api";

export type PdfStep =
  "publication" | "folder" | "mapping" | "processing" | "complete";

export interface PdfWorkflowState {
  step: PdfStep;
  publication?: Publication;
  sourceDir: string;
  mapping: FileMapping[];
  aiPrompt?: string;
  taskId?: string;
  stagingId?: string;
  progress?: Progress;
  staging?: StagingResult;
  isNewPublication: boolean;
  coverImageData?: string;
  setStep: (step: PdfStep) => void;
  setPublication: (publication: Publication, isNew?: boolean) => void;
  setCoverImage: (coverImageData?: string) => void;
  setSourceDir: (sourceDir: string) => void;
  setScan: (mapping: FileMapping[], aiPrompt?: string) => void;
  setTask: (taskId: string, stagingId: string, clearStaging?: boolean) => void;
  setProgress: (progress: Progress) => void;
  setStaging: (staging: StagingResult) => void;
  reset: () => void;
}

const initial = {
  step: "publication" as PdfStep,
  sourceDir: "",
  mapping: [],
  isNewPublication: false,
};

export const usePdfWorkflow = create<PdfWorkflowState>()(
  persist(
    (set) => ({
      ...initial,
      setStep: (step) => set({ step }),
      setPublication: (publication, isNew = false) =>
        set({
          publication,
          isNewPublication: isNew,
          coverImageData: undefined,
          sourceDir: "",
          mapping: [],
          taskId: undefined,
          stagingId: undefined,
          progress: undefined,
          staging: undefined,
          step: "folder",
        }),
      setCoverImage: (coverImageData) => set({ coverImageData }),
      setSourceDir: (sourceDir) => set({ sourceDir }),
      setScan: (mapping, aiPrompt) =>
        set({ mapping, aiPrompt, step: "mapping" }),
      setTask: (taskId, stagingId, clearStaging = false) =>
        set((state) => ({
          taskId,
          stagingId,
          progress: undefined,
          staging: clearStaging ? undefined : state.staging,
          step: "processing",
        })),
      setProgress: (progress) => set({ progress }),
      setStaging: (staging) =>
        set({ staging, stagingId: staging.staging_id, step: "processing" }),
      reset: () => set(initial),
    }),
    {
      name: "jojo-pipe-pdf-workflow",
      partialize: ({ progress: _progress, ...state }) => state,
    },
  ),
);
