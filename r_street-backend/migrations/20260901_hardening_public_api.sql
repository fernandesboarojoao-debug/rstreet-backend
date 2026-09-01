-- Limita a Data API ao minimo necessario para o site publico.
-- O backend usa uma chave secreta/service_role e continua com acesso administrativo.

alter table if exists public.produtos enable row level security;
alter table if exists public.produto_variantes enable row level security;
alter table if exists public.temas_site enable row level security;
alter table if exists public.home_destaques enable row level security;
alter table if exists public.clientes enable row level security;
alter table if exists public.pedidos enable row level security;
alter table if exists public.itens_pedido enable row level security;
alter table if exists public.avaliacoes_produtos enable row level security;
alter table if exists public.pedido_atualizacoes enable row level security;
alter table if exists public.metricas_eventos enable row level security;

revoke all on table public.clientes, public.pedidos, public.itens_pedido,
  public.avaliacoes_produtos, public.pedido_atualizacoes, public.metricas_eventos
  from anon, authenticated;

revoke insert, update, delete on table public.produtos, public.produto_variantes,
  public.temas_site, public.home_destaques from anon, authenticated;

grant select on table public.produtos, public.produto_variantes,
  public.temas_site, public.home_destaques to anon, authenticated;

grant select, insert, update, delete on table public.produtos, public.produto_variantes,
  public.temas_site, public.home_destaques, public.clientes, public.pedidos,
  public.itens_pedido, public.avaliacoes_produtos, public.pedido_atualizacoes,
  public.metricas_eventos to service_role;

drop policy if exists "Produtos leitura publica ativos" on public.produtos;
drop policy if exists "Public read active produtos" on public.produtos;
create policy "Public read active produtos"
  on public.produtos for select to anon, authenticated
  using (ativo = true);

drop policy if exists "Produto variantes leitura publica ativas" on public.produto_variantes;
create policy "Produto variantes leitura publica ativas"
  on public.produto_variantes for select to anon, authenticated
  using (
    ativo = true
    and exists (
      select 1 from public.produtos p
      where p.id = produto_variantes.produto_id and p.ativo = true
    )
  );

drop policy if exists "temas_site_public_read_current" on public.temas_site;
drop policy if exists "Temas ativos para leitura publica" on public.temas_site;
create policy "Temas ativos para leitura publica"
  on public.temas_site for select to anon, authenticated
  using (
    status = 'ativo'
    or (
      status = 'programado'
      and (inicio is null or inicio <= now())
      and (fim is null or fim >= now())
    )
  );

drop policy if exists "Public read active home destaques" on public.home_destaques;
drop policy if exists "Destaques ativos para leitura publica" on public.home_destaques;
create policy "Destaques ativos para leitura publica"
  on public.home_destaques for select to anon, authenticated
  using (ativo = true);

revoke execute on function public.registrar_atualizacao_pedido() from public, anon, authenticated;
revoke execute on function public.update_atualizado_em() from public, anon, authenticated;
revoke execute on function public.update_pedidos_atualizado_em() from public, anon, authenticated;
revoke all on function public.finalizar_pedido_pago(bigint, text) from public, anon, authenticated;
grant execute on function public.finalizar_pedido_pago(bigint, text) to service_role;
