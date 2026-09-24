/**
 * Wall clock for timestamps commands write themselves (e.g. `approved_at`). Always real time in the
 * app; the golden seed moves it so approvals land on its planned dates and `as_of` has history.
 */
export const clock = {
  now: (): Date => new Date(),
};
