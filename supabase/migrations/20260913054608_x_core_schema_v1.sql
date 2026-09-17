create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'Asia/Bangkok',
  locale text not null default 'th-TH',
  role text not null default 'member' check (role in ('owner','member')),
  account_status text not null default 'active' check (account_status in ('active','suspended')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  install_id text not null,
  name text not null,
  platform text,
  app_version text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, install_id),
  unique (id, user_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  origin_device_id uuid,
  title text,
  summary text,
  status text not null default 'active' check (status in ('active','archived')),
  metadata jsonb not null default '{}'::jsonb,
  client_created_at timestamptz,
  client_updated_at timestamptz,
  sync_version bigint not null default 1 check (sync_version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint conversations_origin_device_owner_fk
    foreign key (origin_device_id, user_id)
    references public.devices(id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  origin_device_id uuid,
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  client_created_at timestamptz,
  client_updated_at timestamptz,
  sync_version bigint not null default 1 check (sync_version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint messages_conversation_owner_fk
    foreign key (conversation_id, user_id)
    references public.conversations(id, user_id),
  constraint messages_origin_device_owner_fk
    foreign key (origin_device_id, user_id)
    references public.devices(id, user_id)
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  origin_device_id uuid,
  kind text not null check (kind in ('fact','preference','project','instruction','summary')),
  content text not null,
  importance smallint not null default 50 check (importance between 0 and 100),
  status text not null default 'active' check (status in ('active','archived')),
  source_conversation_id uuid,
  source_message_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  client_created_at timestamptz,
  client_updated_at timestamptz,
  sync_version bigint not null default 1 check (sync_version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memories_origin_device_owner_fk
    foreign key (origin_device_id, user_id)
    references public.devices(id, user_id),
  constraint memories_source_conversation_owner_fk
    foreign key (source_conversation_id, user_id)
    references public.conversations(id, user_id),
  constraint memories_source_message_owner_fk
    foreign key (source_message_id, user_id)
    references public.messages(id, user_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid,
  origin_device_id uuid,
  title text not null,
  instruction text,
  status text not null default 'queued' check (status in ('queued','running','waiting','completed','failed','cancelled')),
  priority smallint not null default 5 check (priority between 0 and 9),
  result jsonb,
  error text,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  client_created_at timestamptz,
  client_updated_at timestamptz,
  sync_version bigint not null default 1 check (sync_version > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_conversation_owner_fk
    foreign key (conversation_id, user_id)
    references public.conversations(id, user_id),
  constraint tasks_origin_device_owner_fk
    foreign key (origin_device_id, user_id)
    references public.devices(id, user_id)
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null default 'member' check (role in ('member')),
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  token_hash text unique,
  invited_by uuid references public.profiles(id),
  accepted_by uuid references public.profiles(id),
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index invites_one_pending_per_email_idx
  on public.invites (lower(email))
  where status = 'pending';

create table public.sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null,
  entity text not null check (entity in ('conversations','messages','memories','tasks')),
  last_pulled_at timestamptz,
  last_pushed_at timestamptz,
  last_server_version bigint not null default 0 check (last_server_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id, entity),
  constraint sync_state_device_owner_fk
    foreign key (device_id, user_id)
    references public.devices(id, user_id)
);

create index conversations_user_updated_idx on public.conversations(user_id, updated_at desc);
create index conversations_user_live_updated_idx on public.conversations(user_id, updated_at desc) where deleted_at is null;
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index messages_user_updated_idx on public.messages(user_id, updated_at desc);
create index messages_user_live_updated_idx on public.messages(user_id, updated_at desc) where deleted_at is null;
create index memories_user_status_updated_idx on public.memories(user_id, status, updated_at desc);
create index memories_user_live_updated_idx on public.memories(user_id, updated_at desc) where deleted_at is null;
create index tasks_user_status_created_idx on public.tasks(user_id, status, created_at desc);
create index tasks_conversation_idx on public.tasks(conversation_id) where conversation_id is not null;
create index tasks_user_live_updated_idx on public.tasks(user_id, updated_at desc) where deleted_at is null;
create index devices_user_last_seen_idx on public.devices(user_id, last_seen_at desc);
create index sync_state_user_device_idx on public.sync_state(user_id, device_id);

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.touch_sync_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.sync_version := old.sync_version + 1;
  return new;
end;
$$;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.handle_new_auth_user() to supabase_auth_admin;
grant usage on schema private to authenticated, service_role;
grant execute on function private.touch_updated_at() to authenticated, service_role;
grant execute on function private.touch_sync_record() to authenticated, service_role;

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function private.touch_updated_at();

create trigger devices_touch_updated_at
before update on public.devices
for each row execute function private.touch_updated_at();

create trigger invites_touch_updated_at
before update on public.invites
for each row execute function private.touch_updated_at();

create trigger sync_state_touch_updated_at
before update on public.sync_state
for each row execute function private.touch_updated_at();

create trigger conversations_touch_sync
before update on public.conversations
for each row execute function private.touch_sync_record();

create trigger messages_touch_sync
before update on public.messages
for each row execute function private.touch_sync_record();

create trigger memories_touch_sync
before update on public.memories
for each row execute function private.touch_sync_record();

create trigger tasks_touch_sync
before update on public.tasks
for each row execute function private.touch_sync_record();

create trigger x_create_profile_after_signup
after insert on auth.users
for each row execute function private.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.tasks enable row level security;
alter table public.invites enable row level security;
alter table public.sync_state enable row level security;

revoke all on table public.profiles, public.devices, public.conversations, public.messages, public.memories, public.tasks, public.invites, public.sync_state from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, timezone, locale, settings) on public.profiles to authenticated;

grant select, insert, update on public.devices to authenticated;
grant select, insert, update on public.conversations to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert, update on public.memories to authenticated;
grant select, insert, update on public.tasks to authenticated;
grant select, insert, update on public.sync_state to authenticated;

grant all privileges on table public.profiles, public.devices, public.conversations, public.messages, public.memories, public.tasks, public.invites, public.sync_state to service_role;

create policy profiles_select_own
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

create policy profiles_update_own
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy devices_select_own
on public.devices for select
to authenticated
using ((select auth.uid()) = user_id);

create policy devices_insert_own
on public.devices for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy devices_update_own
on public.devices for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy conversations_select_own
on public.conversations for select
to authenticated
using ((select auth.uid()) = user_id);

create policy conversations_insert_own
on public.conversations for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy conversations_update_own
on public.conversations for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy messages_select_own
on public.messages for select
to authenticated
using ((select auth.uid()) = user_id);

create policy messages_insert_own
on public.messages for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy messages_update_own
on public.messages for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy memories_select_own
on public.memories for select
to authenticated
using ((select auth.uid()) = user_id);

create policy memories_insert_own
on public.memories for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy memories_update_own
on public.memories for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy tasks_select_own
on public.tasks for select
to authenticated
using ((select auth.uid()) = user_id);

create policy tasks_insert_own
on public.tasks for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy tasks_update_own
on public.tasks for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy sync_state_select_own
on public.sync_state for select
to authenticated
using ((select auth.uid()) = user_id);

create policy sync_state_insert_own
on public.sync_state for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy sync_state_update_own
on public.sync_state for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
;
