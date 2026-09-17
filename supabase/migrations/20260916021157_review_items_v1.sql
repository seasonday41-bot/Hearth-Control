create table public.review_items (
  id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  goal_id text,
  goal_title text,
  step_id text,
  task_id text,
  run_id text,
  result_id text,
  status text not null,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  local_created_at timestamptz,
  local_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.review_items enable row level security;

create policy review_items_select_own
  on public.review_items
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy review_items_insert_own
  on public.review_items
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy review_items_update_own
  on public.review_items
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.review_items to authenticated;

create index review_items_user_id_idx
  on public.review_items (user_id);

create index review_items_user_status_idx
  on public.review_items (user_id, status);

create index review_items_user_updated_at_idx
  on public.review_items (user_id, updated_at desc);

create trigger review_items_touch_updated_at
  before update on public.review_items
  for each row
  execute function private.touch_updated_at();;
