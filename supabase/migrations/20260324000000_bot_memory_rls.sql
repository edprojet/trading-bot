-- Restrict bot_memory to service_role (same pattern as trades, portfolio_snapshots, bot_analyses)
ALTER TABLE bot_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role only" ON bot_memory
  USING (auth.role() = 'service_role');
