import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "../src/Select";

const options = [
  { value: "all", label: "全部书籍" },
  { value: "first", label: "第一本书" },
  { value: "second", label: "第二本书" },
] as const;

afterEach(cleanup);

describe("Select", () => {
  it("renders a controlled JOJO listbox and selects an option", () => {
    const onChange = vi.fn();
    render(<Select value="all" options={options} onChange={onChange} ariaLabel="选择书籍" prefix="书目" />);

    const trigger = screen.getByRole("combobox", { name: "选择书籍" });
    expect(trigger.textContent).toContain("书目");
    expect(trigger.textContent).toContain("全部书籍");
    fireEvent.click(trigger);

    expect(screen.getByRole("listbox", { name: "选择书籍" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "全部书籍" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "第一本书" }));

    expect(onChange).toHaveBeenCalledWith("first");
    expect(screen.queryByRole("listbox", { name: "选择书籍" })).toBeNull();
  });

  it("supports keyboard navigation and Escape", () => {
    const onChange = vi.fn();
    render(<Select value="all" options={options} onChange={onChange} ariaLabel="排序" />);
    const trigger = screen.getByRole("combobox", { name: "排序" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("first");

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "排序" })).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "排序" })).toBeNull();
  });

  it("closes on an outside pointer action", () => {
    render(<><Select value="all" options={options} onChange={() => undefined} ariaLabel="选择书籍" /><button type="button">外部</button></>);
    fireEvent.click(screen.getByRole("combobox", { name: "选择书籍" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "外部" }));
    expect(screen.queryByRole("listbox", { name: "选择书籍" })).toBeNull();
  });

  it("filters long option lists with its built-in search", () => {
    const onChange = vi.fn();
    render(
      <Select
        value="all"
        options={options}
        onChange={onChange}
        ariaLabel="选择书籍"
        searchable
        searchPlaceholder="搜索书名"
        emptyText="未找到相关书籍"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "选择书籍" }));
    const search = screen.getByRole("searchbox", { name: "搜索书名" });
    fireEvent.change(search, { target: { value: "第二" } });
    expect(screen.queryByRole("option", { name: "第一本书" })).toBeNull();
    expect(screen.getByRole("option", { name: "第二本书" })).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("second");

    fireEvent.click(screen.getByRole("combobox", { name: "选择书籍" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索书名" }), { target: { value: "不存在" } });
    expect(screen.getByText("未找到相关书籍")).toBeTruthy();
  });
});
