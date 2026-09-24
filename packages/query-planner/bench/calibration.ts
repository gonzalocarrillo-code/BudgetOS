// Planner-shaped calibration: template strings, parameter pushes, map/join and a regex replace.
// It does not import the planner, so a planner regression does not move it.
const KEYS = ["region", "platform", "objective", "channel", "market", "brand", "audience", "format"];

export function calibrationBatch(calls: number): number {
  const start = performance.now();
  let sink = 0;
  for (let n = 0; n < calls; n += 1) {
    const values: unknown[] = [];
    const p = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const cols = KEYS.map(
      (key, i) => `g${i}.code AS dim_${key.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}, g${i}.label AS lbl_${key}`,
    ).join(", ");
    const joins = KEYS.map(
      (key, i) => `\n LEFT JOIN LATERAL (SELECT dv.code FROM envelope_dimension ed WHERE d.key = ${p(key)} LIMIT 1) g${i} ON TRUE`,
    ).join("");
    const where = KEYS.map((key) => ({ key, value: `${key}-${n % 7}` }))
      .map((clause) => `ed.${clause.key} = ${p(clause.value)}`)
      .join(" AND ");
    const sql = `SELECT ${cols} FROM envelope e ${joins} WHERE ${where} ORDER BY 1 LIMIT ${p(200)}`;
    sink += sql.length + values.length;
  }
  if (sink <= 0) {
    throw new Error("planner calibration did not run");
  }
  return performance.now() - start;
}
