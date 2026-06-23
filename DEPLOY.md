# Observatório de Tecnologia Global — guia de implantação

Você tem duas formas de usar os arquivos. A **1** é instantânea; a **2** liga os recursos novos (notícias ao vivo, IA e fornecedores compartilhados).

## 1) Só o frontend (já funciona hoje)
O `index.html` é autossuficiente e degrada com elegância: sem backend, ele continua mostrando feiras, áreas (cópia embutida), fornecedores (catálogo do seu `fornecedores.js` + os que o usuário salva no navegador), cotação ao vivo, conversor, idiomas PT/EN/ES e a busca em linguagem natural (modo local). Com o backend no ar, feiras e áreas passam a vir do catálogo editável em `/admin`.

Mantenha no mesmo diretório, como já está hoje:
```
index.html
fornecedores.js        (o seu, sem mudanças)
manifest.json          (o seu)
sw.js                  (o seu)
icon-192.png           (o seu)
```
É só substituir o `index.html` antigo pelo novo e publicar como hoje. Notícias e IA ficam em modo local/atalho até você ligar o backend.

## 2) Frontend + backend no Render (libera notícias, IA e fornecedores compartilhados)
O `server.js` serve o site **e** as APIs no mesmo serviço. No frontend, deixe `const API_BASE = "";` (mesma origem) — já está assim.

Estrutura do repositório:
```
server.js
package.json
index.html
admin.html             (painel de edição do catálogo)
catalog.seed.json      (catálogo inicial de feiras e áreas)
fornecedores.js
manifest.json
sw.js
icon-192.png
```

No Render, crie um **Web Service** apontando para o repositório:
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** Node 18+

Variáveis de ambiente (aba *Environment*):
- `ANTHROPIC_API_KEY` — sua chave (necessária só para o resumo por IA em `/api/ask`).
- `ANTHROPIC_MODEL` — opcional. Padrão: `claude-haiku-4-5-20251001` (barato e rápido). Pode trocar por `claude-sonnet-4-6` para respostas mais ricas.
- `DATA_DIR` — opcional. Caminho de gravação dos dados (fornecedores e catálogo de feiras/áreas).
- `ADMIN_PASSWORD` — senha do painel `/admin` que edita feiras e áreas. **Sem ela, o `/admin` fica somente-leitura e nada pode ser salvo.** Defina uma senha forte aqui para liberar a edição.

### Importante sobre persistência
No plano free do Render o disco é **efêmero**: a cada deploy/restart os arquivos gravados em `DATA_DIR` zeram (fornecedores em `suppliers.json` e o catálogo editado em `catalog.json`). Como funciona o catálogo: o backend lê `DATA_DIR/catalog.json` se existir; senão, cai no `catalog.seed.json` do repositório. Ou seja, mesmo que um deploy apague suas edições, o site **nunca fica vazio** — ele volta para a semente. Para tornar as edições duráveis, escolha uma destas opções:
- monte um **Render Disk** e aponte `DATA_DIR` para o ponto de montagem (ex.: `/var/data`) — assim `catalog.json` sobrevive a deploys; ou
- no `/admin`, clique em **Exportar JSON**, e substitua o `catalog.seed.json` do repositório por esse arquivo — assim a sua versão vira a nova semente (e some a dependência de disco); ou
- troque as funções `readCatalog/writeCatalog` (e `readSuppliers/writeSuppliers`) no `server.js` por um banco (Postgres no próprio Render, ou Supabase). A interface já está isolada para facilitar.

## Editar feiras e áreas (painel /admin)
Acesse `https://seusite/admin`. Se `ADMIN_PASSWORD` estiver definida, o painel pede a senha e libera a edição; se não, ele explica que falta configurar. Lá você adiciona, edita e remove feiras (nome, datas de início/fim, exibição, local, área, URL) e áreas (nomes PT/EN/ES, intensidade, estatística, crescimento %, etc.) em formulários, e clica em **Salvar** — as mudanças entram no site e no painel da TV na hora, sem republicar. O status das feiras (vai ocorrer / agora / encerrada) e a contagem regressiva continuam sendo calculados sozinhos a partir das datas. O frontend busca o catálogo do backend ao carregar; se o backend estiver fora, usa a cópia embutida no `index.html` como reserva.

## Endpoints do backend
- `GET  /api/health` — status (IA, push, contagem de fornecedores, feiras, áreas e se o admin está configurado).
- `GET  /api/suppliers` · `POST /api/suppliers` — catálogo de fornecedores compartilhado.
- `GET  /api/catalog` — feiras + áreas (público). `POST /api/catalog` — salva o catálogo (exige header `x-admin-pass` igual a `ADMIN_PASSWORD`).
- `POST /api/admin/verify` · `GET /api/admin/status` — login e status do painel `/admin`.
- `GET  /api/news?area=...&lang=pt` — notícias por área (RSS do Google News → JSON, cache 15 min).
- `GET  /api/fx` — cotação com cache de 20 s (opcional; o frontend já busca direto no AwesomeAPI).
- `POST /api/ask` — resumo por IA usando sua chave.
- `POST /api/briefing` — briefing proativo do **modo painel** (TV), gerado por IA. Recebe o contexto do frontend (próximas feiras + áreas) e responde com um texto curto de manchete. **Cache em memória de 20 min por idioma**, então várias TVs compartilham uma única geração e o custo fica mínimo. Sem IA configurada, retorna 503 e o frontend usa um briefing local automático.

## Modo painel (TV na parede)
O site tem um modo de exibição em tela cheia, pensado para sinalização digital (uma TV na parede que só é olhada, sem teclado). Nesse modo a IA é **proativa**: em vez de esperar uma pergunta, ela escreve sozinha um briefing que entra em rotação na tela.

**Como ligar na TV:** abra `https://seusite/?tv` no navegador da TV e coloque em tela cheia. O estado fica salvo na URL, então se a TV reiniciar e recarregar a página, ela volta direto para o painel. No site normal também há o botão **"Modo painel"** no cabeçalho. Para sair: tecla **Esc** ou mover o mouse (aparece o botão "Sair").

O painel rotaciona 4 cenas em loop (~14 s cada):
1. **Briefing** — texto curto gerado pela IA via `/api/briefing` (com 3 fatos-chave). Se o backend/IA estiver fora, cai num briefing automático montado a partir dos próprios dados — a tela nunca fica vazia.
2. **Câmbio ao vivo** — USD/EUR/CNY em números grandes.
3. **Próximas feiras** — as 5 mais próximas, com contagem regressiva.
4. **Áreas em maior alta** — ranking por crescimento.

Outros detalhes: relógio ao vivo, ticker de feiras no rodapé, **Screen Wake Lock** (impede a TV de dormir), cursor escondido e os 3 idiomas. No rodapé há um **QR code** apontando para a versão interativa (para abrir no celular). O QR é gerado **localmente no próprio navegador** (biblioteca embutida no `index.html`), então funciona mesmo sem internet — não depende de serviço externo.

## Próxima iteração (não incluída ainda)
Notificações push (Web Push) para avisar quando uma feira está chegando. O botão "Ativar avisos" foi removido do frontend, mas o `server.js` ainda tem o endpoint de inscrição (`/api/push/subscribe`) como ponto de partida; falta gerar chaves VAPID (`npx web-push generate-vapid-keys`), reintroduzir a permissão no app e o envio agendado. Posso montar isso quando quiser.
