import { resolve, relative } from "node:path";
import { scanRoutes } from "../router/route-scanner.js";
import { importFile } from "../utils/import-module.js";

/**
 * Registry of server actions grouped by page path.
 *
 * The outer key is the page URL path (e.g. "/contact"). The inner object maps
 * each exported action name to the absolute file path of the `page.action.ts`
 * module that defines it.
 */
export type ActionRegistry = Record<string, Record<string, string>>;

/**
 * Scans `page.action.ts` modules and returns a per-page registry of server actions.
 *
 * Only named function exports are collected; default exports are ignored. The
 * registry is keyed by page URL path so the client can resolve actions scoped
 * to a specific page and avoid name collisions between different routes.
 */
export async function scanActions(appDir: string): Promise<ActionRegistry> {
  const routes = await scanRoutes(appDir);
  const actions: ActionRegistry = {};

  for (const page of routes.pages) {
    if (!page.actionPath) continue;
    const actionPath = resolve(page.actionPath);
    const mod = (await importFile(actionPath)) as Record<string, unknown>;
    const pageActions: Record<string, string> = {};
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default") continue;
      if (typeof value === "function") {
        pageActions[name] = actionPath;
      }
    }
    if (Object.keys(pageActions).length > 0) {
      actions[page.path] = pageActions;
    }
  }

  return actions;
}

/**
 * Return a copy of the action registry where every file path is made relative to
 * the given project root. Useful for serializing actions into the HTML shell
 * without exposing absolute server paths.
 */
export function relativeActions(actions: ActionRegistry, root: string): ActionRegistry {
  const result: ActionRegistry = {};
  for (const [page, pageActions] of Object.entries(actions)) {
    const entries: Record<string, string> = {};
    for (const [name, actionPath] of Object.entries(pageActions)) {
      entries[name] = relative(root, actionPath);
    }
    result[page] = entries;
  }
  return result;
}

/**
 * Return only the names of available actions per page, without file paths.
 * This is the safe format to serialize into the HTML shell: the client only
 * needs to know which actions exist, never where they are implemented.
 */
export function actionNames(actions: ActionRegistry): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [page, pageActions] of Object.entries(actions)) {
    result[page] = Object.keys(pageActions);
  }
  return result;
}
