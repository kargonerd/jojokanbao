import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileMapping, Progress, Publication, StagingResult } from "../lib/api";

export type PdfStep = "publication" | "folder" | "mapping" | "processing" | "complete";

interface PdfWorkflowState {
  step: PdfStep;
  publication?: Publication;
  sourceDir: string;
  mapping: FileMapping[];
  aiPrompt?: string;
  taskId?: string;
  stagingId?: string;
  progress?: Progress;
  staging?: StagingResult;
  setStep: (step: PdfStep) => void;
  setPublication: (publication: Publication) => void;
  setSourceDir: (sourceDir: string) => void;
  setScan: (mapping: FileMapping[], aiPrompt?: string) => void;
  setTask: (taskId: string, stagingId: string) => void;
  setProgress: (progress: Progress) => void;
  setStaging: (staging: StagingResult) => void;
  reset: () => void;
}

const initial = {
  step: "publication" as PdfStep,
  sourceDir: "",
  mapping: [],
};

export const usePdfWorkflow = create<PdfWorkflowState>()(
  persist(
    (set) => ({
      ...initial,
      setStep: (step) => set({ step }),
      setPublication: (publication) => set({ publication, step: "folder" }),
      setSourceDir: (sourceDir) => set({ sourceDir }),
      setScan: (mapping, aiPrompt) => set({ mapping, aiPrompt, step: "mapping" }),
      setTask: (taskId, stagingId) => set({ taskId, stagingId, step: "processing" }),
      setProgress: (progress) => set({ progress }),
      setStaging: (staging) => set({ staging, stagingId: staging.staging_id, step: "processing" }),
      reset: () => set(initial),
    }),
    { name: "jojo-pipe-pdf-workflow" },
  ),
);
