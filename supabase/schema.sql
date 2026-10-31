-- Foreman history: one row per room event. Run once in the Supabase SQL editor.
create table if not exists foreman_events (
  id bigserial primary key,
  repo_id text not null,
  type text not null,
  agent_id text not null,
  agent_label text not null,
  key text,
  to_label text,
  sha text,
  created_at timestamptz not null default now()
);
create index if not exists foreman_events_repo_type on foreman_events (repo_id, type);
