/**
 * Default first-run tours (spec §27, plan §11.7): one per role, 4–6 steps, on the screen that role
 * works in. Every `element` is a `[data-tour="…"]` attribute in apps/web; `path` is under /w/:ws.
 * Org admins edit a workspace's copy in Admin › Tours (a new version shows it to everyone again).
 */
export interface DefaultTourSeed {
  role: "planner" | "approver" | "finance" | "data_admin";
  name: string;
  steps: Array<{ path?: string; element: string; title: string; description: string }>;
}

export const DEFAULT_TOURS: readonly DefaultTourSeed[] = [
  {
    role: "planner",
    name: "Planning budgets",
    steps: [
      { path: "/home", element: '[data-tour="home-pulse"]', title: "Your desk", description: "Home starts with the workspace in one line, then what waits on you: drafts you have not sent, what others sent you, and your budgets' pace." },
      { path: "/budgets", element: '[data-tour="workspace-switcher"]', title: "Your workspace", description: "Budgets, approvals and results live in a workspace. Switch between the ones you work in here." },
      { path: "/budgets", element: '[data-tour="filter-bar"]', title: "Filter what you see", description: "Add filters by market, platform or any granularity. The filter is in the URL, so you can share it." },
      { path: "/budgets", element: '[data-tour="view-toggle"]', title: "Tree, pivot or timeline", description: "See budgets by your hierarchy, pivot them by any granularity, or lay them out on the calendar." },
      { path: "/budgets", element: '[data-tour="structure-actions"]', title: "Change the structure", description: "Add a child budget, move, split or merge. Changes go through approval when a policy asks for it." },
      { path: "/budgets", element: '[data-tour="save-view"]', title: "Save the view", description: "Keep a filter and layout you use often, for yourself or for the workspace." },
      { path: "/budgets", element: '[data-tour="global-search"]', title: "Find anything", description: "Search budgets, targets, alerts and comments. Try country:BR status:pending." },
    ],
  },
  {
    role: "approver",
    name: "Approving changes",
    steps: [
      { path: "/home", element: '[data-tour="home-waiting"]', title: "Decide from Home", description: "What waits on you comes first. Decide opens the request beside the list: what changes, the chain, and your decision." },
      { path: "/approvals", element: '[data-tour="nav-approvals"]', title: "Approvals", description: "Every change a policy routes to you arrives here, and on Home under “Waiting on you”." },
      { path: "/approvals", element: '[data-tour="approvals-tabs"]', title: "Mine first", description: "“Waiting for me” lists only the steps you can decide now; the other tabs show everything in your scope." },
      { path: "/approvals", element: '[data-tour="approvals-list"]', title: "Open a request", description: "Each request shows what changes, the policy chain and where it stands. Approve, reject or ask for changes with a comment." },
      { path: "/approvals", element: '[data-tour="global-search"]', title: "Search requests", description: "Find a request by budget, market or requester, e.g. type:approval status:pending." },
    ],
  },
  {
    role: "finance",
    name: "Closing periods",
    steps: [
      { path: "/home", element: '[data-tour="home-waiting"]', title: "What to close", description: "In a quarter's last two weeks, Home says what is still in draft or waiting for approval in it." },
      { path: "/closures", element: '[data-tour="nav-overview"]', title: "The overview", description: "Budget, spend to date, pacing and what is waiting for you, for the whole workspace." },
      { path: "/closures", element: '[data-tour="nav-closures"]', title: "Closures", description: "When a period ends, close it: its budgets lock and its numbers are frozen for reporting." },
      { path: "/closures", element: '[data-tour="closures-list"]', title: "Closed periods", description: "Every closure with the budgets it locked. Open one for its report; restate it if late actuals arrive." },
      { path: "/closures", element: '[data-tour="closures-close"]', title: "Close a period", description: "Pick the period (FY2026, 2026-Q1 or 2026-03) and close it once it has ended." },
    ],
  },
  {
    role: "data_admin",
    name: "Loading results",
    steps: [
      { path: "/sources", element: '[data-tour="nav-sources"]', title: "Sources", description: "Where actuals and KPIs come from: Snowflake, BigQuery, Google Sheets or CSV." },
      { path: "/sources", element: '[data-tour="sources-list"]', title: "Runs and coverage", description: "Each source shows its runs, how many rows matched a budget, and the rows it rejected with the reason." },
      { path: "/sources", element: '[data-tour="sources-setup"]', title: "Set up a source", description: "Connect a source and map its columns to granularities with the mapping wizard." },
      { path: "/sources/manual", element: '[data-tour="manual-batches"]', title: "Manual results", description: "Results no integration brings in — TV, out of home, print — are typed or pasted here and sent for approval." },
    ],
  },
];
