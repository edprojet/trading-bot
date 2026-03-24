import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const SUPABASE_REF = "bhumjspdeveqybkilcxc";
const ALLOWED_ROLES = new Set(["anon", "authenticated", "service_role"]);

function parseIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isValidDashboardToken(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const payload = JSON.parse(atob(parts[1]));
  const exp = Number(payload?.exp);
  const role = String(payload?.role ?? "");
  const now = Math.floor(Date.now() / 1000);

  if (payload?.iss !== "supabase" || payload?.ref !== SUPABASE_REF) return false;
  if (!ALLOWED_ROLES.has(role)) return false;
  if (!Number.isFinite(exp) || exp <= now) return false;
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!isValidDashboardToken(req)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  const fromIso = parseIsoOrNull(url.searchParams.get("from"));
  const toIso = parseIsoOrNull(url.searchParams.get("to"));

  let persistentCountQuery: any = supabase
    .from("bot_execution_logs")
    .select("id", { count: "exact", head: true });
  let persistentRunsQuery: any = supabase
    .from("bot_execution_logs")
    .select("created_at, run_source, bot_status, severity, human_message, http_status, details")
    .order("created_at", { ascending: false })
    .limit(500);

  if (fromIso) {
    persistentCountQuery = persistentCountQuery.gte("created_at", fromIso);
    persistentRunsQuery = persistentRunsQuery.gte("created_at", fromIso);
  }
  if (toIso) {
    persistentCountQuery = persistentCountQuery.lt("created_at", toIso);
    persistentRunsQuery = persistentRunsQuery.lt("created_at", toIso);
  }

  const [persistentCountRes, persistentRunsRes, legacyRunsRes, legacyCountRes, decisionsRes, botStateRes] = await Promise.all([
    persistentCountQuery,
    persistentRunsQuery,
    supabase.rpc("get_bot_run_logs", { limit_n: 500 }),
    supabase.rpc("get_bot_run_logs_count"),
    supabase
      .from("trades")
      .select("created_at, action, symbol, quantity, reason, status")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("bot_runs")
      .select("is_running, started_at")
      .eq("id", 1)
      .single(),
  ]);

  const hasPersistentRuns = Array.isArray(persistentRunsRes.data) && persistentRunsRes.data.length > 0;
  const filteredLegacyRuns = ((legacyRunsRes.data ?? []) as Array<Record<string, unknown>>).filter((r) => {
    if (!fromIso && !toIso) return true;
    const startedAt = String(r.started_at ?? "");
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return false;
    if (fromIso && t < new Date(fromIso).getTime()) return false;
    if (toIso && t >= new Date(toIso).getTime()) return false;
    return true;
  });
  const persistentTotal = persistentCountRes.count ?? 0;
  const legacyTotal = (fromIso || toIso)
    ? filteredLegacyRuns.length
    : (typeof legacyCountRes.data === "number" ? legacyCountRes.data : (legacyRunsRes.data?.length ?? 0));
  const runs = hasPersistentRuns
    ? (persistentRunsRes.data ?? []).map((r) => ({
        started_at: r.created_at,
        run_source: r.run_source,
        bot_status: r.bot_status,
        severity: r.severity,
        human_message: r.human_message,
        http_status: r.http_status,
        details: r.details,
      }))
    : filteredLegacyRuns;

  return new Response(
    JSON.stringify({
      runs,
      logs_source: hasPersistentRuns ? "bot_execution_logs" : "legacy_rpc",
      total_cycles: hasPersistentRuns ? persistentTotal : legacyTotal,
      displayed_cycles: runs.length,
      decisions: decisionsRes.data ?? [],
      bot_state: botStateRes.data  ?? { is_running: false, started_at: null },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
