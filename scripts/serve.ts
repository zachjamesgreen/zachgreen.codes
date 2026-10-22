// Static server for development and tests that behaves like the production
// nginx (spec §8): `index index.html`, `try_files $uri $uri/ =404`, a 301 for a
// directory requested without its trailing slash, and `error_page 404 /404.html`.
// Dotfiles are never served. It listens on the loopback interface only.
//
//   node scripts/serve.ts --root site [--port 4321] [--fixtures tests/e2e/fixtures]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export interface ServerOptions {
  /** Directory to serve; the equivalent of nginx's `root`. */
  root: string;
  /** Port to listen on. 0, the default, picks a free one. */
  port?: number;
  /**
   * Directory served under `/__fixtures__/`. For tests only: production has
   * no such path, so leave it unset everywhere else.
   */
  fixturesDir?: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const FIXTURES_PREFIX = "/__fixtures__/";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".pdf", "application/pdf"],
  [".woff2", "font/woff2"],
]);

const HTML = CONTENT_TYPES.get(".html")!;

type Lookup =
  | { kind: "file"; path: string }
  | { kind: "redirect"; location: string }
  | { kind: "bad-request" }
  | { kind: "not-found" };

function contentTypeOf(path: string): string {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

function isInside(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
}

/** `stat` that answers undefined for "no such file" instead of throwing. */
async function statOrUndefined(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG") return undefined;
    throw error;
  }
}

async function lookup(root: string, fixturesDir: string | undefined, url: string): Promise<Lookup> {
  if (!url.startsWith("/")) return { kind: "bad-request" };

  // The raw URL is split by hand. Going through `new URL()` would resolve `..`
  // before the checks below could see it.
  const queryAt = url.indexOf("?");
  const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
  const search = queryAt === -1 ? "" : url.slice(queryAt);

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { kind: "bad-request" };
  }
  if (path.includes("\0")) return { kind: "not-found" };

  let base = root;
  let segments = path.split("/").filter(Boolean);
  if (fixturesDir !== undefined && path.startsWith(FIXTURES_PREFIX)) {
    base = fixturesDir;
    segments = segments.slice(1);
  }

  // `.` and `..` fall under this rule too, so traversal is refused outright
  // and the `isInside` check below is the second line of defence.
  if (segments.some((segment) => segment.startsWith("."))) return { kind: "not-found" };

  const target = resolve(base, ...segments);
  if (!isInside(base, target)) return { kind: "not-found" };

  const info = await statOrUndefined(target);
  if (info === undefined) return { kind: "not-found" };

  if (info.isDirectory()) {
    // Leading slashes collapse so `//a` can't become the protocol-relative `//a/`.
    if (!path.endsWith("/")) return { kind: "redirect", location: `${rawPath.replace(/^\/+/, "/")}/${search}` };
    const index = resolve(target, "index.html");
    return (await statOrUndefined(index))?.isFile() ? { kind: "file", path: index } : { kind: "not-found" };
  }
  // `/style.css/` is not a file, just as in nginx.
  return info.isFile() && !path.endsWith("/") ? { kind: "file", path: target } : { kind: "not-found" };
}

function send(
  res: ServerResponse,
  method: string,
  status: number,
  type: string,
  body: Buffer | string,
  extra: Record<string, string> = {},
): void {
  const payload = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { "content-type": type, "content-length": payload.length, ...extra });
  res.end(method === "HEAD" ? undefined : payload);
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const root = resolve(options.root);
  const fixturesDir = options.fixturesDir === undefined ? undefined : resolve(options.fixturesDir);

  async function sendNotFound(res: ServerResponse, method: string): Promise<void> {
    const page = await readFile(resolve(root, "404.html")).catch(() => undefined);
    if (page === undefined) send(res, method, 404, "text/plain; charset=utf-8", "Not Found\n");
    else send(res, method, 404, HTML, page);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(res, method, 405, "text/plain; charset=utf-8", "Method Not Allowed\n", { allow: "GET, HEAD" });
      return;
    }

    const found = await lookup(root, fixturesDir, req.url ?? "");
    switch (found.kind) {
      case "file":
        send(res, method, 200, contentTypeOf(found.path), await readFile(found.path));
        break;
      case "redirect":
        send(res, method, 301, "text/plain; charset=utf-8", "Moved Permanently\n", { location: found.location });
        break;
      case "bad-request":
        send(res, method, 400, "text/plain; charset=utf-8", "Bad Request\n");
        break;
      case "not-found":
        await sendNotFound(res, method);
        break;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) send(res, req.method ?? "GET", 500, "text/plain; charset=utf-8", "Internal Server Error\n");
      else res.destroy();
    });
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(options.port ?? 0, "127.0.0.1", resolveListening);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClosed, rejectClosed) => {
        server.close((error) => (error ? rejectClosed(error) : resolveClosed()));
        server.closeAllConnections();
      }),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      port: { type: "string", default: "4321" },
      fixtures: { type: "string" },
    },
  });
  const port = Number(values.port);
  if (values.root === undefined || !Number.isInteger(port)) {
    console.error("usage: node scripts/serve.ts --root <dir> [--port 4321] [--fixtures <dir>]");
    process.exit(2);
  }
  const { url } = await startServer({ root: values.root, port, fixturesDir: values.fixtures });
  console.log(`Serving ${values.root} at ${url}`);
}
