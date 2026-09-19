-- Apply before deploying the matching backend. Existing rows are never deleted.
CREATE OR REPLACE FUNCTION public.salvar_variantes_seguras(p_produto_id bigint, p_variantes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  item jsonb;
  atual public.produto_variantes%ROWTYPE;
  salvo bigint;
  mantidos bigint[] := '{}';
  novo_estoque integer;
BEGIN
  IF jsonb_typeof(p_variantes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_variantes) > 1000 THEN
    RAISE EXCEPTION 'Lista de variacoes invalida.';
  END IF;
  PERFORM id FROM public.produtos WHERE id = p_produto_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Produto nao encontrado.'; END IF;
  PERFORM id FROM public.produto_variantes WHERE produto_id = p_produto_id ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_variantes) v
    GROUP BY lower(btrim(v->>'cor')), upper(btrim(v->>'tamanho')) HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Combinacao duplicada.'; END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_variantes) LOOP
    IF coalesce(btrim(item->>'cor'), '') = '' OR coalesce(btrim(item->>'tamanho'), '') = '' THEN
      RAISE EXCEPTION 'Cor e tamanho obrigatorios.';
    END IF;
    atual := NULL;
    IF item->>'id' IS NOT NULL THEN
      SELECT * INTO atual FROM public.produto_variantes WHERE id = (item->>'id')::bigint AND produto_id = p_produto_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Variacao alterada. Reabra o produto.'; END IF;
    ELSE
      SELECT * INTO atual FROM public.produto_variantes
       WHERE produto_id = p_produto_id AND lower(btrim(cor)) = lower(btrim(item->>'cor'))
         AND upper(btrim(tamanho)) = upper(btrim(item->>'tamanho')) LIMIT 1;
    END IF;
    novo_estoque := (item->>'estoque')::integer;
    IF novo_estoque IS NULL OR novo_estoque < 0 THEN RAISE EXCEPTION 'Estoque invalido.'; END IF;
    IF atual.id IS NOT NULL THEN
      IF atual.id = ANY(mantidos) THEN RAISE EXCEPTION 'Variacao duplicada.'; END IF;
      IF item->>'estoque_original' IS NULL THEN RAISE EXCEPTION 'Reabra o produto antes de salvar.'; END IF;
      IF novo_estoque = (item->>'estoque_original')::integer THEN
        novo_estoque := atual.estoque;
      ELSIF atual.estoque <> (item->>'estoque_original')::integer THEN
        RAISE EXCEPTION 'Estoque mudou durante a edicao. Reabra o produto.';
      END IF;
      UPDATE public.produto_variantes SET
        cor = item->>'cor', tamanho = item->>'tamanho', estoque = novo_estoque,
        ativo = coalesce((item->>'ativo')::boolean, true), preco = (item->>'preco')::numeric,
        preco_antigo = (item->>'preco_antigo')::numeric, imagem_url = item->>'imagem_url',
        imagens = ARRAY(SELECT jsonb_array_elements_text(item->'imagens')),
        videos = ARRAY(SELECT jsonb_array_elements_text(item->'videos')),
        cor_hex = item->>'cor_hex', ordem = coalesce((item->>'ordem')::integer, 0), atualizado_em = now()
      WHERE id = atual.id RETURNING id INTO salvo;
    ELSE
      INSERT INTO public.produto_variantes (produto_id, cor, tamanho, estoque, ativo, preco, preco_antigo, imagem_url, imagens, videos, cor_hex, ordem)
      VALUES (p_produto_id, item->>'cor', item->>'tamanho', novo_estoque,
        coalesce((item->>'ativo')::boolean, true), (item->>'preco')::numeric, (item->>'preco_antigo')::numeric,
        item->>'imagem_url', ARRAY(SELECT jsonb_array_elements_text(item->'imagens')),
        ARRAY(SELECT jsonb_array_elements_text(item->'videos')), item->>'cor_hex', coalesce((item->>'ordem')::integer, 0))
      RETURNING id INTO salvo;
    END IF;
    mantidos := array_append(mantidos, salvo);
  END LOOP;
  UPDATE public.produto_variantes SET ativo = false, atualizado_em = now()
   WHERE produto_id = p_produto_id AND NOT (id = ANY(mantidos)) AND ativo = true;
  IF EXISTS (SELECT 1 FROM public.produto_variantes WHERE produto_id = p_produto_id) THEN
    UPDATE public.produtos SET estoque = (
      SELECT coalesce(sum(estoque), 0) FROM public.produto_variantes WHERE produto_id = p_produto_id AND ativo = true
    ), atualizado_em = now() WHERE id = p_produto_id;
  END IF;
  RETURN (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY ordem, id), '[]')
    FROM public.produto_variantes v WHERE produto_id = p_produto_id AND id = ANY(mantidos));
END;
$$;
REVOKE ALL ON FUNCTION public.salvar_variantes_seguras(bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salvar_variantes_seguras(bigint, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.avaliacoes_paginadas(p_produto_id bigint, p_pagina integer DEFAULT 1)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'total', count(*), 'media', coalesce(avg(nota), 0),
    'pagina', greatest(1, p_pagina), 'por_pagina', 6,
    'avaliacoes', (SELECT coalesce(jsonb_agg(to_jsonb(page)), '[]') FROM (
      SELECT id, nome_cliente, nota, comentario, criado_em FROM public.avaliacoes_produtos
      WHERE produto_id = p_produto_id AND status = 'aprovada'
      ORDER BY criado_em DESC, id DESC LIMIT 6 OFFSET ((greatest(1, p_pagina)::bigint - 1) * 6)
    ) page)
  ) FROM public.avaliacoes_produtos WHERE produto_id = p_produto_id AND status = 'aprovada';
$$;
REVOKE ALL ON FUNCTION public.avaliacoes_paginadas(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.avaliacoes_paginadas(bigint, integer) TO service_role;
CREATE INDEX IF NOT EXISTS idx_metricas_eventos_variante ON public.metricas_eventos(produto_variante_id);
