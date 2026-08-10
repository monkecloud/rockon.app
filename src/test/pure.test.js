import { describe, expect, it } from "vitest";
import { roleOf, climbGradeSortValue, matchesClimbQuery, sortClimbs } from "../App.jsx";

describe("roleOf", () => {
  it("returns admin when isAdmin is set, even alongside other flags", () => {
    expect(roleOf({ isAdmin: true, isModerator: true, isSetter: true })).toBe("admin");
  });

  it("returns moderator before setter when both are set but not admin", () => {
    expect(roleOf({ isModerator: true, isSetter: true })).toBe("moderator");
  });

  it("returns setter when only isSetter is set", () => {
    expect(roleOf({ isSetter: true })).toBe("setter");
  });

  it("returns member when no role flags are set", () => {
    expect(roleOf({})).toBe("member");
  });
});

describe("climbGradeSortValue", () => {
  it("sorts VB below every numbered grade", () => {
    expect(climbGradeSortValue({ grade: "VB" })).toBeLessThan(climbGradeSortValue({ grade: "V0" }));
  });

  it("sorts a climb with no readable grade to the very end", () => {
    expect(climbGradeSortValue({ grade: "", setterGrade: "" })).toBe(Number.POSITIVE_INFINITY);
  });

  it("sorts a range by its harder (top) end, matching climbBucketGrade", () => {
    expect(climbGradeSortValue({ grade: "", setterGrade: "V2-4" })).toBe(4);
  });
});

describe("matchesClimbQuery", () => {
  const climb = { name: "Iron Crack", setter: "Cubesnail" };

  it("matches on name", () => {
    expect(matchesClimbQuery(climb, "iron")).toBe(true);
  });

  it("matches on setter, case-insensitively", () => {
    expect(matchesClimbQuery(climb, "cubesnail")).toBe(true);
  });

  it("is true for a blank/whitespace-only query", () => {
    expect(matchesClimbQuery(climb, "")).toBe(true);
    expect(matchesClimbQuery(climb, "   ")).toBe(true);
  });

  it("is false when neither name nor setter matches", () => {
    expect(matchesClimbQuery(climb, "sloper")).toBe(false);
  });

  it("doesn't throw when setter is missing", () => {
    expect(matchesClimbQuery({ name: "Iron Crack" }, "iron")).toBe(true);
    expect(matchesClimbQuery({ name: "Iron Crack" }, "nobody")).toBe(false);
  });
});

describe("sortClimbs", () => {
  const climbs = [
    { name: "Beta", setter: "Zed", grade: "V4", setterGrade: "V4" },
    { name: "Alpha", setter: "Yara", grade: "VB", setterGrade: "VB" },
    { name: "Gamma", setter: "Xin", grade: "", setterGrade: "" }, // no readable grade
  ];

  it("does not mutate the input array", () => {
    const copy = [...climbs];
    sortClimbs(climbs, "nameAsc");
    expect(climbs).toEqual(copy);
  });

  it("sorts grade ascending, unreadable grades last (default)", () => {
    const sorted = sortClimbs(climbs, "gradeAsc");
    expect(sorted.map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("sorts grade descending, unreadable grades still last (not first)", () => {
    const sorted = sortClimbs(climbs, "gradeDesc");
    expect(sorted.map((c) => c.name)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("sorts alphabetically by name", () => {
    expect(sortClimbs(climbs, "nameAsc").map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(sortClimbs(climbs, "nameDesc").map((c) => c.name)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("sorts by setter", () => {
    expect(sortClimbs(climbs, "setterAsc").map((c) => c.setter)).toEqual(["Xin", "Yara", "Zed"]);
    expect(sortClimbs(climbs, "setterDesc").map((c) => c.setter)).toEqual(["Zed", "Yara", "Xin"]);
  });
});
