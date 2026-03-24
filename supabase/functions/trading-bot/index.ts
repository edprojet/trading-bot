import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";
const GROK_BASE_URL = "https://api.x.ai/v1";
const STOP_LOSS_PCT = 0.08; // Stop-loss hard à -8% — SELL forcé sans consulter Grok


// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const alpacaHeaders = {
  "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY")!,
  "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_SECRET_KEY")!,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Helpers Alpaca — Trading
// ---------------------------------------------------------------------------

async function getAccount() {
  const res = await fetch(`${ALPACA_BASE_URL}/account`, { headers: alpacaHeaders });
  const data = await res.json();
  if (data?.code || data?.message) throw new Error(`Alpaca account error: ${JSON.stringify(data)}`);
  return data;
}

async function getPositions() {
  const res = await fetch(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders });
  return res.json();
}

async function isClock() {
  try {
    const res = await fetch(`${ALPACA_BASE_URL}/clock`, { headers: alpacaHeaders });
    const clock = await res.json();
    return clock.is_open as boolean;
  } catch (err) {
    console.error("isClock() failed — assuming market closed:", err);
    return false;
  }
}

async function placeOrder(symbol: string, qty: number, side: "buy" | "sell") {
  const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
    }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Helpers Alpaca — Données de marché
// ---------------------------------------------------------------------------

type Bar = { c: number; v: number };
type TechData = {
  price: number;
  change_pct: number;
  volume: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
};

function sma(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

async function fetchBars(symbol: string, limit = 200): Promise<Bar[]> {
  try {
    const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await fetch(
      `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=15Min&limit=${limit}&start=${start}&feed=iex`,
      { headers: alpacaHeaders }
    );
    const data = await res.json();
    return data?.bars ?? [];
  } catch {
    return [];
  }
}

async function computeTechnicals(symbol: string): Promise<TechData & { symbol: string }> {
  const bars = await fetchBars(symbol, 60);
  const closes = bars.map((b) => b.c);

  if (closes.length < 2) {
    return { symbol, price: 0, change_pct: 0, volume: 0, sma20: null, sma50: null, rsi14: null, macd: null, macd_signal: null, macd_hist: null };
  }

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const volume = bars[bars.length - 1].v;

  // SMA
  const sma20 = closes.length >= 20 ? +sma(closes.slice(-20)).toFixed(2) : null;
  const sma50 = closes.length >= 50 ? +sma(closes.slice(-50)).toFixed(2) : null;

  // RSI(14) — utilise les 15 dernières valeurs
  let rsi14: number | null = null;
  if (closes.length >= 15) {
    const slice = closes.slice(-15);
    const changes = slice.slice(1).map((v, i) => v - slice[i]);
    const avgGain = sma(changes.map((c) => Math.max(c, 0)));
    const avgLoss = sma(changes.map((c) => Math.max(-c, 0)));
    rsi14 = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
  }

  // MACD(12, 26, 9)
  let macdVal: number | null = null;
  let macdSignal: number | null = null;
  let macdHist: number | null = null;
  if (closes.length >= 35) {
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = ema(macdLine, 9);
    macdVal = +macdLine[macdLine.length - 1].toFixed(4);
    macdSignal = +signalLine[signalLine.length - 1].toFixed(4);
    macdHist = +(macdVal - macdSignal).toFixed(4);
  }

  return {
    symbol,
    price: +last.toFixed(2),
    change_pct: +(((last - prev) / prev) * 100).toFixed(2),
    volume,
    sma20,
    sma50,
    rsi14,
    macd: macdVal,
    macd_signal: macdSignal,
    macd_hist: macdHist,
  };
}

async function getLatestPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders }
    );
    const data = await res.json();
    return data?.quote?.ap || data?.quote?.bp || null;
  } catch {
    return null;
  }
}

