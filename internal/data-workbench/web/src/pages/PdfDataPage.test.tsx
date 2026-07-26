import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfDataPage } from "./PdfDataPage";
import { usePdfWorkflow } from "../stores/pdfWorkflowStore";

const pdfApiMock = vi.hoisted(() => ({
  publications: vi.fn().mockResolvedValue({ success: true, publications: [] }),
  createPublication: vi.fn(),
  browseFolder: vi.fn(),
  scan: vi.fn(),
  applyRule: vi.fn(),
  saveRule: vi.fn(),
  iterateRule: vi.fn(),
  stage: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  previewVue: vi.fn(),
  applyVue: vi.fn(),
}));

vi.mock("../pdf/api", () => ({ pdfApi: pdfApiMock }));

class FakeEventSource {
  static current?: FakeEventSource;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.current = this;
  }

  close() {
    this.closed = true;
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

const publication = {
  code: "TEST",
  name: "测试报",
  type: "newspaper" as const,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", FakeEventSource);
  usePdfWorkflow.setState({
    step: "publication",
    publication: undefined,
    sourceDir: "",
    mapping: [],
    aiPrompt: undefined,
    taskId: undefined,
    stagingId: undefined,
    progress: undefined,
    staging: undefined,
    isNewPublication: false,
    coverImageData: undefined,
  });
});

describe("PDF data workflow", () => {
  it("uses the backend results field and exposes commit after staging completes", async () => {
    usePdfWorkflow.setState({
      step: "processing",
      publication,
      sourceDir: "C:/pdf",
      mapping: [
        { original: "a.pdf", renamed: "TEST20260101.pdf", success: true },
      ],
      taskId: "stage-1",
      stagingId: "staging-1",
    });

    render(<PdfDataPage />);
    await waitFor(() =>
      expect(FakeEventSource.current?.url).toContain("stage-1"),
    );

    act(() => {
      FakeEventSource.current?.emit({
        status: "completed",
        task_type: "staging",
        results: {
          success: true,
          staging_id: "staging-1",
          preview: [{ original: "a.pdf", renamed: "TEST20260101.pdf" }],
        },
      });
    });

    expect(
      await screen.findByRole("button", { name: "确认提交" }),
    ).toBeEnabled();
  });

  it("persists the new-publication identity used by staging and commit", () => {
    act(() => usePdfWorkflow.getState().setPublication(publication, true));

    const persisted = localStorage.getItem("jojo-pipe-pdf-workflow");
    expect(persisted).toContain('"isNewPublication":true');
    expect(usePdfWorkflow.getState().isNewPublication).toBe(true);
  });

  it("does not allow jumping directly to completion", async () => {
    render(<PdfDataPage />);
    await waitFor(() => expect(pdfApiMock.publications).toHaveBeenCalled());
    const complete = screen.getByRole("button", { name: /05\s*完成/ });
    expect(complete).toBeDisabled();
    fireEvent.click(complete);
    expect(screen.queryByText("数据发布完成")).not.toBeInTheDocument();
  });
});
