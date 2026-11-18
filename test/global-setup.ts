import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

// The tests need a real PostgreSQL server, because row-level security is the boundary under test.
// Set TENANT_GUARD_TEST_PORT to use a server you already run. Otherwise a temporary server starts
// from the embedded-postgres binaries, so nothing has to be installed.
export default async function setup() {
  let stop: () => Promise<void> = async () => undefined;
  if (!process.env.TENANT_GUARD_TEST_PORT) {
    // initdb creates the folder, so that it owns it.
    const dir = join(tmpdir(), `tenant-guard-pg-${randomBytes(6).toString("hex")}`);
    const port = 54000 + Math.floor(Math.random() * 1000);
    const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, onLog: () => undefined });
    await server.initialise();
    await server.start();
    process.env.TENANT_GUARD_TEST_PORT = String(port);
    process.env.TENANT_GUARD_TEST_PASSWORD = "postgres";
    stop = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }
  const admin = new pg.Client({
    host: "127.0.0.1",
    port: Number(process.env.TENANT_GUARD_TEST_PORT),
    user: "postgres",
    password: process.env.TENANT_GUARD_TEST_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS tg_test");
  await admin.query("DROP ROLE IF EXISTS tg_owner");
  await admin.query("DROP ROLE IF EXISTS tg_app");
  await admin.query("CREATE ROLE tg_owner LOGIN PASSWORD 'owner'");
  await admin.query("CREATE ROLE tg_app LOGIN PASSWORD 'app'");
  await admin.query("CREATE DATABASE tg_test OWNER tg_owner");
  await admin.end();
  const db = new pg.Client({ host: "127.0.0.1", port: Number(process.env.TENANT_GUARD_TEST_PORT), user: "postgres", password: process.env.TENANT_GUARD_TEST_PASSWORD, database: "tg_test" });
  await db.connect();
  await db.query("GRANT USAGE ON SCHEMA public TO tg_app");
  await db.query("ALTER DEFAULT PRIVILEGES FOR ROLE tg_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tg_app");
  await db.query("ALTER DEFAULT PRIVILEGES FOR ROLE tg_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tg_app");
  await db.end();
  return stop;
}
