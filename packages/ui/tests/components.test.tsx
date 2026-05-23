import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../src/Button";
import { Tag } from "../src/Tag";
import { Card } from "../src/Card";
import { Pagination } from "../src/Pagination";
import { LoadingSpinner } from "../src/LoadingSpinner";

describe("Button", () => {
  it("renders with primary variant by default", () => {
    render(<Button>Click</Button>);
    expect(screen.getByText("Click")).toBeDefined();
    expect(screen.getByText("Click").className).toContain("btn");
  });

  it("renders outline variant", () => {
    render(<Button variant="outline">Outline</Button>);
    expect(screen.getByText("Outline").className).toContain("btn-outline");
  });

  it("fires onClick", () => {
    let clicked = false;
    render(<Button onClick={() => { clicked = true; }}>Go</Button>);
    fireEvent.click(screen.getByText("Go"));
    expect(clicked).toBe(true);
  });
});

describe("Tag", () => {
  it("renders children", () => {
    render(<Tag>人民日报</Tag>);
    expect(screen.getByText("人民日报")).toBeDefined();
    expect(screen.getByText("人民日报").className).toContain("tag");
  });
});

describe("Card", () => {
  it("renders with border-red class", () => {
    const { container } = render(<Card>Content</Card>);
    expect(container.firstChild?.className).toContain("border-red");
  });
});

describe("Pagination", () => {
  it("renders nothing when total is 1", () => {
    const { container } = render(<Pagination current={1} total={1} onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders page buttons", () => {
    render(<Pagination current={1} total={5} onChange={() => {}} />);
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
  });

  it("calls onChange on click", () => {
    let page = 0;
    render(<Pagination current={2} total={5} onChange={(p) => { page = p; }} />);
    // Click the "next" button (›)
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]); // last button is ›
    expect(page).toBe(3);
  });
});

describe("LoadingSpinner", () => {
  it("renders text when provided", () => {
    render(<LoadingSpinner text="加载中" />);
    expect(screen.getByText("加载中")).toBeDefined();
  });
});
