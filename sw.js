/**
 * O service worker â Ã© ele que faz o navegador aceitar instalar o aplicativo,
 * e o que permite abrir sem sinal.
 *
 * O QUE MUDOU EM 23/09, E POR QUÃ
 *   A regra antiga era "se estÃ¡ guardado, usa o guardado". Com isso, subir
 *   um index.html novo no GitHub nÃ£o adiantava: o celular continuava abrindo
 *   a tela antiga, e a gente discutia o comportamento de uma versÃ£o que o
 *   aparelho nem tinha recebido. Aconteceu trÃªs vezes no mesmo dia.
 *
 *   Agora a PÃGINA Ã© buscada na rede primeiro. Se a rede responder, ela entra
 *   e a cÃ³pia guardada Ã© atualizada. Se nÃ£o responder â sem sinal, no galpÃ£o â,
 *   aÃ­ sim vale a guardada.
 *
 *   O resto da casca (Ã­cones, manifesto) continua saindo do cache, que Ã©
 *   rÃ¡pido e nÃ£o muda.
 *
 * TROCOU O index.html? Mude o nÃºmero da versÃ£o abaixo; ele tambÃ©m limpa o
 * que ficou de trÃ¡s.
 */
const VERSAO = 'despacho-v68';

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
   * A PÃGINA VEM DA REDE PRIMEIRO
   *   Vale para a navegaÃ§Ã£o (abrir o aplicativo) e para o prÃ³prio
   *   index.html. Ã o que faz a versÃ£o nova chegar sem precisar desinstalar.
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

  // o resto: guardado primeiro, que Ã© rÃ¡pido e nÃ£o muda
  e.respondWith(
    caches.match(e.request).then((achado) => achado || fetch(e.request))
  );
});
