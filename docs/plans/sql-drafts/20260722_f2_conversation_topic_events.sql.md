# DRAFT — conversation_topic_events

**DO_NOT_APPLY** · 2026-07-22 · F2 design  
**ADVERTENCIA: Este cambio requiere modificación de esquema.**

Append-only audit log. REOPEN vive aquí (`TOPIC_REOPEN_REQUESTED`, `TOPIC_REOPENED`), no como lifecycle persistente.

---

## Forward SQL (borrador)

```sql
-- DO_NOT_APPLY

CREATE TYPE public.topic_event_type AS ENUM (
  'TOPIC_CREATED',
  'TOPIC_PAUSED',
  'TOPIC_RESUMED',
  'TOPIC_CLOSED',
  'TOPIC_REOPEN_REQUESTED',
  'TOPIC_REOPENED',
  'TOPIC_ARCHIVED',
  'LEAD_LINKED',
  'LEAD_SWITCHED',
  'PROPERTY_ACTIVATED',
  'PROPERTY_REJECTED',
  'HANDOFF_REQUESTED',
  'HANDOFF_ACCEPTED',
  'HANDOFF_RETURNED_TO_AI',
  'HANDOFF_COMPLETED',
  'HANDOFF_CANCELLED',
  'HANDOFF_EXPIRED',
  'CONTROL_CHANGED',
  'SLOT_CORRECTED',
  'SUMMARY_REGENERATED'
);

CREATE TYPE public.topic_event_actor_type AS ENUM (
  'system',
  'perseo',
  'user',
  'advisor'
);

CREATE TABLE public.conversation_topic_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES public.conversation_topics(id) ON DELETE CASCADE,
  event_type public.topic_event_type NOT NULL,
  previous_lifecycle public.topic_lifecycle NULL,
  new_lifecycle public.topic_lifecycle NULL,
  previous_stage text NULL,
  new_stage text NULL,
  previous_control_mode public.topic_control_mode NULL,
  new_control_mode public.topic_control_mode NULL,
  previous_handoff_state public.topic_handoff_state NULL,
  new_handoff_state public.topic_handoff_state NULL,
  actor_type public.topic_event_actor_type NOT NULL,
  actor_id uuid NULL,
  reason_code text NULL,
  evidence_message_id uuid NULL,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.conversation_topic_events IS
  'Append-only topic audit. REOPEN as events. No PII in metadata_redacted.';
COMMENT ON COLUMN public.conversation_topic_events.metadata_redacted IS
  'Codes/IDs/hashes only. Forbidden: transcripts, phones, emails, full packs.';

CREATE INDEX conversation_topic_events_topic_created_idx
  ON public.conversation_topic_events (topic_id, created_at DESC);

CREATE INDEX conversation_topic_events_type_created_idx
  ON public.conversation_topic_events (event_type, created_at DESC);

-- Optional: prevent UPDATE/DELETE via revoke + trigger (enforce append-only)
CREATE OR REPLACE FUNCTION public.forbid_topic_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'conversation_topic_events is append-only';
END;
$$;

CREATE TRIGGER conversation_topic_events_no_update
  BEFORE UPDATE OR DELETE ON public.conversation_topic_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_topic_event_mutation();

ALTER TABLE public.conversation_topic_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversation_topic_events_admin_select
  ON public.conversation_topic_events
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

REVOKE ALL ON public.conversation_topic_events FROM PUBLIC;
GRANT SELECT ON public.conversation_topic_events TO authenticated;
```

---

## Reverse SQL (borrador)

```sql
-- DO_NOT_APPLY reverse
DROP TRIGGER IF EXISTS conversation_topic_events_no_update ON public.conversation_topic_events;
DROP FUNCTION IF EXISTS public.forbid_topic_event_mutation();
DROP POLICY IF EXISTS conversation_topic_events_admin_select ON public.conversation_topic_events;
DROP TABLE IF EXISTS public.conversation_topic_events CASCADE;
DROP TYPE IF EXISTS public.topic_event_actor_type;
DROP TYPE IF EXISTS public.topic_event_type;
```

---

## Retención

`CONFIG_CANDIDATE` 180–365d; job de purge por `created_at` (no borrar topics activos sin política).
