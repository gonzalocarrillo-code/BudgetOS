import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/sources")({ component: () => <Pending title="admin.sources" task="T-032" /> });
