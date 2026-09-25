import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/approvals/$id")({ component: () => <Pending title="page.approval" task="T-029" /> });
