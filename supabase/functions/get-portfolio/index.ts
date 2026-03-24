import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";

const alpacaHeaders = {
  "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY")!,
  "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_SECRET_KEY")!,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const SUPABASE_REF = "bhumjspdeveqybkilcxc";
const ALLOWED_ROLES = new Set(["anon", "authenticated", "service_role"]);

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

  // Vérification JWT stricte (format, scope projet, rôle autorisé, expiration)
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

  const [account, positions, clock, snapshotsRes, tradesRes, allPnlRes, analysisRes, weeklyRes, memoryRes, reflectionsRes] = await Promise.all([
    fetch(`${ALPACA_BASE_URL}/account`,   { headers: alpacaHeaders }).then(r => r.json()).catch(() => null),
    fetch(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders }).then(r => r.json()).catch(() => null),
    fetch(`${ALPACA_BASE_URL}/clock`,     { headers: alpacaHeaders }).then(r => r.json()).catch(() => null),
    supabase.from("portfolio_snapshots").select("created_at, cash, equity").order("created_at", { ascending: true }).limit(200),
    supabase.from("trades").select("*").order("created_at", { ascending: false }).limit(40),
    supabase.from("trades").select("pnl").not("pnl", "is", null),
    supabase.from("bot_analyses").select("*").eq("type", "analysis").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("bot_analyses").select("*").eq("type", "weekly_summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("bot_memory").select("content, importance, layer, times_confirmed, times_contradicted, created_at").eq("is_active", true).order("importance", { ascending: false }).limit(20),
    supabase.from("trade_reflections").select("symbol, pnl, lesson, rule_derived, promote_to_memory, created_at").order("created_at", { ascending: false }).limit(10),
  ]);

  const allClosedTrades = (allPnlRes.data ?? []) as Array<{ pnl: number | null }>;
  const closedTradeCount = allClosedTrades.length;
  const winningTradeCount = allClosedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const totalRealizedPnl = allClosedTrades.reduce((s: number, t) => s + (t.pnl || 0), 0);
  const safeAccount =
    account && typeof account === "object" && !("code" in account)
      ? account as Record<string, unknown>
      : null;
  const safePositions = Array.isArray(positions) ? positions : [];
  const parseNum = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const positionsUnrealized = safePositions.reduce((sum: number, p: Record<string, unknown>) => {
    return sum + (parseNum(p.unrealized_pl) ?? 0);
  }, 0);
  const liveUnrealizedPnl = parseNum(safeAccount?.unrealized_pl) ?? positionsUnrealized;

  return new Response(
    JSON.stringify({
      account:            safeAccount,
      positions:          safePositions,
      market_open:        clock?.is_open ?? false,
      snapshots:          snapshotsRes.data    ?? [],
      trades:             tradesRes.data       ?? [],
      total_realized_pnl: totalRealizedPnl,
      closed_trade_count: closedTradeCount,
      winning_trade_count: winningTradeCount,
      live_unrealized_pnl: liveUnrealizedPnl,
      analysis:           analysisRes.data     ?? null,
      weekly_summary:     weeklyRes.data       ?? null,
      memory:             memoryRes.data       ?? [],
      reflections:        reflectionsRes.data  ?? [],
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
