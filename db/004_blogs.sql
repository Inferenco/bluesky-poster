-- Create blogs table for the blog system
create table if not exists blogs (
  id text primary key,
  title text not null,
  content text not null,
  status text not null default 'draft',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create junction table for blog assets (many-to-many relationship)
create table if not exists blog_assets (
  blog_id text not null references blogs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (blog_id, asset_id)
);

-- Add status constraint (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'blogs_status_check' AND conrelid = 'blogs'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE blogs ADD CONSTRAINT blogs_status_check CHECK (status IN (''draft'', ''published'', ''archived''))';
  END IF;
END $$;

-- Create indexes for performance
create index if not exists blogs_status_idx on blogs (status);
create index if not exists blogs_published_at_idx on blogs (published_at desc);
create index if not exists blogs_created_at_idx on blogs (created_at desc);
create index if not exists blog_assets_blog_id_idx on blog_assets (blog_id);
create index if not exists blog_assets_position_idx on blog_assets (blog_id, position);

-- Create trigger to update updated_at timestamp (if not exists)
CREATE OR REPLACE FUNCTION update_blogs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'blogs_updated_at_trigger' 
    AND tgrelid = 'blogs'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER blogs_updated_at_trigger BEFORE UPDATE ON blogs FOR EACH ROW EXECUTE FUNCTION update_blogs_updated_at()';
  END IF;
END $$;