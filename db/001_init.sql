create table if not exists assets (
  id text primary key,
  storage_kind text not null default 'local',
  path_or_object_key text,
  content bytea,
  mime_type text not null,
  width integer not null,
  height integer not null,
  bytes integer not null,
  alt_text_default text not null,
  created_at timestamptz not null default now()
);

alter table assets add column if not exists storage_kind text not null default 'local';
alter table assets alter column path_or_object_key drop not null;
alter table assets add column if not exists content bytea;

create index if not exists assets_path_or_object_key_idx on assets (path_or_object_key);

create table if not exists messages (
  id text primary key,
  body text not null,
  status text not null default 'draft',
  weight integer not null default 100,
  cooldown_hours integer not null default 168,
  tags jsonb not null default '[]',
  platforms jsonb not null default '["bluesky"]',
  self_labels jsonb not null default '[]',
  image_asset_id text references assets(id),
  image_path text,
  image_alt text,
  normalised_hash text not null,
  last_posted_at timestamptz,
  post_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table messages add column if not exists image_asset_id text references assets(id);
alter table messages add column if not exists platforms jsonb not null default '["bluesky"]';

create index if not exists messages_status_idx on messages (status);
create index if not exists messages_normalised_hash_idx on messages (normalised_hash);
create index if not exists messages_last_posted_at_idx on messages (last_posted_at);

create table if not exists post_runs (
  id text primary key,
  message_id text not null references messages(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  platform text not null default 'bluesky',
  status text not null,
  bsky_uri text,
  bsky_cid text,
  platform_uri text,
  platform_url text,
  http_status integer,
  error text,
  retry_count integer not null default 0
);

create index if not exists post_runs_message_id_idx on post_runs (message_id);
create index if not exists post_runs_attempted_at_idx on post_runs (attempted_at desc);
create index if not exists post_runs_status_idx on post_runs (status);
create index if not exists post_runs_platform_idx on post_runs (platform);

create table if not exists scheduler_state (
  singleton_key text primary key,
  enabled boolean not null default true,
  timezone text not null default 'UTC',
  min_interval_minutes integer not null default 60,
  max_interval_minutes integer not null default 180,
  quiet_hours_json jsonb not null default '[]',
  next_run_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz
);

insert into scheduler_state (singleton_key, next_run_at)
values ('poster', now())
on conflict (singleton_key) do nothing;
