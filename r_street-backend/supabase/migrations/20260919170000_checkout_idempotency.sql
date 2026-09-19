-- A repeated checkout submission reuses the same order and Mercado Pago URL.
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS checkout_token text;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS checkout_fingerprint text;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mp_init_point text;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mp_sandbox_init_point text;

CREATE UNIQUE INDEX IF NOT EXISTS pedidos_checkout_token_unique
  ON public.pedidos(checkout_token)
  WHERE checkout_token IS NOT NULL;

ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_checkout_token_formato;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_checkout_token_formato
  CHECK (checkout_token IS NULL OR checkout_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_checkout_fingerprint_formato;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_checkout_fingerprint_formato
  CHECK (checkout_fingerprint IS NULL OR checkout_fingerprint ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.pedidos.checkout_token IS 'UUID idempotente gerado pelo checkout para impedir pedidos duplicados.';
COMMENT ON COLUMN public.pedidos.checkout_fingerprint IS 'SHA-256 do conteudo validado da tentativa de checkout.';
