# DRAFT — contact_consents

**DO_NOT_APPLY** · 2026-07-22 · F2/F4/F7 design  
**ADVERTENCIA: Este cambio requiere modificación de esquema.**

Ledger de consentimiento por **purpose**. Distinto de `contact_communication_preferences` (canal / opt-out; hoy 0 rows en prod).

---

## Forward SQL (borrador)

```sql
-- DO_NOT_APPLY

CREATE TYPE public.contact_consent_purpose AS ENUM (
  'whatsapp_contact',
  'phone_call',
  'email',
  'visit_coordination',
  'share_with_advisor',
  'process_images',
  'process_audio'
);

CREATE TYPE public.contact_consent_status AS ENUM (
  'granted',
  'denied',
  'withdrawn',
  'unknown'
);

CREATE TABLE public.contact_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  purpose public.contact_consent_purpose NOT NULL,
  status public.contact_consent_status NOT NULL DEFAULT 'unknown',
  source text NULL, -- whatsapp_inbound | advisor_ui | system | meta_lead
  scope text NULL, -- optional narrow scope string/code
  evidence_message_id uuid NULL,
  topic_id uuid NULL REFERENCES public.conversation_topics(id) ON DELETE SET NULL,
  lead_id uuid NULL REFERENCES public.leads(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL, -- CONFIG_CANDIDATE e.g. 180d
  withdrawn_at timestamptz NULL,
  actor_type text NULL, -- user | advisor | system
  actor_id uuid NULL,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.contact_consents IS
  'Purpose-scoped consent ledger. preferences≠consent. Handoff call requires phone_call grant (D8).';
COMMENT ON COLUMN public.contact_consents.metadata_redacted IS
  'No transcript/PII; evidence via evidence_message_id.';

-- Latest row per (contact, purpose) is authoritative; history kept as multiple rows
CREATE INDEX contact_consents_contact_purpose_captured_idx
  ON public.contact_consents (contact_id, purpose, captured_at DESC);

CREATE INDEX contact_consents_topic_idx
  ON public.contact_consents (topic_id)
  WHERE topic_id IS NOT NULL;

ALTER TABLE public.contact_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_consents_admin_select
  ON public.contact_consents
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

REVOKE ALL ON public.contact_consents FROM PUBLIC;
GRANT SELECT ON public.contact_consents TO authenticated;
```

---

## Reverse SQL (borrador)

```sql
-- DO_NOT_APPLY reverse
DROP POLICY IF EXISTS contact_consents_admin_select ON public.contact_consents;
DROP TABLE IF EXISTS public.contact_consents CASCADE;
DROP TYPE IF EXISTS public.contact_consent_status;
DROP TYPE IF EXISTS public.contact_consent_purpose;
```

---

## Reglas de producto

| Acción | Requisito |
|--------|-----------|
| Afirmar “te llamamos” | `phone_call` = granted vigente |
| Handoff WA (D8) | `whatsapp_contact` grant o política inbound firmada |
| Multimodal (D6) | `process_images` / `process_audio` antes de análisis |
| Retiro | nueva fila `withdrawn` + `withdrawn_at` |
