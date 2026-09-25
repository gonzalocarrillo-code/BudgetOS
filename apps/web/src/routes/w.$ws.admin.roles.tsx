import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/roles")({ component: () => <Pending title="admin.roles" task="a later admin task" /> });
