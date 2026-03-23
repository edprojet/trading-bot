CREATE TABLE bot_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  layer TEXT NOT NULL DEFAULT 'rule',   -- 'rule' | 'pattern' | 'observation'
  content TEXT NOT NULL,                -- La règle en langage naturel
  context JSONB,                        -- metadata : symbol, sector, market_condition
  importance INT DEFAULT 50,            -- 0-100, décidé par le bot
  times_applied INT DEFAULT 0,
  times_confirmed INT DEFAULT 0,
  times_contradicted INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'bot'             -- 'bot' | 'human'
);
