// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GradesScreen } from "../screens/GradesScreen.jsx";
import { clearApiCache } from "../lib/fetch.js";
import { installFetchMock } from "./mockFetch.js";

// §14.11 priority 4: GradesScreen's default-grade-from-range — the dropdown
// pre-fills to the bottom end of the setter's original guess (e.g. "V2" out
// of "V2-4") rather than starting blank or at the top.

const climbsFixture = [
  { wallId: 1, setterName: "golden-overhang", name: "Golden Overhang", setter: "alice", setterGrade: "V2-4" },
];

beforeEach(() => {
  clearApiCache();
});

describe("GradesScreen", () => {
  it("defaults the grade dropdown to the bottom of the setter's range", async () => {
    installFetchMock({ "/api/climbs/needs-grade": { body: { climbs: climbsFixture } } });
    render(<GradesScreen />);

    expect(await screen.findByDisplayValue("V2")).toBeInTheDocument();
  });

  it("confirms the default grade and drops the row from the list", async () => {
    const { calls } = installFetchMock({
      "/api/climbs/needs-grade": { body: { climbs: climbsFixture } },
      "POST /api/climbs/grade": { body: {} },
    });
    const user = userEvent.setup();
    render(<GradesScreen />);

    await screen.findByText("Golden Overhang");
    await user.click(screen.getByRole("button", { name: /confirm grade/i }));

    await waitFor(() => expect(screen.queryByText("Golden Overhang")).not.toBeInTheDocument());
    const gradeCall = calls.find((c) => c.pathname === "/api/climbs/grade");
    expect(JSON.parse(gradeCall.init.body)).toEqual({
      wallId: 1,
      setterName: "golden-overhang",
      grade: "V2",
    });
  });

  it("posts the picked grade, not the default, when the dropdown is changed before confirming", async () => {
    const { calls } = installFetchMock({
      "/api/climbs/needs-grade": { body: { climbs: climbsFixture } },
      "POST /api/climbs/grade": { body: {} },
    });
    const user = userEvent.setup();
    render(<GradesScreen />);

    await screen.findByText("Golden Overhang");
    await user.selectOptions(screen.getByDisplayValue("V2"), "V4");
    await user.click(screen.getByRole("button", { name: /confirm grade/i }));

    const gradeCall = calls.find((c) => c.pathname === "/api/climbs/grade");
    expect(JSON.parse(gradeCall.init.body).grade).toBe("V4");
  });

  it("shows an empty state when nothing needs a final grade", async () => {
    installFetchMock({ "/api/climbs/needs-grade": { body: { climbs: [] } } });
    render(<GradesScreen />);

    expect(await screen.findByText("No climbs waiting on a final grade.")).toBeInTheDocument();
  });
});
