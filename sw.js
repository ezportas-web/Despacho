/**
 * O service worker — é ele que faz o navegador aceitar instalar o aplicativo,
 * e o que permite abrir sem sinal.
 *
 * A REGRA É SIMPLES, E DE PROPÓSITO
 *   A casca (tela, estilo, ícones) fica guardada e abre na hora, mesmo sem
 *   internet. Os DADOS nunca são guardados: pedido e faturamento mudam o
 *   tempo todo, e mostrar número velho como se fosse de agora é pior que não
 *   mostrar nada.
 *
 * TROCOU O index.html? Mude o número da versão abaixo. É isso que faz o
 * celular buscar a versão nova em vez de continuar com a antiga.
 */
const VERSAO = 'despacho-v10';
const CASCA = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // dados do motor: sempre da rede, nunca do cache
  if (url.hostname.includes('script.google')) return;

  e.respondWith(
    caches.match(e.request).then((achado) => achado || fetch(e.request))
  );
});
