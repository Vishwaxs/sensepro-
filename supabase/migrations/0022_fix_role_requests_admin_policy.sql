-- Keep the optional Supabase Auth fallback policy aligned with user_roles.
-- Clerk role-request administration goes through the service-backed API, but
-- a Supabase-authenticated admin must still be able to read the same queue.

drop policy if exists "admins_can_read_all_role_requests"
  on public.role_requests;

create policy "admins_can_read_all_role_requests"
  on public.role_requests for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.app_role = 'admin'
    )
  );
