import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/naming")({ component: () => <Pending title="admin.naming" task="T-036" /> });
