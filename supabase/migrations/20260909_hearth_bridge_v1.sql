-- ==============================================================================
-- Hearth Bridge V1 Database Migration
-- Architecture: ChatGPT -> Edge Function -> hearth_tasks (PostgREST Queue) -> Hearth Desktop
-- Source of Truth: auth.uid()
-- ==============================================================================

-- 1. Devices Table
CREATE TABLE IF NOT EXISTS hearth_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL UNIQUE,
  display_name text NULL,
  bridge_enabled boolean NOT NULL DEFAULT false,
  pairing_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A task must always reference a device owned by the same user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hearth_devices_owner_device
  ON hearth_devices(owner_id, device_id);

-- Index for device lookup and pairing verification
CREATE INDEX IF NOT EXISTS idx_hearth_devices_owner ON hearth_devices(owner_id);
CREATE INDEX IF NOT EXISTS idx_hearth_devices_device_id ON hearth_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_hearth_devices_pairing_hash ON hearth_devices(pairing_hash) WHERE pairing_hash IS NOT NULL;

-- Enable RLS on hearth_devices
ALTER TABLE hearth_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "devices_owner_manage" ON hearth_devices;
CREATE POLICY "devices_owner_manage" ON hearth_devices
  FOR ALL
  TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));


-- 2. Tasks Queue Table
CREATE TABLE IF NOT EXISTS hearth_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'chatgpt',
  title text NULL,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'approved',
    'running',
    'waiting',
    'done',
    'error',
    'rejected'
  )),
  hearth_task_id text NULL,
  conversation_id text NULL,
  result text NULL,
  error text NULL,
  request_id text NULL,
  metadata jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Foreign key link to device
ALTER TABLE hearth_tasks
  DROP CONSTRAINT IF EXISTS fk_hearth_tasks_device,
  ADD CONSTRAINT fk_hearth_tasks_device FOREIGN KEY (owner_id, device_id)
    REFERENCES hearth_devices(owner_id, device_id) ON DELETE CASCADE;

-- Performance & routing indexes
CREATE INDEX IF NOT EXISTS idx_hearth_tasks_device_status ON hearth_tasks(device_id, status);
CREATE INDEX IF NOT EXISTS idx_hearth_tasks_created_at ON hearth_tasks(created_at DESC);

-- Strong idempotency constraint: prevent duplicate submission of the same request_id per owner & device
CREATE UNIQUE INDEX IF NOT EXISTS idx_hearth_tasks_owner_device_request_id
  ON hearth_tasks(owner_id, device_id, request_id)
  WHERE request_id IS NOT NULL;

-- Enable RLS on hearth_tasks
ALTER TABLE hearth_tasks ENABLE ROW LEVEL SECURITY;

-- Desktop Hearth only reads & updates tasks belonging to its authenticated owner
DROP POLICY IF EXISTS "tasks_owner_select" ON hearth_tasks;
CREATE POLICY "tasks_owner_select" ON hearth_tasks
  FOR SELECT
  TO authenticated
  USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "tasks_owner_update" ON hearth_tasks;
CREATE POLICY "tasks_owner_update" ON hearth_tasks
  FOR UPDATE
  TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- Explicit Data API privileges. The public client may manage its own device,
-- but task creation is reserved for the Edge Function's service role.
REVOKE ALL ON TABLE hearth_devices, hearth_tasks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hearth_devices TO authenticated;
GRANT SELECT, UPDATE ON TABLE hearth_tasks TO authenticated;
GRANT ALL ON TABLE hearth_devices, hearth_tasks TO service_role;

-- External clients are NOT allowed to INSERT directly via PostgREST anon role.
-- Task insertion is performed exclusively via server-side Supabase Edge Function using service role after validating pairing secret.
