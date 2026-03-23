CREATE TABLE trade_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  symbol TEXT NOT NULL,
  pnl NUMERIC,
  entry_reason TEXT,
  exit_reason TEXT,
  lesson TEXT NOT NULL,
  rule_derived TEXT,
  promote_to_memory BOOLEAN DEFAULT false,
  memory_id UUID REFERENCES bot_memory(id)
);
