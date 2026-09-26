// One isolated fixture server PER WORKER (spec/08 §2), so the suite can run on several workers.
//
// The suite used to run on ONE worker against ONE shared server, because every spec shares the
// site's single draft overlay (two workers PATCHing it raced on the overlay rev: a real 409) and
// each server-chat spec shares the one chat. Nothing in the specs needs that sharing: the fixture
// server builds its own temp git origin, storage and PIN app in a private mkdtemp per process
// (fixture_server.py), so a server per worker is fully isolated. Cold start is ~5-9s, paid once
// per worker, and Playwright hands whole spec files to whichever worker is free.
//
// Specs import `test`/`expect` from here (never straight from "@playwright/test") so the
// worker's own `baseURL` reaches `page`, `request` and `browser.newContext()` alike.

import { test as base, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Correct on CI's ubuntu-latest after actions/setup-python (no bare-name trap on Linux). Locally
// on Windows set WIXY_E2E_PYTHON to the real interpreter (bare `python` is the Store stub).
const PYTHON = process.env["WIXY_E2E_PYTHON"] ?? "python3";
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const BOOT_TIMEOUT_MS = 90_000;
const BOOT_ATTEMPTS = 3;

interface FixtureServer {
  readonly baseURL: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      // The Windows process tree (uvicorn, ffmpeg children) is not reaped by kill().
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

/** Starts fixture_server.py on a free port and resolves once /healthz answers. */
async function bootServer(workerIndex: number): Promise<{ server: FixtureServer; child: ChildProcess }> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    const child = spawn(PYTHON, ["fixture_server.py"], {
      cwd: E2E_DIR,
      env: { ...process.env, WIXY_E2E_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exited: string | null = null;
    child.once("exit", (code, signal) => {
      exited = `exited (code ${code ?? "none"}, signal ${signal ?? "none"})`;
    });
    const tail: string[] = [];
    const relay = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line === "") continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        console.log(`[server w${workerIndex}] ${line}`);
      }
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline && exited === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return { server: { baseURL: `http://127.0.0.1:${port}` }, child };
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    lastFailure = `attempt ${attempt} on port ${port}: ${exited ?? "no /healthz within boot timeout"}\n${tail.join("\n")}`;
    stopTree(child);
  }
  throw new Error(`fixture server failed to start after ${BOOT_ATTEMPTS} attempts:\n${lastFailure}`);
}

export const test = base.extend<object, { fixtureServer: FixtureServer }>({
  fixtureServer: [
    async ({}, use, workerInfo) => {
      const { server, child } = await bootServer(workerInfo.workerIndex);
      await use(server);
      stopTree(child);
    },
    // `auto`: boot before the worker's first test even if that test only calls
    // `browser.newContext()` and never touches a fixture that depends on the server.
    { scope: "worker", auto: true, timeout: BOOT_TIMEOUT_MS * BOOT_ATTEMPTS + 30_000 },
  ],
  baseURL: async ({ fixtureServer }, use) => {
    await use(fixtureServer.baseURL);
  },
});

export { expect };
