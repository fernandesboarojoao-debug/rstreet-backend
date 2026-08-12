-- Finaliza um pagamento e baixa todo o estoque em uma unica transacao.
-- A funcao so pode ser executada pelo backend com service_role.
ALTER TABLE public.produto_variantes
  ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION public.finalizar_pedido_pago(
  p_pedido_id BIGINT,
  p_payment_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pedido public.pedidos%ROWTYPE;
BEGIN
  IF p_pedido_id IS NULL OR p_pedido_id <= 0 OR btrim(COALESCE(p_payment_id, '')) = '' THEN
    RAISE EXCEPTION 'Pedido ou pagamento invalido.';
  END IF;

  SELECT *
    INTO v_pedido
    FROM public.pedidos
   WHERE id = p_pedido_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido nao encontrado.';
  END IF;

  IF v_pedido.status IN ('pago', 'reembolsado', 'estornado') THEN
    RETURN jsonb_build_object('status', v_pedido.status, 'ja_processado', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.itens_pedido WHERE pedido_id = p_pedido_id) THEN
    RAISE EXCEPTION 'Pedido sem itens.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.itens_pedido
     WHERE pedido_id = p_pedido_id
       AND (produto_id IS NULL OR quantidade IS NULL OR quantidade <= 0)
  ) THEN
    RAISE EXCEPTION 'Item invalido no pedido.';
  END IF;

  -- Trava produtos e variacoes sempre na mesma ordem para evitar concorrencia
  -- entre dois retornos/webhooks do mesmo pagamento.
  PERFORM p.id
    FROM public.produtos p
   WHERE p.id IN (
     SELECT DISTINCT produto_id
       FROM public.itens_pedido
      WHERE pedido_id = p_pedido_id
   )
   ORDER BY p.id
   FOR UPDATE;

  PERFORM v.id
    FROM public.produto_variantes v
   WHERE v.id IN (
     SELECT DISTINCT produto_variante_id
       FROM public.itens_pedido
      WHERE pedido_id = p_pedido_id
        AND produto_variante_id IS NOT NULL
   )
   ORDER BY v.id
   FOR UPDATE;

  IF EXISTS (
    WITH requisitado AS (
      SELECT produto_id, produto_variante_id, SUM(quantidade)::INTEGER AS quantidade
        FROM public.itens_pedido
       WHERE pedido_id = p_pedido_id
       GROUP BY produto_id, produto_variante_id
    )
    SELECT 1
      FROM requisitado r
      LEFT JOIN public.produtos p ON p.id = r.produto_id
     WHERE p.id IS NULL OR p.ativo = false
  ) THEN
    RAISE EXCEPTION 'Produto indisponivel no pedido.';
  END IF;

  IF EXISTS (
    WITH requisitado AS (
      SELECT produto_id, produto_variante_id, SUM(quantidade)::INTEGER AS quantidade
        FROM public.itens_pedido
       WHERE pedido_id = p_pedido_id
         AND produto_variante_id IS NOT NULL
       GROUP BY produto_id, produto_variante_id
    )
    SELECT 1
      FROM requisitado r
      LEFT JOIN public.produto_variantes v
        ON v.id = r.produto_variante_id
       AND v.produto_id = r.produto_id
     WHERE v.id IS NULL OR v.ativo = false OR v.estoque < r.quantidade
  ) THEN
    RAISE EXCEPTION 'Estoque insuficiente ou variacao indisponivel no pedido.';
  END IF;

  IF EXISTS (
    WITH requisitado AS (
      SELECT produto_id, SUM(quantidade)::INTEGER AS quantidade
        FROM public.itens_pedido
       WHERE pedido_id = p_pedido_id
         AND produto_variante_id IS NULL
       GROUP BY produto_id
    )
    SELECT 1
      FROM requisitado r
      JOIN public.produtos p ON p.id = r.produto_id
     WHERE p.estoque < r.quantidade
  ) THEN
    RAISE EXCEPTION 'Estoque insuficiente no pedido.';
  END IF;

  WITH requisitado AS (
    SELECT produto_id, produto_variante_id, SUM(quantidade)::INTEGER AS quantidade
      FROM public.itens_pedido
     WHERE pedido_id = p_pedido_id
       AND produto_variante_id IS NOT NULL
     GROUP BY produto_id, produto_variante_id
  )
  UPDATE public.produto_variantes v
     SET estoque = v.estoque - r.quantidade,
         atualizado_em = NOW()
    FROM requisitado r
   WHERE v.id = r.produto_variante_id
     AND v.produto_id = r.produto_id;

  WITH requisitado AS (
    SELECT produto_id, SUM(quantidade)::INTEGER AS quantidade
      FROM public.itens_pedido
     WHERE pedido_id = p_pedido_id
     GROUP BY produto_id
  )
  UPDATE public.produtos p
     SET estoque = GREATEST(0, p.estoque - r.quantidade),
         atualizado_em = NOW()
    FROM requisitado r
   WHERE p.id = r.produto_id;

  UPDATE public.pedidos
     SET status = 'pago',
         mp_payment_id = p_payment_id,
         pago_em = COALESCE(pago_em, NOW()),
         atualizado_em = NOW()
   WHERE id = p_pedido_id;

  RETURN jsonb_build_object('status', 'pago', 'ja_processado', false);
END;
$$;

REVOKE ALL ON FUNCTION public.finalizar_pedido_pago(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalizar_pedido_pago(BIGINT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.finalizar_pedido_pago(BIGINT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_pedido_pago(BIGINT, TEXT) TO service_role;
