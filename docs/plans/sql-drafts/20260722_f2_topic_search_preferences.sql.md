# DRAFT — topic_search_preferences (+ budget/zone history)

**DO_NOT_APPLY** · 2026-07-22 · F2 design  
**ADVERTENCIA: Este cambio requiere modificación de esquema.**

Memoria de journey estructurada. **No** SoT de precio, ownership ni consent.  
Prohibido meter ownership/consent/identidad en key-value auxiliar.

---

## Forward SQL (borrador)

```sql
-- DO_NOT_APPLY

CREATE TABLE public.topic_search_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL UNIQUE REFERENCES public.conversation_topics(id) ON DELETE CASCADE,
  operation text NULL, -- rent | sale | …
  role text NULL, -- buyer | renter | seller | landlord | unknown
  property_type text NULL,
  bedrooms_min integer NULL,
  bedrooms_max integer NULL,
  zone_canonical text NULL,
  zone_id uuid NULL,
  budget_min numeric(14,2) NULL,
  budget_max numeric(14,2) NULL,
  currency text NOT NULL DEFAULT 'MXN',
  confidence text NOT NULL DEFAULT 'medium', -- low|medium|high
  source text NULL, -- user | audio | advisor | inferred
  expires_at timestamptz NULL, -- CONFIG_CANDIDATE vigencia (e.g. 14d)
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.topic_search_preferences IS
  'Current search preference snapshot per topic. Corrections append to history tables.';

CREATE TABLE public.topic_budget_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES public.conversation_topics(id) ON DELETE CASCADE,
  budget_min numeric(14,2) NULL,
  budget_max numeric(14,2) NULL,
  currency text NOT NULL DEFAULT 'MXN',
  source text NULL,
  confidence text NULL,
  reason_code text NULL, -- SLOT_CORRECTED | INITIAL | …
  evidence_message_id uuid NULL,
  actor_type text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.topic_budget_history IS
  'Append-only budget corrections. Latest row informs prefs; never delete for audit window.';

CREATE TABLE public.topic_zone_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES public.conversation_topics(id) ON DELETE CASCADE,
  zone_raw text NULL,
  zone_canonical text NULL,
  zone_id uuid NULL,
  colony_id uuid NULL,
  source text NULL,
  confidence text NULL,
  reason_code text NULL,
  evidence_message_id uuid NULL,
  actor_type text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.topic_zone_history IS
  'Append-only zone corrections. LI canonicalization preferred over raw text.';

CREATE INDEX topic_budget_history_topic_created_idx
  ON public.topic_budget_history (topic_id, created_at DESC);

CREATE INDEX topic_zone_history_topic_created_idx
  ON public.topic_zone_history (topic_id, created_at DESC);

ALTER TABLE public.topic_search_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_budget_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_zone_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY topic_search_preferences_admin_select
  ON public.topic_search_preferences FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY topic_budget_history_admin_select
  ON public.topic_budget_history FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY topic_zone_history_admin_select
  ON public.topic_zone_history FOR SELECT TO authenticated USING (public.is_admin());

REVOKE ALL ON public.topic_search_preferences FROM PUBLIC;
REVOKE ALL ON public.topic_budget_history FROM PUBLIC;
REVOKE ALL ON public.topic_zone_history FROM PUBLIC;
GRANT SELECT ON public.topic_search_preferences TO authenticated;
GRANT SELECT ON public.topic_budget_history TO authenticated;
GRANT SELECT ON public.topic_zone_history TO authenticated;
```

---

## Reverse SQL (borrador)

```sql
-- DO_NOT_APPLY reverse
DROP POLICY IF EXISTS topic_zone_history_admin_select ON public.topic_zone_history;
DROP POLICY IF EXISTS topic_budget_history_admin_select ON public.topic_budget_history;
DROP POLICY IF EXISTS topic_search_preferences_admin_select ON public.topic_search_preferences;
DROP TABLE IF EXISTS public.topic_zone_history CASCADE;
DROP TABLE IF EXISTS public.topic_budget_history CASCADE;
DROP TABLE IF EXISTS public.topic_search_preferences CASCADE;
```

---

## Notas

- Cambio material de operación (renta→compra) ⇒ preferir **nuevo topic** (D1/Anexo J), no mutar prefs silenciosamente.  
- Vigencia budget/zona: `CONFIG_CANDIDATE` 14d (Anexo L).
