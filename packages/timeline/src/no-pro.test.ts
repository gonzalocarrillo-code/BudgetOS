import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { forbiddenMatch } from "../../../scripts/forbidden-packages.mjs";

/** T-037 done-when (spec §23.2, AGENTS §4): no `@svar/*` or SVAR PRO import — eslint refuses it and license-check refuses the package. */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("no SVAR PRO (T-037)", () => {
  it("eslint refuses PRO and commercial imports, and allows the MIT core", async () => {
    const eslint = new ESLint({ cwd: root });
    const lint = async (code: string) => (await eslint.lintText(code, { filePath: join(root, "packages/timeline/src/probe.ts") }))[0]?.messages.filter((m) => m.ruleId === "no-restricted-imports") ?? [];
    for (const name of ["@svar/gantt", "@svar-ui/react-gantt-pro", "@svar-ui/pro-gantt", "ag-grid-react", "@bryntum/gantt", "@syncfusion/ej2-gantt", "@mui/x-data-grid-pro", "@tiptap-pro/extension-comments"]) {
      expect(await lint(`import x from "${name}";\nexport default x;\n`), name).toHaveLength(1);
    }
    expect(await lint(`import { Gantt } from "@svar-ui/react-gantt";\nexport default Gantt;\n`)).toHaveLength(0);
  });

  it("license-check refuses the names; the timeline's own tree has none", () => {
    expect(forbiddenMatch("@svar-ui/react-gantt-pro")?.name).toBe("SVAR PRO");
    expect(forbiddenMatch("@svar/gantt")?.name).toBe("SVAR PRO");
    expect(forbiddenMatch("@svar-ui/gantt-data-provider")).toBeNull();
    expect(forbiddenMatch("@svar-ui/react-gantt")).toBeNull();
    const manifest = JSON.parse(readFileSync(join(root, "packages/timeline/package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((n) => forbiddenMatch(n) !== null)).toEqual([]);
  });
});
