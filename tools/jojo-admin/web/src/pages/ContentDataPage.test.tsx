import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentJob, PublisherStatus } from "../content/api";
import { ContentDataPage } from "./ContentDataPage";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const baseJob: ContentJob = {
  jobId: "single-book", status: "ready", phase: "complete", message: "电子书已生成", progress: {},
  createdAt: "2026-09-12T10:00:00Z", updatedAt: "2026-09-12T10:00:00Z", inputPaths: ["朝花夕拾.epub"],
  publicationStatus: "draft", access: "public", outputDirectory: "output", report: null, publish: {}, logs: [],
};
const completed = { status: "completed", publicationStatus: "draft", access: "public", completedAt: "2026-09-12T10:05:00Z" } as const;
let live: ContentJob;
let jobs: ContentJob[];
let publishers: PublisherStatus;
let upload: () => Promise<Response>;
let publish: (body: { targets: string[]; publicationStatus: ContentJob["publicationStatus"]; access: ContentJob["access"] }) => Promise<Response>;
const fetchMock = vi.fn();

beforeEach(() => {
  live = structuredClone(baseJob);
  jobs = [];
  publishers = { huggingface: { configured: true, repoId: "test/books", private: false }, b2: { configured: true, deliveryRemote: "test:books" } };
  upload = async () => response({ success: true, job: live });
  publish = async (body) => {
    live = { ...live, publicationStatus: body.publicationStatus, access: body.access, status: "published", publish: {
      ...live.publish, ...Object.fromEntries(body.targets.map((target) => [target, { ...completed, publicationStatus: body.publicationStatus, access: body.access }])),
    } };
    return response({ success: true, job: live });
  };
  fetchMock.mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === "/api/content/status") return response({ success: true, publishers });
    if (url === "/api/content/jobs") return response({ success: true, jobs });
    if (url === "/api/content/import-files") return upload();
    if (url === `/api/content/jobs/${live.jobId}`) return response({ success: true, job: live });
    if (url === `/api/content/jobs/${live.jobId}/publish`) return publish(JSON.parse(String(options?.body)));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openPage(url = "/content") {
  render(<MemoryRouter initialEntries={[url]}><ContentDataPage /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText("正在读取导入记录…")).not.toBeInTheDocument());
}

const callBody = () => JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith("/publish"))![1].body);

