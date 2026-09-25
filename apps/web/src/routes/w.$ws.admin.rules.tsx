import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/rules")({ component: () => <Pending title="admin.rules" task="T-032" /> });
