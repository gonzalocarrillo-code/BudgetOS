import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/experiments/")({ component: () => <Pending title="nav.experiments" task="T-038" /> });
