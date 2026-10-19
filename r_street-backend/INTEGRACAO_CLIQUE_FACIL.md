# Preparacao da integracao com Clique Facil

O admin exporta os itens de um pedido pago em JSON. Este e um formato
intermediario da R Street, nao o formato homologado pelo Clique Facil.
Nao existe sincronizacao automatica nem baixa de estoque fisico neste recurso.

## Como obter um exemplo

No admin, abra Pedidos, selecione um pedido pago e use Exportar itens (JSON).
O arquivo inclui referencia, codigo do produto e da variante no site, cor,
tamanho e quantidade. Nao inclui nome, documento, endereco ou e-mail do cliente.

`evento_id` identifica a venda de forma estavel. O consumidor deve guardar esse
identificador para impedir duas baixas quando receber o mesmo arquivo novamente.

## Confirmar com o desenvolvedor

- Formato e codificacao do arquivo: JSON, CSV, TXT ou outro.
- Codigo usado no Clique Facil para produto, cor e tamanho; referencia sozinha
  pode nao identificar uma variante. E necessario mapear os dois sistemas.
- Qual sistema e a fonte principal do estoque e como vendas fisicas voltam ao site.
- Pasta monitorada, computador/servidor responsavel e funcionamento fora do horario.
- Confirmacao de leitura, erro, falta de estoque e politica de novas tentativas.
- Tratamento de cancelamento, devolucao e reembolso.

O futuro conector deve escrever primeiro em arquivo temporario e renomear de forma
atomica, autenticar transferencias, limitar permissoes da pasta e registrar cada
confirmacao. Nao compartilhar chaves do banco nem expor essa pasta na internet.

Somente depois de homologar esses pontos sera seguro ativar a sincronizacao.
