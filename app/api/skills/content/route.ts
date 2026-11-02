import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { SkillViewScope } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { samePath } from "@/lib/paths";
import { readRegularFileText } from "@/lib/regular-file";
import { isApiRequestAllowed } from "@/lib/request-security";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";

export const dynamic = "force-dynamic";

/** Keep a Skills panel response bounded while allowing a complete SKILL.md. */
const SKILL_CONTENT_MAX_BYTES = 1024 * 1024;

function readScope(value: string | null): SkillViewScope | null {
  if (value === null || value === "") return "project";
  return value === "global" || value === "project" ? value : null;
}

function physicalPath(filePath: string): string | undefined {
  try {
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a requested path against the resource loader's actual loaded files.
 * The allowlist is evidence for which resource may be read; it is not itself
 * a filesystem authorization. Both the request and the selected resource are
 * resolved again before the regular-file and allowed-root checks below.
 */
function findLoadedSkillPath(
  requestedPath: string,
  loadedPaths: readonly string[],
): string | undefined {
  const requestedPhysicalPath = physicalPath(requestedPath);
  if (!requestedPhysicalPath) return undefined;
  for (const loadedPath of loadedPaths) {
    const loadedPhysicalPath = physicalPath(loadedPath);
    if (loadedPhysicalPath && samePath(loadedPhysicalPath, requestedPhysicalPath)) {
      return loadedPhysicalPath;
    }
  }
  return undefined;
}

function readErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (/larger than \d+ bytes/.test(message)) {
    return NextResponse.json({ error: message }, { status: 413 });
  }
  if (/not a regular file/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

// GET /api/skills/content?cwd=<path>&filePath=<loaded skill path>&scope=<scope>
// The resource loader is the candidate allowlist: accepting any readable
// Markdown path would turn this panel into a general filesystem reader.
// `sessionId`, `revision`, `trustKey` and `generation` remain request identity
// fields for the peer/client chain; authorization still comes from cwd trust,
// the selected resource scope and the physical file checks below.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  let searchParams: URLSearchParams;
  try {
    searchParams = new URL(req.url).searchParams;
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  const cwd = searchParams.get("cwd");
  const requestedFilePath = searchParams.get("filePath");
  const document = searchParams.get("document");
  const scope = readScope(searchParams.get("scope"));
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  if (!requestedFilePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
  if (!scope) return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // loadSkillsWithInstallInfo applies the same project-trust/resource-scope
    // resolution used by the panel. Only resources it actually loaded can be
    // selected. A loaded resource may be disabled for invocation and still be
    // viewable here; display authorization must not be confused with execution.
    const { skills } = await loadSkillsWithInstallInfo(cwd, scope);
    const loadedPath = findLoadedSkillPath(
      requestedFilePath,
      skills.map((skill) => skill.filePath),
    );
    if (!loadedPath) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    // Re-check the physical path at the read boundary. This rejects a loaded
    // symlink whose target escapes the current allowed roots and prevents a
    // string path in the loader result from becoming authorization by itself.
    const resourceRoots = allowedRoots;
    if (!isExistingFilePathAllowed(requestedFilePath, resourceRoots)
      || !isExistingFilePathAllowed(loadedPath, resourceRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let target = loadedPath;
    if (document !== null) {
      const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });
      if (path.isAbsolute(document) || /[\\:\0]/.test(document) || document.split("/").includes("..")) {
        return refuse(400, "Document path must stay inside the skill folder");
      }
      const MARKDOWN_FILE = /\.(md|markdown)$/i;
      if (!MARKDOWN_FILE.test(document)) return refuse(415, "Only Markdown documents can be opened");
      const skillDir = path.dirname(loadedPath);
      target = path.join(skillDir, document);
      if (!existsSync(target)) return refuse(404, "Skill document not found");
      const resolvedTarget = physicalPath(target);
      if (!resolvedTarget || !isExistingFilePathAllowed(resolvedTarget, new Set([skillDir])) || !MARKDOWN_FILE.test(resolvedTarget)) {
        return refuse(403, "Document is outside the skill folder");
      }
      const stats = statSync(target);
      if (!stats.isFile()) return refuse(400, "Skill document is not a regular file");
      if (stats.size > SKILL_CONTENT_MAX_BYTES) return refuse(413, "Skill document is larger than 1 MiB");
    }

    const content = document !== null
      ? readRegularFileText(target, SKILL_CONTENT_MAX_BYTES)
      : readRegularFileText(loadedPath, SKILL_CONTENT_MAX_BYTES);
    if (content === undefined) {
      return NextResponse.json({ error: document !== null ? "Skill document not found" : "Skill file not found" }, { status: 404 });
    }
    return NextResponse.json(
      { content },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (document !== null) {
      return NextResponse.json({ error: "Skill document could not be read" }, { status: 500 });
    }
    return readErrorResponse(error);
  }
}
