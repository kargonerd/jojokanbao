import { describe, expect, it } from "vitest";
import {
  getFacsimileIssueFilename,
  RMRB_EDGEONE_BLOCKED_ISSUES,
} from "../src/archive/facsimileObjects";

describe("facsimile object routing", () => {
  it("routes every confirmed EdgeOne-blocked RMRB issue to its readable alias", () => {
    expect(RMRB_EDGEONE_BLOCKED_ISSUES).toHaveLength(51);
    for (const issueId of RMRB_EDGEONE_BLOCKED_ISSUES) {
      expect(getFacsimileIssueFilename("rmrb", issueId)).toBe(`${issueId}-r1.pdf`);
    }
  });

  it("keeps the repair manifest sorted and duplicate-free", () => {
    const issues = [...RMRB_EDGEONE_BLOCKED_ISSUES];
    expect(issues).toEqual([...issues].sort());
    expect(new Set(issues).size).toBe(issues.length);
  });

  it("keeps normal RMRB and other publication object names unchanged", () => {
    expect(getFacsimileIssueFilename("rmrb", "19761009")).toBe("19761009.pdf");
    expect(getFacsimileIssueFilename("ckxx", "19760910")).toBe("19760910.pdf");
  });
});
