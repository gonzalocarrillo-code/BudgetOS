import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export type ScrollEngine = "glide" | "tanstack";

const benchDir = dirname(fileURLToPath(import.meta.url));
const glideDist = join(benchDir, "../node_modules/@glideapps/glide-data-grid/dist");

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

function waitForDevtools(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buffer);
      const port = match?.[1];
      if (port !== undefined) {
        cleanup();
        resolve(Number(port));
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

function contentType(path: string): string {
  if (path.endsWith(".js")) {
    return "text/javascript";
  }
  if (path.endsWith(".css")) {
    return "text/css";
  }
  return "text/html";
}

async function serve(dir: string, glideStyles: boolean): Promise<{ server: Server; port: number }> {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${glideStyles ? '<link rel="stylesheet" href="/glide/index.css">' : ""}
</head>
<body style="margin:0">
<div id="root"></div>
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
    if (url.pathname.startsWith("/glide/")) {
      const relative = normalize(url.pathname.slice("/glide/".length));
      const file = join(glideDist, relative);
      if (!file.startsWith(glideDist)) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        response.writeHead(200, { "content-type": contentType(file) });
        response.end(readFileSync(file));
      } catch (error: unknown) {
        if (!(error instanceof Error)) {
          throw error;
        }
        response.writeHead(404);
        response.end();
      }
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
  method?: string;
  params?: unknown;
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

export async function measureScrollFps(engine: ScrollEngine): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "grid-spike-"));
  const profile = join(dir, "chrome-profile");
  let chrome: ChildProcess | undefined;
  let server: Server | undefined;
  try {
    await build({
      absWorkingDir: benchDir,
      entryPoints: [join(benchDir, engine === "glide" ? "scroll-glide.tsx" : "scroll-tanstack.tsx")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      outfile: join(dir, "app.js"),
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "text" },
    });
    const served = await serve(dir, engine === "glide");
    server = served.server;
    const debugPort = await freePort();
    chrome = spawn("google-chrome", [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForDevtools(chrome);
    const created = (await fetch(
      `http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${served.port}/`,
      { method: "PUT" },
    ).then(async (response) => {
      if (!response.ok) {
        throw new Error(`chrome /json/new failed: ${response.status}`);
      }
      return response.json() as Promise<{ webSocketDebuggerUrl?: string }>;
    }));
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
      const kind = await evaluate(cdp, "typeof window.__gridSpikeMeasure", false);
      if (kind === "function") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      throw new Error(`${engine} scroll page did not install the sampler`);
    }
    const fps = await evaluate(cdp, "window.__gridSpikeMeasure()", true);
    if (typeof fps !== "number" || !Number.isFinite(fps)) {
      throw new Error(`${engine} scroll fps was ${String(fps)}`);
    }
    ws.close();
    return Number(fps.toFixed(1));
  } finally {
    await stopChrome(chrome);
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await removeDir(dir);
  }
}

async function stopChrome(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined) {
    return;
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function removeDir(path: string): Promise<void> {
  let pending: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      pending = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (pending !== undefined) {
    return;
  }
}
