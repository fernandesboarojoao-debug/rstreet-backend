-- Available stock is allocated before a payment link is returned.
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS reserva_estado text
  CHECK (reserva_estado IN ('ativa', 'consumida', 'liberada'));
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS reserva_expira_em timestamptz;
CREATE INDEX IF NOT EXISTS pedidos_reservas_ativas_idx ON public.pedidos(reserva_expira_em, id)
  WHERE reserva_estado = 'ativa';

CREATE OR REPLACE FUNCTION public.alocar_estoque_pedido(p_pedido_id bigint, p_validar_preco boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE r record; p public.produtos%ROWTYPE; v public.produto_variantes%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.itens_pedido WHERE pedido_id = p_pedido_id)
    OR EXISTS (SELECT 1 FROM public.itens_pedido WHERE pedido_id = p_pedido_id
      AND (produto_id IS NULL OR quantidade IS NULL OR quantidade <= 0)) THEN
    RAISE EXCEPTION 'Item invalido no pedido.';
  END IF;
  -- Same lock order as admin edits and legacy payment finalization.
  PERFORM id FROM public.produtos WHERE id IN
    (SELECT produto_id FROM public.itens_pedido WHERE pedido_id = p_pedido_id) ORDER BY id FOR UPDATE;
  PERFORM id FROM public.produto_variantes WHERE produto_id IN
    (SELECT produto_id FROM public.itens_pedido WHERE pedido_id = p_pedido_id) ORDER BY id FOR UPDATE;
  FOR r IN SELECT produto_id, produto_variante_id, SUM(quantidade)::integer AS quantidade,
    MIN(preco_unitario) AS preco_min, MAX(preco_unitario) AS preco_max
    FROM public.itens_pedido WHERE pedido_id = p_pedido_id GROUP BY produto_id, produto_variante_id
  LOOP
    SELECT * INTO p FROM public.produtos WHERE id = r.produto_id;
    IF NOT FOUND OR p.ativo IS NOT TRUE THEN RAISE EXCEPTION 'Produto indisponivel no pedido.'; END IF;
    IF r.produto_variante_id IS NOT NULL THEN
      SELECT * INTO v FROM public.produto_variantes WHERE id = r.produto_variante_id AND produto_id = p.id;
      IF NOT FOUND OR v.ativo IS NOT TRUE OR v.estoque IS NULL OR v.estoque < r.quantidade THEN
        RAISE EXCEPTION 'Estoque insuficiente ou variacao indisponivel no pedido.';
      END IF;
      IF p_validar_preco AND (r.preco_min IS DISTINCT FROM COALESCE(v.preco,p.preco)
        OR r.preco_max IS DISTINCT FROM COALESCE(v.preco,p.preco)) THEN
        RAISE EXCEPTION 'Preco mudou. Revise o carrinho.';
      END IF;
      UPDATE public.produto_variantes SET estoque = estoque - r.quantidade, atualizado_em = now() WHERE id = v.id;
    ELSE
      IF EXISTS (SELECT 1 FROM public.produto_variantes WHERE produto_id = p.id AND ativo) THEN
        RAISE EXCEPTION 'Escolha uma variacao do produto.';
      END IF;
      IF p.estoque IS NULL OR p.estoque < r.quantidade THEN RAISE EXCEPTION 'Estoque insuficiente no pedido.'; END IF;
      IF p_validar_preco AND (r.preco_min IS DISTINCT FROM p.preco OR r.preco_max IS DISTINCT FROM p.preco) THEN
        RAISE EXCEPTION 'Preco mudou. Revise o carrinho.';
      END IF;
    END IF;
    UPDATE public.produtos SET estoque = GREATEST(0, estoque - r.quantidade), atualizado_em = now() WHERE id = p.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.reservar_estoque_pedido(p_pedido_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p public.pedidos%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido nao encontrado.'; END IF;
  IF p.reserva_estado = 'ativa' THEN RETURN to_jsonb(p); END IF;
  IF p.reserva_estado IS NOT NULL OR p.status <> 'pendente' OR p.mp_preference_id IS NOT NULL THEN
    RAISE EXCEPTION 'Pedido nao pode ser reservado.';
  END IF;
  PERFORM public.alocar_estoque_pedido(p_pedido_id, true);
  UPDATE public.pedidos SET reserva_estado = 'ativa', reserva_expira_em = now() + interval '30 minutes'
    WHERE id = p_pedido_id RETURNING * INTO p;
  RETURN to_jsonb(p);
END $$;

CREATE OR REPLACE FUNCTION public.finalizar_pedido_pago(p_pedido_id bigint, p_payment_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p public.pedidos%ROWTYPE;
BEGIN
  IF p_pedido_id IS NULL OR p_pedido_id <= 0 OR btrim(COALESCE(p_payment_id,'')) = '' THEN
    RAISE EXCEPTION 'Pedido ou pagamento invalido.';
  END IF;
  SELECT * INTO p FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido nao encontrado.'; END IF;
  IF p.status IN ('pago','reembolsado','estornado') OR p.reserva_estado = 'consumida' THEN
    RETURN jsonb_build_object('status',p.status,'ja_processado',true);
  END IF;
  -- Old checkouts and late payments still take the same atomic stock path.
  IF p.reserva_estado IS DISTINCT FROM 'ativa' THEN
    PERFORM public.alocar_estoque_pedido(p_pedido_id, false);
  END IF;
  UPDATE public.pedidos SET status = 'pago', mp_payment_id = p_payment_id,
    pago_em = COALESCE(pago_em,now()), atualizado_em = now(),
    reserva_estado = CASE WHEN reserva_estado IS NULL THEN NULL ELSE 'consumida' END WHERE id = p_pedido_id;
  RETURN jsonb_build_object('status','pago','ja_processado',false);
END $$;

-- Backend must verify the expired preference AND all payment attempts before calling.
CREATE OR REPLACE FUNCTION public.liberar_reserva_pedido(p_pedido_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p public.pedidos%ROWTYPE; r record;
BEGIN
  SELECT * INTO p FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND OR p.reserva_estado IS DISTINCT FROM 'ativa'
    OR p.reserva_expira_em IS NULL OR p.reserva_expira_em > now() - interval '5 minutes'
    OR p.status IN ('pago','reembolsado','estornado','estoque_indisponivel') THEN RETURN false; END IF;
  PERFORM id FROM public.produtos WHERE id IN
    (SELECT produto_id FROM public.itens_pedido WHERE pedido_id = p_pedido_id) ORDER BY id FOR UPDATE;
  PERFORM id FROM public.produto_variantes WHERE produto_id IN
    (SELECT produto_id FROM public.itens_pedido WHERE pedido_id = p_pedido_id) ORDER BY id FOR UPDATE;
  FOR r IN SELECT produto_id, produto_variante_id, SUM(quantidade)::integer AS quantidade
    FROM public.itens_pedido WHERE pedido_id = p_pedido_id GROUP BY produto_id,produto_variante_id
  LOOP
    IF r.produto_id IS NULL THEN RAISE EXCEPTION 'Produto da reserva foi removido.'; END IF;
    IF r.produto_variante_id IS NOT NULL THEN
      UPDATE public.produto_variantes SET estoque = estoque + r.quantidade, atualizado_em = now() WHERE id = r.produto_variante_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Variacao da reserva foi removida.'; END IF;
      UPDATE public.produtos SET estoque = (SELECT COALESCE(SUM(estoque),0) FROM public.produto_variantes
        WHERE produto_id = r.produto_id AND ativo), atualizado_em = now() WHERE id = r.produto_id;
    ELSE
      UPDATE public.produtos SET estoque = estoque + r.quantidade, atualizado_em = now() WHERE id = r.produto_id;
    END IF;
  END LOOP;
  UPDATE public.pedidos SET reserva_estado = 'liberada', status = 'cancelado', atualizado_em = now() WHERE id = p_pedido_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.alocar_estoque_pedido(bigint,boolean), public.reservar_estoque_pedido(bigint),
  public.finalizar_pedido_pago(bigint,text), public.liberar_reserva_pedido(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.alocar_estoque_pedido(bigint,boolean), public.reservar_estoque_pedido(bigint),
  public.finalizar_pedido_pago(bigint,text), public.liberar_reserva_pedido(bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.proteger_produto_reservado()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.itens_pedido i JOIN public.pedidos p ON p.id = i.pedido_id
    WHERE i.produto_id = OLD.id AND p.reserva_estado = 'ativa') THEN
    RAISE EXCEPTION 'Produto com reserva ativa. Desative o produto em vez de excluir.';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.proteger_produto_reservado() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.proteger_produto_reservado() TO service_role;
CREATE TRIGGER trg_proteger_produto_reservado BEFORE DELETE ON public.produtos
  FOR EACH ROW EXECUTE FUNCTION public.proteger_produto_reservado();

CREATE OR REPLACE FUNCTION public.proteger_variacao_reservada()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.itens_pedido i JOIN public.pedidos p ON p.id = i.pedido_id
    WHERE i.produto_variante_id = OLD.id AND p.reserva_estado = 'ativa') THEN
    RAISE EXCEPTION 'Variacao com reserva ativa. Desative a variacao em vez de excluir.';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.proteger_variacao_reservada() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.proteger_variacao_reservada() TO service_role;
CREATE TRIGGER trg_proteger_variacao_reservada BEFORE DELETE ON public.produto_variantes
  FOR EACH ROW EXECUTE FUNCTION public.proteger_variacao_reservada();
