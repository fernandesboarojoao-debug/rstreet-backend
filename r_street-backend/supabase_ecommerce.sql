-- ================================================
-- R Street — Tabelas de E-commerce
-- Execute no Supabase SQL Editor
-- ================================================

-- TABELA: clientes (cache dos dados do comprador)
CREATE TABLE IF NOT EXISTS clientes (
  id         BIGSERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  email      TEXT NOT NULL,
  telefone   TEXT,
  cpf        TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes(email);

-- TABELA: pedidos
CREATE TABLE IF NOT EXISTS pedidos (
  id                   BIGSERIAL PRIMARY KEY,

  -- Cliente
  cliente_nome         TEXT NOT NULL,
  cliente_email        TEXT NOT NULL,
  cliente_telefone     TEXT,
  cliente_cpf          TEXT,

  -- Endereço
  endereco_cep         TEXT,
  endereco_rua         TEXT,
  endereco_numero      TEXT,
  endereco_complemento TEXT,
  endereco_bairro      TEXT,
  endereco_cidade      TEXT,
  endereco_estado      TEXT,

  -- Frete
  frete_tipo           TEXT,
  frete_valor          NUMERIC(10,2) DEFAULT 0,

  -- Valores
  subtotal             NUMERIC(10,2) NOT NULL DEFAULT 0,
  total                NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Pagamento
  metodo_pagamento     TEXT,
  status               TEXT NOT NULL DEFAULT 'pendente',
  mp_preference_id     TEXT,
  mp_payment_id        TEXT,

  -- Datas
  pago_em              TIMESTAMPTZ,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_status     ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_email      ON pedidos(cliente_email);
CREATE INDEX IF NOT EXISTS idx_pedidos_mp_payment ON pedidos(mp_payment_id);

-- TABELA: itens do pedido
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

-- TRIGGER: atualiza atualizado_em dos pedidos
CREATE OR REPLACE FUNCTION update_pedidos_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN NEW.atualizado_em = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pedidos_atualizado
  BEFORE UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION update_pedidos_atualizado_em();

-- POLÍTICAS DE SEGURANÇA (RLS)
ALTER TABLE pedidos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE itens_pedido ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes     ENABLE ROW LEVEL SECURITY;

-- Backend tem acesso total (usa service role key)
CREATE POLICY "Backend total pedidos"      ON pedidos      USING (true) WITH CHECK (true);
CREATE POLICY "Backend total itens"        ON itens_pedido USING (true) WITH CHECK (true);
CREATE POLICY "Backend total clientes"     ON clientes     USING (true) WITH CHECK (true);
