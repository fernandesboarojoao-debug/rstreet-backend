-- ================================================
-- R Street - Tabelas de E-commerce
-- Execute no Supabase SQL Editor
-- ================================================

CREATE TABLE IF NOT EXISTS clientes (
  id         BIGSERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  email      TEXT NOT NULL,
  telefone   TEXT,
  cpf        TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes(email);

CREATE TABLE IF NOT EXISTS pedidos (
  id                   BIGSERIAL PRIMARY KEY,
  cliente_nome         TEXT NOT NULL,
  cliente_email        TEXT NOT NULL,
  cliente_telefone     TEXT,
  cliente_cpf          TEXT,
  endereco_cep         TEXT,
  endereco_rua         TEXT,
  endereco_numero      TEXT,
  endereco_complemento TEXT,
  endereco_bairro      TEXT,
  endereco_cidade      TEXT,
  endereco_estado      TEXT,
  frete_tipo           TEXT,
  frete_valor          NUMERIC(10,2) DEFAULT 0,
  subtotal             NUMERIC(10,2) NOT NULL DEFAULT 0,
  total                NUMERIC(10,2) NOT NULL DEFAULT 0,
  metodo_pagamento     TEXT,
  status               TEXT NOT NULL DEFAULT 'pendente',
  mp_preference_id     TEXT,
  mp_payment_id        TEXT,
  pago_em              TIMESTAMPTZ,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_status     ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_email      ON pedidos(cliente_email);
CREATE INDEX IF NOT EXISTS idx_pedidos_mp_payment ON pedidos(mp_payment_id);

CREATE TABLE IF NOT EXISTS itens_pedido (
  id              BIGSERIAL PRIMARY KEY,
  pedido_id       BIGINT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id      BIGINT,
  nome_produto    TEXT NOT NULL,
  quantidade      INTEGER NOT NULL DEFAULT 1,
  preco_unitario  NUMERIC(10,2) NOT NULL,
  total           NUMERIC(10,2) NOT NULL,
  tamanho         TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_itens_pedido_id ON itens_pedido(pedido_id);

CREATE OR REPLACE FUNCTION update_pedidos_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pedidos_atualizado ON pedidos;
CREATE TRIGGER trg_pedidos_atualizado
  BEFORE UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION update_pedidos_atualizado_em();

ALTER TABLE pedidos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE itens_pedido ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Backend total pedidos" ON pedidos;
DROP POLICY IF EXISTS "Backend total itens" ON itens_pedido;
DROP POLICY IF EXISTS "Backend total clientes" ON clientes;
DROP POLICY IF EXISTS "Backend total produtos" ON produtos;
DROP POLICY IF EXISTS "Public read active produtos" ON produtos;

CREATE POLICY "Backend total pedidos"
  ON pedidos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Backend total itens"
  ON itens_pedido FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Backend total clientes"
  ON clientes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Backend total produtos"
  ON produtos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Public read active produtos"
  ON produtos FOR SELECT TO anon, authenticated
  USING (ativo = true);

-- Atualizacoes usadas pelo site atual
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS envio_status TEXT,
  ADD COLUMN IF NOT EXISTS codigo_rastreio TEXT,
  ADD COLUMN IF NOT EXISTS rastreio_url TEXT;

ALTER TABLE itens_pedido
  ADD COLUMN IF NOT EXISTS produto_variante_id BIGINT,
  ADD COLUMN IF NOT EXISTS cor TEXT;

CREATE TABLE IF NOT EXISTS produto_variantes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  cor TEXT NOT NULL CHECK (btrim(cor) <> ''),
  tamanho TEXT NOT NULL CHECK (btrim(tamanho) <> ''),
  estoque INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
  preco NUMERIC(10,2),
  preco_antigo NUMERIC(10,2),
  imagem_url TEXT,
  imagens TEXT[] DEFAULT '{}',
  videos TEXT[] DEFAULT '{}',
  cor_hex TEXT,
  ordem INTEGER DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE produto_variantes
  ADD COLUMN IF NOT EXISTS preco NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS preco_antigo NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS imagem_url TEXT,
  ADD COLUMN IF NOT EXISTS imagens TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS videos TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cor_hex TEXT,
  ADD COLUMN IF NOT EXISTS ordem INTEGER DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS produto_variantes_produto_cor_tamanho_unique
  ON produto_variantes (produto_id, lower(btrim(cor)), lower(btrim(tamanho)));

CREATE INDEX IF NOT EXISTS idx_produto_variantes_produto_id ON produto_variantes(produto_id);
CREATE INDEX IF NOT EXISTS idx_produto_variantes_produto_cor
  ON produto_variantes (produto_id, lower(btrim(cor)));
CREATE INDEX IF NOT EXISTS idx_itens_pedido_produto_variante_id ON itens_pedido(produto_variante_id);

ALTER TABLE produto_variantes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Produto variantes leitura publica ativas" ON produto_variantes;
CREATE POLICY "Produto variantes leitura publica ativas"
  ON produto_variantes FOR SELECT TO anon, authenticated
  USING (
    ativo = true
    AND EXISTS (
      SELECT 1 FROM produtos p
      WHERE p.id = produto_variantes.produto_id
        AND p.ativo = true
    )
  );
