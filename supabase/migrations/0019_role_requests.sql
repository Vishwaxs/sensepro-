-- Migration 0019: Role access requests (unassigned users -> admin review)
create table if not exists public.role_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email text not null,
  full_name text,
  requested_role text not null check (requested_role in ('teacher', 'management', 'admin', 'student')),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolved_role text
);

-- Index for rapid filtering and lookup
create index if not exists idx_role_requests_status on public.role_requests (status);
create index if not exists idx_role_requests_user_id on public.role_requests (user_id);
create index if not exists idx_role_requests_email on public.role_requests (email);

-- Enable RLS
alter table public.role_requests enable row level security;

-- Policies:
create policy "users_can_read_own_role_requests"
  on public.role_requests for select
  to authenticated
  using (user_id = auth.uid()::text or email = auth.jwt()->>'email');

create policy "admins_can_read_all_role_requests"
  on public.role_requests for select
  to authenticated
  using (
    exists (
      select 1 from public.user_roles ur
      where (ur.user_id = auth.uid()::text or ur.user_id = (auth.jwt()->>'sub'))
        and ur.role = 'admin'
    )
  );

create policy "users_can_insert_own_role_requests"
  on public.role_requests for insert
  to authenticated
  with check (true);

-- Grants
grant select, insert on public.role_requests to authenticated;
grant all on public.role_requests to service_role;
grant all on public.role_requests to postgres;
