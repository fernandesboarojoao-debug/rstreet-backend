# Bloqueio do login

Três senhas incorretas da mesma origem dentro de 15 minutos bloqueiam novas
entradas dessa origem por 15 minutos. O prazo conta do terceiro erro e não se
estende a cada tentativa. Um login válido antes do bloqueio zera a contagem.
Sessões já autenticadas e o catálogo não são bloqueados.

Os contadores são transacionais, não contêm senhas nem IPs em texto e são
apagados após vencer, na próxima consulta. A API responde com 429 e
Retry-After durante o bloqueio; se não puder consultar o controle, não emite
uma sessão. O limite de volume por conexão é separado.

Antes de publicar o backend, aplique a migração 20261128122429_admin_login_limit
no projeto atual da loja. Com NODE_ENV=production (ou ADMIN_LOGIN_STORE=supabase),
todas as instâncias consultam o mesmo banco pelo backend. A operação só pode
ser executada pelo serviço. Uma falha não libera acesso nem troca o controle
para um contador local. SQLite fica reservado a desenvolvimento e testes.
A identificação da origem depende do proxy confiável da hospedagem.
