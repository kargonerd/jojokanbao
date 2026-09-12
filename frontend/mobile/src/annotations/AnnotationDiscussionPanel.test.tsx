import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationComment, AnnotationThread } from "@jojo/content";
import { AnnotationDiscussionPanel, type AnnotationDiscussionPanelProps } from "./AnnotationDiscussionPanel";
import { editorialTheme } from "../theme/tokens";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: "div", Text: "span", Pressable: "button", ScrollView: "section", TextInput: "textarea", KeyboardAvoidingView: "main",
    Modal: ({ visible, children, ...props }: { visible: boolean; children: import("react").ReactNode }) => visible ? createElement("dialog", props, children) : null,
    Platform: { OS: "android", select: (values: { android: string }) => values.android },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "aside" }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));

const comment = (id: string, authorId: string, visibility: "public" | "private", body: string): AnnotationComment => ({
  id, annotationId: "thread", parentCommentId: null, authorId, authorName: authorId === "me" ? "我" : "其他读者", body, visibility, createdAt: "2026-09-12T12:00:00Z", reportedByMe: false,
});
const thread: AnnotationThread = {
  id: "thread", contentType: "book", contentId: "books:book", sectionId: "chapter", contentTitle: "测试书 · 第一章",
  quote: "所选原文", prefix: "", suffix: "", startOffset: 0, endOffset: 4, authorId: "me", authorName: "我", createdAt: "2026-09-12T12:00:00Z", underlineCount: 7,
  comments: [comment("mine", "me", "public", "自己的公开想法"), comment("other", "other", "public", "其他人的公开想法"), comment("private", "me", "private", "自己的私密想法"), comment("hidden", "other", "private", "不该显示的私密想法")],
};

let view: ReactTestRenderer;
let props: AnnotationDiscussionPanelProps;
const find = (label: string) => view.root.findByProps({ accessibilityLabel: label });
async function press(label: string) { await act(async () => { find(label).props.onPress(); }); }
async function input(label: string, value: string) { await act(async () => { find(label).props.onChangeText(value); }); }
async function render() { await act(async () => { view = create(<AnnotationDiscussionPanel {...props} />); }); }
const renderedText = () => view.root.findAllByType("span").map((element) => element.props.children).flat().filter((value) => typeof value === "string" || typeof value === "number").join("");

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  props = { thread, currentUserId: "me", theme: editorialTheme, onClose: vi.fn(), onComment: vi.fn(async () => undefined), onReport: vi.fn(async () => undefined) };
});
afterEach(async () => { if (view) await act(async () => view.unmount()); });

