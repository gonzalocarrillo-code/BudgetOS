import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/experiments/$id")({ component: () => <Pending title="page.experiment" task="T-038" /> });
