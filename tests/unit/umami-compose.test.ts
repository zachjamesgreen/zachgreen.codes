// deploy/umami/compose.yaml runs Umami on the server, so this pins what keeps it private
// and bounded: the port bound to loopback only, exact image pins, memory limits, restarts
// after the box reboots, log rotation, and secrets that only ever come from the
// server's .env. The file is parsed as YAML, with the pinned `yaml` package.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const COMPOSE_PATH = new URL("../../deploy/umami/compose.yaml", import.meta.url);
const EXAMPLE_PATH = new URL("../../deploy/umami/.env.example", import.meta.url);

interface Service {
  image?: string;
  ports?: unknown[];
  expose?: unknown[];
  environment?: Record<string, string>;
  env_file?: unknown;
  depends_on?: Record<string, { condition?: string }>;
  volumes?: string[];
  networks?: string[];
  restart?: string;
  mem_limit?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  healthcheck?: { test?: string[] };
  logging?: { driver?: string; options?: Record<string, string> };
}

interface Compose {
  name?: string;
  services: Record<string, Service>;
  networks?: Record<string, { internal?: boolean }>;
  volumes?: Record<string, unknown>;
}

const raw = readFileSync(COMPOSE_PATH, "utf8");
const compose = parse(raw) as Compose;
const { umami, db } = compose.services;

/** The file without its comment lines, which compose never interpolates. */
const yamlCode = raw.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/** Every `${NAME...}` the file interpolates, in order of first use. */
const interpolated = [...new Set([...yamlCode.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name!))];

/** The keys .env.example sets, each with the comment line above it. */
function exampleEntries(): { key: string; value: string; comment: string | undefined }[] {
  const lines = readFileSync(EXAMPLE_PATH, "utf8").split("\n");
  return lines.flatMap((line, i) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return [];
    const above = lines[i - 1];
    return [{ key: match[1]!, value: match[2]!, comment: above?.startsWith("#") ? above : undefined }];
  });
}