async function getNews(symbol: string, limit = 5): Promise<string[]> {
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=${limit}`,
      { headers: alpacaHeaders }
    );
    const data = await res.json();
    return (data?.news ?? []).map((n: Record<string, string>) => n.headline);
  } catch {
    return [];
  }
}

async function getMarketContext(): Promise<string> {
  const [spy, qqq] = await Promise.all([
    computeTechnicals("SPY"),
    computeTechnicals("QQQ"),
  ]);
  const fmt = (t: TechData & { symbol: string }) =>
    `${t.symbol}: $${t.price} (${t.change_pct > 0 ? "+" : ""}${t.change_pct}%) | SMA20: ${t.sma20 ?? "N/A"} | RSI: ${t.rsi14 ?? "N/A"}`;
  return `${fmt(spy)}\n${fmt(qqq)}`;
}

async function getMarketData(symbols: string[]) {
  const results = await Promise.all(
    symbols.map(async (sym) => {
      const [tech, news] = await Promise.all([computeTechnicals(sym), getNews(sym)]);
      return [sym, { tech, news }] as const;
    })
  );
  return Object.fromEntries(results);
}

// ---------------------------------------------------------------------------
// Historique Supabase
// ---------------------------------------------------------------------------

async function getTradeHistory(limit = 50) {
  const { data } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .neq("action", "HOLD")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

async function logTrade(trade: Record<string, unknown>) {
  await supabase.from("trades").insert(trade);
}

function getRunSource(req: Request): string {
  const ua = (req.headers.get("user-agent") ?? "").toLowerCase();
  if (ua.includes("pg_net") || ua.includes("postgresql")) return "cron";
  return "manual";
}

function buildHumanMessage(status: string, details?: Record<string, unknown>): string {
  if (status === "market_closed") return "Marché fermé — aucune action";
  if (status === "already_running") return "Cycle ignoré — un autre cycle était déjà en cours";
  if (status === "grok_parse_error") return "Erreur IA — Grok n'a pas retourné une réponse exploitable";
  if (status === "error") {
    const msg = typeof details?.message === "string" ? details.message : "erreur inconnue";
    return `Crash de la fonction : ${msg}`;
  }

  if (status === "ok") {
    const decisions = Array.isArray(details?.decisions)
      ? (details?.decisions as Array<Record<string, unknown>>)
      : [];
    const trades = decisions.filter((d) => d.action === "BUY" || d.action === "SELL");
    if (!trades.length) return "HOLD — aucune opportunité détectée";

    return trades.map((d) => {
      const action = String(d.action);
      const qty = d.quantity ?? "?";
      const symbol = d.symbol ?? "?";
      return action === "BUY"
        ? `Achat de ${qty} ${symbol}`
        : `Vente de ${qty} ${symbol}`;
    }).join(" + ");
  }

  return `Statut ${status}`;
}

function getSeverity(status: string): "ok" | "warn" | "error" {
  if (status === "ok" || status === "market_closed") return "ok";
  if (status === "already_running") return "warn";
  return "error";
}

async function logExecutionEvent(
  req: Request,
  status: string,
  httpStatus: number,
  details?: Record<string, unknown>
) {
  try {
    await supabase.from("bot_execution_logs").insert({
      run_source: getRunSource(req),
      bot_status: status,
      severity: getSeverity(status),
      human_message: buildHumanMessage(status, details),
      http_status: httpStatus,
      details: details ?? null,
    });
  } catch (err) {
    console.error("logExecutionEvent() failed:", err);
  }
}

async function closeBuyTrade(symbol: string, priceExit: number) {
  const { data } = await supabase
    .from("trades")
    .select("id, price_entry, quantity")
    .eq("symbol", symbol)
    .eq("action", "BUY")
    .eq("status", "open");

  if (!data?.length) return;

  await Promise.all(data.map((trade) => {
    const pnl = trade.price_entry
      ? +((priceExit - trade.price_entry) * trade.quantity).toFixed(2)
      : null;
    return supabase
      .from("trades")
      .update({ price_exit: priceExit, pnl, status: "closed" })
      .eq("id", trade.id);
  }));
}

async function logSnapshot(cash: number, equity: number, positions: unknown[]) {
  await supabase.from("portfolio_snapshots").insert({ cash, equity, positions });
}

async function getLastAnalyses(): Promise<{ cyclic: string | null; weekly: string | null }> {
  const [{ data: cyclicData }, { data: weeklyData }] = await Promise.all([
    supabase
      .from("bot_analyses")
      .select("analysis, created_at, trade_count")
      .eq("type", "analysis")
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("bot_analyses")
      .select("analysis, created_at, trade_count")
      .eq("type", "weekly_summary")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const cyclic = cyclicData?.[0]
    ? `### Analyse de performance (cycle #${cyclicData[0].trade_count}, ${new Date(cyclicData[0].created_at).toISOString().split("T")[0]})\n${cyclicData[0].analysis}`
    : null;

  const weekly = weeklyData?.[0]
    ? `### Bilan hebdomadaire (cycle #${weeklyData[0].trade_count}, ${new Date(weeklyData[0].created_at).toISOString().split("T")[0]})\n${weeklyData[0].analysis}`
    : null;

  return { cyclic, weekly };
}

