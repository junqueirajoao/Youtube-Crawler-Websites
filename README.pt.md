# YouTube Video Crawler

Um crawler Node.js que percorre uma lista de URLs e detecta se um vídeo específico do YouTube está incorporado em cada página. Utiliza uma estratégia de busca em duas camadas — requisições HTTP rápidas primeiro, navegador headless com stealth como fallback para páginas protegidas contra bots.

---

## Requisitos

- **Node.js** >= 18.0.0
- **npm**

---

## Instalação

```bash
npm install
npx playwright install chromium
```

---

## Estrutura do Projeto

```
Youtube-Crawler-Websites/
├── Crawler-Sites.js          # Script principal do crawler
├── package.json
├── urls/
│   ├── urls-list.txt         # Entrada: lista de URLs para rastrear (uma por linha)
│   └── urls-blog.txt         # Lista alternativa de URLs
└── resultados/
    └── resultados.jsonl      # Saída: resultados no formato JSON Lines
```

---

## Configuração

Todas as configurações são constantes no topo do [`Crawler-Sites.js`](Crawler-Sites.js):

| Constante | Padrão | Descrição |
|---|---|---|
| `INPUT_FILE` | `./urls/urls-list.txt` | Caminho para a lista de URLs de entrada |
| `OUTPUT_FILE` | `./resultados/resultados.jsonl` | Caminho para o arquivo de resultados |
| `VIDEO_ID` | `eiKEhwPUGY0` | ID do vídeo do YouTube a ser buscado |
| `CONCURRENCY` | `10` | Máximo de workers axios em paralelo |
| `TIMEOUT` | `15000` | Timeout da requisição em milissegundos |
| `RETRIES` | `2` | Número de tentativas em caso de erro de rede |
| `PLAYWRIGHT_CONCURRENCY` | `3` | Máximo de sessões headless simultâneas |

Para buscar um vídeo diferente, altere `VIDEO_ID` para o ID de 11 caracteres da URL do YouTube.  
Por exemplo, para `https://youtube.com/watch?v=eiKEhwPUGY0`, o ID é `eiKEhwPUGY0`.

---

## Uso

### Executar o crawler

```bash
npm start
# ou
node Crawler-Sites.js
```

### Formato do arquivo de entrada (`urls/urls-list.txt`)

Uma URL por linha. Linhas em branco e linhas iniciadas com `#` são ignoradas.

```
# Isto é um comentário — ignorado
https://www.exemplo.com.br/pagina-um
https://www.exemplo.com.br/pagina-dois
https://www.outrasite.com.br/artigo
```

URLs duplicadas são removidas automaticamente.

---

## Como Funciona

### Estratégia de busca em duas camadas

Cada URL passa por duas camadas, em ordem:

```
1. Axios (HTTP rápido)
       │
       ├─ HTTP 200 → analisa HTML → concluído
       │
       └─ HTTP 403 / 429 → passa para o Playwright
                               │
                               ├─ HTTP 200 → analisa HTML → concluído
                               │
                               └─ HTTP 403 → registra erro
```

**Camada 1 — Axios**  
Requisição HTTP rápida e leve. Envia um conjunto completo de headers stealth que imitam um Chrome real no Windows (User-Agent, `Sec-Fetch-*`, client hints `sec-ch-ua`, etc.). Trata redirecionamentos e descompressão automaticamente. Cobre a grande maioria das páginas.

