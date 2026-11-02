import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runNpx } from "@/lib/npx";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { getPluginPackageIdentity } from "@/lib/plugin-project-status";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { refreshUpdatedSkillTriggerMetadata } from "@/lib/skill-trigger-analysis";
import { resolveAnalysisCwd } from "@/lib/skill-analysis-cwd";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const { package: pkg, scope, cwd } = await req.json() as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) return NextResponse.json({ error: "package required" }, { status: 400 });

    const isGlobal = scope !== "project";
    if (!isGlobal) {
      if (!cwd) return NextResponse.json({ error: "cwd required for project install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) {
        return NextResponse.json(
          { error: "Project resources must be trusted before installing project skills" },
          { status: 403 },
        );
      }
    }
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      return NextResponse.json({ error: output.slice(-300) || "Install failed" }, { status: 500 });
    }
    // Analysis loads settings, project resources and model services for the
    // given directory, so it must never receive an unvalidated caller path.
    const analysis = resolveAnalysisCwd(cwd, await getAllowedFileRoots());
    if (analysis.rejected) {
      console.warn("[skills/install] trigger-mode analysis skipped for an unauthorized cwd");
    }
    const analysisCwd = analysis.cwd;
    const installScope = isGlobal ? "global" : "project";
    let triggerModes;
    try {
      const refreshed = await loadSkillsWithInstallInfo(analysisCwd, installScope);
      // Match on resolved source identity instead of raw command input: a
      // repository or GitHub URL install is recorded in the skill lock as
      // `owner/repo@skillName`, so exact input equality selects nothing.
      const requested = pkg.trim();
      const identityOptions = { cwd: analysisCwd, scope: isGlobal ? "user" as const : "project" as const };
      const requestedIdentity = getPluginPackageIdentity(requested, identityOptions);
      const installedSkills = refreshed.skills.filter((skill) => {
        if (skill.install?.scope !== installScope) return false;
        const recorded = skill.install.source;
        if (!recorded) return false;
        if (recorded === requested || skill.install.package === requested) return true;
        return getPluginPackageIdentity(recorded, identityOptions) === requestedIdentity;
      });
      triggerModes = await refreshUpdatedSkillTriggerMetadata(installedSkills, { cwd: analysisCwd });
    } catch (error) {
      console.warn(`[skills/install] trigger-mode analysis skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return NextResponse.json({ success: true, output, ...(triggerModes ? { triggerModes } : {}) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    return NextResponse.json({ error: output || (err.message ?? String(e)) }, { status: 500 });
  }
}
