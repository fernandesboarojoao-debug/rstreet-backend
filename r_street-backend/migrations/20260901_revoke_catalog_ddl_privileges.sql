-- As tabelas de catalogo sao somente leitura para visitantes.
-- REVOKE ALL tambem remove TRUNCATE, TRIGGER e REFERENCES, que o RLS nao cobre.

revoke all on table public.produtos, public.produto_variantes,
  public.temas_site, public.home_destaques from anon, authenticated;

grant select on table public.produtos, public.produto_variantes,
  public.temas_site, public.home_destaques to anon, authenticated;
