import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/")({ component: () => <Pending title="nav.overview" task="T-033" /> });
