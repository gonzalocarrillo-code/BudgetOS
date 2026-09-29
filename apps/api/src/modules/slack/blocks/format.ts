import { money } from "@budget/workers";
import { Decimal } from "decimal.js";

/** Numbers as Slack shows them in answers: whole currency units, whole percentages, pace to two places. */

/** "USD 12,345,678" from a decimal string (rounded half up), or "—". */
export const wholeMoney = (amount: string | null | undefined, currency: string): string => (amount === null || amount === undefined ? "—" : money(new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0), currency));

/** "47%" from a ratio string ("0.4700"), or "—". */
export const percent = (ratio: string | null | undefined): string => (ratio === null || ratio === undefined || ratio === "" ? "—" : `${new Decimal(ratio).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)}%`);

/** "0.88" from a pace index, or "—". */
export const paceOf = (index: string | null | undefined): string => (index === null || index === undefined || index === "" ? "—" : new Decimal(index).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
