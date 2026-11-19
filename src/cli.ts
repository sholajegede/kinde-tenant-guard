#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkProject, type CheckReport } from "./check.js";

const HELP = `Usage: kinde-tenant-guard check [paths...] [options]

Checks a project for tenant isolation problems:
  - database access outside the guard (the no-unguarded-db rule)
  - tenant tables and models the guard does not cover
  - Convex tenant tables without an index on the tenant field
  - with --database-url, row-level security in the live database

Options:
  --json                 Print the report as JSON
  --database-url <url>   Check row-level security in this PostgreSQL database (needs pg)
  --client <name>        A raw database client name. Repeat for more. Default: db, prisma
  --convex-context <n>   A Convex context name. Repeat for more. Default: ctx
  --ignore <glob>        Skip matching paths, such as "scripts/**". Repeat for more
  --include-tests        Also check test files, which are skipped by default
  -h, --help             Show this help

Exits with 1 when there is an error finding or a failed database check.`;

function print(report: CheckReport) {
  const out: string[] = [];
  for (const finding of report.findings) {
    out.push(`${finding.file}:${finding.line}:${finding.column}  ${finding.severity}  ${finding.message}  [${finding.rule}]`);
  }
  if (report.database) {
    out.push("", "Database:");
    for (const check of report.database.checks) {
      out.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}${check.ok || !check.fix ? "" : `\n        Fix: ${check.fix}`}`);
    }
  }
  const files = `${report.files} file${report.files === 1 ? "" : "s"}`;
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warnings = report.findings.length - errors;
  out.push(
    "",
    report.ok
      ? `No tenant isolation problems in ${files}${warnings ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`
      : `${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} in ${files}${report.database && !report.database.ok ? ", and the database check failed" : ""}.`,
  );
  console.log(out.join("\n").replace(/^\n/, ""));
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "database-url": { type: "string" },
      client: { type: "string", multiple: true },
      "convex-context": { type: "string", multiple: true },
      ignore: { type: "string", multiple: true },
      "include-tests": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...paths] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  if (command !== "check") {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }
  const report = await checkProject({
    paths,
    ignore: values.ignore,
    includeTests: values["include-tests"],
    clients: values.client,
    convexContexts: values["convex-context"],
    databaseUrl: values["database-url"],
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
