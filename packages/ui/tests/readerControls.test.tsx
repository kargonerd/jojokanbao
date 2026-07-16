import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatePicker, YearPicker } from "../src/DatePicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DatePicker reader interactions", () => {
  it("displays the editorial date format and toggles the calendar", () => {
    render(<DatePicker value="19761009" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "1976年10月09日" });

    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "上一月" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一月" })).toBeTruthy();
    expect(screen.getByText("1976 年")).toBeTruthy();
    expect(screen.getByText("10月")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "上一月" })).toBeNull();
  });

  it("selects a day, closes the panel, and emits yyyyMMdd", async () => {
    const onChange = vi.fn();
    render(<DatePicker value="19761009" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "1976年10月09日" }));
    fireEvent.click(screen.getByRole("button", { name: "8" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("19761008"));
    expect(screen.queryByRole("button", { name: "上一月" })).toBeNull();
  });

  it("keeps disabled dates inert and the calendar open", async () => {
    const onChange = vi.fn();
    render(<DatePicker value="19460627" onChange={onChange} disabledDate={(date) => date === "19460628"} />);
    fireEvent.click(screen.getByRole("button", { name: "1946年06月27日" }));
    const disabledDay = screen.getByRole("button", { name: "28" }) as HTMLButtonElement;

    expect(disabledDay.disabled).toBe(true);
    fireEvent.click(disabledDay);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "上一月" })).toBeTruthy();
  });

  it("moves across January and December without losing the year", () => {
    render(<DatePicker value="19760115" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "1976年01月15日" }));
    fireEvent.click(screen.getByRole("button", { name: "上一月" }));
    expect(screen.getByText("1975 年")).toBeTruthy();
    expect(screen.getByText("12月")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一月" }));
    expect(screen.getByText("1976 年")).toBeTruthy();
    expect(screen.getByText("1月")).toBeTruthy();
  });

  it("supports direct year and month selection before choosing a day", async () => {
    const onChange = vi.fn();
    render(<DatePicker value="19761009" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "1976年10月09日" }));
    fireEvent.click(screen.getByRole("button", { name: "1976 年" }));
    expect(screen.getByText("1970 年 - 1979 年")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "上十年" }));
    expect(screen.getByText("1960 年 - 1969 年")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1965" }));
    expect(screen.getByText("1965 年")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "三月" }));
    expect(screen.getByText("3月")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "10" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("19650310"));
  });

  it("uses panel-specific previous and next controls", () => {
    render(<DatePicker value="19761009" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "1976年10月09日" }));
    fireEvent.click(screen.getByRole("button", { name: "10月" }));
    expect(screen.getByRole("button", { name: "上一年" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上一年" }));
    expect(screen.getByText("1975 年")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一年" }));
    expect(screen.getByText("1976 年")).toBeTruthy();
  });

  it("closes on an outside pointer action without changing the value", () => {
    const onChange = vi.fn();
    render(<DatePicker value="19761009" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "1976年10月09日" }));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("button", { name: "上一月" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("synchronizes the visible month when the route value changes", () => {
    const view = render(<DatePicker value="19761009" onChange={() => {}} />);
    view.rerender(<DatePicker value="19810312" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "1981年03月12日" }));

    expect(screen.getByText("1981 年")).toBeTruthy();
    expect(screen.getByText("3月")).toBeTruthy();
  });
});

describe("YearPicker reader interactions", () => {
  it("shows the current decade and selects a year", () => {
    const onChange = vi.fn();
    render(<YearPicker value="1964" onChange={onChange} min={1958} max={1976} />);
    fireEvent.click(screen.getByRole("button", { name: "1964年" }));

    expect(screen.getByText("1960 年 - 1969 年")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1965" }));
    expect(onChange).toHaveBeenCalledWith("1965");
    expect(screen.queryByText("1960 年 - 1969 年")).toBeNull();
  });

  it("disables years outside publication bounds", () => {
    render(<YearPicker value="1958" onChange={() => {}} min={1958} max={1976} />);
    fireEvent.click(screen.getByRole("button", { name: "1958年" }));

    expect((screen.getByRole("button", { name: "1957" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "1958" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "上十年" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stops decade navigation at the maximum year", () => {
    render(<YearPicker value="1976" onChange={() => {}} min={1958} max={1976} />);
    fireEvent.click(screen.getByRole("button", { name: "1976年" }));

    expect((screen.getByRole("button", { name: "下十年" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "1977" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("navigates decades and closes on outside click", () => {
    render(<YearPicker value="1964" onChange={() => {}} min={1934} max={2025} />);
    fireEvent.click(screen.getByRole("button", { name: "1964年" }));
    fireEvent.click(screen.getByRole("button", { name: "下十年" }));
    expect(screen.getByText("1970 年 - 1979 年")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("1970 年 - 1979 年")).toBeNull();
  });

  it("synchronizes its decade when the route year changes", () => {
    const view = render(<YearPicker value="1964" onChange={() => {}} min={1934} max={2025} />);
    view.rerender(<YearPicker value="2009" onChange={() => {}} min={1934} max={2025} />);
    fireEvent.click(screen.getByRole("button", { name: "2009年" }));

    expect(screen.getByText("2000 年 - 2009 年")).toBeTruthy();
  });
});