async function getCycleCount(): Promise<number> {
  const { count } = await supabase
    .from("portfolio_snapshots")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Mémoire persistante (Phase 2)
// ---------------------------------------------------------------------------

async function loadBotMemory(): Promise<string> {
  const { data } = await supabase
    .from("bot_memory")
    .select("layer, content, importance, times_confirmed, times_contradicted")
    .eq("is_active", true)
    .order("importance", { ascending: false })
    .limit(20);

  if (!data?.length) return "";

  const lines = data.map((r, i) =>
    `Règle #${i + 1} [importance ${r.importance}/100, layer: ${r.layer}] : ${r.content}` +
    (r.times_confirmed || r.times_contradicted
      ? ` (confirmée ${r.times_confirmed}x, contredite ${r.times_contradicted}x)`
      : "")
  );
  return lines.join("\n");
}

async function reflectOnClosedTrade(
  symbol: string,
  pnl: number,
  entryReason: string,
  exitReason: string
): Promise<void> {
  const prompt = `Tu es un trader IA qui analyse ses propres trades pour apprendre.

## Trade clôturé
- Symbole : ${symbol}
- PnL réalisé : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}
- Raison d'entrée (BUY) : ${entryReason}
- Raison de sortie (SELL) : ${exitReason}

Analyse ce trade et extrais un apprentissage concret.

Réponds UNIQUEMENT en JSON valide, sans markdown :
{
  "lesson": "ce que tu as appris de ce trade en 1-2 phrases",
  "rule_derived": "la règle concrète que tu en tires (ou null si rien de nouveau)",
  "importance": 50,
  "promote_to_memory": true
}

- "importance" : 0-100 (calibre selon la force de la leçon)
- "promote_to_memory" : true si la règle mérite d'être mémorisée durablement, false sinon`;

  try {
    const content = await callGrok(prompt, undefined, false);
    const parsed = extractJson(content) as Record<string, unknown>;

    const lesson = String(parsed.lesson ?? "");
    const ruleDerived = parsed.rule_derived ? String(parsed.rule_derived) : null;
    const importance = typeof parsed.importance === "number" ? parsed.importance : 50;
    const promoteToMemory = Boolean(parsed.promote_to_memory);

    // Insérer la réflexion
    const { data: reflection } = await supabase.from("trade_reflections").insert({
      symbol,
      pnl,
      entry_reason: entryReason,
      exit_reason: exitReason,
      lesson,
      rule_derived: ruleDerived,
      promote_to_memory: promoteToMemory,
    }).select("id").single();

    // Promouvoir en mémoire si demandé
    if (promoteToMemory && ruleDerived) {
      const { data: memory } = await supabase.from("bot_memory").insert({
        layer: "rule",
        content: ruleDerived,
        context: { symbol },
        importance,
        source: "bot",
      }).select("id").single();

      if (memory?.id && reflection?.id) {
        await supabase.from("trade_reflections").update({ memory_id: memory.id }).eq("id", reflection.id);
      }

      console.log(`Nouvelle règle mémorisée depuis ${symbol}: "${ruleDerived}"`);
    }

    console.log(`Réflexion post-trade ${symbol} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}): "${lesson}"`);
  } catch (err) {
    console.error("reflectOnClosedTrade() error:", err);
  }
}

async function consolidateMemory(cycleCount: number): Promise<void> {
  // Charger les 20 dernières réflexions
  const { data: reflections } = await supabase
    .from("trade_reflections")
    .select("symbol, pnl, lesson, rule_derived, promote_to_memory")
    .order("created_at", { ascending: false })
    .limit(20);

  // Charger les règles actives
  const { data: rules } = await supabase
    .from("bot_memory")
    .select("id, content, importance, times_confirmed, times_contradicted, layer")
    .eq("is_active", true)
    .order("importance", { ascending: false });

  if (!reflections?.length && !rules?.length) return;

  const prompt = `Tu es un trader IA. Consolide ta mémoire à partir de tes récentes réflexions post-trade et de tes règles actuelles.

## Tes 20 dernières réflexions post-trade
${JSON.stringify(reflections, null, 2)}

## Tes règles actuelles en mémoire
${JSON.stringify(rules, null, 2)}

Analyse et retourne une liste d'actions pour mettre à jour ta mémoire.

Réponds UNIQUEMENT en JSON valide, sans markdown :
{
  "actions": [
    {
      "type": "confirm",
      "id": "<uuid de la règle existante>",
      "reason": "pourquoi cette règle est confirmée"
    },
    {
      "type": "update",
      "id": "<uuid de la règle existante>",
      "new_content": "nouvelle formulation améliorée",
      "new_importance": 75
    },
    {
      "type": "archive",
      "id": "<uuid de la règle existante>",
      "reason": "pourquoi archiver (obsolète, contredite...)"
    },
    {
      "type": "create",
      "content": "nouvelle règle à mémoriser",
      "layer": "rule",
      "importance": 70,
      "reason": "pourquoi créer cette règle"
    }
  ]
}

Sois sélectif : ne créer que des règles vraiment utiles. Ne pas confirmer une règle juste pour confirmer.`;

  try {
    const content = await callGrok(prompt, undefined, false);
    const parsed = extractJson(content) as Record<string, unknown>;
    const actions = (parsed.actions ?? []) as Array<Record<string, unknown>>;

    for (const action of actions) {
      if (action.type === "confirm" && action.id) {
        const { data: row } = await supabase.from("bot_memory").select("times_confirmed").eq("id", action.id).single();
        if (row) await supabase.from("bot_memory").update({ times_confirmed: (row.times_confirmed ?? 0) + 1, updated_at: new Date().toISOString() }).eq("id", action.id);

      } else if (action.type === "update" && action.id) {
        await supabase.from("bot_memory").update({
          content: action.new_content,
          importance: action.new_importance,
          updated_at: new Date().toISOString(),
        }).eq("id", action.id);

      } else if (action.type === "archive" && action.id) {
        await supabase.from("bot_memory").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", action.id);

      } else if (action.type === "create") {
        await supabase.from("bot_memory").insert({
          layer: action.layer ?? "rule",
          content: action.content,
          importance: action.importance ?? 50,
          source: "bot",
        });
      }
    }

    console.log(`consolidateMemory() cycle #${cycleCount} — ${actions.length} actions appliquées`);
  } catch (err) {
    console.error("consolidateMemory() error:", err);
  }
}

async function generateAndSaveAnalysis(
  cycleCount: number,
  account: Record<string, unknown>,
  positions: unknown[]
) {
  const { data: lastDecisions } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .order("created_at", { ascending: false })
    .limit(20);

  if (!lastDecisions?.length) return;

  // Métriques calculées localement
  const closedTrades = lastDecisions.filter((t: Record<string, unknown>) => t.pnl != null);
  const winCount = closedTrades.filter((t: Record<string, unknown>) => (t.pnl as number) > 0).length;
  const winRate = closedTrades.length ? Math.round((winCount / closedTrades.length) * 100) : null;
  const totalPnl = closedTrades.reduce((s: number, t: Record<string, unknown>) => s + ((t.pnl as number) || 0), 0);
  const holdCount = lastDecisions.filter((t: Record<string, unknown>) => t.action === "HOLD").length;
  const holdRate = Math.round((holdCount / lastDecisions.length) * 100);

  const positionsStr = (positions as Record<string, unknown>[]).length
    ? (positions as Record<string, unknown>[]).map(p =>
        `  ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl} (${(parseFloat(String(p.unrealized_plpc ?? 0)) * 100).toFixed(2)}%)`
      ).join("\n")
    : "  Aucune";

  const { cyclic: previousCyclic } = await getLastAnalyses();

  const prompt = `Tu es un trader IA qui améliore son analyse de performance en continu.

## État du portfolio (maintenant)
- Equity totale : $${account.equity} | Cash disponible : $${account.cash}
- Positions ouvertes :
${positionsStr}

## Métriques sur les 20 dernières décisions
- PnL réalisé total : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}
- Win rate : ${winRate !== null ? `${winRate}% (${winCount} gagnants / ${closedTrades.length} trades clôturés)` : "Aucun trade clôturé"}
- Ratio HOLD : ${holdRate}% des décisions (${holdCount}/${lastDecisions.length})

## 20 dernières décisions (récent → ancien)
${JSON.stringify(lastDecisions, null, 2)}
${previousCyclic ? `\n## Ta version précédente de cette analyse\n${previousCyclic}\n` : ""}
${previousCyclic
  ? `Produis une version améliorée de ton analyse — garde ce qui reste vrai, corrige ce qui était faux, ajoute ce que tu as appris depuis. Cette version remplace la précédente dans les prompts futurs.

1. **Performance réelle** : le portfolio progresse-t-il ? Analyse le PnL et l'equity.
2. **Décisions pertinentes** : quelles décisions étaient justifiées et pourquoi
3. **Décisions discutables** : quelles décisions auraient pu être différentes
4. **Patterns identifiés** : tendances récurrentes (ex: trop de HOLD, entrées trop tôt, mauvais timing...)
5. **Feedback version précédente** : les ajustements recommandés ont-ils été appliqués ? Avec quel résultat ?
6. **Ajustements concrets** : ce que tu vas changer dans les prochains cycles`
  : `Produis une première analyse structurée et actionnable :
1. **Performance réelle** : le portfolio progresse-t-il ? Analyse le PnL et l'equity.
2. **Décisions pertinentes** : quelles décisions étaient justifiées et pourquoi
3. **Décisions discutables** : quelles décisions auraient pu être différentes
4. **Patterns identifiés** : tendances récurrentes (ex: trop de HOLD, entrées trop tôt, mauvais timing...)
5. **Ajustements concrets** : ce que tu vas changer dans les prochains cycles`}

Sois concis, factuel et actionnable. Cette analyse sera injectée dans tes prochains prompts de décision.`;

  const analysis = await callGrok(prompt);

  await supabase.from("bot_analyses").insert({
    trade_count: cycleCount,
    type: "analysis",
    analysis,
    trades_ref: lastDecisions,
  });

  console.log(`Auto-analyse générée au cycle #${cycleCount}`);
}

function isLastCycleOfWeek(now: Date, deadline: Date): boolean {
  return now.getUTCDay() === 5 && (deadline.getTime() - now.getTime()) < 60 * 60 * 1000;
}

async function generateWeeklySummary(
  account: Record<string, unknown>,
  positions: unknown[],
  cycleCount: number
) {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);

  const { data: weekDecisions } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .gte("created_at", monday.toISOString())
    .order("created_at", { ascending: true });

  if (!weekDecisions?.length) return;

  const closedTrades = weekDecisions.filter((t: Record<string, unknown>) => t.pnl != null);
  const winCount = closedTrades.filter((t: Record<string, unknown>) => (t.pnl as number) > 0).length;
  const winRate = closedTrades.length ? Math.round((winCount / closedTrades.length) * 100) : null;
  const totalPnl = closedTrades.reduce((s: number, t: Record<string, unknown>) => s + ((t.pnl as number) || 0), 0);
  const holdCount = weekDecisions.filter((t: Record<string, unknown>) => t.action === "HOLD").length;

  const positionsStr = (positions as Record<string, unknown>[]).length
    ? (positions as Record<string, unknown>[]).map(p =>
        `  ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl}`
      ).join("\n")
    : "  Aucune";

  const { weekly: previousWeekly } = await getLastAnalyses();

  const prompt = `Tu es un trader IA. La semaine de trading se termine. ${previousWeekly ? "Améliore ton bilan stratégique en intégrant les résultats de cette semaine." : "Produis un premier bilan complet."}

## Performance de la semaine
- Equity finale : $${account.equity} | Départ : ~$100 000
- PnL réalisé cette semaine : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}
- Win rate : ${winRate !== null ? `${winRate}% (${winCount}/${closedTrades.length} trades)` : "Aucun trade clôturé"}
- Total décisions : ${weekDecisions.length} (dont ${holdCount} HOLD)
- Positions encore ouvertes :
${positionsStr}

## Toutes les décisions de la semaine
${JSON.stringify(weekDecisions, null, 2)}
${previousWeekly ? `\n## Ton bilan précédent\n${previousWeekly}\n` : ""}
${previousWeekly
  ? `Produis une version améliorée de ce bilan — garde la stratégie qui reste valide, corrige ce qui était faux, intègre ce que cette semaine t'a appris en plus. Cette version remplace la précédente.`
  : `Produis un bilan hebdomadaire structuré :`}

1. **Résumé de la semaine** : performance globale, est-ce une bonne semaine ?
2. **Meilleures décisions** : quels trades ont le plus contribué au résultat
3. **Pires décisions** : quels trades ont coûté le plus cher
4. **Stratégie semaine prochaine** : que faire différemment lundi ? Sur quels secteurs se concentrer ?
5. **3 règles concrètes** pour améliorer les performances la semaine prochaine
${previousWeekly ? "6. **Feedback bilan précédent** : les recommandations de la semaine dernière ont-elles été suivies ? Avec quel résultat ?" : ""}

Ce bilan sera injecté dans chaque cycle de la semaine prochaine. Sois factuel et stratégique.`;

  const analysis = await callGrok(prompt);

  await supabase.from("bot_analyses").insert({
    trade_count: cycleCount,
    type: "weekly_summary",
    analysis,
    trades_ref: weekDecisions,
  });

  console.log(`Bilan de fin de semaine généré au cycle #${cycleCount}`);
}