describe("deploy/umami/compose.yaml", () => {
  it("is the umami project with exactly the umami and db services", () => {
    assert.equal(compose.name, "umami");
    assert.deepEqual(Object.keys(compose.services).toSorted(), ["db", "umami"]);
  });

  it("pins both images to an exact release tag and its digest", () => {
    assert.match(umami?.image ?? "", /^ghcr\.io\/umami-software\/umami:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    assert.match(db?.image ?? "", /^postgres:\d+\.\d+-alpine\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it("publishes Umami on 127.0.0.1:3000 only, and the database not at all", () => {
    assert.deepEqual(umami?.ports, ["127.0.0.1:3000:3000"]);
    assert.equal(db?.ports, undefined);
    assert.equal(db?.expose, undefined);
    // The database's network has no route out, and only Umami joins it.
    assert.deepEqual(db?.networks, ["db"]);
    assert.equal(compose.networks?.db?.internal, true);
  });

  it("keeps the database in the umami-db volume, where the Postgres 18+ images keep their data", () => {
    const major = Number(/^postgres:(\d+)\./.exec(db?.image ?? "")?.[1]);
    assert.ok(major >= 18, `postgres ${major}: before 18 the images keep the data in /var/lib/postgresql/data`);
    assert.deepEqual(db?.volumes, ["umami-db:/var/lib/postgresql"]);
    assert.ok(compose.volumes && "umami-db" in compose.volumes, "no top-level umami-db volume");
  });

  it("sets Umami's environment: the database, the secrets, the tracker name, no telemetry, the proxy's IP header", () => {
    const env = umami?.environment ?? {};
    assert.deepEqual(Object.keys(env).toSorted(), [
      "APP_SECRET", "CLIENT_IP_HEADER", "DATABASE_URL", "DISABLE_TELEMETRY", "TRACKER_SCRIPT_NAME", "TWO_FACTOR_ENCRYPTION_KEY",
    ]);
    // The tracker loads from https://stats.zachgreen.codes/insights.
    assert.equal(env.TRACKER_SCRIPT_NAME, "insights");
    assert.equal(env.DISABLE_TELEMETRY, "1");
    // nginx sets X-Real-IP itself; the other headers Umami would look at first are the client's to forge.
    assert.equal(env.CLIENT_IP_HEADER, "x-real-ip");
    assert.match(env.DATABASE_URL ?? "", /^postgresql:\/\/umami:\$\{POSTGRES_PASSWORD:\?[^}]*\}@db:5432\/umami$/);

    const dbEnv = db?.environment ?? {};
    assert.deepEqual(Object.keys(dbEnv).toSorted(), ["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
    assert.equal(dbEnv.POSTGRES_DB, "umami");
    assert.equal(dbEnv.POSTGRES_USER, "umami");
  });

  it("takes every secret from .env by interpolation, and fails to start without one", () => {
    const secrets = { APP_SECRET: umami?.environment?.APP_SECRET, TWO_FACTOR_ENCRYPTION_KEY: umami?.environment?.TWO_FACTOR_ENCRYPTION_KEY, POSTGRES_PASSWORD: db?.environment?.POSTGRES_PASSWORD };
    for (const [name, value] of Object.entries(secrets)) {
      assert.match(value ?? "", new RegExp(String.raw`^\$\{${name}:\?[^}]*\}$`), name);
    }
    // One way in: no env_file, and every reference is ${NAME:?...}, which stops compose when NAME is unset.
    assert.equal(umami?.env_file, undefined);
    assert.equal(db?.env_file, undefined);
    assert.deepEqual(interpolated.toSorted(), ["APP_SECRET", "POSTGRES_PASSWORD", "TWO_FACTOR_ENCRYPTION_KEY"]);
    assert.deepEqual([...yamlCode.matchAll(/\$\{?[A-Za-z0-9_]+(?![A-Za-z0-9_]|:\?)[^}\s]*\}?/g)].map(([ref]) => ref), [], "a reference without :?");
  });

  it("holds no secret itself: no hex or base64 string besides the image digests", () => {
    // The shapes `openssl rand -hex` and `-base64` give.
    const tokens = [...raw.replaceAll(/sha256:[0-9a-f]{64}/g, "").matchAll(/[0-9A-Fa-f]{32,}|[A-Za-z0-9+/]{40,}={0,2}/g)];
    assert.deepEqual(tokens.map(([token]) => `${token.length} characters`), []);
  });

  it("caps memory at 512m for Umami and 256m for the database", () => {
    assert.equal(umami?.mem_limit, "512m");
    assert.equal(db?.mem_limit, "256m");
  });

  it("starts Umami only once pg_isready passes", () => {
    assert.deepEqual(db?.healthcheck?.test, ["CMD", "pg_isready", "-U", "umami", "-d", "umami"]);
    assert.deepEqual(umami?.depends_on, { db: { condition: "service_healthy" } });
    // Umami's own health route, which setup-umami.sh waits on through `up --wait`.
    assert.ok(umami?.healthcheck?.test?.some((arg) => arg.endsWith("/api/heartbeat")), "Umami has no /api/heartbeat healthcheck");
  });

  for (const [name, service] of Object.entries({ umami, db })) {
    it(`${name}: comes back after a reboot, rotates its logs, and runs without new privileges, read-only`, () => {
      assert.equal(service?.restart, "unless-stopped");
      assert.equal(service?.logging?.driver, "json-file");
      assert.match(service?.logging?.options?.["max-size"] ?? "", /^\d+m$/);
      assert.match(String(service?.logging?.options?.["max-file"] ?? ""), /^\d+$/);
      assert.ok(service?.security_opt?.includes("no-new-privileges:true"), "no no-new-privileges:true");
      assert.deepEqual(service?.cap_drop, ["ALL"]);
      assert.equal(service?.read_only, true);
    });
  }
});

describe("deploy/umami/.env.example", () => {
  it("lists exactly the variables compose.yaml interpolates, each with one comment line", () => {
    const entries = exampleEntries();
    assert.deepEqual(entries.map(({ key }) => key).toSorted(), interpolated.toSorted());
    for (const { key, comment } of entries) assert.ok(comment, `${key} has no comment line above it`);
  });

  it("has placeholders, not values", () => {
    for (const { key, value } of exampleEntries()) {
      assert.match(value, /^<[^>]+>$/, `${key} isn't a <placeholder>`);
    }
  });
});
