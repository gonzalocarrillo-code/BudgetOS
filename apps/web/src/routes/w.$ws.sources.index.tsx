import { createFileRoute } from "@tanstack/react-router";
import { Pending } from "../components/page.js";

export const Route = createFileRoute("/w/$ws/sources/")({ component: () => <Pending title="nav.sources" task="T-032" /> });
