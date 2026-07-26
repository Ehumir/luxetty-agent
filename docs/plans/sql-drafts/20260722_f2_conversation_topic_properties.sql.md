# DRAFT — conversation_topic_properties

**DO_NOT_APPLY** · 2026-07-22 · F2 design  
**ADVERTENCIA: Este cambio requiere modificación de esquema.**

Reemplaza arrays duplicados tipo `ai_state.last_shown_property_ids`. Precio vigente = SoT `properties`; snapshot = evidencia del momento.

---

## Forward SQL (borrador)

```sql
-- DO_NOT_APPLY

CREATE TYPE public.topic_property_relationship AS ENUM (
  'SHOWN',
  'ACTIVE',
  'SELECTED',
  'REJECTED',
  'VISIT_REQUESTED',
  'VISITED',
  'COMPARED',
  'FAVORITE'
);

CREATE TABLE public.conversation_topic_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES public.conversation_topics(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id),
  relationship_type public.topic_property_relationship NOT NULL,
  source text NULL, -- inventory_sql | user | advisor | campaign | …
  ranking_position integer NULL,
  shown_at timestamptz NULL,
  selected_at timestamptz NULL,
  rejected_at timestamptz NULL,
  rejection_reason text NULL, -- structured code preferred
  active_from timestamptz NULL,
  active_to timestamptz NULL,
  snapshot_price numeric(14,2) NULL,
  snapshot_status text NULL,
  snapshot_operation text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.conversation_topic_properties IS
  'Normalized property interest per topic. Live price from SoT; snapshot for audit. Does not change ownership.';
COMMENT ON COLUMN public.conversation_topic_properties.snapshot_price IS
  'Evidence at show time; never treat as live listing price.';

CREATE INDEX conversation_topic_properties_topic_rel_idx
  ON public.conversation_topic_properties (topic_id, relationship_type);

CREATE INDEX conversation_topic_properties_property_idx
  ON public.conversation_topic_properties (property_id);

-- At most one ACTIVE property per topic at a time
CREATE UNIQUE INDEX conversation_topic_properties_one_active_per_topic
  ON public.conversation_topic_properties (topic_id)
  WHERE relationship_type = 'ACTIVE' AND (active_to IS NULL);

ALTER TABLE public.conversation_topic_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversation_topic_properties_admin_select
  ON public.conversation_topic_properties
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

REVOKE ALL ON public.conversation_topic_properties FROM PUBLIC;
GRANT SELECT ON public.conversation_topic_properties TO authenticated;
```

---

## Reverse SQL (borrador)

```sql
-- DO_NOT_APPLY reverse
DROP POLICY IF EXISTS conversation_topic_properties_admin_select ON public.conversation_topic_properties;
DROP TABLE IF EXISTS public.conversation_topic_properties CASCADE;
DROP TYPE IF EXISTS public.topic_property_relationship;
```

---

## Notas

- “la segunda” / “esa” resuelven por `ranking_position` del turno + events.  
- Consultar propiedad de otro asesor = interés (`SHOWN`/`ACTIVE`), **no** reasignación.
