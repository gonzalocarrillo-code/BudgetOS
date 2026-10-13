import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState, type ReactElement } from "react";
import { factValuesQuery } from "../../lib/queries.js";
import { ValuePicker } from "./value-picker.js";

/**
 * EX-9 (ADR-0094): the value picker for a data-derived granularity (campaign). Its values are the
 * ones in the spend data, searched on the server (largest spend first) — there is no registry list
 * to load whole. Same keyboard and pills as ValuePicker.
 */
export function FactValuePicker({ ws, dimKey, picked, onChange, placeholder, testId }: { ws: string; dimKey: string; picked: string[]; onChange: (codes: string[]) => void; placeholder: string; testId?: string }): ReactElement {
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const { data } = useQuery({ ...factValuesQuery(ws, dimKey, { q: search, limit: 50 }), placeholderData: keepPreviousData });
  const values = (data?.items ?? []).map((v) => ({ code: v.code, label: v.code }));
  return <ValuePicker values={values} picked={picked} onChange={onChange} placeholder={placeholder} onQueryChange={setQ} {...(testId ? { testId } : {})} />;
}