describe("native annotation discussion", () => {
  it("shows full quote and underline count, filters other readers' private comments, and leaves the keyboard closed", async () => {
    await render();
    expect(find("划线原文").props.children).toBe("所选原文");
    expect(renderedText()).toContain("7 人划线");
    expect(renderedText()).toContain("自己的私密想法");
    expect(renderedText()).not.toContain("不该显示的私密想法");
    expect(view.root.findByProps({ testID: "annotation-comment-private" }).findAllByType("button")).toHaveLength(0);
    expect(view.root.findByProps({ testID: "annotation-comment-mine" }).findAllByType("button")).toHaveLength(1);
    expect(find("讨论想法内容").props.autoFocus).toBeUndefined();
    expect(find("讨论想法内容").props.maxLength).toBe(2000);
    expect(view.root.findAllByType("section").every((section) => section.props.keyboardShouldPersistTaps === "handled")).toBe(true);
  });

  it("posts a private reply and clears the draft and reply only after saving succeeds", async () => {
    await render();
    await press("回复其他读者的想法");
    await input("讨论想法内容", " 回复内容 ");
    await press("仅自己可见");
    await press("发表想法");
    expect(props.onComment).toHaveBeenCalledExactlyOnceWith("回复内容", "other", "private");
    expect(find("讨论想法内容").props.value).toBe("");
    expect(find("公开").props.accessibilityState.checked).toBe(true);
    expect(view.root.findAllByProps({ accessibilityLabel: "取消回复" })).toHaveLength(0);
    expect(renderedText()).toContain("想法已保存");
  });

  it("keeps the comment, reply and visibility on failure and retries without exposing a database error", async () => {
    props.onComment = vi.fn().mockRejectedValueOnce(new Error("SQL select private.user_id from annotation_comments")).mockResolvedValue(undefined);
    await render();
    await press("回复其他读者的想法");
    await input("讨论想法内容", "保留这段内容");
    await press("仅自己可见");
    await press("发表想法");
    expect(find("讨论想法内容").props.value).toBe("保留这段内容");
    expect(find("仅自己可见").props.accessibilityState.checked).toBe(true);
    expect(renderedText()).toContain("想法暂未保存，请重试。");
    expect(renderedText()).not.toContain("SQL");
    const editor = view.root.findByProps({ testID: "discussion-editor-scroll" });
    expect(editor.findByProps({ accessibilityLabel: "讨论想法内容" }).props.value).toBe("保留这段内容");
    expect(editor.findByProps({ accessibilityLabel: "取消回复" })).toBeTruthy();
    expect(editor.findByProps({ accessibilityLabel: "重试" })).toBeTruthy();
    expect(editor.findAllByProps({ accessibilityLabel: "发表想法" })).toHaveLength(0);
    expect(editor.findAllByProps({ accessibilityLabel: "仅自己可见" })).toHaveLength(0);
    await press("重试");
    expect(props.onComment).toHaveBeenLastCalledWith("保留这段内容", "other", "private");
    expect(props.onComment).toHaveBeenCalledTimes(2);
    expect(find("讨论想法内容").props.value).toBe("");
  });

  it("disables dismissal and duplicate submissions until the request settles", async () => {
    let resolve!: () => void;
    props.onComment = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    await render();
    await input("讨论想法内容", "想法");
    const submit = find("发表想法").props.onPress;
    await act(async () => { submit(); submit(); });
    expect(props.onComment).toHaveBeenCalledOnce();
    expect(find("发表想法").props.disabled).toBe(true);
    expect(find("讨论想法内容").props.editable).toBe(false);
    await act(async () => view.root.findByType("dialog").props.onRequestClose());
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    await press("关闭划线详情");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("preserves report reasons and details through failure, then marks a successful report", async () => {
    props.onReport = vi.fn().mockRejectedValueOnce(new Error("SQL failed")).mockResolvedValue(undefined);
    await render();
    await press("举报其他读者的想法");
    await press("骚扰");
    await input("举报补充说明", " 具体说明 ");
    await press("提交举报");
    expect(props.onReport).toHaveBeenCalledExactlyOnceWith("other", "harassment", "具体说明");
    expect(find("举报补充说明").props.value).toBe(" 具体说明 ");
    expect(find("骚扰").props.accessibilityState.checked).toBe(true);
    expect(renderedText()).toContain("举报暂未提交，请重试。");
    await press("重试");
    expect(props.onReport).toHaveBeenCalledTimes(2);
    expect(find("已举报").props.disabled).toBe(true);
    expect(view.root.findAllByProps({ accessibilityLabel: "举报补充说明" })).toHaveLength(0);
    expect(renderedText()).toContain("举报已提交");
  });

  it("bounds typed comments and resets drafts and private data when account or thread changes", async () => {
    await render();
    await input("讨论想法内容", "字".repeat(2100));
    expect(find("讨论想法内容").props.value).toHaveLength(2000);
    props = { ...props, currentUserId: "another-user" };
    await act(async () => view.update(<AnnotationDiscussionPanel {...props} />));
    expect(find("讨论想法内容").props.value).toBe("");
    expect(renderedText()).not.toContain("自己的私密想法");
    await input("讨论想法内容", "另一个话题");
    props = { ...props, thread: { ...thread, id: "another-thread", quote: "另一段原文", comments: [] } };
    await act(async () => view.update(<AnnotationDiscussionPanel {...props} />));
    expect(find("讨论想法内容").props.value).toBe("");
    expect(renderedText()).toContain("还没有想法。");
  });
});