describe("book import and publication steps", () => {
  it("marks an old import and prevents republishing it over the latest version", async () => {
    live = { ...live, newerJobId: "latest-book" };
    jobs = [live];
    await openPage("/content?job=single-book&step=3");
    await screen.findByRole("heading", { name: "设置发布" });
    expect(screen.getByRole("link", { name: "切换到最新版本" })).toHaveAttribute("href", "/content?job=latest-book&step=3");
    expect(screen.getByRole("button", { name: "保存草稿并上传" })).toBeDisabled();
    expect(screen.getByRole("option", { name: /旧版本/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/publish"))).toBe(false);
  });
  it("imports exactly one file locally, then exposes preview before publication settings", async () => {
    await openPage();
    const input = screen.getByLabelText("电子书文件") as HTMLInputElement;
    expect(input.multiple).toBe(false);
    expect(input).not.toHaveAttribute("webkitdirectory");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /03\s*设置发布/ })).toBeDisabled();
    const chosen = new File(["book"], "朝花夕拾.epub");
    fireEvent.change(input, { target: { files: [new File(["first"], "第一本.epub")] } });
    fireEvent.change(input, { target: { files: [chosen] } });
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.getByRole("status")).toHaveTextContent(chosen.name);
    fireEvent.click(screen.getByRole("checkbox", { name: "导入封面与正文图片" }));
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("heading", { name: "检查导入结果" });
    expect(screen.getByRole("link", { name: "打开阅读预览" })).toHaveAttribute("href", "/content/single-book/preview");
    expect(screen.queryByLabelText("电子书文件")).not.toBeInTheDocument();
    const form = fetchMock.mock.calls.find(([url]) => url === "/api/content/import-files")![1].body as FormData;
    expect(form.getAll("files")).toEqual([chosen]);
    expect(form.get("fetchAssets")).toBe("false");
    expect(form.get("publicationStatus")).toBe("draft");
    expect(form.get("access")).toBe("public");
    fireEvent.click(screen.getByRole("button", { name: "确认预览，设置发布" }));
    expect(await screen.findByRole("heading", { name: "设置发布" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^草稿/ })).toBeChecked();
    expect(screen.queryByRole("link", { name: "打开阅读预览" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/publish"))).toBe(false);
  });

  it("keeps a failed upload's file for retry and prevents unsupported files", async () => {
    await openPage();
    const input = screen.getByLabelText("电子书文件");
    fireEvent.change(input, { target: { files: [new File(["pdf"], "测试.pdf")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("请选择 EPUB");
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    upload = async () => response({ success: false, message: "EPUB 文件损坏" }, 400);
    fireEvent.change(input, { target: { files: [new File(["book"], "测试.epub")] } });
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("EPUB 文件损坏");
    expect(screen.getByRole("status")).toHaveTextContent("测试.epub");
    expect(screen.getByRole("button", { name: "开始处理" })).toBeEnabled();
    upload = async () => response({ success: true, job: live });
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("heading", { name: "检查导入结果" });
  });

  it("blocks later steps and changing books during processing", async () => {
    live.status = "building";
    jobs = [live];
    await openPage();
    await screen.findByRole("heading", { name: "正在处理电子书" });
    expect(screen.getByRole("button", { name: "确认预览，设置发布" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入另一本" })).toBeDisabled();
    expect(screen.getByLabelText("最近导入")).toBeDisabled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("resumes a completed draft and changes its real publication settings without reimporting", async () => {
    live = { ...live, status: "published", publish: { huggingface: { ...completed, result: { commit: "https://huggingface.co/datasets/test/books/commit/123" } }, b2: completed } };
    jobs = [live];
    await openPage();
    await screen.findByRole("heading", { name: "上传完成" });
    expect(screen.getByRole("status")).toHaveTextContent("馆藏状态：草稿，不在馆藏展示");
    expect(screen.getAllByText("同步完成")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "查看上传记录" })).toHaveAttribute("href", "https://huggingface.co/datasets/test/books/commit/123");
    fireEvent.click(screen.getByRole("button", { name: "修改发布设置" }));
    fireEvent.click(screen.getByRole("radio", { name: /^发布到馆藏/ }));
    fireEvent.change(screen.getByLabelText("阅读门槛"), { target: { value: "authenticated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置并同步" }));
    await screen.findByRole("heading", { name: "上传完成" });
    expect(callBody()).toEqual({ targets: ["huggingface", "b2"], publicationStatus: "published", access: "authenticated" });
    expect(screen.getByRole("status")).toHaveTextContent("馆藏状态：已发布，在馆藏展示");
    expect(screen.getByRole("status")).toHaveTextContent("登录后阅读");
    expect(fetchMock.mock.calls.some(([url]) => url.includes("import-files"))).toBe(false);
  });

  it("shows upload progress until polling confirms completion and preserves target controls", async () => {
    jobs = [live];
    await openPage("/content?job=single-book&step=3");
    const normalPublish = publish;
    publish = async (body) => {
      await normalPublish(body);
      return response({ success: true, job: { ...live, status: "publishing", publish: { huggingface: { status: "uploading" }, b2: { status: "pending" } } } });
    };
    fireEvent.click(screen.getByRole("button", { name: "保存草稿并上传" }));
    await screen.findByRole("heading", { name: "正在上传" });
    expect(screen.getByText("等待同步")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改发布设置" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("等待同步确认");
    await screen.findByRole("heading", { name: "上传完成" }, { timeout: 4_000 });
    expect(screen.getByRole("status")).toHaveTextContent("草稿，不在馆藏展示");
    expect(screen.getByRole("button", { name: "修改发布设置" })).toBeEnabled();
  });

  it("reports partial failure and retries only the failed target with the saved settings", async () => {
    live = { ...live, status: "publish-failed", publicationStatus: "published", publish: {
      huggingface: { ...completed, publicationStatus: "published" },
      b2: { status: "failed", message: "连接中断", lastSuccessful: completed },
    } };
    jobs = [live];
    await openPage();
    await screen.findByRole("heading", { name: "部分上传失败" });
    expect(screen.getByRole("status")).toHaveTextContent("等待同步确认");
    expect(screen.getByText(/上次成功同步：草稿/)).toBeInTheDocument();
    expect(screen.getByText("连接中断")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试失败目标" }));
    await screen.findByRole("heading", { name: "上传完成" });
    expect(callBody()).toEqual({ targets: ["b2"], publicationStatus: "published", access: "public" });
  });

  it("returns to the requested book and step, disables unconfigured targets, and retains failed edits", async () => {
    jobs = [{ ...live, jobId: "newer-book" }, live];
    publishers.huggingface.configured = false;
    await openPage("/content?job=single-book&step=3");
    await screen.findByRole("heading", { name: "设置发布" });
    expect(screen.getByLabelText("最近导入")).toHaveValue("single-book");
    const choices = within(screen.getByRole("group", { name: "上传到哪里" }));
    expect(choices.getByRole("checkbox", { name: /Hugging Face/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /^发布到馆藏/ }));
    publish = async () => response({ success: false, message: "保存设置失败" }, 500);
    fireEvent.click(screen.getByRole("button", { name: "确认发布并上传" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存设置失败");
    expect(screen.getByRole("radio", { name: /^发布到馆藏/ })).toBeChecked();
    expect(screen.getByRole("heading", { name: "设置发布" })).toBeInTheDocument();
    expect(callBody().targets).toEqual(["b2"]);
  });
});
