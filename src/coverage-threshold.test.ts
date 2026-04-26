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
});

describe("assertCoverageThreshold", () => {
  test("throws when line coverage is below the minimum", () => {
    const output = "All files                           |   91.05 |   79.99 |";

    expect(() => assertCoverageThreshold(output, 80)).toThrow(
      "Coverage 79.99% is below minimum 80%",
    );
  });
});
