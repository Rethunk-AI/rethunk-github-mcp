import { describe, expect, test } from "bun:test";

import {
  assertCoverageThreshold,
  parseAllFilesLineCoverage,
} from "../scripts/coverage-threshold.js";

describe("parseAllFilesLineCoverage", () => {
  test("extracts line coverage from Bun's All files summary row", () => {
    const output = `
------------------------------------|---------|---------|-------------------
File                                | % Funcs | % Lines | Uncovered Line #s
------------------------------------|---------|---------|-------------------
All files                           |   91.05 |   92.03 |
 src/server/json.ts                 |  100.00 |   96.55 | 16
`;

    expect(parseAllFilesLineCoverage(output)).toBe(92.03);
  });

  test("returns undefined when Bun output has no all-files coverage row", () => {
    const output = "160 pass\n0 fail\nRan 160 tests across 11 files.";

    expect(parseAllFilesLineCoverage(output)).toBeUndefined();
  });
});

describe("assertCoverageThreshold", () => {
  test("accepts line coverage at the minimum and reports the passing value", () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      assertCoverageThreshold("All files                           |   91.05 |   80.00 |", 80);
    } finally {
      console.log = originalLog;
    }

    expect(messages).toEqual(["Coverage OK: 80.00%"]);
  });

  test("throws when no coverage summary is present", () => {
    expect(() => assertCoverageThreshold("160 pass\n0 fail", 80)).toThrow(
      "No coverage summary found.",
    );
  });

  test("throws when line coverage is below the minimum", () => {
    const output = "All files                           |   91.05 |   79.99 |";

    expect(() => assertCoverageThreshold(output, 80)).toThrow(
      "Coverage 79.99% is below minimum 80%",
    );
  });
});
