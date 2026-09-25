import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/approvals/")({ component: () => <Pending title="nav.approvals" task="T-029" /> });
