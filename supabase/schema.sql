create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.workflows (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  nodes jsonb not null,
  edges jsonb not null,
  deployed boolean not null default false,
  api_key_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.runs (
  id uuid primary key,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('running', 'completed', 'failed')),
  output jsonb,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists workflows_user_updated_idx
  on public.workflows(user_id, updated_at desc);
create index if not exists runs_workflow_created_idx
  on public.runs(workflow_id, created_at desc);

create or replace function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
  after insert or update of email on auth.users
  for each row execute procedure public.create_profile_for_auth_user();

alter table public.profiles enable row level security;
alter table public.workflows enable row level security;
alter table public.runs enable row level security;

create policy "Users can read own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "Users can read own workflows" on public.workflows
  for select using (auth.uid() = user_id);
create policy "Users can manage own workflows" on public.workflows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can read own runs" on public.runs
  for select using (auth.uid() = user_id);

grant all on public.profiles, public.workflows, public.runs to service_role;
