-- Migration 0020: Make app_settings and deletion_requests audit columns identity-provider agnostic (text)
alter table if exists public.app_settings
  alter column updated_by type text using updated_by::text;

alter table if exists public.deletion_requests
  alter column resolved_by type text using resolved_by::text;
