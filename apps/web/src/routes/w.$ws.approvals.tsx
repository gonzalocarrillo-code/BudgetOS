import { Outlet, createFileRoute } from "@tanstack/react-router";

/** Parent of the list page (index) and its child routes. */
export const Route = createFileRoute("/w/$ws/approvals")({ component: Outlet });
