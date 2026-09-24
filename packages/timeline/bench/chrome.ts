import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolveChromePath } from "../../../scripts/chrome-path.mjs";
import type { EngineSample } from "./session.js";

export type TimelineEngine = "svar" | "vis" | "canvas";

const benchDir = dirname(fileURLToPath(import.meta.url));

const ENTRY: Record<TimelineEngine, string> = {
  svar: "render-svar.tsx",
  vis: "render-vis.ts",
  canvas: "render-canvas.ts",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function waitForDevtools(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      if (buffer.includes("DevTools listening on ws://")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`chrome exited ${code ?? "null"} before DevTools opened: ${buffer}`));
    };
    const cleanup = (): void => {
      child.stderr?.off("data", onData);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function serve(dir: string): Promise<{ server: Server; port: number }> {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0">
<div id="root"></div>
<script>window.addEventListener("error", (event) => { window.__timelineSpikeError = (event.error && event.error.stack) || event.message; });</script>
<script src="/app.js"></script>
</body>
</html>`;
  const port = await freePort();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(html);
      return;
    }
    if (url.pathname === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(readFileSync(join(dir, "app.js")));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { server, port };
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

class Cdp {
  private next = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id === undefined) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error?.message !== undefined) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
    });
  }

  send(method: string, params?: object): Promise<unknown> {
    const id = this.next + 1;
    this.next = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluate(cdp: Cdp, expression: string, awaitPromise: boolean): Promise<unknown> {
  const raw = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  })) as EvalResult;
  if (raw.exceptionDetails !== undefined) {
    const description = raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? "evaluate failed";
    throw new Error(description);
  }
  return raw.result?.value;
}

function isSample(value: unknown): value is EngineSample {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const sample = value as Record<string, unknown>;
  return (
    typeof sample["renderP95Ms"] === "number" &&
    typeof sample["panFpsP50"] === "number" &&
    sample["targetLaneProven"] === true &&
    sample["markerOverlayProven"] === true
  );
}

export async function measureEngine(engine: TimelineEngine): Promise<EngineSample> {
  const dir = await mkdtemp(join(tmpdir(), "timeline-spike-"));
  const profile = join(dir, "chrome-profile");
  let chrome: ChildProcess | undefined;
  let server: Server | undefined;
  try {
    await build({
      absWorkingDir: benchDir,
      entryPoints: [join(benchDir, ENTRY[engine])],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      outfile: join(dir, "app.js"),
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "text" },
    });
    const served = await serve(dir);
    server = served.server;
    const debugPort = await freePort();
    chrome = spawn(
      resolveChromePath(),
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForDevtools(chrome);
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${served.port}/`, {
      method: "PUT",
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`chrome /json/new failed: ${response.status}`);
      }
      return response.json() as Promise<{ webSocketDebuggerUrl?: string }>;
    });
    const pageUrl = created.webSocketDebuggerUrl;
    if (pageUrl === undefined) {
      throw new Error("chrome did not return a page websocket");
    }
    const ws = new WebSocket(pageUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("chrome page websocket failed")));
    });
    const cdp = new Cdp(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${served.port}/` });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const kind = await evaluate(cdp, "typeof window.__timelineSpikeMeasure", false);
      if (kind === "function") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      const detail = await evaluate(cdp, "String(window.__timelineSpikeError || document.body.innerText || '')", false);
      throw new Error(`${engine} page did not install the sampler: ${String(detail)}`);
    }
    const sample = await evaluate(cdp, "window.__timelineSpikeMeasure()", true);
    if (!isSample(sample)) {
      throw new Error(`${engine} sample was ${JSON.stringify(sample)}`);
    }
    ws.close();
    return sample;
  } finally {
    await stopChrome(chrome);
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await removeDir(dir);
  }
}

async function stopChrome(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
