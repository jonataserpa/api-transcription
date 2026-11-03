# API Transcription

Aplicação de terminal que captura o monitor de áudio do headset no Linux, envia blocos a um modelo com entrada de áudio no OpenRouter e grava as traduções progressivamente em um arquivo local.

## Requisitos

- Node.js 20 ou superior e npm
- `parec`, normalmente disponibilizado por `pulseaudio-utils` (PulseAudio) ou `pipewire-pulse` (PipeWire com compatibilidade PulseAudio)
- O dispositivo monitor configurado no PulseAudio/PipeWire
- Uma chave de API do OpenRouter

## Instalação e execução

Na raiz do projeto:

```bash
npm install
cp .env.example .env
```

Edite `.env` e preencha `OPENROUTER_API_KEY` com uma chave criada em [OpenRouter](https://openrouter.ai/keys). O modelo padrão é `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`; disponibilidade e limites de uso do nível grátis dependem do OpenRouter e dos provedores. Embora as inferências desse modelo sejam gratuitas, o OpenRouter pode exigir pelo menos US$ 0,50 de saldo na conta para aceitar requisições de áudio. Verifique se o monitor está disponível:

```bash
pactl list short sources
```

Execute a aplicação:

```bash
npm run build && npm start
```

O processo fica ativo no terminal e a captura não depende do foco da janela nem da janela da Netflix. Use `Ctrl+C` para encerrar. A captura usa o monitor de saída, não o microfone; assim, ela recebe o áudio reproduzido no headset. Os blocos de áudio são enviados ao modelo configurado no OpenRouter para transcrição e tradução.

Por padrão, a captura forma blocos de 30 segundos, reduzindo o número de chamadas (um episódio de 43 minutos gera no máximo cerca de 86 blocos com áudio contínuo; blocos quase silenciosos são ignorados). Até quatro blocos são enviados em paralelo. Cada resposta aparece assim que chega e pode estar fora de ordem; número e horário da captura identificam a sequência. O pedido limita o raciocínio do modelo a 128 tokens e reserva até 2048 tokens para a resposta.

## Como o áudio chega ao modelo

1. O Netflix reproduz som como parte do áudio normal do navegador. PipeWire/PulseAudio encaminha esse som para uma saída (*sink*), como o Logitech H390.
2. `AUDIO_DEVICE` aponta para a fonte `.monitor` dessa saída. O monitor é uma cópia digital do áudio encaminhado ao sink: não grava pelo microfone nem captura diretamente a aba do Netflix. Outros sons enviados à mesma saída também podem ser capturados.
3. `parec` lê o monitor e converte o sinal para PCM bruto: amostras assinadas de 16 bits, little-endian, a 16 kHz, mono. O serviço acumula as amostras até completar cada bloco. Em 30 segundos: 16.000 amostras/s × 1 canal × 2 bytes × 30 s = 960.000 bytes.
4. `wrapPcmAsWav` não reconhece, comprime nem traduz o áudio. Ele cria um cabeçalho WAV/RIFF de 44 bytes com os metadados do formato e o concatena com os dados PCM. Assim, os bytes formam um WAV válido, e não áudio bruto sem indicação de formato.
5. O WAV completo é codificado em Base64 e enviado no corpo JSON da API OpenRouter como `input_audio`, com formato `wav`. A API pode processá-lo se o modelo e a rota escolhidos aceitarem entrada de áudio; um modelo que só aceite texto/imagem, ainda que gratuito, não serve.
6. A instrução enviada junto ao áudio pede somente as palavras faladas, em inglês. Títulos, horários, rótulos de falante, comentários e análises são removidos antes de mostrar ou salvar o texto. Se a fala já estiver em inglês, o resultado é uma transcrição; se estiver em outro idioma, o modelo deve traduzi-la.

A captura é feita em blocos, não continuamente pela API. Por isso, há pelo menos o tempo do bloco (30 s por padrão), mais o tempo de envio e processamento do provedor. O modelo também pode interpretar incorretamente áudio ruidoso, silêncio, música ou fala sobreposta.

### Fila de áudio persistente

Antes de enviar um bloco ao OpenRouter, o app grava seu PCM em um arquivo local na pasta `data/audio-queue/` (permissões restritas no Linux). Quando a API retorna uma transcrição, o app remove formatação e comentários, grava um arquivo de resultado por bloco e atualiza `data/transcript.txt` com apenas as falas, organizadas pela ordem de captura. Só depois remove o PCM da fila. Em caso de limite diário, falha de rede, resposta vazia ou encerramento inesperado, os arquivos de áudio ficam pendentes e são tentados novamente na próxima execução. Ao reiniciar, a fila pendente é carregada antes da captura de novos blocos; arquivos de resultado antigos também são limpos e migrados para o formato só com falas.

Se o limite gratuito `429 free-models-per-day` for atingido, novas chamadas à API são suspensas para evitar repetir o erro, mas a captura continua salvando blocos audíveis no disco. Esses blocos não são perdidos, embora o disco usado aumente; quando a API voltar a aceitar requisições, reinicie o programa para processar os pendentes. Não apague a pasta da fila enquanto quiser preservar esses áudios. Os arquivos PCM e as traduções intermediárias ficam locais; proteja essa pasta como conteúdo privado. A transcrição consolidada também é local e, por padrão, fica em `data/transcript.txt`.

Um bloco de 30 s ocupa aproximadamente 960 KB; 43 minutos contínuos de áudio ocupam cerca de 83 MB.

## Configuração opcional

- `AUDIO_DEVICE`: nome do monitor PulseAudio/PipeWire. O padrão é o monitor Logitech H390 informado no requisito.
- `AUDIO_CHUNK_SECONDS`: duração dos blocos enviados à API (inteiro de 1 a 30; padrão `30`).
- `AUDIO_QUEUE_DIR`: pasta da fila de áudio persistente (padrão `data/audio-queue` relativa à raiz de execução).
- `AUDIO_TRANSCRIPT_FILE`: caminho do arquivo de texto consolidado (padrão `data/transcript.txt` relativa à raiz de execução).
- `OPENROUTER_MODEL`: modelo do OpenRouter. O padrão é `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`; escolha outro modelo grátis que aceite áudio se esse não estiver disponível na sua conta/região.

Para executar em modo de desenvolvimento:

```bash
npm run dev
```
