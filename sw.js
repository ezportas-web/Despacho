/**
 * O service worker — é ele que faz o navegador aceitar instalar o aplicativo,
 * e o que permite abrir sem sinal.
 *
 * O QUE MUDOU EM 23/09, E POR QUÊ
 *   A regra antiga era "se está guardado, usa o guardado". Com isso, subir
 *   um index.html novo no GitHub não adiantava: o celular continuava abrindo
 *   a tela antiga, e a gente discutia o comportamento de uma versão que o
 *   aparelho nem tinha recebido. Aconteceu três vezes no mesmo dia.
 *
 *   Agora a PÁGINA é buscada na rede primeiro. Se a rede responder, ela entra
 *   e a cópia guardada é atualizada. Se não responder — sem sinal, no galpão —,
 *   aí sim vale a guardada.
 *
 *   O resto da casca (ícones, manifesto) continua saindo do cache, que é
 *   rápido e não muda.
 *
 * TROCOU O index.html? Mude o número da versão abaixo; ele também limpa o
 * que ficou de trás.
 */
const VERSAO = 'despacho-v16';

const CASCA = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSAO)
      .then((c) => c.addAll(CASCA))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // dados do motor: sempre da rede, nunca do cache
  if (url.hostname.includes('script.google')) return;

  /**
   * A PÁGINA VEM DA REDE PRIMEIRO
   *   Vale para a navegação (abrir o aplicativo) e para o próprio
   *   index.html. É o que faz a versão nova chegar sem precisar desinstalar.
   */
  const ehPagina = e.request.mode === 'navigate' ||
                   url.pathname.endsWith('/') ||
                   url.pathname.endsWith('index.html');

  if (ehPagina) {
    e.respondWith(
      fetch(e.request)
        .then((resposta) => {
          const copia = resposta.clone();
          caches.open(VERSAO).then((c) => c.put(e.request, copia));
          return resposta;
        })
        .catch(() => caches.match(e.request)
          .then((achado) => achado || caches.match('./index.html')))
    );
    return;
  }

  // o resto: guardado primeiro, que é rápido e não muda
  e.respondWith(
    caches.match(e.request).then((achado) => achado || fetch(e.request))
  );
});
