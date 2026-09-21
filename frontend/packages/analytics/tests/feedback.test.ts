import { beforeEach, describe, expect, it, vi } from "vitest";
import { analytics, type AnalyticsTransport } from "../src/index";
import { FEEDBACK_SURVEY_ID, feedbackResponses, submitFeedback } from "../src/feedback";
import { sanitizePostHogEvent } from "../src/sanitize";

const context = { client: "web" as const, platform: "browser", app_version: "1.0", release_channel: "stable", app_variant: "standard", installation_id: "installation" };

function installFixture(): AnalyticsTransport {
  const transport: AnalyticsTransport = {
    capture: vi.fn(), exception: vi.fn(), identify: vi.fn(), reset: vi.fn(), identifiedId: () => undefined, setEnabled: vi.fn(),
  };
  analytics.install(transport, context);
  analytics.setConsent(true);
  analytics.setIdentity({ initialized: true, userId: "reader" });
  return transport;
}

describe("feedback payload", () => {
  it("builds survey responses with topic, message and optional context fields", () => {
    expect(feedbackResponses({ topic: "content_correction", message: "  标题应为「今日要闻」  ", quote: "今日耍闻", contentType: "periodical", contentId: "people/20260901", contentTitle: "人民日报 2026-09-01", section: "第 1 版", screen: "archive_reader" }))
      .toEqual({ topic: "content_correction", message: "标题应为「今日要闻」", quote: "今日耍闻", content_type: "periodical", content_id: "people/20260901", content_title: "人民日报 2026-09-01", section: "第 1 版" });
  });
  it("rejects empty messages, unknown topics and drops blank optional fields", () => {
    expect(feedbackResponses({ topic: "bug", message: "   " })).toBeUndefined();
    expect(feedbackResponses({ topic: "complaint" as never, message: "x" })).toBeUndefined();
    expect(feedbackResponses({ topic: "bug", message: "x", quote: "  ", contentId: "" })).toEqual({ topic: "bug", message: "x" });
  });
  it("clips overlong values instead of dropping the whole submission", () => {
    const responses = feedbackResponses({ topic: "suggestion", message: "x".repeat(3_000), quote: "q".repeat(900), contentTitle: "t".repeat(300) });
    expect(responses?.message.length).toBe(2_000);
    expect(responses?.quote.length).toBe(600);
    expect((responses?.content_title as string).length).toBe(200);
  });
});

describe("submitFeedback", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("captures the standard survey event with context and sign-in state", () => {
    const transport = installFixture();
    const outcome = submitFeedback({ topic: "bug", message: "翻页后目录高亮没有更新", screen: "book_reader" });
    expect(outcome).toBe("sent");
    expect(transport.capture).toHaveBeenCalledWith("survey sent", {
      $survey_id: FEEDBACK_SURVEY_ID,
      $survey_name: "JOJO 看报用户反馈",
      $survey_completed: true,
      $survey_responses: { topic: "bug", message: "翻页后目录高亮没有更新" },
      screen: "book_reader",
      ...context,
      signed_in: true,
    });
  });
  it("returns unavailable while consent is off or the SDK is not ready", () => {
    const transport = installFixture();
    analytics.setConsent(false);
    expect(submitFeedback({ topic: "bug", message: "x" })).toBe("unavailable");
    expect(transport.capture).not.toHaveBeenCalled();
    analytics.setConsent(true);
    expect(submitFeedback({ topic: "bug", message: "x" })).toBe("sent");
  });
  it("returns invalid for empty submissions without touching the transport", () => {
    const transport = installFixture();
    expect(submitFeedback({ topic: "other", message: "" })).toBe("invalid");
    expect(transport.capture).not.toHaveBeenCalled();
  });
  it("survives a transport failure", () => {
    const transport = installFixture();
    vi.mocked(transport.capture).mockImplementation(() => { throw new Error("offline"); });
    expect(submitFeedback({ topic: "bug", message: "x" })).toBe("unavailable");
  });
});

describe("feedback survives the event sanitizer", () => {
  it("keeps survey properties while still dropping unknown keys", () => {
    const sanitized = sanitizePostHogEvent({
      event: "survey sent",
      properties: {
        $survey_id: FEEDBACK_SURVEY_ID, $survey_name: "JOJO 看报用户反馈", $survey_completed: true,
        $survey_responses: { topic: "bug", message: "正文文字错误" }, screen: "archive_reader",
        client: "web", app_version: "1.0", secret_query: "private",
      },
    });
    expect(sanitized.properties).toEqual({
      $survey_id: FEEDBACK_SURVEY_ID, $survey_name: "JOJO 看报用户反馈", $survey_completed: true,
      $survey_responses: { topic: "bug", message: "正文文字错误" }, screen: "archive_reader",
      client: "web", app_version: "1.0",
    });
  });
});
