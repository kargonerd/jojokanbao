import { type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookThoughtComposer } from "./BookThoughtComposer";
import { editorialTheme } from "../theme/tokens";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: "div", Text: "span", Pressable: "button", ScrollView: "section", TextInput: "textarea", KeyboardAvoidingView: "main",
    Modal: ({ visible, children, ...props }: { visible: boolean; children: import("react").ReactNode }) => visible ? createElement("dialog", props, children) : null,
    Platform: { OS: "android", select: (values: { android: string }) => values.android }, StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "aside" }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));

let view: ReactTestRenderer;
let props: ComponentProps<typeof BookThoughtComposer>;
const find = (label: string) => view.root.findByProps({ accessibilityLabel: label });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  props = { quote: "原文", value: "想法", visibility: "public", saving: false, error: "", theme: editorialTheme,
    onChange: vi.fn(), onVisibilityChange: vi.fn(), onCancel: vi.fn(), onSave: vi.fn() };
});
afterEach(async () => { if (view) await act(async () => view.unmount()); });

it("exposes both visibility choices and passes the private selection to its owner", async () => {
  await act(async () => { view = create(<BookThoughtComposer {...props} />); });
  expect(find("公开").props.accessibilityState.checked).toBe(true);
  await act(async () => find("仅自己可见").props.onPress());
  expect(props.onVisibilityChange).toHaveBeenCalledWith("private");
  await act(async () => view.update(<BookThoughtComposer {...props} visibility="private" />));
  expect(find("仅自己可见").props.accessibilityState.checked).toBe(true);
  await act(async () => find("保存想法").props.onPress());
  expect(props.onSave).toHaveBeenCalledOnce();
  expect(find("想法内容").props.maxLength).toBe(2000);
});

it("locks content, visibility and dismiss while saving and leaves the failed draft editable", async () => {
  await act(async () => { view = create(<BookThoughtComposer {...props} saving />); });
  expect(find("想法内容").props.editable).toBe(false);
  expect(find("仅自己可见").props.disabled).toBe(true);
  expect(find("保存想法").props.disabled).toBe(true);
  await act(async () => view.root.findByType("dialog").props.onRequestClose());
  expect(props.onCancel).not.toHaveBeenCalled();
  await act(async () => view.update(<BookThoughtComposer {...props} visibility="private" error="请重试" />));
  expect(find("想法内容").props.value).toBe("想法");
  expect(find("想法内容").props.editable).toBe(true);
  expect(find("仅自己可见").props.accessibilityState.checked).toBe(true);
  expect(view.root.findByProps({ accessibilityRole: "alert" }).props.children).toBe("请重试");
});

it("does not present a local-only legacy note as publicly published", async () => {
  await act(async () => { view = create(<BookThoughtComposer {...props} localOnly value="" />); });
  expect(view.root.findAllByProps({ accessibilityRole: "radio" })).toHaveLength(0);
  expect(view.root.findAllByType("span").some((span) => span.props.children === "仅保存在本机")).toBe(true);
  expect(find("保存想法").props.disabled).toBe(true);
});

it("offers local saving only after a cloud failure and keeps both retry choices separate", async () => {
  props.onSaveLocal = vi.fn();
  await act(async () => { view = create(<BookThoughtComposer {...props} />); });
  expect(view.root.findAllByProps({ accessibilityLabel: "先保存到本机" })).toHaveLength(0);
  await act(async () => view.update(<BookThoughtComposer {...props} error="暂未保存，请重试。" />));
  await act(async () => find("先保存到本机").props.onPress());
  expect(props.onSaveLocal).toHaveBeenCalledOnce();
  expect(props.onSave).not.toHaveBeenCalled();
  expect(find("想法内容").props.value).toBe("想法");
  await act(async () => find("保存想法").props.onPress());
  expect(props.onSave).toHaveBeenCalledOnce();

  const editor = view.root.findByProps({ testID: "thought-editor-scroll" });
  expect(editor.props.keyboardShouldPersistTaps).toBe("handled");
  expect(editor.findByProps({ accessibilityLabel: "想法内容" })).toBeTruthy();
  expect(editor.findByProps({ accessibilityRole: "alert" })).toBeTruthy();
  expect(editor.findByProps({ accessibilityLabel: "先保存到本机" })).toBeTruthy();
  expect(editor.findAllByProps({ accessibilityLabel: "保存想法" })).toHaveLength(0);
  expect(editor.findAllByProps({ accessibilityLabel: "仅自己可见" })).toHaveLength(0);

  await act(async () => view.update(<BookThoughtComposer {...props} error="暂未保存，请重试。" saving />));
  expect(find("先保存到本机").props.disabled).toBe(true);
  await act(async () => view.update(<BookThoughtComposer {...props} error="暂未保存，请重试。" value="" />));
  expect(find("先保存到本机").props.disabled).toBe(true);
  await act(async () => view.update(<BookThoughtComposer {...props} error="暂未保存，请重试。" localOnly />));
  expect(view.root.findAllByProps({ accessibilityLabel: "先保存到本机" })).toHaveLength(0);
  await act(async () => view.update(<BookThoughtComposer {...props} error="暂未保存，请重试。" onSaveLocal={undefined} />));
  expect(view.root.findAllByProps({ accessibilityLabel: "先保存到本机" })).toHaveLength(0);
});
