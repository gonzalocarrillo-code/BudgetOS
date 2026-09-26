import type { Page } from "@playwright/test";
import { tokenFor } from "./auth.js";

/** Signs the page in as a golden persona (T-032 specs). */
export const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
