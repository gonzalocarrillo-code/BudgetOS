import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/admin/tours")({ component: () => <Pending title="admin.tours" task="T-040" /> });
