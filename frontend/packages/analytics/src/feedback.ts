/** User-initiated feedback rides the standard `survey sent` event so PostHog
 * surveys, Hog Functions and dashboards all see the same shape. */
import { analytics } from "./index";

export type FeedbackTopic = "content_correction" | "bug" | "suggestion" | "other";
export type FeedbackOutcome = "sent" | "unavailable" | "invalid";

export interface FeedbackRequest {
  topic: FeedbackTopic;
  /** What the user typed; required, trimmed to MESSAGE_MAX_LENGTH characters. */
  message: string;
  /** The quoted passage a correction refers to; truncated to QUOTE_MAX_LENGTH. */
  quote?: string;
  contentType?: "book" | "periodical" | "times_article";
  contentId?: string;
  contentTitle?: string;
  /** Chapter or section label, e.g. the current book chapter. */
  section?: string;
  /** Controlled screen name, mirrors the `screen_viewed` vocabulary. */
  screen?: string;
}

const MESSAGE_MAX_LENGTH = 2_000;
const QUOTE_MAX_LENGTH = 600;
const FIELD_MAX_LENGTH = 200;
const TOPICS: ReadonlySet<FeedbackTopic> = new Set(["content_correction", "bug", "suggestion", "other"]);

export const FEEDBACK_SURVEY_ID = "jojo-reader-feedback";
export const FEEDBACK_SURVEY_NAME = "JOJO 看报用户反馈";

function clipped(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** Builds the `$survey_responses` payload; returns undefined when unusable. */
export function feedbackResponses(request: FeedbackRequest): Record<string, string> | undefined {
  const message = request.message.trim();
  if (!message || !TOPICS.has(request.topic)) return undefined;
  const responses: Record<string, string> = { topic: request.topic, message: message.slice(0, MESSAGE_MAX_LENGTH) };
  const quote = clipped(request.quote, QUOTE_MAX_LENGTH);
  if (quote) responses.quote = quote;
  const contentType = request.contentType;
  if (contentType) responses.content_type = contentType;
  const contentId = clipped(request.contentId, FIELD_MAX_LENGTH);
  if (contentId) responses.content_id = contentId;
  const contentTitle = clipped(request.contentTitle, FIELD_MAX_LENGTH);
  if (contentTitle) responses.content_title = contentTitle;
  const section = clipped(request.section, FIELD_MAX_LENGTH);
  if (section) responses.section = section;
  return responses;
}

/** Submit one user-initiated feedback entry. Never throws. */
export function submitFeedback(request: FeedbackRequest): FeedbackOutcome {
  const responses = feedbackResponses(request);
  if (!responses) return "invalid";
  const screen = request.screen?.trim().slice(0, FIELD_MAX_LENGTH);
  const sent = analytics.captureFeedback({
    $survey_id: FEEDBACK_SURVEY_ID,
    $survey_name: FEEDBACK_SURVEY_NAME,
    $survey_completed: true,
    $survey_responses: responses,
    ...(screen ? { screen } : {}),
  });
  return sent ? "sent" : "unavailable";
}
