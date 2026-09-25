import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/alerts")({ component: () => <Pending title="nav.alerts" task="T-032" /> });
