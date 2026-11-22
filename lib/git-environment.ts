import { sanitizeProjectCommandEnvironment } from "./project-command-env.ts";

/**
 * Environment for Git children running in a project folder. Repository-owned
 * hooks may execute, so keep normal PATH and project variables but remove the
 * Reader host runtime and login secret, and pin Git's diagnostics to English.
 */
export function projectGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...sanitizeProjectCommandEnvironment(base), LC_ALL: "C" };
}
