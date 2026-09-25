import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/policies")({ component: () => <Pending title="admin.policies" task="a later Epic 1.3 task" /> });
