import { createRoot, type Root } from "react-dom/client";
import { Gantt, Willow, defaultTaskTypes, type ITask } from "@svar-ui/react-gantt";
import ganttCss from "@svar-ui/react-gantt/all.css";
import { proofBars, toSvarTasks, type SpikeBar } from "../src/spike-layout.js";
import { SPIKE_BAR_COUNT, materializeBars } from "./bars.js";
import { appendMarkerOverlay, readProof } from "./proof.js";
import { injectCss, installMeasure, largestScroller, panFps, sampleRender, waitFor } from "./session.js";

injectCss(ganttCss);

const bars = materializeBars();
if (bars.length !== SPIKE_BAR_COUNT) {
  throw new Error(`svar spike expected ${SPIKE_BAR_COUNT} bars`);
}

const taskTypes = [
  ...defaultTaskTypes,
  { id: "target", label: "Target" },
  { id: "experiment", label: "Experiment" },
];

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("svar spike root is missing");
}
const host: HTMLElement = rootElement;

const root: Root = createRoot(host);

function SpikeTemplate({ data }: { data: ITask }) {
  return <div data-spike-key={String(data.id ?? "")} style={{ height: 20 }} />;
}

function Chart({ data, proof }: { data: SpikeBar[]; proof: boolean }) {
  const tasks = toSvarTasks(data).map((task) => (proof ? task : { ...task, open: true }));
  const visible = proof ? tasks.filter((task) => task.type !== "target" || task.open) : tasks;
  const parents = new Set(visible.map((task) => task.parent).filter((parent) => parent !== 0));
  const ganttTasks = visible.map((task) => ({ ...task, open: parents.has(task.id) }));
  return (
    <div
      className="spike-root"
      style={{ position: "relative", width: 1280, height: 800 }}
      ref={(node) => {
        if (node !== null && proof && node.querySelector("[data-marker-overlay]") === null) {
          appendMarkerOverlay(node);
        }
      }}
    >
      <Willow>
        <Gantt
          tasks={ganttTasks}
          readonly
          cellHeight={36}
          cellWidth={40}
          autoScale={false}
          start={new Date("2026-01-01T00:00:00.000Z")}
          end={new Date("2026-07-01T00:00:00.000Z")}
          columns={[{ id: "text", header: "Envelope", flexgrow: 1 }]}
          taskTypes={taskTypes}
          taskTemplate={SpikeTemplate}
        />
      </Willow>
    </div>
  );
}

function paint(data: SpikeBar[], proof: boolean): void {
  root.render(<Chart data={data} proof={proof} />);
}

installMeasure(async () => {
  paint(proofBars(), true);
  await waitFor(() => document.querySelector("[data-spike-key='tgt-budget']") !== null, "svar proof");
  readProof(document);
  const mount = async (): Promise<void> => {
    paint(bars, false);
    await waitFor(() => document.querySelector("[data-task-id]") !== null, "svar bars");
  };
  const renderP95Ms = await sampleRender(mount);
  const panFpsP50 = await panFps(() => largestScroller(document));
  return {
    renderP95Ms,
    panFpsP50,
    targetLaneProven: true,
    markerOverlayProven: true,
  };
});
