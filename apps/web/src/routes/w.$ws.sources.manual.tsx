import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/sources/manual")({ component: () => <Pending title="page.manualEntry" task="T-039" /> });
