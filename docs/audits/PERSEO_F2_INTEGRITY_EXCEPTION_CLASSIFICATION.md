# F2 integrity exception classification

Date: 2026-07-28  
Scope: read-only precertification evidence  
Production writes: none

## Decision boundary

This inventory classifies evidence; it does not authorize repairs, lead closure,
backfill, merge, migration, or deployment. UUIDs are technical identifiers. No
names, phones, email addresses, message bodies, or other direct personal data are
included.

## Contactless conversations

The read-only cut found 19 conversations with `contact_id is null`.

| Conversation ID | State | Lead link | Classification | Proposed treatment |
| --- | --- | ---: | --- | --- |
| `d961e787-33ae-4f2e-aeac-d4ac418841ac` | closed | no | legacy tolerable | retain; no repair |
| `a3694208-32ad-49c2-a920-3cc7e128a2fa` | closed | no | legacy tolerable | retain; no repair |
| `41540af3-8229-4e62-884e-6a0f6b9f3608` | closed | no | legacy tolerable | retain; no repair |
| `70536071-945d-4e92-9a14-8a91c94d4b48` | closed | no | legacy tolerable | retain; no repair |
| `6c13a0f8-2a73-416f-90ec-177cc20cd7e6` | closed | no | legacy tolerable | retain; no repair |
| `03cc500c-ee7c-4f06-a41f-4cd02bead23f` | closed | no | legacy tolerable | retain; no repair |
| `b6fc386c-7305-4138-85ca-e50cd2c02df2` | closed | no | legacy tolerable | retain; no repair |
| `52ced7e6-21a3-4852-ae9f-aef1e3ab4dbf` | closed | yes | correctable candidate | verify FK evidence and human approval |
| `5982ed09-f4cf-4ba0-a2a9-e29c346d9a6e` | open | no | incomplete | business review |
| `1e2853e4-fd90-4b0b-838e-b8958195ef21` | open | no | incomplete | business review |
| `87e38323-cda0-49ee-b677-c80a7920bffc` | open | no | incomplete | business review |
| `4de0c153-300f-4821-92d6-3277f5d594ed` | open | no | incomplete | business review |
| `794f2745-af56-4c1a-a6c1-3a2e9e447f18` | open | no | incomplete | business review |
| `5b5ea858-023a-4b16-8ca2-d8507c51b7e8` | open | no | incomplete | business review |
| `2129e42d-8e83-4696-ab2a-4f0e695e8683` | open | no | incomplete | business review |
| `4a787a90-ff36-4a74-9cb2-23236b17299e` | open | no | incomplete | business review |
| `492a09c9-d11e-4c0f-a89a-2d27a7c63e24` | open | no | high-risk incomplete | priority human review; long-lived dialogue |
| `517412d5-7ab7-4fac-ad18-f88237adbdf4` | open | no | incomplete | business review |
| `ea3803fd-c7e7-4145-b6a1-9b45c552fa02` | open | no | incomplete | business review |

Aggregate result: 7 legacy-tolerable, 1 correctable candidate, 10 incomplete
requiring business review, and 1 high-risk incomplete requiring priority review.
The correctable candidate is not approved for automatic repair.

## Contacts with multiple active leads

The read-only cut found 15 contacts with more than one active, non-archived lead.
A business signature is `(lead_type, interested_in_operation,
interested_property_id)`; owner is analyzed separately.

| Contact ID | Active | Business signatures | Classification |
| --- | ---: | ---: | --- |
| `01bf6138-4293-4a9c-a5fb-0b62e6490d7d` | 2 | 2 | valid multiple intents |
| `0367888e-5ac8-4c1d-8733-19549fd615d4` | 3 | 3 | valid multiple intents |
| `202e327a-99e7-49d6-9a9f-9dfc7d991b3c` | 3 | 3 | valid multiple intents |
| `2a2e0ca1-6700-47c9-8781-d92542e47c86` | 9 | 5 | mixed intents plus duplicate candidates; priority review |
| `3fcb450e-0f45-4acf-b0af-78ba907380be` | 3 | 3 | valid multiple listings |
| `6f361ba2-608e-4b4c-822a-c26d19cf253a` | 2 | 2 | valid multiple listings |
| `6f46d2fc-62aa-4c35-91d9-f61bc8763c5f` | 3 | 3 | valid intents; one incomplete signature needs review |
| `7654bfd0-bd00-41ec-9045-6d56233c1627` | 2 | 2 | valid intents; one incomplete signature needs review |
| `823f9c69-5bd2-491f-960c-bef10d03d752` | 4 | 4 | valid multiple intents |
| `88a08334-67ca-447a-9e00-761c0152bdc3` | 2 | 2 | valid dual role |
| `96a3fbc1-899e-4f9a-a84a-ff2a9632e2ec` | 4 | 4 | distinct intents; legacy/business review |
| `9b0b2e34-f5ba-4e42-b457-5028448b494b` | 2 | 2 | valid multiple listings |
| `e0a0c16f-7f30-430c-98e8-99f96c22122e` | 2 | 1 | high-confidence duplicate candidate |
| `e1e8bf07-3475-470a-a1f1-9e3598c49365` | 3 | 1 | duplicate candidate with ownership conflict |
| `eadf532b-b696-4453-a068-cb9253537357` | 2 | 2 | valid distinct operations |

No lead is proposed for automatic closure. In particular, null property values are
not treated as proof of duplication, and distinct listings or operations remain
valid by design.

## Controlled follow-up

1. A named business owner reviews the 11 open contactless conversations.
2. A data owner verifies the linked-lead evidence for the single correctable
   conversation candidate.
3. Business and lead owners review the three duplicate/mixed contact groups.
4. Only after a signed decision may a separate, versioned repair proposal be
   prepared with an exact rollback and before/after counts.

The companion `scripts/sql/f2-integrity-dry-run.sql` is read-only and the
classification tests enforce that it contains no mutating SQL.
