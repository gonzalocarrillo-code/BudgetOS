import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/templates")({ component: () => <Pending title="admin.templates" task="T-040" /> });
