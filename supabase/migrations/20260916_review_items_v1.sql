-- ==============================================================================
-- Review Items — Remote Projection (visibility-only)
-- Project: Project X (pavrugcmxdgdxrjinzlm)
-- Architecture: Hearth (local goal.reviewQueue, authoritative)
--               -> best-effort one-way sync -> public.review_items
--               -> ChatGPT/Main Brain reads (SELECT only)
--
-- LOCKED: this table is a PROJECTION, never a control surface.
--   - goal.reviewQueue / goals.json remains the sole authoritative Review
--     Queue state. Nothing in Hearth ever reads this table back into any
--     local decision (Goal state, X dispatch, approvals, continuation,
--     recovery). A row here being edited, deleted, or forged by anyone has
--     ZERO effect on local Hearth state.
--   - RLS below is standard owner-scoped access (auth.uid() = user_id),
--     the SAME pattern already used elsewhere in this project (see
--     public.tasks). It does not, and is not claimed to, distinguish
--     "Hearth's own sync" from any other client authenticated as the same
--     Project X user — that distinction does not exist yet and is not
--     required for this phase, precisely because this table is never
--     consumed for local control. If a future phase ever wants to read
--     this table back into a decision, that requires a real trust-boundary
--     design first (see the Phase 2 remote-preauthorization audits), not
--     an RLS policy alone.
--   - No service_role usage from Hearth. No Edge Function. No dedicated
--     Chat/Hearth identity. All deferred.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.review_items (
  -- Exact local reviewItem.idempotencyKey (an X runId, or a synthetic
  -- "<goalId>:<stepId>:<status>" key for a pre-dispatch failure) — text,
  -- never forced to uuid, since the local contract does not guarantee one.
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_id text,
  goal_title text,
  step_id text,
  task_id text,
  run_id text,
  result_id text,
  status text NOT NULL,
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  local_created_at timestamptz,
  local_updated_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_items_user_id ON public.review_items(user_id);
CREATE INDEX IF NOT EXISTS idx_review_items_status ON public.review_items(status);
CREATE INDEX IF NOT EXISTS idx_review_items_goal_id ON public.review_items(goal_id) WHERE goal_id IS NOT NULL;

ALTER TABLE public.review_items ENABLE ROW LEVEL SECURITY;

-- Owner-scoped access (auth.uid() = user_id) — the same pattern public.tasks
-- already uses. This is standard row ownership, not a claim of "Hearth-only
-- write security": any client authenticated as this same Project X user can
-- read/write its own rows. That is acceptable here ONLY because this table
-- is never read back into local Hearth control state (see header note).
DROP POLICY IF EXISTS "review_items_owner_select" ON public.review_items;
CREATE POLICY "review_items_owner_select" ON public.review_items
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "review_items_owner_insert" ON public.review_items;
CREATE POLICY "review_items_owner_insert" ON public.review_items
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "review_items_owner_update" ON public.review_items;
CREATE POLICY "review_items_owner_update" ON public.review_items
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- No DELETE policy for `authenticated` (matches public.tasks' own posture:
-- no client-facing delete grant). Manual cleanup of test/smoke rows is done
-- by the project owner via the Supabase dashboard, not via this RLS surface.

REVOKE ALL ON TABLE public.review_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.review_items TO authenticated;

-- updated_at trigger, mirroring the existing public.tasks convention of
-- letting the database own this column rather than any client write.
CREATE OR REPLACE FUNCTION public.set_review_items_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_items_updated_at ON public.review_items;
CREATE TRIGGER trg_review_items_updated_at
  BEFORE UPDATE ON public.review_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_review_items_updated_at();
