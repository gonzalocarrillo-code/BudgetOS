import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/registry")({ component: () => <Pending title="admin.registry" task="T-031" /> });
