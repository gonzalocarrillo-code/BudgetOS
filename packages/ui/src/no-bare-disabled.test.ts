import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

/** T-040 done-when (spec §27): the eslint rule `budget/no-bare-disabled` fails a bare `disabled`. */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

it("budget/no-bare-disabled fails a bare disabled and passes one with a reason", async () => {
  const eslint = new ESLint({ cwd: root });
  const lint = async (code: string) => ((await eslint.lintText(code, { filePath: join(root, "apps/web/src/probe.tsx") }))[0]?.messages ?? []).filter((m) => m.ruleId === "budget/no-bare-disabled");
  const bare = await lint(`export const A = () => <Button disabled>Send</Button>;\n`);
  expect(bare).toHaveLength(1);
  expect(bare[0]?.message).toContain("needs a `reason`");
  expect(await lint(`export const B = (x: boolean) => <button disabled={x}>Send</button>;\n`)).toHaveLength(1);
  expect(await lint(`export const B2 = (x: boolean) => <select disabled={x} title="Pick a dimension first" />;\n`)).toHaveLength(0);
  expect(await lint(`export const B3 = (x: boolean) => <Select disabled={x} title="Not a reason" />;\n`)).toHaveLength(1);
  expect(await lint(`export const C = () => <Button disabled reason="Fill in the name first">Send</Button>;\n`)).toHaveLength(0);
  expect(await lint(`export const D = () => <Button disabled={false}>Send</Button>;\n`)).toHaveLength(0);
  expect(await lint(`export const E = () => <Button onClick={() => undefined}>Send</Button>;\n`)).toHaveLength(0);
});
