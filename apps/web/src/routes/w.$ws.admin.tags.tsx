import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/tags")({ component: () => <Pending title="admin.tags" task="T-030" /> });
