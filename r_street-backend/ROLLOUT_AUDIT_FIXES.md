# Implantacao segura das correcoes de auditoria

As correcoes de frontend, backend e banco foram publicadas inicialmente em 19/09/2026. As migracoes abaixo ja foram aplicadas no Supabase. A reserva de estoque agora fica ativa por padrao para impedir duas vendas da ultima unidade.

## O que foi corrigido

- Consulta de pedido por e-mail sem curingas que poderiam expor outro pedido.
- Edicao atomica de variacoes, preservando IDs, fotos e estoque atualizado por vendas concorrentes.
- Conferencia server-side de produto, variacao, estoque, preco, frete, total, moeda e vinculo do pagamento.
- Webhooks antigos nao rebaixam um pedido pago e pagamentos de outra tentativa nao alteram o pedido correto.
- Carrinho, checkout e gaveta nao apagam mudancas feitas em outra aba.
- Avaliacoes paginadas com total e media calculados sobre todas as avaliacoes aprovadas.
- Checkout novo limitado a cartao, debito e Pix. O Checkout Pro ainda pode mostrar saldo da conta Mercado Pago dentro do ambiente do proprio Mercado Pago; a API de Preferences nao permite excluir essa opcao.
- Reserva transacional de estoque preparada para impedir duas compras da ultima unidade.

## Estado atual da implantacao

1. `supabase/migrations/20260916191122_audit_integrity.sql`: aplicada.
2. `supabase/migrations/20260917185850_checkout_reservations.sql`: aplicada.
3. Backend e frontend: reserva ativada por padrao.
4. Testes automatizados, validacao sintatica e verificacoes de producao sem pagamento real: concluidos.
5. Testes automatizados de concorrencia, repeticao de webhook, liberacao e consumo de reserva: concluidos.
6. `STOCK_RESERVATIONS_DISABLED=true`: usar apenas como reversao emergencial e temporaria.

Nao volte a funcao antiga `finalizar_pedido_pago` depois de ativar reservas, pois ela descontaria novamente um estoque que ja foi reservado.

## Acompanhamento da reserva

1. Acompanhar os primeiros pedidos, conferindo `reserva_estado`, `reserva_expira_em`, status e estoque.
2. Validar periodicamente no sandbox: cartao aprovado, cartao recusado, Pix aprovado, Pix pendente, cancelamento e webhook repetido.
3. Em uma emergencia comprovada, definir `STOCK_RESERVATIONS_DISABLED=true`, publicar o backend e investigar antes de reativar.

## Comportamento da reserva

- A reserva dura 30 minutos e a preferencia do Mercado Pago recebe o mesmo vencimento.
- Uma margem adicional de 5 minutos evita liberar estoque durante atraso de processamento.
- Pagamentos aprovados consomem a reserva sem descontar estoque duas vezes.
- Pix ou cartao ainda pendente mantem o estoque reservado ate existir um estado terminal verificavel.
- Se a API do Mercado Pago estiver indisponivel ou retornar dados incompletos, o sistema mantem a reserva. Ele nunca libera estoque por suposicao.
- Um pagamento verdadeiro que aparecer depois da liberacao tenta alocar o estoque novamente. Se outra venda ja levou a ultima unidade, o pedido fica para tratamento manual em vez de gerar estoque negativo.
- O reconciliador roda no processo do backend. Se o Render estiver suspenso, reservas vencidas so serao revistas quando o processo voltar a executar.

## Verificacoes operacionais

- `SUPABASE_KEY` deve ser a chave secreta usada apenas no backend; nunca no frontend.
- `MP_WEBHOOK_SECRET` deve estar configurado. Sem ele, o backend ainda consulta a API do Mercado Pago, mas a assinatura direta do webhook nao e validada.
- O status financeiro de pedidos com checkout Mercado Pago deve vir do webhook. O admin continua podendo alterar envio e rastreio.
- Nao fazer um pagamento real durante a validacao. Usar comprador, cartoes e credenciais de teste do Mercado Pago.

## Testes locais executados

- 34 testes de backend: checkout, webhooks, privacidade, seguranca, admin, banco, variacoes, notificacoes e reservas concorrentes.
- 11 testes de frontend: carrinho, checkout, outra aba, gaveta, APIs publicas, Merchant e carregamento tardio do admin.
- Validacao sintatica de 11 arquivos HTML e 9 scripts.
- Conferencia visual do checkout em 390 x 844 e 1440 x 900, sem erros no console.

## Pendencias que exigem ambiente externo

- Executar pagamentos no sandbox do Mercado Pago e confirmar webhooks reais.
- Configurar IDs reais de Google Analytics e Meta Pixel quando estiverem disponiveis.
- Configurar Resend e verificar o dominio de envio para ativar os avisos automaticos por e-mail.
