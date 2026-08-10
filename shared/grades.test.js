import { describe, expect, it } from "vitest";
import {
  GRADE_OPTIONS,
  GRADE_BUCKETS,
  gradeToBucket,
  bucketCounts,
  climbBucketGrade,
  climbDisplayGrade,
  composeSetterGrade,
  parseSetterGrade,
} from "./grades.js";

describe("gradeToBucket", () => {
  it("buckets VB case-insensitively", () => {
    expect(gradeToBucket("VB")).toBe("VB");
    expect(gradeToBucket("vb")).toBe("VB");
  });

  it("buckets a plain V-grade", () => {
    expect(gradeToBucket("V4")).toBe("V4");
    expect(gradeToBucket("v4")).toBe("V4");
  });

  it("collapses anything >= V10 into the V10+ catch-all", () => {
    expect(gradeToBucket("V10")).toBe("V10+");
    expect(gradeToBucket("V17")).toBe("V10+");
  });

  it("returns null for blank or unparseable input", () => {
    expect(gradeToBucket("")).toBeNull();
    expect(gradeToBucket(null)).toBeNull();
    expect(gradeToBucket("banana")).toBeNull();
    expect(gradeToBucket("V2-4")).toBeNull(); // ranges aren't single grades
  });
});

describe("bucketCounts", () => {
  it("counts grades into GRADE_BUCKETS order, skipping unparseable ones", () => {
    const counts = bucketCounts(["V4", "V4", "VB", "V17", "garbage", ""]);
    expect(counts.map((c) => c.grade)).toEqual(GRADE_BUCKETS);
    expect(counts.find((c) => c.grade === "V4").count).toBe(2);
    expect(counts.find((c) => c.grade === "VB").count).toBe(1);
    expect(counts.find((c) => c.grade === "V10+").count).toBe(1);
    expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(4);
  });

  it("returns every bucket at zero for an empty list", () => {
    const counts = bucketCounts([]);
    expect(counts.every((c) => c.count === 0)).toBe(true);
  });
});

describe("climbBucketGrade", () => {
  it("prefers the confirmed grade over setterGrade", () => {
    expect(climbBucketGrade({ grade: "V5", setterGrade: "V2-4" })).toBe("V5");
  });

  it("falls back to setterGrade when unconfirmed", () => {
    expect(climbBucketGrade({ grade: "", setterGrade: "V6" })).toBe("V6");
  });

  it("buckets a range by its harder (top) end", () => {
    expect(climbBucketGrade({ grade: "", setterGrade: "V2-4" })).toBe("V4");
  });
});

describe("climbDisplayGrade", () => {
  it("prefers the confirmed grade", () => {
    expect(climbDisplayGrade({ grade: "V5", setterGrade: "V2-4" })).toBe("V5");
  });

  it("shows the setterGrade range as-is when unconfirmed", () => {
    expect(climbDisplayGrade({ grade: "", setterGrade: "V2-4" })).toBe("V2-4");
  });
});

describe("composeSetterGrade / parseSetterGrade round-trip", () => {
  it("collapses a matching bottom/top into a single grade", () => {
    expect(composeSetterGrade("V6", "V6")).toBe("V6");
  });

  it("joins a differing bottom/top into a V<bottom>-<top> range", () => {
    expect(composeSetterGrade("V2", "V4")).toBe("V2-4");
  });

  it("round-trips every single grade in GRADE_OPTIONS", () => {
    for (const grade of GRADE_OPTIONS) {
      const composed = composeSetterGrade(grade, grade);
      expect(parseSetterGrade(composed)).toEqual({ bottom: grade, top: grade });
    }
  });

  it("round-trips a range", () => {
    const composed = composeSetterGrade("V2", "V4");
    expect(parseSetterGrade(composed)).toEqual({ bottom: "V2", top: "V4" });
  });

  it("rejects malformed or out-of-order ranges", () => {
    expect(parseSetterGrade("banana")).toBeNull();
    expect(parseSetterGrade("V3-")).toBeNull();
    expect(parseSetterGrade("V4-2")).toBeNull(); // top < bottom
    expect(parseSetterGrade("V4-99")).toBeNull(); // top not a real grade
    expect(parseSetterGrade(null)).toBeNull();
  });

  it("accepts a valid range and a valid single grade", () => {
    expect(parseSetterGrade("V6")).toEqual({ bottom: "V6", top: "V6" });
    expect(parseSetterGrade("V2-4")).toEqual({ bottom: "V2", top: "V4" });
  });
});
