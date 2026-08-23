// --- CLI commands: check, routes, doctor (plan §12.1) ---
//
// `check`  — typechecks the project and validates route/config integrity.
// `routes` — lists all discovered routes and their metadata.
// `doctor` — diagnoses common configuration and environment issues.
//
// All commands produce actionable error messages with cause/path/suggestion
// and reliable exit codes.

import { stat, access } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { scanRoutes } from "../router/route-scanner.js";
import { scanActions } from "../action/scan.js";
import type { CliOptions } from "../cli.js";

/** Exit codes used by all CLI commands. */
export const ExitCode = {
  Success: 0,
  GenericError: 1,
  ConfigError: 2,
  TypeError: 3,
  RouteConflict: 4,
  MissingDependency: 5,
} as const;

/** Formats an error with cause, path, and suggestion. */
export function formatError(
  cause: string,
  path?: string,
  suggestion?: string,
): string {
  const parts = [cause];
  if (path) parts.push(`  at: ${path}`);
  if (suggestion) parts.push(`  fix: ${suggestion}`);
  return parts.join("\n");
}

// check — typecheck + route/config integrity

export async function doCheck(options: CliOptions): Promise<number> {
  console.log("Running typecheck...");
  const typecheckResult = await runTypecheck(options.root);
  if (typecheckResult !== 0) {
    console.error(formatError(
      "Typecheck failed.",
      undefined,
      "Fix TypeScript errors above before building.",
    ));
    return ExitCode.TypeError;
  }
  console.log("✓ Typecheck passed");

  console.log("\nValidating routes...");
  try {
    const routes = await scanRoutes(options.appDir);
    console.log(`✓ ${routes.pages.length} page route(s), ${routes.api.length} API route(s)`);
    if (routes.error404) console.log("  - 404 page: configured");
    if (routes.error500) console.log("  - 500 page: configured");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(formatError(
      "Route validation failed.",
      options.appDir,
      message,
    ));
    return ExitCode.RouteConflict;
  }

  console.log("\nValidating actions...");
  try {
    const actions = await scanActions(options.appDir);
    console.log(`✓ ${actions.size} action(s) discovered`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(formatError(
      "Action validation failed.",
      options.appDir,
      message,
    ));
    return ExitCode.GenericError;
  }

  console.log("\n✓ All checks passed");
  return ExitCode.Success;
}

// routes — list all discovered routes

export async function doRoutes(options: CliOptions): Promise<number> {
  try {
    const routes = await scanRoutes(options.appDir);

    console.log("\nPage routes:");
    if (routes.pages.length === 0) {
      console.log("  (none)");
    } else {
      for (const page of routes.pages) {
        const params = page.params.length > 0 ? ` [${page.params.join(", ")}]` : "";
        const loading = page.loadingPath ? " +loading" : "";
        const action = page.actionPath ? " +action" : "";
        const data = page.dataPath ? " +data" : "";
        const optional = page.optionalCatchAll ? " (optional)" : "";
        console.log(`  ${page.path}${params}${data}${loading}${action}${optional}`);
        console.log(`    page: ${relative(options.root, page.pagePath)}`);
        if (page.layouts.length > 0) {
          console.log(`    layouts: ${page.layouts.map((l) => relative(options.root, l)).join(" → ")}`);
        }
      }
    }

    console.log("\nAPI routes:");
    if (routes.api.length === 0) {
      console.log("  (none)");
    } else {
      for (const api of routes.api) {
        const params = api.params.length > 0 ? ` [${api.params.join(", ")}]` : "";
        console.log(`  ${api.path}${params}`);
        console.log(`    route: ${relative(options.root, api.routePath)}`);
      }
    }

    if (routes.error404) {
      console.log(`\n404 page: ${relative(options.root, routes.error404.pagePath)}`);
    } else {
      console.log("\n404 page: (not configured)");
    }
    if (routes.error500) {
      console.log(`500 page: ${relative(options.root, routes.error500.pagePath)}`);
    } else {
      console.log("500 page: (not configured)");
    }

    return ExitCode.Success;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(formatError("Failed to scan routes.", options.appDir, message));
    return ExitCode.RouteConflict;
  }
}

// doctor — diagnose common issues

interface DiagnosticResult {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  suggestion?: string;
}

export async function doDoctor(options: CliOptions): Promise<number> {
  const results: DiagnosticResult[] = [];

  // Check 1: app directory exists
  results.push(await checkExists("App directory", options.appDir, "Create src/app/ with at least a page.ts"));

  // Check 2: islands directory exists (optional)
  if (options.islandsDir) {
    results.push(await checkExists("Islands directory", options.islandsDir, "Create src/islands/ for client-side islands", "warn"));
  }

  // Check 3: public directory exists (optional)
  if (options.publicDir) {
    results.push(await checkExists("Public directory", options.publicDir, "Create public/ for static assets", "warn"));
  }

  // Check 4: nix.config.ts exists (optional)
  const configPaths = ["nix.config.ts", "nix.config.js", "nix.config.mjs"];
  let configFound = false;
  for (const p of configPaths) {
    try {
      await access(join(options.root, p));
      configFound = true;
      results.push({ name: "Config file", status: "ok", message: `Found ${p}` });
      break;
    } catch {
      // continue
    }
  }
  if (!configFound) {
    results.push({
      name: "Config file",
      status: "warn",
      message: "No nix.config.ts/js/mjs found",
      suggestion: "Create nix.config.ts for custom configuration (optional, defaults work)",
    });
  }

  // Check 5: TypeScript config exists
  results.push(await checkExists("tsconfig.json", join(options.root, "tsconfig.json"), "Create a tsconfig.json for TypeScript support", "warn"));

  // Check 6: Node.js version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0]!, 10);
  if (major >= 18) {
    results.push({ name: "Node.js version", status: "ok", message: `v${nodeVersion}` });
  } else {
    results.push({
      name: "Node.js version",
      status: "error",
      message: `v${nodeVersion} (requires >= 18)`,
      suggestion: "Upgrade Node.js to v18 or later",
    });
  }

  // Check 7: routes scan
  try {
    const routes = await scanRoutes(options.appDir);
    results.push({
      name: "Route scan",
      status: routes.pages.length > 0 ? "ok" : "warn",
      message: `${routes.pages.length} page(s), ${routes.api.length} API route(s)`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({
      name: "Route scan",
      status: "error",
      message: message,
      suggestion: "Fix route conflicts or file structure issues",
    });
  }

  // Check 8: optional peer dependencies
  const peers = [
    { name: "marked", import: "marked", purpose: "Markdown rendering" },
    { name: "zod", import: "zod", purpose: "Schema validation" },
    { name: "sharp", import: "sharp", purpose: "Image optimization" },
  ];
  for (const peer of peers) {
    try {
      await import(peer.import);
      results.push({ name: `Peer dep: ${peer.name}`, status: "ok", message: `available (${peer.purpose})` });
    } catch {
      results.push({
        name: `Peer dep: ${peer.name}`,
        status: "warn",
        message: `not installed (${peer.purpose})`,
        suggestion: `Install with: bun add ${peer.name}`,
      });
    }
  }

  // Print results
  console.log("\nNix.js Kit doctor\n");
  let hasErrors = false;
  let hasWarnings = false;
  for (const result of results) {
    const icon = result.status === "ok" ? "✓" : result.status === "warn" ? "⚠" : "✗";
    const color = result.status === "ok" ? "" : result.status === "warn" ? "" : "";
    console.log(`${icon} ${result.name}: ${color}${result.message}`);
    if (result.suggestion) console.log(`    → ${result.suggestion}`);
    if (result.status === "error") hasErrors = true;
    if (result.status === "warn") hasWarnings = true;
  }

  console.log("");
  if (hasErrors) {
    console.log("✗ Issues found. Fix errors before building.");
    return ExitCode.GenericError;
  } else if (hasWarnings) {
    console.log("⚠ Warnings found. Project may work but consider fixing them.");
    return ExitCode.Success;
  } else {
    console.log("✓ All checks passed. Project is healthy.");
    return ExitCode.Success;
  }
}

// Helpers

async function checkExists(
  name: string,
  path: string,
  suggestion: string,
  level: "error" | "warn" = "error",
): Promise<DiagnosticResult> {
  try {
    await stat(path);
    return { name, status: "ok", message: path };
  } catch {
    return {
      name,
      status: level,
      message: `not found at ${path}`,
      suggestion,
    };
  }
}

async function runTypecheck(root: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsc", "--noEmit"], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
