import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/targets")({ component: () => <Pending title="nav.targets" task="T-030" /> });
