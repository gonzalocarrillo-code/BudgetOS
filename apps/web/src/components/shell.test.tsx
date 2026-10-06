import "../test/dom-polyfills.js";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../lib/queries.js";
import { renderWithQuery } from "../test/render.js";
import { Shell } from "./shell.js";

// Shell pulls in TanStack Router, the signed-in person's auth helper, the theme and the global
// search / tour / notification features. None of those are what this test is about (the
// workspace switcher, sign-out and the search hotkey are): they are stubbed so the test drives
// only Shell's own state, per AGENTS.md ("mock the typed client, not fetch").
const { navigateMock, signOutMock, signOutEverywhereMock, setThemeChoiceMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  signOutMock: vi.fn(),
  signOutEverywhereMock: vi.fn(),
  setThemeChoiceMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  // Only what Shell actually reads from a Link: where it goes and what it renders. Router-only
  // props (`params`, `activeOptions`, `activeProps`) are swallowed rather than spread onto the `<a>`.
  Link: (props: { to: string; children?: ReactNode; className?: string; params?: unknown; activeOptions?: unknown; activeProps?: unknown }) => {
    const { to, children, className, params, activeOptions, activeProps, ...rest } = props;
    void params;
    void activeOptions;
    void activeProps;
    return (
      <a href={typeof to === "string" ? to : "#"} className={className} {...rest}>
        {children}
      </a>
    );
  },
  useNavigate: () => navigateMock,
  useRouterState: <T,>({ select }: { select: (state: { location: { pathname: string } }) => T }) => select({ location: { pathname: "/w/ws-1" } }),
}));

// SESSION gates the "Sign out everywhere" item (ADR-067 addendum, W5-3): true here so that item
// renders and is exercised below, the same as a real AUTH_MODE=session build.
vi.mock("../lib/auth.js", () => ({
  SESSION: true,
  signOut: (...a: unknown[]) => signOutMock(...a),
  signOutEverywhere: (...a: unknown[]) => signOutEverywhereMock(...a),
}));

vi.mock("../lib/theme.js", () => ({
  useTheme: () => ({ choice: "light" as const, resolved: "light" as const }),
  setThemeChoice: (...a: unknown[]) => setThemeChoiceMock(...a),
}));

const { GET } = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("../lib/api.js", () => ({
  api: { GET: (...a: unknown[]) => GET(...a), PATCH: vi.fn(async () => ({})) },
  unwrap: vi.fn(async (p: Promise<unknown>) => p),
}));

vi.mock("../features/search/global-search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/search/global-search.js")>();
  return {
    ...actual,
    GlobalSearch: ({ open }: { open: boolean }) => <div data-testid="global-search-palette" data-open={open} />,
  };
});

vi.mock("../features/home/tour-launcher.js", () => ({ TourLauncher: () => <div data-testid="tour-launcher-stub" /> }));
vi.mock("../features/home/notifications.js", () => ({ NotificationBell: () => <div data-testid="notification-bell-stub" /> }));

const ME: Me = {
  user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", orgId: "org-1" },
  isOrgAdmin: false,
  isSuperadmin: false,
  workspaces: [
    { workspaceId: "ws-1", name: "Golden", currency: "USD", roles: ["WORKSPACE_ADMIN"], permissions: [] },
    { workspaceId: "ws-2", name: "Acme", currency: "USD", roles: ["VIEWER"], permissions: [] },
  ],
  archivedWorkspaces: [],
};

beforeEach(() => {
  GET.mockReset();
  GET.mockImplementation(async (path: string) => {
    if (path === "/api/v1/workspaces/{ws}/dimensions") return [];
    throw new Error(`unmocked GET ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Shell", () => {
  it("lists every workspace in the switcher, with the current one checked", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <Shell me={ME} ws="ws-1">
        <div data-testid="page-content" />
      </Shell>,
    );

    await user.click(screen.getByTestId("workspace-switcher"));
    const options = await screen.findAllByTestId("workspace-option");
    expect(options.map((o) => o.getAttribute("data-value"))).toEqual(["ws-1", "ws-2"]);
    expect(options[0]?.textContent).toContain("Golden");
    expect(options[1]?.textContent).toContain("Acme");
    // Only the current workspace (ws-1) carries the "current workspace" check.
    expect(options[0]?.querySelector('[aria-label="Current workspace"]')).toBeTruthy();
    expect(options[1]?.querySelector('[aria-label="Current workspace"]')).toBeNull();
  });

  it("signs out through the auth helper from the user menu", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <Shell me={ME} ws="ws-1">
        <div data-testid="page-content" />
      </Shell>,
    );

    await user.click(screen.getByTestId("profile-button"));
    const signOutButton = await screen.findByTestId("sign-out");
    await user.click(signOutButton);

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("signs out everywhere through the auth helper from the user menu (session mode, W5-3)", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <Shell me={ME} ws="ws-1">
        <div data-testid="page-content" />
      </Shell>,
    );

    await user.click(screen.getByTestId("profile-button"));
    const signOutAllButton = await screen.findByTestId("sign-out-all");
    await user.click(signOutAllButton);

    expect(signOutEverywhereMock).toHaveBeenCalledTimes(1);
  });

  it("opens the search palette on the '/' hotkey", async () => {
    renderWithQuery(
      <Shell me={ME} ws="ws-1">
        <div data-testid="page-content" />
      </Shell>,
    );

    expect(screen.getByTestId("global-search-palette").getAttribute("data-open")).toBe("false");
    // The hotkey listener checks `e.target`, which a `window` keydown does not carry; dispatch from
    // the body, as a real keypress outside any input would.
    fireEvent.keyDown(document.body, { key: "/" });
    await waitFor(() => expect(screen.getByTestId("global-search-palette").getAttribute("data-open")).toBe("true"));
  });
});
