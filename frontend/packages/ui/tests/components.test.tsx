import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../src/Button";
import { Tag } from "../src/Tag";
import { Card } from "../src/Card";
import { Pagination } from "../src/Pagination";
import { LoadingSpinner } from "../src/LoadingSpinner";
import { AppShell } from "../src/AppShell";
import { EmptyState } from "../src/EmptyState";
import { Field, TextInput } from "../src/Form";
import { ListItem } from "../src/ListItem";
import { PageHeader } from "../src/PageHeader";
import { Panel } from "../src/Panel";
import { Toolbar } from "../src/Toolbar";
import { NavBar } from "../src/NavBar";
import { Modal } from "../src/Modal";

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

describe("Modal", () => {
  it("supports viewport-safe wide content", () => {
    render(
      <Modal open size="wide" surface="bare" onClose={() => undefined}>
        <div>Wide audit content</div>
      </Modal>,
    );
    expect(screen.getByText("Wide audit content").parentElement?.className).toContain(
      "w-[1120px]",
    );
    expect(screen.getByText("Wide audit content").parentElement?.className).toContain(
      "max-w-full",
    );
    expect(screen.getByText("Wide audit content").parentElement?.className).toContain(
      "bg-transparent",
    );
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
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain("border-red");
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
    fireEvent.click(buttons.at(-1)!); // last button is ›
    expect(page).toBe(3);
  });
});

describe("LoadingSpinner", () => {
  it("renders text when provided", () => {
    render(<LoadingSpinner text="加载中" />);
    expect(screen.getByText("加载中")).toBeDefined();
  });
});

describe("Layout primitives", () => {
  it("renders app shell regions", () => {
    render(<AppShell header="Header" sidebar="Side">Main</AppShell>);
    expect(screen.getByText("Header")).toBeDefined();
    expect(screen.getByText("Side")).toBeDefined();
    expect(screen.getByText("Main")).toBeDefined();
  });

  it("renders page header actions", () => {
    render(<PageHeader title="Title" description="Desc" actions={<Button>Act</Button>} />);
    expect(screen.getByText("Title")).toBeDefined();
    expect(screen.getByText("Desc")).toBeDefined();
    expect(screen.getByText("Act")).toBeDefined();
  });

  it("renders empty state", () => {
    render(<EmptyState title="Empty" description="Nothing here" />);
    expect(screen.getByText("Empty")).toBeDefined();
    expect(screen.getByText("Nothing here")).toBeDefined();
  });

  it("renders field and text input", () => {
    render(<Field label="Name"><TextInput defaultValue="JOJO" /></Field>);
    expect(screen.getByText("Name")).toBeDefined();
    expect(screen.getByDisplayValue("JOJO")).toBeDefined();
  });

  it("renders list item actions", () => {
    render(<ListItem title="Source" meta="RSS" actions={<Button>Delete</Button>} />);
    expect(screen.getByText("Source")).toBeDefined();
    expect(screen.getByText("RSS")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  it("renders panel and toolbar", () => {
    render(
      <Panel>
        <Toolbar>Tools</Toolbar>
      </Panel>
    );
    expect(screen.getByText("Tools")).toBeDefined();
  });

  it("opens desktop nav dropdown on hover", () => {
    render(
      <NavBar
        items={[
          {
            label: "Papers",
            children: [{ label: "Daily", href: "/daily" }],
          },
        ]}
        onNavigate={() => {}}
        isActive={() => false}
      />
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Papers" }));
    expect(screen.getByText("Daily")).toBeDefined();
  });
});
