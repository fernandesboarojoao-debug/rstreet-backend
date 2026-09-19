# Implantacao segura das correcoes de auditoria

Estas alteracoes ainda nao foram publicadas. A reserva de estoque fica desligada por padrao ate que o fluxo real de teste do Mercado Pago seja concluido.

## O que foi corrigido

- Consulta de pedido por e-mail sem curingas que poderiam expor outro pedido.
- Edicao atomica de variacoes, preservando IDs, fotos e estoque atualizado por vendas concorrentes.
- Conferencia server-side de produto, variacao, estoque, preco, frete, total, moeda e vinculo do pagamento.
- Webhooks antigos nao rebaixam um pedido pago e pagamentos de outra tentativa nao alteram o pedido correto.
- Carrinho, checkout e gaveta nao apagam mudancas feitas em outra aba.
- Avaliacoes paginadas com total e media calculados sobre todas as avaliacoes aprovadas.
- Checkout novo limitado a cartao, debito e Pix. O Checkout Pro ainda pode mostrar saldo da conta Mercado Pago dentro do ambiente do proprio Mercado Pago; a API de Preferences nao permite excluir essa opcao.
- Reserva transacional de estoque preparada para impedir duas compras da ultima unidade.

## Ordem obrigatoria de implantacao

1. Criar um backup ou ponto de restauracao do banco.
2. Aplicar `supabase/migrations/20260916191122_audit_integrity.sql`.
3. Publicar o backend e o frontend com `STOCK_RESERVATIONS_ENABLED=false`.
4. Validar no ambiente de teste: cartao aprovado, cartao recusado, Pix aprovado, Pix pendente, cancelamento, webhook repetido e ultima unidade concorrente.
5. Aplicar `supabase/migrations/20260917185850_checkout_reservations.sql`.
6. Repetir os testes com a reserva ainda desligada e conferir logs e estoque.
7. Definir `STOCK_RESERVATIONS_ENABLED=true` no backend somente depois dos testes e publicar novamente.
8. Acompanhar os primeiros pedidos e conferir `reserva_estado`, `reserva_expira_em`, status do pedido e estoque.

Nao publique um backend que chama os novos RPCs antes da primeira migracao. Nao volte a funcao antiga `finalizar_pedido_pago` depois de ativar reservas, pois ela descontaria novamente um estoque que ja foi reservado.

## Comportamento da reserva

- A reserva dura 30 minutos e a preferencia do Mercado Pago recebe o mesmo vencimento.
- Uma margem adicional de 5 minutos evita liberar estoque durante atraso de processamento.
- Pagamentos aprovados consomem a reserva sem descontar estoque duas vezes.
- Pix ou cartao ainda pendente mantem o estoque reservado ate existir um estado terminal verificavel.
- Se a API do Mercado Pago estiver indisponivel ou retornar dados incompletos, o sistema mantem a reserva. Ele nunca libera estoque por suposicao.
- Um pagamento verdadeiro que aparecer depois da liberacao tenta alocar o estoque novamente. Se outra venda ja levou a ultima unidade, o pedido fica para tratamento manual em vez de gerar estoque negativo.
- O reconciliador roda no processo do backend. Se o Render estiver suspenso, reservas vencidas so serao revistas quando o processo voltar a executar.

## Verificacoes antes de ativar

- `SUPABASE_KEY` deve ser a chave secreta usada apenas no backend; nunca no frontend.
- `MP_WEBHOOK_SECRET` deve estar configurado. Sem ele, o backend ainda consulta a API do Mercado Pago, mas a assinatura direta do webhook nao e validada.
- O status financeiro de pedidos com checkout Mercado Pago deve vir do webhook. O admin continua podendo alterar envio e rastreio.
- Nao fazer um pagamento real durante a validacao. Usar comprador, cartoes e credenciais de teste do Mercado Pago.

## Testes locais executados

- 27 testes de backend: checkout, webhooks, privacidade, seguranca, admin, banco, variacoes e reservas concorrentes.
- 7 testes de frontend: carrinho, checkout, outra aba, gaveta, busca de categoria do Merchant e carregamento tardio do admin.
- Validacao sintatica de 10 arquivos HTML e 9 scripts.
- Conferencia visual do checkout em 390 x 844 e 1440 x 900, sem erros no console.

## Pendencias que exigem ambiente externo

- Executar pagamentos no sandbox do Mercado Pago e confirmar webhooks reais.
- Aplicar as duas migracoes no Supabase apenas durante a implantacao autorizada.
- Ligar a reserva somente depois desses testes.
- Configurar IDs reais de Google Analytics e Meta Pixel quando estiverem disponiveis.
- Otimizar imagens pesadas e completar metadados sociais por produto em uma etapa separada.
