# DRAFT — conversation_topics

**DO_NOT_APPLY** · 2026-07-22 · F2 design  
**ADVERTENCIA: Este cambio requiere modificación de esquema.**

Estados lifecycle **estables:** `OPEN | PAUSED | CLOSED | ARCHIVED`.  
Reopen = eventos en `conversation_topic_events`, no columnas/estados `REOPENED`.

---

## Forward SQL (borrador)

```sql
-- DO_NOT_APPLY
-- conversation_topics F2

CREATE TYPE public.topic_lifecycle AS ENUM (
  'OPEN',
  'PAUSED',
  'CLOSED',
  'ARCHIVED'
);

CREATE TYPE public.topic_control_mode AS ENUM (
  'AI',
  'HUMAN',
  'MIXED'
);

CREATE TYPE public.topic_handoff_state AS ENUM (
  'NONE',
  'REQUESTED',
  'ACCEPTED',
  'ACTIVE',
  'RETURNED_TO_AI',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE public.topic_closure_reason AS ENUM (
  'COMPLETED',
  'USER_DECLINED',
  'NO_RESPONSE',
  'DUPLICATE',
  'OUT_OF_SCOPE',
  'PROPERTY_UNAVAILABLE',
  'VISIT_CANCELLED',
  'CONTACT_NO_FOLLOW_UP',
  'SYSTEM_INACTIVE',
  'HANDOFF_COMPLETED', -- solo si objetivo del tema concluido; NUNCA automático al ACCEPT
  'ADVISOR_CLOSED',
  'OTHER'
);

CREATE TABLE public.conversation_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id),
  lead_id uuid NULL REFERENCES public.leads(id),
  parent_topic_id uuid NULL REFERENCES public.conversation_topics(id),
  lifecycle public.topic_lifecycle NOT NULL DEFAULT 'OPEN',
  conversation_stage text NULL, -- map V3 stages; no enum duro en V1 schema
  control_mode public.topic_control_mode NOT NULL DEFAULT 'AI',
  handoff_state public.topic_handoff_state NOT NULL DEFAULT 'NONE',
  closure_reason public.topic_closure_reason NULL,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb, -- redactado; sin PII innecesaria
  asked_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL,
  archived_at timestamptz NULL,
  CONSTRAINT conversation_topics_closed_requires_reason
    CHECK (
      (lifecycle IN ('CLOSED', 'ARCHIVED') AND closure_reason IS NOT NULL)
      OR (lifecycle IN ('OPEN', 'PAUSED'))
    ),
  CONSTRAINT conversation_topics_handoff_not_implies_closed
    CHECK (
      -- documental: handoff ACTIVE/ACCEPTED no fuerza CLOSED (enforce en app + tests)
      true
    )
);

COMMENT ON TABLE public.conversation_topics IS
  'F2 topic lifecycle. Max one OPEN per conversation. Handoff≠close. Ownership never derived from topic.';
COMMENT ON COLUMN public.conversation_topics.lead_id IS
  'Nullable in discovery/informational; set via CRM gate + Anexo J — never from RAG.';
COMMENT ON COLUMN public.conversation_topics.control_mode IS
  'AI|HUMAN|MIXED — separate from lifecycle. HUMAN => PERSEO silent except system.';
COMMENT ON COLUMN public.conversation_topics.handoff_state IS
  'Separate machine from lifecycle. ACCEPT must not auto-CLOSE topic.';
COMMENT ON COLUMN public.conversation_topics.summary_json IS
  'Redacted topic summary; regenerate on schedule CONFIG_CANDIDATE (e.g. every 5 topic turns).';

-- Un solo OPEN activo por conversación
CREATE UNIQUE INDEX conversation_topics_one_open_per_conversation
  ON public.conversation_topics (conversation_id)
  WHERE lifecycle = 'OPEN';

CREATE INDEX conversation_topics_conversation_lifecycle_idx
  ON public.conversation_topics (conversation_id, lifecycle);

CREATE INDEX conversation_topics_contact_updated_idx
  ON public.conversation_topics (contact_id, updated_at DESC);

CREATE INDEX conversation_topics_lead_idx
  ON public.conversation_topics (lead_id)
  WHERE lead_id IS NOT NULL;

CREATE INDEX conversation_topics_parent_idx
  ON public.conversation_topics (parent_topic_id)
  WHERE parent_topic_id IS NOT NULL;

ALTER TABLE public.conversation_topics ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; policies for authenticated ATENA roles
CREATE POLICY conversation_topics_admin_select
  ON public.conversation_topics
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Agents: read topics for contacts they own (align to ATENA ownership helpers)
-- NOTE: replace is_contact_owner() with the real ATENA helper before APPLY.
-- CREATE POLICY conversation_topics_agent_select ...

REVOKE ALL ON public.conversation_topics FROM PUBLIC;
GRANT SELECT ON public.conversation_topics TO authenticated;
-- INSERT/UPDATE/DELETE: service_role / dedicated backend roles only (PERSEO)
```

---

## Reverse SQL (borrador)

```sql
-- DO_NOT_APPLY reverse
DROP POLICY IF EXISTS conversation_topics_admin_select ON public.conversation_topics;
DROP TABLE IF EXISTS public.conversation_topics CASCADE;
DROP TYPE IF EXISTS public.topic_closure_reason;
DROP TYPE IF EXISTS public.topic_handoff_state;
DROP TYPE IF EXISTS public.topic_control_mode;
DROP TYPE IF EXISTS public.topic_lifecycle;
```

---

## Notas de contrato

- `CLOSED → OPEN` silencioso **prohibido**; reopen = eventos + (mismo topic vuelve a `OPEN` tras confirmación) o `parent_topic_id` hijo.  
- `topic_id` **nunca** decide ownership (Anexo O).  
- Dual-read con `conversations.ai_state` durante rollout; no borrar arrays legacy hasta flag OFF dual-read.
