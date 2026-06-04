alter table messages add column if not exists platforms jsonb not null default '["bluesky"]';

alter table post_runs add column if not exists platform text not null default 'bluesky';
alter table post_runs add column if not exists platform_uri text;
alter table post_runs add column if not exists platform_url text;

create index if not exists post_runs_platform_idx on post_runs (platform);
