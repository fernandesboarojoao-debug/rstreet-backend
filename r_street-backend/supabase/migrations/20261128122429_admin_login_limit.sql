create schema if not exists rstreet_security;
revoke all on schema rstreet_security from public, anon, authenticated;
grant usage on schema rstreet_security to service_role;
create table rstreet_security.admin_login_limit (
  origin_hash text primary key,
  last_error timestamptz not null,
  previous_error timestamptz,
  expires_at timestamptz not null,
  locked boolean not null
);
alter table rstreet_security.admin_login_limit enable row level security;
revoke all on rstreet_security.admin_login_limit from public, anon, authenticated;
grant select, insert, update, delete on rstreet_security.admin_login_limit to service_role;
create index on rstreet_security.admin_login_limit (expires_at);

create function public.rstreet_admin_login_wait(p_origin text, p_correct boolean)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  r rstreet_security.admin_login_limit%rowtype;
  t timestamptz;
  lock_now boolean;
begin
  if p_origin is null or p_origin !~ '^[0-9a-f]{64}$' or p_correct is null then
    raise exception 'invalid login decision';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_origin, 90417));
  t := clock_timestamp();
  delete from rstreet_security.admin_login_limit where origin_hash in
    (select origin_hash from rstreet_security.admin_login_limit where expires_at <= t
     order by expires_at limit 100 for update skip locked);
  select * into r from rstreet_security.admin_login_limit where origin_hash=p_origin;
  if r.locked and r.expires_at > t then
    return ceil(extract(epoch from (r.expires_at-t)))::integer;
  end if;
  if p_correct then
    delete from rstreet_security.admin_login_limit where origin_hash=p_origin;
    return 0;
  end if;
  lock_now := coalesce(r.previous_error > t - interval '15 minutes' and r.expires_at > t,false);
  insert into rstreet_security.admin_login_limit values
    (p_origin,t,case when r.expires_at > t then r.last_error end,t+interval '15 minutes',lock_now)
  on conflict (origin_hash) do update set last_error=excluded.last_error,
    previous_error=excluded.previous_error,expires_at=excluded.expires_at,locked=excluded.locked;
  return case when lock_now then 900 else 0 end;
end;
$$;
revoke all on function public.rstreet_admin_login_wait(text,boolean) from public, anon, authenticated;
grant execute on function public.rstreet_admin_login_wait(text,boolean) to service_role;