**Camada 2 — Playwright + Plugin Stealth**  
Ativada automaticamente quando o Axios recebe HTTP 403 ou 429. Inicia um navegador Chromium headless real com o [`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) aplicado, que corrige mais de 10 vetores de fingerprinting:
- Remove `navigator.webdriver = true`
- Simula o objeto de runtime `chrome`
- Normaliza fingerprints de canvas, WebGL e áudio
- Falsifica APIs de permissão

Até `PLAYWRIGHT_CONCURRENCY` (3) contextos de navegador rodam em paralelo. Uma única instância do navegador é reutilizada em todas as chamadas de fallback e encerrada corretamente ao final do crawl.

### Detecção do vídeo

O crawler busca no HTML completo de cada página pelo ID do vídeo alvo usando cinco padrões regex:

| Tipo de padrão | Exemplo de correspondência |
|---|---|
| `youtube-watch` | `youtube.com/watch?v=VIDEO_ID` |
| `youtube-embed` | `youtube.com/embed/VIDEO_ID` |
| `youtube-nocookie` | `youtube-nocookie.com/embed/VIDEO_ID` |
| `youtu-be` | `youtu.be/VIDEO_ID` |
| `id` | `VIDEO_ID` isolado em qualquer parte do HTML |

Correspondências duplicadas são removidas antes do registro.

---

## Formato de Saída

Os resultados são gravados em `resultados/resultados.jsonl` no formato **JSON Lines** — um objeto JSON por linha.

### Vídeo encontrado
```json
{
  "url": "https://www.exemplo.com.br/pagina",
  "finalUrl": "https://www.exemplo.com.br/pagina",
  "status": 200,
  "found": true,
  "matches": [
    { "type": "youtube-embed", "value": "youtube.com/embed/eiKEhwPUGY0" }
  ]
}
```

### Página carregada, vídeo não encontrado
```json
{
  "url": "https://www.exemplo.com.br/pagina",
  "finalUrl": "https://www.exemplo.com.br/pagina",
  "status": 200,
  "found": false,
  "matches": []
}
```

### Página bloqueada ou com erro
```json
{
  "url": "https://www.exemplo.com.br/protegida",
  "found": false,
  "status": 403,
  "matches": [],
  "error": "HTTP 403"
}
```

### Referência dos campos

| Campo | Tipo | Descrição |
|---|---|---|
| `url` | string | URL original do arquivo de entrada |
| `finalUrl` | string | URL após redirecionamentos (pode diferir de `url`) |
| `status` | number | Código HTTP final |
| `found` | boolean | `true` se o ID do vídeo foi detectado |
| `matches` | array | Todas as ocorrências encontradas, com tipo e valor bruto |
| `error` | string | Presente apenas quando a requisição falhou |

---

## Saída no Console

```
======================================
 YouTube Video Crawler
======================================
Vídeo: eiKEhwPUGY0
Concorrência: 10 (Playwright: 3)
Timeout: 15000ms
Retries: 2

URLs encontradas: 745

[1/745] 0.1% [----] https://www.exemplo.com.br/pagina-um
[2/745] 0.3% [FOUND] https://www.exemplo.com.br/pagina-dois
  → [403] Switching to Playwright for https://www.exemplo.com.br/protegida
[3/745] 0.4% [ERROR] https://www.exemplo.com.br/protegida
```

Tags de status no log:

| Tag | Significado |
|---|---|
| `[FOUND]` | ID do vídeo detectado nesta página |
| `[----]` | Página carregada, vídeo não presente |
| `[ERROR]` | Requisição falhou (timeout, 403, etc.) |

---

## Reprocessar URLs com Erro

Para isolar as URLs que falharam e gravá-las novamente no arquivo de entrada para uma nova execução:

```bash
node -e "
import { readFileSync, writeFileSync } from 'fs';
const lines = readFileSync('resultados/resultados.jsonl', 'utf8').trim().split('\n');
const errors = lines.map(l => JSON.parse(l)).filter(r => r.error).map(r => r.url);
writeFileSync('urls/urls-list.txt', errors.join('\n') + '\n');
console.log(errors.length + ' URLs gravadas');
" --input-type=module
```

Ou com Python:

```bash
python3 -c "
import json
with open('resultados/resultados.jsonl') as f:
    urls = [json.loads(l)['url'] for l in f if json.loads(l).get('error')]
with open('urls/urls-list.txt', 'w') as f:
    f.write('\n'.join(urls) + '\n')
print(len(urls), 'URLs gravadas')
"
```

---

## Limitações Conhecidas

Sites protegidos pelo **Akamai Bot Manager**, **Cloudflare** ou WAFs corporativos similares podem continuar retornando 403 mesmo após o fallback com Playwright stealth. Esses sistemas fazem fingerprinting no nível do handshake TLS e do IP/rede, o que não pode ser contornado por nenhuma ferramenta local. Para rastrear essas páginas, seria necessário um **serviço de proxy residencial** (ex.: Bright Data, Oxylabs, Smartproxy).
