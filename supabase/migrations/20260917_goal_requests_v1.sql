-- Remote Goal ingress transport for Project X (pavrugcmxdgdxrjinzlm).
--
-- LOCKED PRINCIPLE (same as review_items_v1 and public.tasks): this table is
-- TRANSPORT + PROJECTION ONLY. It never authorizes anything. goals.json
-- (GoalStorage) remains the sole authoritative local truth for Goal state,
-- X dispatch, approvals, and continuation. A modified or forged row here has
-- ZERO effect on local Goal state, X dispatch, approvals, continuation, or
-- recovery -- Hearth only ever reads a row's `goal` payload ONCE, at the
-- moment it is claimed (queued -> running); every write after that is a
-- one-way, best-effort projection of local durable truth back onto the row.
--
-- Deliberately a SEPARATE table from public.tasks: public.tasks is, and
-- remains, ONE ROW = ONE complete x-task-v1 (see mcp/bridge/public-tasks-
-- client.mjs's own header comment) -- a remote Goal is a different shape
-- (an ordered set of already-authored steps, each optionally carrying its
-- own x-task-v1), and overloading public.tasks's metadata.x_task contract
-- to also mean "a whole Goal" would break that table's existing, already-
-- proven single-task semantics for every other caller.
--
-- Owner-scoped RLS (auth.uid() = user_id) is acceptable for this phase, same
-- as review_items_v1 -- but per that migration's own note, this is NOT
-- "Hearth-only write security": any client authenticated as the same
-- Project X user can read/write these rows. No service_role. No Edge
-- Function. No dedicated Chat/Hearth identity in this phase.
--
-- NOT APPLIED to Project X in this pass. This file is for local review only.

CREATE TABLE public.goal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Status vocabulary is deliberately IDENTICAL to public.tasks's own
  -- (queued/running/waiting/completed/failed/cancelled) rather than
  -- inventing a parallel one -- see public-tasks-client.mjs's header
  -- comment for that established vocabulary.
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),

  title text NOT NULL,

  -- The COMPLETE remote-goal-v1 payload authored by Chat/Main Brain: title,
  -- objective, constraints, and an ordered steps[] array where every
  -- route:"x" step already carries a complete x-task-v1 payload. Hearth
  -- reads this exactly once (at claim time) and never repairs, synthesizes,
  -- or reorders anything in it -- see mcp/bridge/goal-requests-client.mjs.
  goal jsonb NOT NULL,

  -- Durable linkage to the local Goal this row was imported into. Written
  -- once, immediately after a successful local create_goal(); the LOCAL
  -- goal.remoteGoalRequest field is the reverse link and is the side that
  -- actually matters for local idempotency (this column exists for the
  -- remote viewer's convenience only, e.g. so Chat can correlate without
  -- re-deriving the deterministic id format).
  local_goal_id text NULL,

  -- Compact, sanitized projection of current/terminal Goal state -- never a
  -- raw transcript, chain-of-thought, or full x-result-v1 dump for every
  -- step. See project_goal_state() in goal-requests-client.mjs.
  result jsonb NULL,
  error text NULL,

  started_at timestamptz NULL,
  finished_at timestamptz NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Matches public.tasks's own sync_version convention (trigger-owned,
  -- never written by any client) so remote viewers can detect a change
  -- without comparing full row contents.
  sync_version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz NULL
);

CREATE INDEX idx_goal_requests_user_status ON public.goal_requests (user_id, status, created_at);
CREATE INDEX idx_goal_requests_local_goal_id ON public.goal_requests (local_goal_id) WHERE local_goal_id IS NOT NULL;

ALTER TABLE public.goal_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY goal_requests_select_own ON public.goal_requests
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY goal_requests_insert_own ON public.goal_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY goal_requests_update_own ON public.goal_requests
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- No DELETE policy: rows are soft-deleted via deleted_at, matching
-- public.tasks's own convention, never hard-deleted by any client.

REVOKE ALL ON public.goal_requests FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.goal_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.goal_requests_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.sync_version = OLD.sync_version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goal_requests_set_updated_at
  BEFORE UPDATE ON public.goal_requests
  FOR EACH ROW EXECUTE FUNCTION public.goal_requests_set_updated_at();
