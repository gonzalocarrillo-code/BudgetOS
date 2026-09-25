import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/closures")({ component: () => <Pending title="nav.closures" task="T-032" /> });