// ---------------------------------------------------------------------------
// Validation des décisions Grok
// ---------------------------------------------------------------------------

function isValidSymbol(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{1,5}$/.test(s);
}

function isValidQuantity(q: unknown): q is number {
  return typeof q === "number" && Number.isInteger(q) && q > 0 && q < 100_000;
}

// ---------------------------------------------------------------------------
// Helpers parsing JSON robuste
// ---------------------------------------------------------------------------

function extractJson(content: string): unknown {
  // 1. Parse direct
  try { return JSON.parse(content); } catch { /* suite */ }
  // 2. Strip blocs markdown ```json ... ```
  const stripped = content.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
  try { return JSON.parse(stripped); } catch { /* suite */ }
  // 3. Extraire le premier tableau JSON trouvé dans le texte
  const arr = content.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* suite */ } }
  // 4. Extraire le premier objet JSON trouvé dans le texte
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* suite */ } }
  throw new Error("No valid JSON found in Grok response");
}

// ---------------------------------------------------------------------------
// Appels Grok — Discovery puis Decision
// ---------------------------------------------------------------------------

async function callGrok(prompt: string, systemPrompt?: string, liveSearch = false): Promise<string> {
  if (liveSearch) {
    // Nouvelle Responses API avec web_search (search_parameters déprécié)
    const input: Array<{ role: string; content: string }> = [];
    if (systemPrompt) input.push({ role: "system", content: systemPrompt });
    input.push({ role: "user", content: prompt });

    const res = await fetch(`${GROK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("GROK_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4.20-beta-latest-non-reasoning",
        input,
        tools: [{ type: "web_search" }],
      }),
    });
    const data = await res.json();
    // Extraire le texte depuis output[].content[].text
    const output = (data.output ?? []) as Array<Record<string, unknown>>;
    for (const item of output) {
      if (item.type === "message") {
        const content = (item.content ?? []) as Array<Record<string, unknown>>;
        for (const c of content) {
          if (c.type === "output_text") return (c.text as string) ?? "";
        }
      }
    }
    console.error("Réponse Responses API inattendue:", JSON.stringify(data));
    return "";
  }

  // chat/completions classique (sans web search)
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetch(`${GROK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("GROK_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3",
      messages,
      temperature: 0.2,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Étape 1 — Grok scanne X, Reddit, les news et choisit les symboles à analyser
async function discoverSymbols(
  positions: unknown[],
  history: unknown[],
  lastAnalysis: string | null
): Promise<{ symbols: string[]; earnings: Record<string, string | null> }> {
  const openSymbols = (positions as Record<string, string>[]).map((p) => p.symbol);

  const prompt = `Tu es un trader IA. Scanne X (Twitter), Reddit (r/wallstreetbets, r/stocks, r/investing), les news financières et le web en ce moment.

Contexte :
- Positions actuellement ouvertes : ${openSymbols.length ? openSymbols.join(", ") : "aucune"}
- Derniers trades : ${JSON.stringify(history.slice(0, 10), null, 2)}
${lastAnalysis ? `\n## Tes dernières auto-analyses de performance\n${lastAnalysis}\n` : ""}
Ta mission : identifier les actions américaines (NYSE/NASDAQ) les plus prometteuses RIGHT NOW — que ce soit pour un BUY, un SELL potentiel ou surveiller une position ouverte.

Critères : buzz, catalyseurs (earnings, annonce produit, macro), momentum technique, sentiment social.

Pour chaque symbole identifié, cherche aussi sa prochaine date d'earnings (résultats financiers trimestriels).

Réponds UNIQUEMENT en JSON valide, sans markdown :
{
  "symbols": ["TICKER1", "TICKER2", ...],
  "rationale": "en 2 phrases : pourquoi ces symboles maintenant",
  "earnings": {
    "TICKER1": "YYYY-MM-DD",
    "TICKER2": null
  }
}`;

  try {
    const content = await callGrok(prompt, undefined, true);
    const parsed = extractJson(content) as Record<string, unknown>;
    const discovered: string[] = (parsed.symbols as string[]) ?? [];
    const earnings = (parsed.earnings as Record<string, string | null>) ?? {};
    const symbols = [...new Set([...discovered, ...openSymbols])];
    return { symbols, earnings };
  } catch {
    console.error("Discovery parse error — falling back to open positions");
    const symbols = openSymbols.length ? openSymbols : ["SPY"];
    return { symbols, earnings: {} };
  }
}

// Étape 2 — Grok prend la décision finale avec les données techniques
function getCurrentWeekDeadline(): Date {
  const now = new Date();
  const daysUntilFriday = ((5 - now.getUTCDay()) + 7) % 7;
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() + daysUntilFriday);
  friday.setUTCHours(20, 0, 0, 0);
  if (friday <= now) friday.setUTCDate(friday.getUTCDate() + 7);
  return friday;
}

function estimateRemainingCycles(now: Date, deadline: Date): number {
  // Compte les minutes de marché ouvert restantes (Lu-Ve, 09:30-16:00 ET = 13:30-20:00 UTC en EDT)
  const MARKET_OPEN_UTC  = 13 * 60 + 30; // 13h30 UTC
  const MARKET_CLOSE_UTC = 20 * 60;       // 20h00 UTC
  let remaining = 0;
  const cursor = new Date(now);
  while (cursor < deadline) {
    const day = cursor.getUTCDay(); // 0=dim, 6=sam
    if (day !== 0 && day !== 6) {
      const minutesUTC = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
      if (minutesUTC >= MARKET_OPEN_UTC && minutesUTC < MARKET_CLOSE_UTC) {
        remaining += 30;
      }
    }
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }
  return Math.floor(remaining / 30);
}

async function makeDecision(
  account: Record<string, unknown>,
  positions: unknown[],
  history: unknown[],
  marketData: Record<string, { tech: TechData & { symbol: string }; news: string[] }>,
  cyclicAnalysis: string | null,
  weeklyAnalysis: string | null,
  cycleCount: number,
  marketContext: string,
  earnings: Record<string, string | null>,
  botMemory: string
) {
  const now = new Date();
  const marketSummary = Object.entries(marketData)
    .map(([sym, { tech, news }]) => {
      const earningsDate = earnings[sym];
      let earningsStr = "Earnings: inconnue";
      if (earningsDate) {
        const daysUntil = Math.round((new Date(earningsDate).getTime() - now.getTime()) / 86400000);
        const warning = daysUntil >= 0 && daysUntil <= 7 ? " ⚠️ IMMINENT" : daysUntil >= 0 && daysUntil <= 14 ? " (proche)" : "";
        earningsStr = `Earnings: ${earningsDate} (J${daysUntil >= 0 ? "+" : ""}${daysUntil})${warning}`;
      }
      return (
        `${sym}: $${tech.price} (${tech.change_pct > 0 ? "+" : ""}${tech.change_pct}%) | ` +
        `Vol: ${tech.volume?.toLocaleString()} | ` +
        `SMA20: ${tech.sma20 ?? "N/A"} SMA50: ${tech.sma50 ?? "N/A"} | ` +
        `RSI: ${tech.rsi14 ?? "N/A"} | ` +
        `MACD: ${tech.macd ?? "N/A"} Sig: ${tech.macd_signal ?? "N/A"} Hist: ${tech.macd_hist ?? "N/A"} | ` +
        `${earningsStr}\n` +
        `  News: ${news.length ? news.slice(0, 3).join(" | ") : "aucune"}`
      );
    })
    .join("\n\n");

  const systemPrompt = `Tu es le moteur de décision d'un bot de trading autonome opérant sur les marchés américains (NYSE / NASDAQ).

## Comment tu fonctionnes
Toutes les 30 minutes pendant les heures de marché (09h30–16h00 ET, lundi–vendredi), tu reçois l'état complet du portfolio, les données de marché en temps réel, et l'historique de tes trades. Tu n'as pas de mémoire entre les appels — tout le contexte est fourni à chaque fois.

## Ton objectif
Faire croître le portfolio de façon **consistante et durable**. Vise +0.3% à +0.5% par jour. Une semaine régulière à +1.5% vaut mieux qu'une semaine à +5% suivie d'un drawdown. Ne jamais perdre plus de 2% en un seul jour. La consistance sur la durée est ce qui compte.

## Règles non négociables
1. Maximum 25% du portfolio total par position (ex: si equity = $100k, max $25k par symbole)
2. Ne jamais perdre plus de 15% du portfolio initial dans la semaine (seuil : $85 000)
3. Tu peux placer plusieurs ordres simultanément dans le même cycle

## Règles d'allocation — OBLIGATOIRES
- **Minimum 60% du portfolio doit être investi en permanence** pendant les heures de marché.
- **Si tu as moins de 3 positions ouvertes ET plus de $30 000 en cash → tu DOIS placer au moins un BUY ce cycle.**
- **Position sizing** : utilise "montant_à_investir = cash_disponible / 4" pour calculer la taille de chaque nouvelle position.
- **HOLD = cas exceptionnel uniquement** (timing vraiment flou, signal contradictoire majeur). Ce n'est PAS une option par défaut.

## Comment décider — exemples concrets
**Exemple agressif (correct)** : Tu as $80k en cash, 1 position ouverte. Signal fort sur NVDA (RSI 45, MACD haussier, annonce produit ce soir). → BUY NVDA avec $20k ($80k/4). Tu as du cash, tu as un signal, tu achètes.
**Exemple conservateur (incorrect)** : Mêmes conditions. → HOLD "par prudence". NON. Rester assis sur $80k de cash alors qu'il y a des signaux, c'est rater l'objectif.
**HOLD légitime** : Tu as 4 positions ouvertes représentant 70%+ du portfolio, aucun nouveau signal clair, marché dans une range étroite. → HOLD pour ce cycle.

## Comment décider
Raisonne étape par étape :
1. **Évalue chaque position ouverte** : PnL non réalisé, momentum, risque — vaut-il mieux tenir ou couper ?
2. **Scanne le marché** : quelles opportunités existent RIGHT NOW (buzz, catalyseurs, technicals) ?
3. **Vérifie ton allocation** : si < 60% investi et des signaux existent → BUY obligatoire.
4. **Décide au niveau du portfolio** : quelle combinaison d'actions maximise le gain tout en respectant les règles ?`;

  const userPrompt = `## Horodatage
${now.toISOString()} — Cycle #${cycleCount}
${botMemory ? `\n## Tes règles (écrites par toi-même — OBLIGATOIRES)\n${botMemory}\n` : ""}

## État du marché global (contexte — ne pas trader SPY/QQQ directement)
${marketContext}

## Portfolio actuel
- Cash disponible : $${account.cash}
- Valeur totale : $${account.equity}
- Positions ouvertes (avec PnL non réalisé) :
${(positions as Record<string, unknown>[]).map((p) =>
  `  ${p.symbol}: ${p.qty} actions | Prix moyen : $${p.avg_entry_price} | Prix actuel : $${p.current_price} | PnL : $${p.unrealized_pl} (${parseFloat(String(p.unrealized_plpc ?? 0) ) > 0 ? "+" : ""}${(parseFloat(String(p.unrealized_plpc ?? 0)) * 100).toFixed(2)}%)`
).join("\n") || "  Aucune"}

## Données de marché (symboles présélectionnés ce cycle)
${marketSummary}

## Historique de tes ${history.length} derniers trades BUY/SELL (récent → ancien)
${JSON.stringify(history, null, 2)}
${cyclicAnalysis ? `\n## Ton analyse de performance (version actuelle)\n${cyclicAnalysis}\n` : ""}${weeklyAnalysis ? `\n## Ton bilan hebdomadaire (version actuelle)\n${weeklyAnalysis}\n` : ""}
## Instructions
1. Scanne X, Reddit et les news financières en ce moment
2. Applique le raisonnement en 3 étapes (positions → marché → portfolio)
3. Retourne TOUTES tes décisions pour ce cycle

Réponds UNIQUEMENT en JSON valide (tableau), sans markdown :
[
  {
    "action": "BUY" | "SELL" | "HOLD",
    "symbol": "TICKER ou null si HOLD global",
    "quantity": nombre entier ou null si HOLD,
    "reason": "justification concise avec les signaux clés"
  }
]
Si tu n'as aucun trade à faire, retourne un tableau avec un seul HOLD : [{"action":"HOLD","symbol":null,"quantity":null,"reason":"..."}]`;

  let content = "";
  try {
    content = await callGrok(userPrompt, systemPrompt, true);
    const parsed = extractJson(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    console.error("Decision parse error — raw Grok response:", content);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Risk Agent (Phase 3) — valide/ajuste les décisions de makeDecision
// ---------------------------------------------------------------------------

async function applyRiskCheck(
  decisions: Array<Record<string, unknown>>,
  account: Record<string, unknown>,
  positions: unknown[],
  botMemory: string
): Promise<Array<Record<string, unknown>>> {
  // Si aucune décision actionnable, pas besoin du Risk Agent
  const actionable = decisions.filter(d => d.action === "BUY" || d.action === "SELL");
  if (!actionable.length) return decisions;

  const positionsStr = (positions as Record<string, unknown>[]).length
    ? (positions as Record<string, unknown>[]).map(p =>
        `  ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl} (${(parseFloat(String(p.unrealized_plpc ?? 0)) * 100).toFixed(2)}%)`
      ).join("\n")
    : "  Aucune";

  const maxPerPosition = (parseFloat(String(account.equity)) * 0.25).toFixed(0);
  const maxTotalInvested = (parseFloat(String(account.equity)) * 0.85).toFixed(0);

  const prompt = `Tu es le Risk Manager d'un bot de trading. Le Trader IA vient de proposer des décisions. Ton rôle : valider, ajuster ou bloquer en fonction des règles de risque.

## Portfolio actuel
- Cash disponible : $${account.cash}
- Equity totale : $${account.equity}
- Positions ouvertes :
${positionsStr}

## Décisions proposées par le Trader
${JSON.stringify(decisions, null, 2)}
${botMemory ? `\n## Règles mémorisées du bot (à respecter)\n${botMemory}\n` : ""}
## Règles de risque non négociables
1. Maximum 25% du portfolio par position (max $${maxPerPosition} par symbole)
2. Maximum 4 positions ouvertes simultanément
3. Ne jamais dépasser 85% du capital total investi (max $${maxTotalInvested} investi)
4. Si une règle mémorisée s'applique clairement à une décision → applique-la

## Tes options pour chaque décision
- **APPROVE** : décision validée telle quelle → recopie-la sans modification
- **REDUCE** : réduire la quantité (précise la nouvelle quantité dans "quantity" et explique dans "risk_note")
- **BLOCK** : convertir en HOLD (seulement si violation claire d'une règle — pas par prudence générale)

## Instructions
- Ne bloque PAS par excès de prudence générale
- Ne réduis une quantité que si elle dépasse vraiment une limite calculable
- Si tout est dans les clous → approuve tout, retourne les décisions identiques
- Raisonne au niveau du portfolio global

Réponds UNIQUEMENT en JSON valide (tableau), sans markdown :
[
  {
    "action": "BUY" | "SELL" | "HOLD",
    "symbol": "TICKER ou null",
    "quantity": nombre entier ou null,
    "reason": "raison originale du trader",
    "risk_note": null | "ce qui a été ajusté et pourquoi (seulement si modification)"
  }
]
Retourne TOUTES les décisions originales (y compris les HOLD non modifiées).`;

  try {
    const content = await callGrok(prompt, undefined, false);
    const parsed = extractJson(content);
    const validated = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;

    for (const d of validated) {
      if (d.risk_note) {
        console.log(`Risk Agent — ${d.action} ${d.symbol}: ${d.risk_note}`);
      }
    }

    return validated;
  } catch (err) {
    console.error("applyRiskCheck() error — fallback sur décisions originales:", err);
    return decisions;
  }
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // Vérification JWT stricte (format Bearer + scope projet + rôle + expiration)
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    const token = auth.slice(7).trim();
    const parts = token.split(".");
    if (parts.length !== 3) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    const payload = JSON.parse(atob(parts[1]));
    const now = Math.floor(Date.now() / 1000);
    const exp = Number(payload?.exp);
    if (
      payload?.role !== "service_role" ||
      payload?.ref !== "bhumjspdeveqybkilcxc" ||
      payload?.iss !== "supabase" ||
      !Number.isFinite(exp) ||
      exp <= now
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // 0. Lock distribué — évite deux instances simultanées
  const { data: claimed } = await supabase.rpc("try_claim_bot_run");
  if (!claimed) {
    console.log("Bot already running — skipping.");
    await logExecutionEvent(req, "already_running", 200);
    return new Response(JSON.stringify({ status: "already_running" }), { status: 200 });
  }

  try {
    // 1. Vérifier que le marché est ouvert
    const marketOpen = await isClock();
    if (!marketOpen) {
      console.log("Market closed — skipping.");
      await supabase.rpc("release_bot_run");
      await logExecutionEvent(req, "market_closed", 200);
      return new Response(JSON.stringify({ status: "market_closed" }), { status: 200 });
    }

    // 2. Récupérer l'état du portfolio
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);

    // 3. Snapshot
    await logSnapshot(parseFloat(account.cash), parseFloat(account.equity), positions);

    // 4. Mémoire du bot + historique des trades + dernières analyses (en parallèle)
    const [botMemory, history, analyses] = await Promise.all([
      loadBotMemory(),
      getTradeHistory(50),
      getLastAnalyses(),
    ]);
    // 5. Grok scanne X, Reddit, les news et choisit les symboles + earnings dates
    const lastAnalysisForDiscovery = [analyses.cyclic, analyses.weekly].filter(Boolean).join("\n\n---\n\n") || null;
    const { symbols, earnings } = await discoverSymbols(positions, history, lastAnalysisForDiscovery);
    console.log("Symbols discovered by Grok:", symbols);
    console.log("Earnings dates:", earnings);

    // 6. Données de marché (technicals + news) + contexte global en parallèle
    const [marketData, marketContext] = await Promise.all([
      getMarketData(symbols),
      getMarketContext(),
    ]);

    // 7. Stop-loss hard — SELL forcé si position à -8% ou pire (sans consulter Grok)
    const stopLossOrders: Array<{ symbol: string; qty: number }> = [];
    for (const pos of positions as Record<string, unknown>[]) {
      const plpc = parseFloat(String(pos.unrealized_plpc ?? 0));
      if (plpc <= -STOP_LOSS_PCT) {
        console.warn(`STOP-LOSS déclenché sur ${pos.symbol} (${(plpc * 100).toFixed(2)}%)`);
        const qty = parseInt(String(pos.qty), 10);
        const alpacaOrder = await placeOrder(pos.symbol as string, qty, "sell");
        if (alpacaOrder?.code || alpacaOrder?.message) {
          console.error("Alpaca STOP-LOSS rejected:", alpacaOrder);
          await logTrade({ symbol: pos.symbol, action: "SELL_REJECTED", quantity: qty, reason: `STOP-LOSS automatique (-${(plpc * 100).toFixed(2)}%) — rejeté par Alpaca: ${JSON.stringify(alpacaOrder)}`, status: "error" });
        } else {
          const priceExit = await getLatestPrice(pos.symbol as string) || parseFloat(String(pos.current_price ?? 0));
          if (priceExit) await closeBuyTrade(pos.symbol as string, priceExit);
          const stopLossReason = `STOP-LOSS automatique déclenché à ${(plpc * 100).toFixed(2)}% de perte`;
          await logTrade({ symbol: pos.symbol, action: "SELL", quantity: qty, reason: stopLossReason, price_entry: priceExit, alpaca_order_id: alpacaOrder?.id ?? null, status: "closed" });
          stopLossOrders.push({ symbol: pos.symbol as string, qty });
          // Réflexion post-trade sur le stop-loss
          const stopLossPnl = parseFloat(String(pos.unrealized_pl ?? 0));
          const entryReasonForStop = history.find((t: Record<string, unknown>) => t.symbol === pos.symbol && t.action === "BUY")?.reason as string ?? "raison inconnue";
          await reflectOnClosedTrade(pos.symbol as string, stopLossPnl, entryReasonForStop, stopLossReason);
        }
      }
    }
    // Retirer les positions liquidées par stop-loss pour ne pas les re-traiter
    const positionsAfterStopLoss = (positions as Record<string, unknown>[]).filter(
      p => !stopLossOrders.some(sl => sl.symbol === p.symbol)
    );

    // 8. Grok prend la décision finale avec les données techniques
    const cycleCount = await getCycleCount();
    const rawDecisions = await makeDecision(account, positionsAfterStopLoss, history, marketData, analyses.cyclic, analyses.weekly, cycleCount, marketContext, earnings, botMemory);
    if (!rawDecisions) {
      await supabase.rpc("release_bot_run");
      await logExecutionEvent(req, "grok_parse_error", 200, {
        cycle_count: cycleCount,
        symbols,
      });
      return new Response(JSON.stringify({ status: "grok_parse_error" }), { status: 200 });
    }

    console.log("Grok decisions (avant Risk Agent):", rawDecisions);

    // 8b. Risk Agent — valide/ajuste les décisions
    const decisions = await applyRiskCheck(rawDecisions, account, positionsAfterStopLoss, botMemory);

    console.log("Decisions après Risk Agent:", decisions);

    // 9. Exécuter chaque décision et tout logger (y compris HOLD)
    const executedOrders = [];
    for (const decision of decisions) {
      let alpacaOrder = null;
      let priceEntry: number | null = null;

      if (decision.action === "BUY" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
        const alreadyOpen = (positions as Record<string, string>[]).some(p => p.symbol === decision.symbol);
        if (alreadyOpen) {
          console.warn(`BUY ignoré — position déjà ouverte sur ${decision.symbol}`);
          continue;
        }
        alpacaOrder = await placeOrder(decision.symbol, decision.quantity, "buy");
        if (alpacaOrder?.code || alpacaOrder?.message) {
          console.error("Alpaca BUY rejected:", alpacaOrder);
          await logTrade({ symbol: decision.symbol, action: "BUY_REJECTED", quantity: decision.quantity, reason: JSON.stringify(alpacaOrder), status: "error" });
          continue;
        }
        priceEntry = await getLatestPrice(decision.symbol) || marketData[decision.symbol]?.tech.price;

      } else if (decision.action === "SELL" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
        const priceExit = await getLatestPrice(decision.symbol) || marketData[decision.symbol]?.tech.price;
        alpacaOrder = await placeOrder(decision.symbol, decision.quantity, "sell");
        if (alpacaOrder?.code || alpacaOrder?.message) {
          console.error("Alpaca SELL rejected:", alpacaOrder);
          await logTrade({ symbol: decision.symbol, action: "SELL_REJECTED", quantity: decision.quantity, reason: JSON.stringify(alpacaOrder), status: "error" });
          continue;
        }
        if (priceExit) await closeBuyTrade(decision.symbol, priceExit);
        priceEntry = priceExit;
        // Réflexion post-trade
        const sellPos = (positions as Record<string, unknown>[]).find(p => p.symbol === decision.symbol);
        const sellPnl = parseFloat(String(sellPos?.unrealized_pl ?? 0));
        const sellEntryReason = history.find((t: Record<string, unknown>) => t.symbol === decision.symbol && t.action === "BUY")?.reason as string ?? "raison inconnue";
        await reflectOnClosedTrade(decision.symbol, sellPnl, sellEntryReason, decision.reason);
      } else if (decision.action !== "HOLD") {
        console.warn("Decision invalide ignorée:", JSON.stringify(decision));
        continue;
      }

      // Logger toutes les décisions (BUY, SELL, HOLD)
      await logTrade({
        symbol: decision.symbol ?? null,
        action: decision.action,
        quantity: decision.quantity ?? null,
        reason: decision.reason,
        price_entry: priceEntry,
        alpaca_order_id: alpacaOrder?.id ?? null,
        status: decision.action === "SELL" ? "closed" : decision.action === "BUY" ? "open" : "hold",
        risk_note: (decision.risk_note as string) ?? null,
      });

      if (alpacaOrder) executedOrders.push(alpacaOrder);
    }

    // 10. Consolidation mémoire tous les 10 cycles
    if (cycleCount > 0 && cycleCount % 10 === 0) {
      await consolidateMemory(cycleCount);
    }

    // 11. Auto-analyse tous les 5 cycles
    if (cycleCount > 0 && cycleCount % 5 === 0) {
      await generateAndSaveAnalysis(cycleCount, account, positions);
    }

    // 12. Bilan de fin de semaine (dernier cycle du vendredi)
    const weekDeadline = getCurrentWeekDeadline();
    if (isLastCycleOfWeek(new Date(), weekDeadline)) {
      await generateWeeklySummary(account, positions, cycleCount);
    }

    await supabase.rpc("release_bot_run");
    await logExecutionEvent(req, "ok", 200, {
      cycle_count: cycleCount,
      decisions,
      raw_decisions: rawDecisions,
      executed_orders_count: executedOrders.length,
      stop_loss_orders_count: stopLossOrders.length,
    });
    return new Response(JSON.stringify({ status: "ok", rawDecisions, decisions, executedOrders }), { status: 200 });
  } catch (err) {
    console.error(err);
    await supabase.rpc("release_bot_run");
    await logExecutionEvent(req, "error", 500, { message: String(err) });
    return new Response(JSON.stringify({ status: "error", message: String(err) }), { status: 500 });
  }
});
