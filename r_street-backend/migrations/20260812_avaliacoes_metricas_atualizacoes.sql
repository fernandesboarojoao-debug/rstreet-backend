-- Avaliações moderadas, atualização de pedido e métricas anônimas.

create table if not exists public.avaliacoes_produtos (
  id bigserial primary key,
  pedido_id bigint not null references public.pedidos(id) on delete cascade,
  produto_id bigint not null references public.produtos(id) on delete cascade,
  nome_cliente text not null,
  nota smallint not null check (nota between 1 and 5),
  comentario text not null check (char_length(comentario) between 8 and 800),
  status text not null default 'pendente' check (status in ('pendente', 'aprovada', 'recusada')),
  criado_em timestamptz not null default now(),
  aprovado_em timestamptz,
  unique (pedido_id, produto_id)
);
create index if not exists avaliacoes_produtos_publicadas_idx on public.avaliacoes_produtos (produto_id, criado_em desc) where status = 'aprovada';

create table if not exists public.pedido_atualizacoes (
  id bigserial primary key,
  pedido_id bigint not null references public.pedidos(id) on delete cascade,
  status text,
  envio_status text,
  titulo text not null,
  descricao text,
  criado_em timestamptz not null default now()
);
create index if not exists pedido_atualizacoes_pedido_idx on public.pedido_atualizacoes (pedido_id, criado_em);

alter table public.pedidos drop constraint if exists pedidos_envio_status_check;
alter table public.pedidos add constraint pedidos_envio_status_check check (
  envio_status is null or envio_status in ('aguardando_envio', 'em_preparacao', 'enviado', 'entregue', 'retirada_disponivel', 'retirado')
);

create table if not exists public.metricas_eventos (
  id bigserial primary key,
  sessao_id text not null,
  tipo text not null check (tipo in ('page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'begin_checkout_item', 'purchase', 'purchase_item', 'whatsapp')),
  pagina text not null,
  produto_id bigint references public.produtos(id) on delete set null,
  produto_variante_id bigint references public.produto_variantes(id) on delete set null,
  marca text,
  categoria text,
  valor numeric(10,2),
  criado_em timestamptz not null default now()
);
create index if not exists metricas_eventos_tipo_data_idx on public.metricas_eventos (tipo, criado_em desc);
create index if not exists metricas_eventos_produto_data_idx on public.metricas_eventos (produto_id, criado_em desc);

alter table public.avaliacoes_produtos enable row level security;
alter table public.pedido_atualizacoes enable row level security;
alter table public.metricas_eventos enable row level security;

drop policy if exists "Service role avaliacoes" on public.avaliacoes_produtos;
create policy "Service role avaliacoes" on public.avaliacoes_produtos for all to service_role using (true) with check (true);
drop policy if exists "Service role atualizacoes pedido" on public.pedido_atualizacoes;
create policy "Service role atualizacoes pedido" on public.pedido_atualizacoes for all to service_role using (true) with check (true);
drop policy if exists "Service role metricas" on public.metricas_eventos;
create policy "Service role metricas" on public.metricas_eventos for all to service_role using (true) with check (true);

create or replace function public.registrar_atualizacao_pedido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pedido_atualizacoes (pedido_id, status, envio_status, titulo, descricao)
    values (new.id, new.status, new.envio_status, 'Pedido recebido', 'Recebemos seu pedido e vamos acompanhar o pagamento.');
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.pedido_atualizacoes (pedido_id, status, envio_status, titulo, descricao)
    values (new.id, new.status, new.envio_status,
      case new.status when 'pago' then 'Pagamento aprovado' when 'pendente' then 'Aguardando pagamento' when 'em_analise' then 'Pagamento em análise' when 'recusado' then 'Pagamento recusado' when 'cancelado' then 'Pedido cancelado' when 'reembolsado' then 'Pedido reembolsado' else 'Status do pedido atualizado' end,
      case new.status when 'pago' then 'Seu pagamento foi confirmado. Vamos preparar seu pedido.' when 'pendente' then 'Assim que o pagamento for confirmado, seu pedido seguirá para preparação.' when 'em_analise' then 'O pagamento está sendo analisado pelo Mercado Pago.' when 'recusado' then 'O pagamento não foi aprovado. Tente outra forma de pagamento.' when 'cancelado' then 'Este pedido foi cancelado.' when 'reembolsado' then 'O reembolso deste pedido foi registrado.' else null end);
  end if;

  if new.envio_status is distinct from old.envio_status then
    insert into public.pedido_atualizacoes (pedido_id, status, envio_status, titulo, descricao)
    values (new.id, new.status, new.envio_status,
      case new.envio_status when 'em_preparacao' then 'Pedido em preparação' when 'retirada_disponivel' then 'Disponível para retirada' when 'enviado' then 'Pedido enviado' when 'entregue' then 'Pedido entregue' when 'retirado' then 'Pedido retirado' else 'Aguardando preparação' end,
      case new.envio_status when 'em_preparacao' then 'Estamos separando e embalando seu pedido.' when 'retirada_disponivel' then 'Seu pedido já pode ser retirado na loja.' when 'enviado' then 'Seu pedido foi enviado. Consulte o rastreio quando disponível.' when 'entregue' then 'Entrega confirmada.' when 'retirado' then 'Pedido retirado na loja.' else 'Seu pedido aguarda a próxima etapa de envio.' end);
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_registrar_atualizacao on public.pedidos;
create trigger pedidos_registrar_atualizacao after insert or update of status, envio_status on public.pedidos for each row execute function public.registrar_atualizacao_pedido();
revoke execute on function public.registrar_atualizacao_pedido() from public, anon, authenticated;
