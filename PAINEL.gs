/**
 * ============================================================================
 * PAINEL DE DESPACHO — o motor
 * ============================================================================
 * Página web servida pelo Apps Script, mesma URL no computador e no celular.
 * Lista os pedidos pagos que ainda não viraram nota, cota o frete em quem
 * atende o destino, e monta o e-mail de faturamento.
 *
 * AS TABELAS DE DADOS FICAM EM OUTRO ARQUIVO
 *   NOME_LOGISTICA_PAINEL e PESO_SKU_PAINEL saíram daqui e vivem no
 *   TABELAS_PAINEL.gs. São 350 linhas de dados que não mudam quando mexemos
 *   na lógica — e, separadas, não precisam ser recolocadas a cada versão
 *   deste arquivo. O Apps Script junta tudo no mesmo espaço de nomes, então
 *   funciona igual.
 *
 * COMO O PAINEL DECIDE O QUE É "EM ABERTO"
 *   Pelo ENVIO, não pela ausência na planilha.
 *
 *   A primeira versão listava tudo que estava pago no ML e não tinha linha na
 *   planilha — e isso trazia 99 pedidos, quase todos JÁ DESPACHADOS. A nota
 *   saiu, a mercadoria foi, e a linha não entrou (ou entrou com o número do
 *   pedido irmão, no caso da fusão).
 *
 *   Agora a própria busca do Mercado Livre filtra por shipping.status=pending,
 *   que é o estado de quem ainda vai sair. Pedido despachado some sozinho,
 *   sem depender da planilha estar em dia.
 *
 * O NOME E O CPF DO COMPRADOR
 *   A busca de pedidos do ML devolve APELIDO, não nome. O nome real e o CPF
 *   estão no billing_info, uma chamada por pedido — agora feita já na
 *   listagem, com cache de 6 horas. Ver painelNomeCpf_ lá embaixo.
 *
 * MODO DE TESTE — o que está ligado e o que não está
 *   LIGADO ....: puxar pedidos, cotar, montar o escopo, ENVIAR E-MAIL
 *   DESLIGADO .: gravar na planilha, mensagem ao comprador
 *
 *   O e-mail vai SÓ para EMAIL_TESTE_PAINEL, não para o faturamento. Quando o
 *   painel estiver aprovado, é trocar PAINEL_TESTE para false e o resto liga.
 *
 * COMO PUBLICAR
 *   1. Este arquivo entra no MESMO projeto onde está a autorização do ML —
 *      ele lê as gavetas ml_token_facil e ml_token_domo, igual ao telegram.gs
 *   2. Crie um arquivo HTML no projeto chamado "painel" e cole o conteúdo do
 *      painel.html
 *   3. Crie o TABELAS_PAINEL.gs com as duas tabelas de dados
 *   4. No doGet que já existe (o do OAuth), acrescente como PRIMEIRA linha:
 *
 *        if (e && e.parameter && e.parameter.painel !== undefined) return painelDoGet_(e);
 *
 *      O Apps Script só aceita um doGet por projeto, então o painel entra
 *      por parâmetro na mesma URL: .../exec?painel
 *   5. Implante (nova versão do Web App) e abra a URL com ?painel no fim
 *
 * AS COTAÇÕES
 *   Todas pelo CNPJ da FÁCIL SHOP, como pagador e remetente, mesmo em pedido
 *   da Domo — é assim que a extensão já faz.
 *
 *   Quem atende cada destino segue as regras que o Jonas ditou em 14/09:
 *     Sinil ......... SC e PR
 *     Azurelog ...... qualquer UF fora do Sul; ela avisa quando não atende
 *     Itoupava ...... cidades da planilha dela
 *     Transoliveira . MG, GO, DF e ES inteiros; em SP só as da planilha
 *     Arlete ........ cidades da planilha dela; só coleta na TERÇA
 *     TW ............ RS — agora COTA, credenciais recebidas em 17/09
 *     Rodonaves ..... o país inteiro — COTA desde 18/09, por API própria
 *
 *   A Modular saiu da lista em 18/09. Sem API e sem uso recente, só ocupava
 *   espaço na tela.
 *
 *   E a regra mais importante: a cotação RESPONDER não prova que a
 *   transportadora atende. A lista filtra, a API só cota.
 *
 * NOMES COM SUFIXO
 *   No Apps Script TODOS os arquivos dividem o mesmo espaço de nomes: uma
 *   constante repetida em dois arquivos quebra o projeto inteiro, com
 *   "Identifier has already been declared", e nada roda.
 *
 *   O PRINCIPAL.gs já tinha EMAIL_FATURAMENTO. Por isso tudo aqui leva
 *   sufixo _PAINEL ou Painel_ — feio de ler, mas é o que mantém os arquivos
 *   independentes.
 * ============================================================================
 */

// ===========================================================================
// CONFIGURAÇÃO
// ===========================================================================

/**
 * AS CONFIGURAÇÕES QUE NÃO SE PERDEM
 *
 *   Toda vez que este arquivo é colado por cima, os ajustes voltam ao
 *   padrão — e três deles já foram desfeitos sem ninguém notar: o modo de
 *   teste, a chave do aplicativo e o domínio da TW, que voltou para
 *   homologação e fez uma cotação sair com preço indicativo.
 *
 *   Agora elas vivem nas Propriedades do Script, que sobrevivem a qualquer
 *   colagem. O valor escrito aqui é só o padrão de quem nunca configurou.
 *
 *   Para ajustar, rode configurarPainel() uma vez — ele mostra o que está
 *   valendo e como mudar.
 */
function cfgPainel_(chave, padrao) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(chave);
    if (v === null || v === undefined || v === '') return padrao;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  } catch (e) { return padrao; }
}

/**
 * Mostra as configurações e ensina a mudar.
 *   Para trocar:  PropertiesService.getScriptProperties()
 *                   .setProperty('PAINEL_TESTE', 'false');
 */
function configurarPainel() {
  var p = PropertiesService.getScriptProperties();
  Logger.log('O QUE ESTÁ VALENDO AGORA');
  Logger.log('   PAINEL_TESTE ....: ' + cfgPainel_('PAINEL_TESTE', true) +
             (cfgPainel_('PAINEL_TESTE', true) === true
               ? '   (e-mail só para você, planilha desligada)'
               : '   (VALENDO: e-mail ao faturamento e linha na planilha)'));
  Logger.log('   DOMINIO_TW ......: ' + cfgPainel_('DOMINIO_TW', 'TW2') +
             (cfgPainel_('DOMINIO_TW', 'TW2') === 'TW2'
               ? '   (HOMOLOGAÇÃO — preço indicativo)'
               : '   (produção)'));
  Logger.log('');
  Logger.log('PARA MUDAR, rode uma destas no editor:');
  Logger.log("   PropertiesService.getScriptProperties().setProperty('PAINEL_TESTE','false');");
  Logger.log("   PropertiesService.getScriptProperties().setProperty('DOMINIO_TW','TWT');");
  Logger.log('');
  Logger.log('Ou use os atalhos: ligarPainelValendo() e ligarTwProducao().');
}

/** Atalhos, para não precisar digitar aquilo tudo. */
function ligarPainelValendo() {
  PropertiesService.getScriptProperties().setProperty('PAINEL_TESTE', 'false');
  Logger.log('Painel VALENDO: e-mail vai ao faturamento e a linha entra na planilha.');
}

function ligarPainelTeste() {
  PropertiesService.getScriptProperties().setProperty('PAINEL_TESTE', 'true');
  Logger.log('Painel em teste: e-mail só para ' + EMAIL_TESTE_PAINEL + '.');
}

function ligarTwProducao() {
  PropertiesService.getScriptProperties().setProperty('DOMINIO_TW', 'TWT');
  CacheService.getScriptCache().remove('painel_pedidos');
  Logger.log('TW em PRODUÇÃO. As cotações passam a valer de verdade.');
}

function ligarTwHomologacao() {
  PropertiesService.getScriptProperties().setProperty('DOMINIO_TW', 'TW2');
  Logger.log('TW em homologação: preço indicativo.');
}


var PAINEL_TESTE = cfgPainel_('PAINEL_TESTE', true);
var EMAIL_TESTE_PAINEL = 'ezportas@gmail.com';
var EMAIL_FATURAMENTO_PAINEL = 'faturamentofacilshop@gmail.com';

/**
 * QUEM GRAVA NA PLANILHA
 *
 *   O processarPedido_, o mesmo que a extensão do computador usa há meses.
 *   Ele confere se o pedido já está lá, escreve a linha, copia as fórmulas
 *   de custo e margem, e manda o e-mail ao faturamento.
 *
 *   ESCREVER UMA SEGUNDA VERSÃO DISSO SERIA ERRO. As fórmulas de lucro e
 *   margem dependem de detalhes que custaram caro para acertar — a coluna do
 *   custo achada pelo cabeçalho e não pela letra, o N() em volta das
 *   quantidades, a data construída ao meio-dia para não cair no dia
 *   anterior. Duas implementações viveriam divergindo.
 *
 *   Descoberto em 19/09: a URL que a extensão usa é a MESMA deste projeto,
 *   ou seja, o doPost mora aqui do lado. Então o painel chama a função
 *   direto, em vez de mandar uma requisição pela internet para si mesmo.
 */

var CTRL_PAINEL = '1KD5YP1VBMypLXfhwEqqZYh6bGm-8MybMn5g7CnRuXzI';

var LOJAS_PAINEL = {
  facil: { nome: 'Fácil Shop', curto: 'FÁCIL', seller: 2390295012, cor: '#1E2D3D' },
  domo:  { nome: 'Domo Wood',  curto: 'DOMO',  seller: 3487383217, cor: '#5B3A1E' }
};

/**
 * Quantos dias para trás buscar pedidos.
 *
 * Pode ser largo agora. Até 16/09 a janela precisava ser curta porque o
 * filtro era "não está na planilha", e isso trazia pedido antigo já
 * despachado. Com o filtro pelo ENVIO, pedido que saiu some sozinho — a
 * janela só limita o quanto se olha para trás.
 */
var JANELA_DIAS_PAINEL = 30;

/**
 * O QUE É PEDIDO EM ABERTO
 *
 *   É pedido pago cujo ENVIO ainda não saiu. E a busca do Mercado Livre
 *   aceita filtrar por isso: shipping.status=pending devolveu 3 de 358 no
 *   teste de 16/09, enquanto só "paid" trazia os 358.
 *
 *   ready_to_ship deu ZERO, e faz sentido: com envio próprio, o pedido passa
 *   de pending direto para shipped quando a nota sai. O ready_to_ship é do
 *   Mercado Envios, que não é o caso aqui.
 *
 *   A tag not_delivered NÃO serve: 159 pedidos a têm, incluindo os já
 *   despachados. Ela só diz que a mercadoria não chegou ao cliente.
 */
var STATUS_ENVIO_ABERTO_PAINEL = 'pending';

/** CEP de origem e o CNPJ que paga o frete — sempre a Fácil. */
var CEP_ORIGEM_PAINEL = '89136000';
var CNPJ_FACIL_PAINEL = '59315378000127';

/**
 * O WEBSERVICE DE COTAÇÃO — o que REGISTRA
 *
 *   Até 16/09 usávamos o sswCotacao, que só calcula. A resposta dele tem 38
 *   campos de valores e prazos, e nenhum identificador — por isso o e-mail
 *   saía sem o NÚMERO DA COTAÇÃO, que o Everton usa para confirmar o preço
 *   com a transportadora.
 *
 *   O sswCotacaoColeta faz o mesmo cálculo — testamos lado a lado e deu
 *   R$ 52,92 nos dois — mas REGISTRA e devolve o número, além de um token
 *   que serve para pedir a coleta depois, se um dia quisermos.
 *
 *   A contrapartida: cada cotação vira um registro no sistema deles. Com seis
 *   transportadoras por pedido, são seis registros. Vale confirmar com o SSW
 *   se isso incomoda.
 */
var URL_COTACAO_PAINEL = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php';
var NS_COTACAO_PAINEL = 'urn:sswinfbr.sswCotacaoColeta';

/** Acima disto, o preço acende — mas continua cotando. */
var TETO_ALERTA_PAINEL = 150;

/**
 * O DESTINO DA SIMULAÇÃO
 *
 *   O botão Executar do editor roda a função SEM argumentos — por isso o
 *   destino fica aqui, e não no parâmetro. Edite esta linha e rode
 *   painelSimularDestino(), sem precisar de console.
 *
 *   Peso e valor são os de uma porta de 90: 20 kg, R$ 400.
 */
var DESTINO_TESTE_PAINEL = {
  cidade: 'Belo Horizonte', uf: 'MG', cep: '30110001', peso: 20, valorNF: 400
};

/**
 * BUSCAR O CPF NO BLING quando o Mercado Livre não entregar
 *
 *   Em 17/09 as três rotas de faturamento do ML passaram a responder 403
 *   PolicyAgent — é falta de Permissão funcional no aplicativo, que só o
 *   dono da conta pode habilitar, e depois exige reautorizar as duas lojas.
 *
 *   Enquanto isso não acontece, o Bling resolve: ele importa o pedido do
 *   Mercado Livre com o contato completo, CPF incluído.
 *
 *   Duas limitações conhecidas: o Bling NÃO importa os pedidos irmãos de
 *   carrinho, e o número que ele guarda como numeroLoja costuma ser o do
 *   carrinho, não o do pedido — por isso a busca tenta os dois.
 */
var USAR_BLING_CPF_PAINEL = true;

/**
 * O CPF QUE OS TESTES USAM
 *
 *   A TW em PRODUÇÃO recusa cotação sem o documento do destinatário —
 *   "Informe o CNPJ/CPF do destinatario" —, enquanto a homologação aceitava
 *   em branco. Nas cotações reais o painel passa o CPF do comprador, tirado
 *   do pedido. Nos testes de bancada não há comprador, então ponha aqui o
 *   CPF de um cliente real, de um pedido antigo.
 *
 *   Só números, sem ponto nem traço.
 */
var CPF_TESTE_PAINEL = '';

/**
 * O DOMÍNIO DA TW — homologação ou produção
 *
 *   TW2 = homologação. Cota e coleta sem afetar o ambiente real deles, e dá
 *         para testar à vontade. Pode divergir em preço, prazo e cidade
 *         atendida, porque não é atualizado sempre.
 *   TWT = produção. Vale de verdade.
 *
 *   Enquanto estiver em TW2, o valor que a TW mostrar no painel é indicativo.
 *   Trocar para TWT quando o testarTW() estiver respondendo certo.
 */
var DOMINIO_TW_PAINEL = cfgPainel_('DOMINIO_TW', 'TW2');

/**
 * As transportadoras. As que têm SSW cotam sozinhas; as outras aparecem com
 * campo para digitar o valor.
 *
 * coletar e destContribuinte seguem a tela do SSW, que usa S nos dois. A TW
 * pede os três EM BRANCO, e a mercadoria como TEXTO com os zeros ('001') —
 * está escrito na documentação dela. Por isso é por transportadora.
 */
var TRANSPORTADORAS_PAINEL = [
  { id: 'SINIL',    ssw: { dominio: 'CLD', login: '59315378', senha: '59315378', mercadoria: 1 },
    coletar: 'S', contribuinte: 'S', entDificil: 'N' },
  { id: 'AZURELOG', ssw: { dominio: 'AZU', login: 'barcelos', senha: '60416105', mercadoria: 1 },
    coletar: 'S', contribuinte: 'S', entDificil: 'N' },
  { id: 'ITOUPAVA', ssw: { dominio: 'ITO', login: 'everton', senha: 'everton', mercadoria: 1 },
    coletar: 'S', contribuinte: 'S', entDificil: 'N' },
  { id: 'TRANSOLIVEIRA', ssw: { dominio: 'TOL', login: 'zermia', senha: '127', mercadoria: 92 },
    coletar: 'S', contribuinte: 'S', entDificil: 'N' },
  { id: 'ARLETE',   ssw: { dominio: 'ARL', login: '59315378', senha: 'FAC#6672', mercadoria: 1 },
    coletar: 'S', contribuinte: 'S', entDificil: 'N', obs: 'coleta só na terça' },

  // TW — credenciais recebidas do TI deles em 17/09/2026. As mesmas servem
  // para cotação, coleta e rastreamento. Mercadorias: 001 Diversos,
  // 003 Metais, 009 Químico.
  // o domínio dela sai do DOMINIO_TW_PAINEL na hora de cotar, não aqui:
  // constante lida dentro de outra constante quebra se a ordem mudar
  { id: 'TW', ssw: { dominio: '', login: 'fclshop', senha: 'fcsp1963',
                     mercadoria: '001', mercadoriaTexto: true },
    coletar: '', contribuinte: '', entDificil: '' },

  // A Rodonaves não usa SSW: tem API própria, em quatro servidores. Cota
  // desde 18/09/2026, conferida contra o portal deles (R$ 238,85 nos dois,
  // para o mesmo pedido).
  { id: 'RODONAVES', ssw: null, api: 'rodonaves' }

  // MODULAR saiu em 18/09: fica de fora até você decidir se volta. Se
  // voltar, é acrescentar aqui com ssw: null e a cobertura de Norte e
  // Nordeste na tabela abaixo.
];

/**
 * A RODONAVES — a única que não fala SSW
 *
 *   Quatro servidores, cada um com o seu token. O que funciona é a
 *   credencial do PORTAL DO DESENVOLVEDOR; a do portal do cliente, com
 *   CNPJ, é recusada.
 *
 *   O gera-cotacao devolve o número de protocolo, como o SSW, mas exige o
 *   destinatário CADASTRADO. Por isso o painel cadastra sozinho, e só
 *   quando a cotação reclamar que o cliente não existe.
 *
 *   Sem CPF do comprador ele cai no simula-cotacao, que cota sem cadastro
 *   mas não gera número.
 */
var RODONAVES_PAINEL = {
  user: 'FACILSHOP',
  senha: '7Q26I5C9',
  empresa: '1',

  /**
   * O ID DA CIDADE DE ORIGEM
   *
   *   Este número é só uma RESERVA. Eu o anotei do teste de 18/09 e o deixei
   *   fixo — e chumbar id de sistema alheio é pedir para quebrar. Se ele
   *   estiver errado, a cotação recusa com "Não localizado CEP para entrega
   *   da mercadoria", mensagem que parece ser sobre o destino e não é.
   *
   *   Agora o id é consultado a partir do CEP de origem e guardado por 24
   *   horas, igual ao do destino. Só cai neste número se a consulta falhar.
   */
  cidadeOrigemReserva: 8659,

  // o contato responsável pela cotação é VOCÊ, não quem recebe — e o
  // telefone é obrigatório
  contatoNome: 'Jonas Lima',
  contatoTelefone: '47992618710',
  email: 'ezportas@gmail.com'
};

/** As planilhas de cidades atendidas. */
var PLANILHAS_CIDADES_PAINEL = {
  ITOUPAVA:      '1r6VmtI0iVJQ4WoXAhLnv4VGltizOfPwpG-xLDeg2mF8',
  TRANSOLIVEIRA: '1gLV5O6PB0mWlaA6wG7dRruvTdYK4WBhBs_neTTQm_Uo',
  ARLETE:        '1bJy0OixYFE2bAUc7tN53X14lKLcob85nIzgz7Qwfut4'
};

var UF_SUL_PAINEL = ['SC', 'PR', 'RS'];
var UF_NORTE_NORDESTE_PAINEL = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'MA', 'PA', 'PB',
                         'PE', 'PI', 'RN', 'RO', 'RR', 'SE', 'TO'];

/**
 * ===========================================================================
 * QUEM ATENDE ONDE — a tabela de cobertura
 * ===========================================================================
 * Ficava espalhada num switch dentro do código. Agora é uma tabela só: mudar
 * a cobertura de uma transportadora é editar uma linha aqui, sem procurar
 * nada. É o que mais muda com o tempo — a Transoliveira ganhou o ES em
 * 16/09 depois de uma venda para o Rio não trazer ela.
 *
 * Os campos, na ordem em que são lidos:
 *   tudo ......... atende o país inteiro
 *   ufs .......... atende só estes estados, por inteiro
 *   planilhaEm ... nestes estados, só as cidades da planilha dela
 *   planilha ..... em qualquer lugar, só as cidades da planilha dela
 *   foraDe ....... atende fora destes estados, mas não temos certeza da
 *                  cidade: deixa a cotação responder (é o caso da Azurelog,
 *                  que avisa "cidade não cadastrada" quando não dá)
 *
 * E a regra que vale acima de tudo: a cotação RESPONDER não prova que a
 * transportadora atende. A lista filtra, a API só cota.
 */
var COBERTURA_PAINEL = {
  SINIL:         { ufs: ['SC', 'PR'] },

  // A Azurelog atende tudo fora do Sul: MG, ES, DF e RJ, o Centro-Oeste
  // (MS, MT, GO), o Norte e o Nordeste. Como a lista dela muda, quem
  // responde é a cotação — mas atenção à regra de leitura abaixo: ela
  // devolve VALOR junto com "região não cadastrada" quando não atende.
  AZURELOG:      { foraDe: UF_SUL_PAINEL },
  ITOUPAVA:      { planilha: true },
  TRANSOLIVEIRA: { ufs: ['MG', 'GO', 'DF', 'ES'], planilhaEm: ['SP'] },
  ARLETE:        { planilha: true },
  TW:            { ufs: ['RS', 'SC', 'PR'] },
  RODONAVES:     { tudo: true }
};

/**
 * A MENSAGEM AO COMPRADOR, no momento do despacho
 *
 *   POR QUE ELA EXISTE, já havendo a de rastreio
 *     São dois momentos. Esta sai quando você fecha o despacho; a de
 *     rastreio só depois que a nota é emitida, e entre uma coisa e outra
 *     pode passar um dia inteiro. Sem esta, o comprador fica sem saber se a
 *     compra deu certo.
 *
 *   O PRAZO MUDA COM A DISTÂNCIA
 *     Prometer 10 dias para a Bahia é criar reclamação. Os prazos abaixo
 *     são os que o Jonas definiu em 19/09, por região.
 *
 *   DESLIGADA no modo de teste, como o resto.
 */
var PRAZO_MENSAGEM_PAINEL = {
  // Sul e Sudeste, mais Goiás e o Distrito Federal: a maior parte das vendas
  SC: 10, PR: 10, RS: 10, SP: 10, RJ: 10, MG: 10, ES: 10, GO: 10, DF: 10,
  // o resto do Centro-Oeste
  MS: 15, MT: 15,
  // Norte e Nordeste
  BA: 19, SE: 19, AL: 19, PE: 19, PB: 19, RN: 19, CE: 19, PI: 19, MA: 19,
  PA: 19, AP: 19, AM: 19, RR: 19, RO: 19, AC: 19, TO: 19
};

/** Quando a UF não vier, vai o prazo mais longo: promessa curta demais vira reclamação. */
var PRAZO_PADRAO_PAINEL = 19;

function mensagemCompradorPainel_(uf) {
  var dias = PRAZO_MENSAGEM_PAINEL[String(uf || '').toUpperCase()] || PRAZO_PADRAO_PAINEL;

  return 'Obrigado! 🙏 Seu pedido está sendo encaminhado ao despacho e será ' +
    'entregue em até ' + dias + ' dias.\n' +
    '❗ IMPORTANTE: Ao receber, verifique a embalagem na frente do entregador.\n' +
    '⚠️ Se notar qualquer problema (caixa amassada, rasgada, violada), anote o que ' +
    'viu no documento da transportadora antes de assinar. Isso é essencial para a ' +
    'garantia.';
}


// ===========================================================================
// A PÁGINA
// ===========================================================================

/** Chamado pelo doGet existente quando a URL tem ?painel. */
function painelDoGet_(e) {
  var t = HtmlService.createTemplateFromFile('painel');
  t.modoTeste = PAINEL_TESTE;
  return t.evaluate()
    .setTitle('Despacho')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ===========================================================================
// 1) LISTAR OS PEDIDOS ABERTOS
// ===========================================================================

/**
 * Os pedidos pagos das duas lojas cujo envio ainda não saiu.
 * Cache de 3 minutos, para a lista abrir rápido e não bater no ML a cada toque.
 */
function painelListarPedidos(forcar) {
  var cache = CacheService.getScriptCache();
  if (!forcar) {
    var c = cache.get('painel_pedidos');
    if (c) return JSON.parse(c);
  }

  var jaNaPlanilha = pedidosNaPlanilhaPainel_();
  var saida = [];

  Object.keys(LOJAS_PAINEL).forEach(function (chave) {
    var loja = LOJAS_PAINEL[chave];
    var token = painelTokenML_(chave);
    if (!token) return;

    var pedidos = pedidosRecentesMlPainel_(chave, token, loja.seller);

    // agrupa por carrinho: vários pedidos do mesmo pack_id são UMA entrega
    var pacotes = {};
    pedidos.forEach(function (p) {
      var k = String(p.pack_id || p.id);
      if (!pacotes[k]) pacotes[k] = [];
      pacotes[k].push(p);
    });

    Object.keys(pacotes).forEach(function (k) {
      var grupo = pacotes[k];
      var ids = grupo.map(function (p) { return String(p.id); });

      // se QUALQUER um dos pedidos do pacote já está na planilha, o pacote
      // inteiro já foi despachado
      //
      // E O NÚMERO DO CARRINHO TAMBÉM CONTA
      //   A extensão grava o "Venda #" da tela do Mercado Livre, que às
      //   vezes é o número do carrinho e não o do pedido. Comparando só
      //   pelo pedido, uma venda despachada pela extensão continuava
      //   aparecendo no aplicativo até a nota sair.
      //
      // NÃO SAI DAQUI AINDA — só é MARCADO
      //   Em 21/09, a Suelene fez duas compras no mesmo dia. Você despachou
      //   pela extensão, que gravou um dos números. Eliminando aqui, uma
      //   compra sumia e a outra ficava sozinha na lista, parecendo pedido
      //   novo. O certo é juntar primeiro e esconder o GRUPO inteiro se
      //   qualquer compra dele já estiver na planilha — o que acontece lá
      //   embaixo, depois do juntarMesmoCompradorPainel_.
      var packs = grupo.map(function (p) { return String(p.pack_id || ''); })
                       .filter(Boolean);
      var naPlanilha = ids.some(function (id) { return jaNaPlanilha[id]; }) ||
                       !!jaNaPlanilha[k] ||
                       packs.some(function (pk) { return jaNaPlanilha[pk]; });

      var primeiro = grupo[0];
      var itens = [];
      grupo.forEach(function (p) {
        (p.order_items || []).forEach(function (oi) {
          var sku = String((oi.item && (oi.item.seller_sku || oi.item.seller_custom_field)) || '');
          itens.push({
            sku: sku,
            nome: (oi.item && oi.item.title) || '',
            // o NOME PARA LOGÍSTICA é o que vai no e-mail: diz o friso, o
            // enchimento e a cor da ferragem. O título do anúncio não diz.
            nomeLogistica: NOME_LOGISTICA_PAINEL[sku] || '',
            tipo: (oi.listing_type_id === 'gold_pro') ? 'PREMIUM' : 'CLASSICO',
            qtd: Number(oi.quantity) || 1,
            unitario: Number(oi.unit_price || 0),
            valor: Number(oi.unit_price || 0) * (Number(oi.quantity) || 1)
          });
        });
      });

      /**
       * O FRETE QUE O COMPRADOR PAGOU
       *
       *   Fica no ENVIO, não no pedido — ver o comentário em painelDetalhe.
       *   Aqui vale o que o pedido trouxer, se trouxer; o valor bom entra
       *   quando o endereço é lido, em pedidosComEnderecoApp_.
       */
      var freteRecebido = 0;
      grupo.forEach(function (p) {
        (p.payments || []).forEach(function (pg) {
          freteRecebido += Number(pg.shipping_cost || 0);
        });
      });

      var carga = cargaDosItensPainel_(itens);
      var criado = new Date(primeiro.date_created);
      var dias = Math.floor((Date.now() - criado.getTime()) / 86400000);

      // o nome real e o CPF, que a busca não traz
      var quem = painelNomeCpf_(chave, ids[0],
                                primeiro.shipping && primeiro.shipping.id, primeiro);

      saida.push({
        chave: k,
        loja: chave,
        lojaNome: loja.nome,
        lojaCurto: loja.curto,
        lojaCor: loja.cor,
        ids: ids,
        cliente: quem.nome,
        clienteNota: quem.nomeNota || quem.nome,
        cpf: quem.cpf,
        origemNome: quem.origem,
        compradorId: primeiro.buyer && primeiro.buyer.id,
        criado: criado.toISOString(),
        dias: dias,
        freteRecebido: Math.round(freteRecebido * 100) / 100,
        itens: itens,
        total: itens.reduce(function (a, x) { return a + x.valor; }, 0),
        peso: carga.peso,
        cubagem: carga.cubagem,
        medidas: carga.medidas,
        volumes: carga.volumes,
        skuSemPeso: carga.semPeso,
        envioId: primeiro.shipping && primeiro.shipping.id,
        // um envio por pedido: quando duas compras são juntadas, o frete que
        // o comprador pagou é a soma dos dois
        envios: grupo.map(function (p) {
          return { id: String(p.id), envio: p.shipping && p.shipping.id };
        }),
        juntos: 1,
        naPlanilha: naPlanilha
      });
    });
  });

  saida = juntarMesmoCompradorPainel_(saida);

  // agora sim: some o grupo inteiro se qualquer compra dele já foi despachada
  saida = saida.filter(function (p) { return !p.naPlanilha; });

  saida.sort(function (a, b) { return b.dias - a.dias; });   // os mais antigos primeiro
  cache.put('painel_pedidos', JSON.stringify(saida), 180);
  return saida;
}


/**
 * JUNTA COMPRAS DO MESMO COMPRADOR NO MESMO DIA
 *
 *   O carrinho já era juntado: vários pedidos com o mesmo pack_id viram uma
 *   entrega só. Mas o cliente que compra hoje de manhã e de novo à tarde faz
 *   duas compras separadas, cada uma com seu carrinho — e o Everton emite
 *   uma nota só para as duas.
 *
 *   Foi o caso do Antony e da Rosana. No aplicativo eles apareciam como dois
 *   pedidos, e cotar e enviar cada um separado gerava dois e-mails e duas
 *   linhas para uma entrega só.
 *
 *   A regra: mesma loja, mesmo comprador, mesmo dia no fuso do Brasil. O
 *   cartão mostra quantas compras foram juntadas, para você conferir.
 */
function juntarMesmoCompradorPainel_(lista) {
  var grupos = {};
  var ordem = [];

  lista.forEach(function (p) {
    var dia = Utilities.formatDate(new Date(p.criado), 'GMT-3', 'yyyy-MM-dd');
    var k = p.loja + '|' + (p.compradorId || p.chave) + '|' + dia;
    if (!grupos[k]) { grupos[k] = []; ordem.push(k); }
    grupos[k].push(p);
  });

  return ordem.map(function (k) {
    var g = grupos[k];
    if (g.length === 1) return g[0];

    var base = JSON.parse(JSON.stringify(g[0]));
    var itens = [], ids = [], envios = [];
    var total = 0, freteRecebido = 0, dias = 0;

    g.forEach(function (p) {
      itens = itens.concat(p.itens);
      ids = ids.concat(p.ids);
      envios = envios.concat(p.envios || []);
      total += Number(p.total) || 0;
      freteRecebido += Number(p.freteRecebido) || 0;
      if (p.dias > dias) dias = p.dias;
    });

    var carga = cargaDosItensPainel_(itens);

    base.itens = itens;
    base.ids = ids;
    base.envios = envios;
    base.total = total;
    base.freteRecebido = freteRecebido;
    base.dias = dias;
    base.peso = carga.peso;
    base.cubagem = carga.cubagem;
    base.medidas = carga.medidas;
    base.volumes = carga.volumes;
    base.skuSemPeso = carga.semPeso;
    base.juntos = g.length;
    // uma compra já despachada leva o grupo junto: é a mesma entrega
    base.naPlanilha = g.some(function (p) { return p.naPlanilha; });
    return base;
  });
}


/**
 * O frete que o comprador pagou, somado de todos os envios do pedido.
 *   Numa compra só, é o envio dela. Em duas compras juntadas, são dois
 *   envios, cada um com o seu valor — e a nota precisa da soma.
 */
function freteCompradorTotalPainel_(pedido) {
  var envios = pedido.envios || [{ id: pedido.ids[0], envio: pedido.envioId }];
  var soma = 0;
  envios.forEach(function (e) {
    if (!e.envio) return;
    try {
      var d = painelDetalhe(pedido.loja, e.id, e.envio);
      soma += Number(d.freteComprador) || 0;
    } catch (err) {}
  });
  return soma;
}

/** Os pedidos que já têm linha na PEDIDOS — inclusive os irmãos, separados por barra. */
function pedidosNaPlanilhaPainel_() {
  var out = {};
  try {
    var v = SpreadsheetApp.openById(CTRL_PAINEL).getSheetByName('PEDIDOS')
      .getRange('C2:C').getValues();
    v.forEach(function (l) {
      String(l[0] || '').split(/[\/,;\n]+/).forEach(function (n) {
        n = n.trim();
        if (/^\d{6,}$/.test(n)) out[n] = true;
      });
    });
  } catch (e) {}
  return out;
}

function pedidosRecentesMlPainel_(loja, token, seller) {
  // com janela 0, parte da meia-noite de hoje
  var desde = new Date(Date.now() - JANELA_DIAS_PAINEL * 86400000);
  var iso = Utilities.formatDate(desde, 'GMT-3', "yyyy-MM-dd'T'00:00:00.000-03:00");
  var todos = [];

  for (var off = 0; off < 500; off += 50) {
    var r = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/orders/search?seller=' + seller +
      '&order.status=paid' +
      // o filtro que resolve: só o que ainda não saiu
      '&shipping.status=' + STATUS_ENVIO_ABERTO_PAINEL +
      '&sort=date_desc&order.date_created.from=' +
      encodeURIComponent(iso) + '&limit=50&offset=' + off,
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) break;
    var d = JSON.parse(r.getContentText());
    var lista = d.results || [];
    lista.forEach(function (p) { todos.push(p); });
    if (lista.length < 50) break;
  }
  return todos;
}

/**
 * O TETO DE PESO POR VOLUME
 *   O peso máximo que a transportadora aceita numa embalagem só. A extensão
 *   do computador sempre aplicou isso; o painel não aplicava, e a mesma
 *   porta era cotada com peso diferente nos dois. Igualado em 19/09/2026.
 *
 *   São 25 kg: é o que a transportadora aceita por embalagem, e é o que o
 *   Jonas quer declarar mesmo nos 18 SKUs que pesam 26 ou 28 na tabela.
 *
 *   O mesmo número está no sidepanel.js da extensão, em TETO_PESO_VOLUME.
 */
var TETO_PESO_VOLUME_PAINEL = 25;

/** Soma peso e cubagem dos itens, pela tabela do TABELAS_PAINEL.gs. */
function cargaDosItensPainel_(itens) {
  var peso = 0, cub = 0, vol = 0, semPeso = [];
  itens.forEach(function (it) {
    var d = PESO_SKU_PAINEL[it.sku];
    if (!d) { semPeso.push(it.sku || '?'); return; }
    // o teto é POR UNIDADE, antes de multiplicar pela quantidade
    peso += Math.min(d.p, TETO_PESO_VOLUME_PAINEL) * it.qtd;
    cub += (d.l / 100) * (d.a / 100) * (d.e / 100) * it.qtd;
    vol += it.qtd;
  });
  /**
   * AS MEDIDAS DO MAIOR VOLUME
   *   Para a cotação por WhatsApp da CWLog e da Modular, que pedem
   *   "MEDIDAS DOS VOLUMES" em metros. Quando há mais de um item, vai a
   *   medida do maior — é a que manda no caminhão.
   */
  var maior = null;
  itens.forEach(function (it) {
    var d = PESO_SKU_PAINEL[it.sku];
    if (!d) return;
    var cubUm = d.l * d.a * d.e;
    if (!maior || cubUm > maior.cub) maior = { l: d.l, a: d.a, e: d.e, cub: cubUm };
  });

  return {
    peso: Math.round(peso * 100) / 100,
    cubagem: Math.round(cub * 10000) / 10000,
    volumes: vol || itens.reduce(function (a, x) { return a + x.qtd; }, 0),
    semPeso: semPeso,
    medidas: maior
      ? { l: maior.l / 100, a: maior.a / 100, e: maior.e / 100 }
      : null
  };
}


// ===========================================================================
// O NOME E O CPF DO COMPRADOR
//
//   O Mercado Livre NÃO devolve o nome real na busca de pedidos. O que vem em
//   buyer.first_name/last_name é o apelido, ou nada — por isso a lista
//   mostrava coisas como "JONA1234" em vez de "João da Silva".
//
//   O nome verdadeiro e o CPF estão no billing_info, que é uma chamada por
//   pedido. Fazer isso já na listagem custa uma chamada a mais por pedido,
//   mas são poucos pedidos em aberto e o resultado fica em cache por 6 horas
//   — nome e CPF de pedido não mudam.
//
//   A ordem de tentativa:
//     1. billing_info — o titular da nota, é o que vale
//     2. o nome de quem recebe, do envio — também é nome real
//     3. buyer.first_name + last_name
//     4. o apelido, por último
// ===========================================================================

function painelNomeCpf_(loja, pedidoId, envioId, pedidoBruto) {
  var cache = CacheService.getScriptCache();

  /**
   * A CHAVE TEM VERSÃO
   *   O resultado fica 6 horas em cache. Quando a ordem das fontes muda, o
   *   que está guardado vira mentira — foi o que aconteceu em 17/09: ficou
   *   gravado "sem CPF" de antes do Bling entrar, e a tela continuou sem.
   *   Subir o número aqui joga fora tudo que estava guardado.
   */
  var k = 'painel_nc3_' + pedidoId;
  var c = cache.get(k);
  if (c) return JSON.parse(c);

  var token = painelTokenML_(loja);
  var h = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  var h2 = { headers: { Authorization: 'Bearer ' + token, 'x-version': '2' },
             muteHttpExceptions: true };
  /**
   * SÃO DOIS NOMES, e cada um serve a uma coisa
   *
   *   nome ...... o do comprador, como aparece na tela do Mercado Livre:
   *               "Neria Souza". É o que a lista mostra, para você achar o
   *               pedido lá sem se perder.
   *
   *   nomeNota .. o do titular no faturamento: "Neria Maria de Souza". É o
   *               que vai no e-mail, porque é o nome que entra na nota.
   */
  var out = { nome: '', cpf: '', origem: '', cpfOrigem: '', nomeNota: '' };

  /**
   * O NOME É O DO COMPRADOR, NÃO O DE QUEM RECEBE
   *
   *   São pessoas diferentes com frequência: a Creche Referência recebe, mas
   *   quem comprou foi a Renata Maio — e é "Renata Maio" que aparece na tela
   *   do Mercado Livre. Mostrar o destinatário faz você procurar por um nome
   *   que não existe lá.
   *
   *   Ordem: o comprador no pedido, o titular do faturamento, o contato do
   *   Bling, e só em último caso quem recebe.
   *
   * O CPF
   *   As três rotas de faturamento do ML respondem 403 PolicyAgent desde
   *   17/09 — falta Permissão funcional no aplicativo. Enquanto isso, o
   *   documento vem do Bling, que importa o pedido com o contato completo.
   */

  // ---- 1) o pedido: o comprador, o carrinho e o id do faturamento ----
  var billingId = '', packId = '';
  try {
    var rp = UrlFetchApp.fetch('https://api.mercadolibre.com/orders/' + pedidoId, h);
    if (rp.getResponseCode() === 200) {
      var o = JSON.parse(rp.getContentText());
      var b = o.buyer || {};
      if (b.billing_info && b.billing_info.id) billingId = String(b.billing_info.id);
      if (o.pack_id) packId = String(o.pack_id);

      var n = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
      if (n) { out.nome = n; out.origem = 'comprador'; }
      else if (b.nickname) { out.nome = b.nickname; out.origem = 'apelido'; }

      var id0 = b.identification || {};
      if (id0.number) { out.cpf = String(id0.number).replace(/\D/g, ''); out.cpfOrigem = 'pedido'; }
    }
  } catch (e1) {}

  // ---- 2) o recurso novo de faturamento ----
  if (billingId && (!out.cpf || out.origem === 'apelido')) {
    try {
      var rb = UrlFetchApp.fetch(
        'https://api.mercadolibre.com/orders/billing-info/MLB/' + billingId, h);
      if (rb.getResponseCode() === 200) {
        var achado = lerBillingPainel_(JSON.parse(rb.getContentText()));
        if (achado.nome) out.nomeNota = achado.nome;      // o nome da nota
        if (achado.nome && (!out.nome || out.origem === 'apelido')) {
          out.nome = achado.nome; out.origem = 'faturamento';
        }
        if (achado.cpf && !out.cpf) { out.cpf = achado.cpf; out.cpfOrigem = 'faturamento'; }
      }
    } catch (e2) {}
  }

  // ---- 3) o legado, enquanto ainda responder ----
  if (!out.cpf) {
    try {
      var r = UrlFetchApp.fetch(
        'https://api.mercadolibre.com/orders/' + pedidoId + '/billing_info', h2);
      if (r.getResponseCode() === 200) {
        var velho = lerBillingPainel_(JSON.parse(r.getContentText()));
        if (velho.nome && !out.nomeNota) out.nomeNota = velho.nome;
        if (velho.cpf) { out.cpf = velho.cpf; out.cpfOrigem = 'billing_info legado'; }
        if (velho.nome && (!out.nome || out.origem === 'apelido')) {
          out.nome = velho.nome; out.origem = 'billing_info legado';
        }
      }
    } catch (e3) {}
  }

  // ---- 4) o Bling, que hoje é quem entrega o documento ----
  if ((!out.cpf || !out.nome || out.origem === 'apelido') && USAR_BLING_CPF_PAINEL) {
    var doBling = cpfDoBlingPainel_(loja, pedidoId, packId);
    if (doBling.cpf && !out.cpf) { out.cpf = doBling.cpf; out.cpfOrigem = 'bling'; }
    // o Bling devolve "Fulano De Tal (apelidoml)" — o apelido não vai na nota
    if (doBling.nome && !out.nomeNota) {
      out.nomeNota = String(doBling.nome).replace(/\s*\([^)]*\)\s*$/, '').trim();
    }
    if (doBling.nome && (!out.nome || out.origem === 'apelido')) {
      out.nome = doBling.nome; out.origem = 'bling';
    }
  }

  // ---- 5) quem recebe, só se nada mais deu nome ----
  if (!out.nome && envioId) {
    try {
      var rs = UrlFetchApp.fetch('https://api.mercadolibre.com/shipments/' + envioId, h);
      if (rs.getResponseCode() === 200) {
        var a = (JSON.parse(rs.getContentText()).receiver_address) || {};
        if (a.receiver_name) { out.nome = a.receiver_name; out.origem = 'quem recebe'; }
      }
    } catch (e4) {}
  }

  if (!out.nome && pedidoBruto && pedidoBruto.buyer && pedidoBruto.buyer.nickname) {
    out.nome = pedidoBruto.buyer.nickname; out.origem = 'apelido';
  }
  if (!out.nome) { out.nome = 'Comprador'; out.origem = 'nenhuma'; }

  out.nome = arrumarCaixaPainel_(out.nome);
  out.nomeNota = arrumarCaixaPainel_(out.nomeNota || out.nome);

  /**
   * QUANTO TEMPO GUARDAR
   *
   *   Completo, guarda 6 horas: nome e CPF de pedido não mudam.
   *
   *   FALTANDO O CPF, guarda só 15 minutos. O documento vem do Bling, e o
   *   Bling leva um tempo para importar a venda do Mercado Livre — pedido
   *   feito agora ainda não está lá. Guardando "sem CPF" por 6 horas, o
   *   painel continuaria dizendo que não tem documento a tarde inteira,
   *   mesmo depois de o Bling ter importado. Foi o que aconteceu em 18/09
   *   com dois pedidos da manhã.
   */
  cache.put(k, JSON.stringify(out), out.cpf ? 21600 : 900);
  return out;
}


// ===========================================================================
// O CPF PELO BLING
// ===========================================================================

/**
 * Procura o pedido no Bling e devolve o documento do contato.
 *
 *   O mapa numeroLoja -> id do pedido fica em cache por 6 horas: montá-lo
 *   custa várias páginas da API deles, e não vale refazer a cada toque na
 *   tela. Pedido novo que ainda não estava no mapa aparece na próxima
 *   renovação — ou você força com painelLimparCacheBling_().
 */
function cpfDoBlingPainel_(loja, pedidoId, packId) {
  var out = { cpf: '', nome: '' };
  var token;
  try { token = getBlingAccessToken_(loja); } catch (e) { return out; }
  if (!token) return out;

  var mapa = mapaBlingPainel_(loja, token);
  var id = mapa[String(pedidoId)] || (packId ? mapa[String(packId)] : null);

  /**
   * PEDIDO NOVO NÃO ESTÁ NO MAPA GUARDADO
   *
   *   O mapa numeroLoja -> id fica 6 horas em cache, porque montá-lo custa
   *   várias páginas da API do Bling. Só que venda feita agora é importada
   *   pelo Bling depois — e o mapa guardado não a tem, então o painel dizia
   *   "sem CPF" o resto do dia.
   *
   *   Quando o pedido não aparece, vale refazer o mapa. Mas só uma vez a
   *   cada 10 minutos: senão, um pedido que realmente não está lá faria o
   *   painel remontar tudo a cada toque na tela.
   */
  if (!id) {
    var cache = CacheService.getScriptCache();
    var trava = 'bling_refeito_' + loja;
    if (!cache.get(trava)) {
      cache.put(trava, '1', 600);
      mapa = mapaBlingPainel_(loja, token, true);
      id = mapa[String(pedidoId)] || (packId ? mapa[String(packId)] : null);
    }
  }
  if (!id) return out;

  try {
    var r = UrlFetchApp.fetch('https://api.bling.com.br/Api/v3/pedidos/vendas/' + id, {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return out;
    var d = JSON.parse(r.getContentText()).data || {};
    var c = d.contato || {};
    if (c.numeroDocumento) out.cpf = String(c.numeroDocumento).replace(/\D/g, '');
    if (c.nome) out.nome = String(c.nome);
  } catch (e) {}
  return out;
}

/** numeroLoja -> id do pedido, de todos os pedidos dos últimos 90 dias. */
function mapaBlingPainel_(loja, token, forcar) {
  var cache = CacheService.getScriptCache();
  var k = 'painel_bling_' + loja;
  if (!forcar) {
    var c = cache.get(k);
    if (c) { try { return JSON.parse(c); } catch (e) {} }
  }

  var mapa = {};
  var hoje = new Date();
  var inicio = new Date(hoje.getTime() - 90 * 86400000);
  var fmt = function (d) { return Utilities.formatDate(d, 'GMT-3', 'yyyy-MM-dd'); };

  /**
   * PÁGINA QUE FALHA É REPETIDA, NÃO PULADA
   *
   *   O Bling limita a três chamadas por segundo e devolve 429 quando passa.
   *   A versão anterior fazia "continue" nesse caso — e continue AVANÇA a
   *   página, perdendo 100 pedidos em silêncio. Se a página perdida fosse a
   *   dos mais recentes, a venda de hoje sumia do mapa e o painel dizia que
   *   o Bling não tinha o pedido.
   *
   *   Agora a mesma página é tentada de novo, até três vezes.
   */
  for (var pagina = 1; pagina <= 20; pagina++) {
    var lista = null;

    for (var tentativa = 1; tentativa <= 3; tentativa++) {
      var url = 'https://api.bling.com.br/Api/v3/pedidos/vendas?dataInicial=' + fmt(inicio) +
                '&dataFinal=' + fmt(hoje) + '&limite=100&pagina=' + pagina;
      var r;
      try {
        r = UrlFetchApp.fetch(url, {
          headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
      } catch (e) { Utilities.sleep(1500); continue; }

      if (r.getResponseCode() === 200) {
        try { lista = JSON.parse(r.getContentText()).data || []; } catch (e) { lista = []; }
        break;
      }
      Utilities.sleep(1500 * tentativa);
    }

    if (lista === null) break;          // três tentativas e nada: para por aqui
    if (!lista.length) break;           // acabou a lista
    lista.forEach(function (p) { if (p.numeroLoja) mapa[String(p.numeroLoja)] = p.id; });
    Utilities.sleep(400);
  }

  var txt = JSON.stringify(mapa);
  if (txt.length < 95000) cache.put(k, txt, 21600);
  return mapa;
}

/**
 * Mostra, para cada pedido aberto, se o Bling tem o pedido e qual documento
 * ele guarda. É o que diz se dá para contar com essa fonte enquanto o
 * Mercado Livre não libera a permissão.
 */
function painelDiagnosticoBling() {
  var lista = painelListarPedidos(true);
  if (!lista.length) { Logger.log('Nenhum pedido aberto.'); return; }

  Logger.log('O QUE O BLING TEM DOS PEDIDOS ABERTOS');
  Logger.log('');

  var mapas = {};
  lista.forEach(function (p) {
    if (!mapas[p.loja]) {
      var tk = null;
      try { tk = getBlingAccessToken_(p.loja); } catch (e) {}
      if (!tk) { Logger.log(p.lojaNome + ': sem token do Bling.'); mapas[p.loja] = {}; return; }
      mapas[p.loja] = mapaBlingPainel_(p.loja, tk);
      Logger.log(p.lojaNome + ': ' + Object.keys(mapas[p.loja]).length +
                 ' pedido(s) no Bling nos últimos 90 dias.');
    }
  });
  Logger.log('');

  lista.forEach(function (p) {
    var pedido = p.ids[0];
    var r = cpfDoBlingPainel_(p.loja, pedido, p.chave);
    Logger.log(p.lojaCurto + '  ' + p.cliente);
    Logger.log('   pedido ' + pedido + '   carrinho ' + p.chave);
    Logger.log('   no Bling: ' + ((mapas[p.loja] || {})[pedido] ? 'pelo número do pedido'
      : (mapas[p.loja] || {})[p.chave] ? 'pelo número do carrinho' : 'NÃO ACHEI'));
    Logger.log('   CPF: ' + (r.cpf || '(não veio)') +
               (r.nome ? '   contato: ' + r.nome : ''));
    Logger.log('');
    Utilities.sleep(400);
  });
}

/**
 * O QUE O BLING DEVOLVE DE VERDADE
 *
 *   O painel casa o pedido pelo campo numeroLoja — o número da venda no
 *   Mercado Livre. Em 18/09 o pedido da Inovar estava no Bling (nº 5390,
 *   Atendido) e mesmo assim o mapa não achava. Ou o campo tem outro nome, ou
 *   vem vazio, ou traz outro número.
 *
 *   Esta função mostra as últimas vendas cruas, campo a campo, para a gente
 *   ver com os próprios olhos.
 */
function painelDiagnosticoBlingCru(loja) {
  loja = loja || 'facil';
  var token = getBlingAccessToken_(loja);
  if (!token) { Logger.log('sem token do Bling para ' + loja); return; }

  var hoje = new Date();
  var inicio = new Date(hoje.getTime() - 7 * 86400000);
  var fmt = function (d) { return Utilities.formatDate(d, 'GMT-3', 'yyyy-MM-dd'); };

  var url = 'https://api.bling.com.br/Api/v3/pedidos/vendas?dataInicial=' + fmt(inicio) +
            '&dataFinal=' + fmt(hoje) + '&limite=10&pagina=1';
  var r = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });

  Logger.log('HTTP ' + r.getResponseCode() + '   últimos 7 dias, ' + loja);
  if (r.getResponseCode() !== 200) {
    Logger.log(r.getContentText().substring(0, 500));
    return;
  }

  var lista = [];
  try { lista = JSON.parse(r.getContentText()).data || []; } catch (e) {}
  Logger.log(lista.length + ' pedido(s) nesta página');
  Logger.log('');

  lista.forEach(function (p) {
    Logger.log('--- pedido ' + p.numero + ' ---');
    Logger.log('   ' + JSON.stringify(p).substring(0, 700));
    Logger.log('');
  });

  Logger.log('OLHE: existe campo numeroLoja? Está preenchido? Que número traz —');
  Logger.log('o da venda do Mercado Livre ou o do carrinho?');
}

/** Esquece o mapa do Bling, para pedido novo aparecer na hora. */
function painelLimparCacheBling_() {
  var cache = CacheService.getScriptCache();
  cache.remove('painel_bling_facil');
  cache.remove('painel_bling_domo');
  cache.remove('painel_pedidos');
  Logger.log('Cache do Bling e da lista limpo.');
}

/**
 * Esquece nome e CPF já lidos dos pedidos abertos, e a lista.
 * Use depois de mexer nas fontes, ou quando a tela mostrar algo velho.
 */
function painelLimparCacheNomes() {
  var cache = CacheService.getScriptCache();
  var lista = painelListarPedidos(true);
  var chaves = [];
  lista.forEach(function (p) {
    p.ids.forEach(function (id) { chaves.push('painel_nc3_' + id); });
  });
  if (chaves.length) cache.removeAll(chaves);
  cache.remove('painel_pedidos');
  Logger.log('Esquecidos ' + chaves.length + ' pedido(s). A próxima leitura busca de novo.');
}

/**
 * Lê os dados de faturamento em qualquer das formas que o ML usa.
 *
 *   O recurso novo devolve tudo dentro de buyer.billing_info, com o documento
 *   em identification.number e a razão social em name (pessoa jurídica não
 *   traz last_name). O legado devolvia campos soltos ou uma lista de
 *   additional_info com {type, value}. Em vez de apostar numa forma, procuro
 *   nas três.
 */
function lerBillingPainel_(j) {
  var out = { nome: '', cpf: '' };
  var bi = j || {};
  if (bi.buyer && bi.buyer.billing_info) bi = bi.buyer.billing_info;
  else if (bi.billing_info) bi = bi.billing_info;

  var primeiro = bi.first_name || bi.name || '';
  var ultimo = bi.last_name || '';
  var razao = bi.business_name || '';
  if (bi.doc_number) out.cpf = String(bi.doc_number).replace(/\D/g, '');

  (bi.additional_info || []).forEach(function (x) {
    var t = String(x.type || '').toUpperCase();
    var v = String(x.value == null ? '' : x.value).trim();
    if (!v) return;
    if (t === 'FIRST_NAME') primeiro = v;
    else if (t === 'LAST_NAME') ultimo = v;
    else if (t === 'BUSINESS_NAME' || t === 'NAME') razao = razao || v;
    else if ((t === 'DOC_NUMBER' || t === 'CPF' || t === 'CNPJ') && !out.cpf) {
      out.cpf = v.replace(/\D/g, '');
    }
  });

  // na versão 2 o documento vem em identification: { type, number }
  if (!out.cpf && bi.identification && bi.identification.number) {
    out.cpf = String(bi.identification.number).replace(/\D/g, '');
  }
  if (!out.nome && bi.identification && bi.identification.name) {
    razao = razao || bi.identification.name;
  }

  out.nome = [primeiro, ultimo].filter(Boolean).join(' ').trim() || razao;
  return out;
}

/** O ML manda tudo em maiúsculas. Deixa em caixa de nome próprio. */
function arrumarCaixaPainel_(nome) {
  var s = String(nome || '').trim();
  if (!s) return s;
  if (s !== s.toUpperCase()) return s;          // já veio misturado, não mexe
  var miudas = ['DA', 'DE', 'DO', 'DAS', 'DOS', 'E'];
  return s.toLowerCase().split(/\s+/).map(function (p, i) {
    if (i > 0 && miudas.indexOf(p.toUpperCase()) >= 0) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(' ');
}

/**
 * Para quando o nome ou o CPF não vierem: despeja a resposta crua do
 * billing_info no log, para a gente ver em que forma o ML mandou.
 */
function painelDiagnosticoComprador(loja, pedidoId) {
  loja = loja || 'facil';
  if (!pedidoId) {
    var lista = painelListarPedidos(true);
    if (!lista.length) { Logger.log('Nenhum pedido aberto para diagnosticar.'); return; }
    loja = lista[0].loja; pedidoId = lista[0].ids[0];
    Logger.log('usando o primeiro pedido aberto: ' + pedidoId);
  }
  var token = painelTokenML_(loja);
  var h = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };

  // ---- 1) o pedido: é dele que sai o id do faturamento ----
  Logger.log('--- 1) o pedido, campo buyer ---');
  var billingId = '', packId = '';
  var rp = UrlFetchApp.fetch('https://api.mercadolibre.com/orders/' + pedidoId, h);
  if (rp.getResponseCode() === 200) {
    try {
      var o = JSON.parse(rp.getContentText());
      Logger.log(JSON.stringify(o.buyer));
      if (o.buyer && o.buyer.billing_info) billingId = String(o.buyer.billing_info.id || '');
      if (o.pack_id) packId = String(o.pack_id);
      Logger.log('carrinho (pack_id): ' + (packId || '(não tem)'));
    } catch (e) { Logger.log('não deu para ler.'); }
  } else {
    Logger.log('HTTP ' + rp.getResponseCode());
  }
  Logger.log('billing_info.id: ' + (billingId || '(não veio)'));
  Logger.log('');

  // ---- 2) o recurso novo ----
  Logger.log('--- 2) /orders/billing-info/MLB/{id} — o caminho novo ---');
  if (billingId) {
    var rb = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/orders/billing-info/MLB/' + billingId, h);
    Logger.log('HTTP ' + rb.getResponseCode());
    Logger.log(rb.getContentText().substring(0, 1200));
    try { Logger.log('lido: ' + JSON.stringify(lerBillingPainel_(JSON.parse(rb.getContentText())))); }
    catch (e) { Logger.log('não deu para ler.'); }
  } else {
    Logger.log('sem id, não dá para consultar.');
  }
  Logger.log('');

  // ---- 3) o envio ----
  Logger.log('--- 3) /shipments/{id}/billing_info ---');
  var lista = painelListarPedidos(false);
  var envio = '';
  lista.forEach(function (x) { if (x.ids.indexOf(String(pedidoId)) >= 0) envio = x.envioId; });
  if (envio) {
    var rs = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/shipments/' + envio + '/billing_info', h);
    Logger.log('HTTP ' + rs.getResponseCode());
    Logger.log(rs.getContentText().substring(0, 800));
  } else {
    Logger.log('não achei o envio deste pedido na lista.');
  }
  Logger.log('');

  // ---- 4) o legado ----
  Logger.log('--- 4) /orders/{id}/billing_info com x-version: 2 — o legado ---');
  var rv = UrlFetchApp.fetch(
    'https://api.mercadolibre.com/orders/' + pedidoId + '/billing_info',
    { headers: { Authorization: 'Bearer ' + token, 'x-version': '2' },
      muteHttpExceptions: true });
  Logger.log('HTTP ' + rv.getResponseCode() + '   ' + rv.getContentText().substring(0, 600));
  Logger.log('');

  Logger.log('--- 5) o Bling, que hoje é quem entrega o CPF ---');
  try {
    var tkB = getBlingAccessToken_(loja);
    if (!tkB) {
      Logger.log('sem token do Bling.');
    } else {
      var mapaB = mapaBlingPainel_(loja, tkB, true);   // refaz, para pegar venda nova
      var chaves = Object.keys(mapaB);
      Logger.log(chaves.length + ' pedido(s) no Bling nos últimos 90 dias.');

      var idB = mapaB[String(pedidoId)] || (packId ? mapaB[String(packId)] : null);
      Logger.log('pelo número do pedido (' + pedidoId + '): ' +
                 (mapaB[String(pedidoId)] || 'não achei'));
      if (packId) {
        Logger.log('pelo número do carrinho (' + packId + '): ' +
                   (mapaB[String(packId)] || 'não achei'));
      }

      if (idB) {
        Logger.log(JSON.stringify(cpfDoBlingPainel_(loja, pedidoId, packId)));
      } else {
        // mostra os maiores números, que são as vendas mais recentes: assim
        // dá para ver se o formato bate e até onde o mapa alcançou
        var recentes = chaves.filter(function (x) { return /^\d{10,}$/.test(x); })
                             .sort().slice(-6);
        Logger.log('as vendas mais recentes que o mapa tem:');
        recentes.forEach(function (x) { Logger.log('   ' + x + '   id ' + mapaB[x]); });
        Logger.log('se o número deste pedido for MAIOR que todos acima, o Bling');
        Logger.log('ainda não importou. Se estiver no meio da faixa, o mapa é que');
        Logger.log('perdeu uma página.');
      }
    }
  } catch (e) {
    Logger.log('erro ao consultar o Bling: ' + e.message);
  }
  Logger.log('');

  Logger.log('--- o que o painel montaria ---');
  Logger.log(JSON.stringify(painelNomeCpf_(loja, pedidoId, envio, null)));
}


// ===========================================================================
// 2) O DETALHE — endereço, e o CPF que a lista já achou
// ===========================================================================

function painelDetalhe(loja, pedidoId, envioId) {
  /**
   * GUARDADO POR UMA HORA
   *   Endereço de entrega não muda depois da compra. Sem isso, cada abertura
   *   de pedido no aplicativo repetia a consulta ao Mercado Livre — e com o
   *   endereço vindo junto da lista, seriam oito consultas a cada abertura.
   */
  var cacheD = CacheService.getScriptCache();
  /**
   * A CHAVE TEM VERSÃO
   *   O endereço fica guardado por uma hora. Quando um campo novo entra —
   *   como o frete pago pelo comprador, em 19/09 — o que está guardado não
   *   tem esse campo, e o painel continua mostrando zero mesmo com o código
   *   certo. Subir o número aqui joga fora o antigo.
   */
  var chaveD = 'painel_det2_' + pedidoId;
  var guardadoD = cacheD.get(chaveD);
  if (guardadoD) { try { return JSON.parse(guardadoD); } catch (eD) {} }

  var token = painelTokenML_(loja);
  var h = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  var out = { endereco: '', cidade: '', uf: '', cep: '', cpf: '', telefone: '', recebe: '' };

  // o endereço vem do envio
  if (envioId) {
    var r = UrlFetchApp.fetch('https://api.mercadolibre.com/shipments/' + envioId, h);
    if (r.getResponseCode() === 200) {
      var e = JSON.parse(r.getContentText());
      var a = e.receiver_address || {};
      out.endereco = [a.street_name, a.street_number].filter(Boolean).join(' ');
      out.complemento = a.comment || '';
      out.bairro = (a.neighborhood && a.neighborhood.name) || '';
      out.estadoNome = (a.state && a.state.name) || '';
      out.cidade = (a.city && a.city.name) || '';
      out.uf = String((a.state && a.state.id) || '').replace('BR-', '');
      out.cep = String(a.zip_code || '').replace(/\D/g, '');
      out.recebe = a.receiver_name || '';
      out.telefone = a.receiver_phone || '';
      out.envioStatus = e.status;

      /**
       * O FRETE QUE O COMPRADOR PAGOU
       *
       *   Conferido em 19/09 nos pedidos abertos: base_cost do envio traz o
       *   valor certo — R$ 350, 149, 99, 149 — e bate com receiver.cost em
       *   /shipments/{id}/costs.
       *
       *   NÃO está no pedido. paid_amount menos total_amount dava zero em
       *   metade das vendas, e a da Renata, com frete pago, aparecia como
       *   frete grátis. O envio é me1 (próprio), e nesse modo o valor mora
       *   só aqui.
       */
      var opcao = e.shipping_option || {};
      out.freteComprador = Number(e.base_cost || 0) ||
                           Number(opcao.cost || 0) || 0;
    }
  }

  // o CPF já foi buscado na listagem e está em cache — aproveita
  var quem = painelNomeCpf_(loja, pedidoId, envioId, null);
  out.cpf = quem.cpf || '';
  out.nomeReal = quem.nome || '';
  out.nomeNota = quem.nomeNota || quem.nome || '';
  out.origemNome = quem.origem || '';

  // só guarda quando veio completo: endereço pela metade não vale a pena
  if (out.cep && out.cidade) {
    try { cacheD.put(chaveD, JSON.stringify(out), 3600); } catch (eG) {}
  }
  return out;
}


// ===========================================================================
// 3) COTAR — quem atende, e quanto
// ===========================================================================

/**
 * A RODONAVES SÓ QUANDO VOCÊ PEDIR
 *
 *   Ela é a única fora do SSW: servidor instável, repetições, e na maioria
 *   dos destinos não é ela que ganha. Deixá-la na leva automática fazia toda
 *   cotação esperar por ela.
 *
 *   Agora as cinco do SSW cotam sozinhas e ela aparece com um botão. Quando
 *   quiser, você toca e ela cota — normalmente em destinos onde as outras
 *   recusaram ou saíram caras.
 */
function painelCotar(pedido, destino, comRodonaves) {
  var uf = String(destino.uf || '').toUpperCase();
  var cidade = normalizarCidadePainel_(destino.cidade);
  var cep = String(destino.cep || '').replace(/\D/g, '');
  var doc = String(destino.cpf || pedido.cpf || '').replace(/\D/g, '');

  var resultado = { cotadas: [], manuais: [], recusadas: [], avisos: [] };

  if (!cep || !uf) {
    resultado.avisos.push('Pedido sem CEP ou UF no endereço de entrega.');
    return resultado;
  }
  if (!doc) {
    resultado.avisos.push('Sem o CPF do comprador. A TW recusa cotação sem ' +
      'documento, e a Rodonaves cota sem número de protocolo.');
  }
  if (pedido.skuSemPeso && pedido.skuSemPeso.length) {
    resultado.avisos.push('SKU sem peso na tabela: ' + pedido.skuSemPeso.join(', ') +
      '. A cotação usou só o que tinha.');
  }

  var dadosCarga = {
    cepDestino: cep, valorNF: pedido.total, quantidade: pedido.volumes || 1,
    peso: pedido.peso, volume: pedido.cubagem, cnpjDestinatario: doc
  };

  // ---- 1) quem entra, e o que cada uma precisa ----
  var fila = [];          // o que vai ser disparado junto

  TRANSPORTADORAS_PAINEL.forEach(function (t) {
    if (atendePainel_(t.id, uf, cidade) === false) return;

    if (t.ssw) {
      fila.push({ t: t, tipo: 'ssw', req: montarPedidoSswPainel_(t, dadosCarga) });
      return;
    }

    if (t.api === 'rodonaves') {
      if (!comRodonaves) {
        /**
         * ELA FICA NA LISTA, SEM PREÇO
         *   Não é "cotar por fora" — isso significa cotar no sistema dela e
         *   digitar aqui. Ela cota sozinha, só não na mesma hora que as
         *   outras, porque é lenta e fazia todo mundo esperar. Então aparece
         *   junto das concorrentes, sem valor, até você tocar.
         */
        resultado.sobDemanda = (resultado.sobDemanda || []).concat([{ t: t.id }]);
        return;
      }
      var pedidoRn = montarPedidoRodonavesPainel_(pedido, destino, doc);
      if (pedidoRn.erro) {
        // sem token ou sem cidade: cai para digitar à mão, em vez de sumir
        resultado.manuais.push({ t: t.id, obs: pedidoRn.erro });
      } else {
        fila.push({ t: t, tipo: 'rodonaves', req: pedidoRn.req, corpo: pedidoRn.corpo });
      }
      return;
    }

    resultado.manuais.push({ t: t.id, obs: obsPainel_(t) });
  });

  if (!fila.length) return resultado;

  /**
   * DUAS LEVAS, E NÃO UMA
   *
   *   O fetchAll é o que faz as transportadoras serem consultadas ao mesmo
   *   tempo em vez de uma de cada vez. Só que ele ESTOURA POR INTEIRO se uma
   *   única URL falhar no DNS — e em 18/09 foi o que aconteceu: a Rodonaves
   *   oscilou e derrubou a cotação das seis de uma vez, com "a consulta
   *   falhou por inteiro". Ficou pior que o modelo antigo, em que cada uma
   *   falhava sozinha.
   *
   *   Por isso as do SSW vão numa leva — são todas do mesmo servidor, que é
   *   estável — e a Rodonaves vai à parte, com repetição própria. Uma não
   *   derruba mais a outra.
   */
  var filaSsw = fila.filter(function (x) { return x.tipo === 'ssw'; });
  var filaRn  = fila.filter(function (x) { return x.tipo === 'rodonaves'; });

  // ---- 2) as do SSW, todas juntas ----
  if (filaSsw.length) {
    var respostas = fetchAllSeguroPainel_(filaSsw.map(function (x) { return x.req; }));
    filaSsw.forEach(function (x, i) {
      lerRespostaSswPainel_(x.t, respostas[i], resultado);
    });
  }

  // ---- 3) a Rodonaves, sozinha e com paciência ----
  filaRn.forEach(function (x) {
    var res = buscarComRepeticaoPainel_(x.req);
    if (!res) {
      resultado.manuais.push({ t: x.t.id, obs: 'a rede da Rodonaves não respondeu' });
      return;
    }
    lerRespostaRodonavesPainel_(x, res, resultado, pedido, destino, doc);
  });

  resultado.cotadas.sort(function (a, b) { return a.v - b.v; });
  if (resultado.cotadas.some(function (c) { return c.caro; }) &&
      UF_NORTE_NORDESTE_PAINEL.indexOf(uf) === -1) {
    resultado.avisos.push('Frete acima de R$ ' + TETO_ALERTA_PAINEL + ' para esta região.');
  }
  return resultado;
}


/**
 * Quando a resposta diz que não atende, mesmo trazendo valor.
 *
 *   A Azurelog calcula e devolve um preço AINDA QUE não atenda a região —
 *   junto com uma mensagem de "região não cadastrada". Olhar só o valor
 *   faria ela virar opção num destino que ela não faz, e o pedido sairia
 *   para uma transportadora que ia recusar a coleta.
 *
 *   Por isso a mensagem manda mais que o número.
 */
var RECUSA_NA_MENSAGEM_PAINEL = [
  // as frases exatas da Azurelog, vistas em 18/09 numa cotação para Lauro
  // de Freitas: ela devolveu R$ 347,38, GRIS, TAS, rota e número de cotação,
  // com este aviso por cima
  'nao e atendida',
  'nao atende a rota',
  // e as variações que as outras usam
  'nao atendid', 'nao cadastrad', 'nao atende', 'fora de area',
  'fora da area', 'sem atendimento', 'localidade nao'
];

function recusouNaMensagemPainel_(msg) {
  // limpa as entidades ANTES de comparar, senão "N&Atilde;O" não bate com
  // nenhuma frase da lista
  var m = limparMsgSswPainel_(msg)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  var achou = false;
  RECUSA_NA_MENSAGEM_PAINEL.forEach(function (x) {
    if (m.indexOf(x) !== -1) achou = true;
  });
  return achou;
}

/**
 * fetchAll que não derruba tudo quando uma URL falha.
 *
 *   Se a leva estourar, refaz uma por uma — mais lento, mas só acontece
 *   quando algo já deu errado. Devolve sempre um array do mesmo tamanho, com
 *   null onde não houve resposta.
 */
function fetchAllSeguroPainel_(reqs) {
  try {
    return UrlFetchApp.fetchAll(reqs);
  } catch (e) {
    return reqs.map(function (r) {
      try { return UrlFetchApp.fetch(r.url, r); } catch (e2) { return null; }
    });
  }
}

/** Uma chamada, com três tentativas, para host que oscila. */
function buscarComRepeticaoPainel_(req) {
  for (var i = 1; i <= 3; i++) {
    try {
      return UrlFetchApp.fetch(req.url, req);
    } catch (e) {
      if (i < 3) Utilities.sleep(700 * i);
    }
  }
  return null;
}

/** Interpreta o que o SSW devolveu e põe no lugar certo do resultado. */
function lerRespostaSswPainel_(t, res, resultado) {
  var r = lerSswPainel_(res);
  var valor = Number(r.dados.totalFrete) || 0;
  var recado = limparMsgSswPainel_(r.mensagem);

  // valor não vale nada se a mensagem disser que não atende
  if (recusouNaMensagemPainel_(recado)) {
    resultado.recusadas.push({
      t: t.id, erro: r.erro,
      msg: recado + (valor > 0 ? '   (devolveu R$ ' + valor.toFixed(2) +
                                 ', mas não atende)' : '')
    });
    return;
  }

  /**
   * FRETE ZERO NÃO É COTAÇÃO
   *   Em 17/09 a Azurelog respondeu erro 1 com frete vazio para Lauro de
   *   Freitas, e o painel mostrou "R$ 0,00" como se fosse preço. O erro 1 é
   *   aviso, não sucesso: ela calculou e não tem tarifa para lá.
   */
  if ((r.erro === '0' || r.erro === '1') && valor > 0) {
    resultado.cotadas.push({
      t: t.id,
      v: valor,
      prazo: Number(r.dados.diasUteis || r.dados.prazo) || null,
      previsao: r.dados.dataPrevisao || '',
      cotacao: r.dados.cotacao || '',
      token: r.dados.token || '',
      pesoCalculo: r.dados.pesoCalculo || '',
      obs: obsPainel_(t),
      caro: valor > TETO_ALERTA_PAINEL
    });
  } else if (r.erro === '0' || r.erro === '1') {
    resultado.recusadas.push({
      t: t.id, erro: r.erro,
      msg: recado || 'respondeu sem valor de frete',
      cru: JSON.stringify(r.dados).substring(0, 300)
    });
  } else {
    resultado.recusadas.push({ t: t.id, erro: r.erro, msg: recado });
  }
}


// ===========================================================================
// A RODONAVES
// ===========================================================================

/**
 * Monta o pedido de cotação da Rodonaves, para entrar na leva do fetchAll.
 *
 *   Antes disso precisa de duas coisas que ficam em cache e quase nunca são
 *   buscadas: o token, que vale 5 horas, e o id da cidade de destino, que
 *   não muda nunca. O id da cidade de origem é constante.
 */
function montarPedidoRodonavesPainel_(pedido, destino, doc) {
  /**
   * O CAMINHO DO PORTAL, e não o da documentação
   *
   *   Provado em 19/09: o gera-cotacao da documentação recusava metade dos
   *   destinos com "Não localizado CEP para entrega da mercadoria", mesmo em
   *   cidades que a Rodonaves atende — e exigia consultar id de cidade e
   *   cadastrar o comprador antes, o que quebrava de outras formas.
   *
   *   O portal deles usa outra API: rodonaves.com.br/api/quotations/create.
   *   Sem token, sem id de cidade, sem cadastro. Manda os endereços dos dois
   *   lados e a carga. Campo Limpo Paulista, que o outro caminho recusava,
   *   cotou R$ 147,61 com protocolo 222877594 no primeiro teste.
   *
   *   Quando não há rota, ela responde 409 dizendo isso com todas as letras,
   *   em vez de inventar erro de CEP.
   */
  var cep = String(destino.cep || '').replace(/\D/g, '');
  if (!cep) return { erro: 'pedido sem CEP de entrega' };

  var rua = String(destino.endereco || '');
  var numero = (rua.match(/(\d+)\s*$/) || [])[1] || 'S/N';
  rua = rua.replace(/\s*\d+\s*$/, '').trim();

  var documento = String(doc || '').replace(/\D/g, '');

  var corpo = {
    origin: { zipCode: CEP_ORIGEM_PAINEL },
    originAddress: ORIGEM_PORTAL_RNR,
    destination: { zipCode: cep },
    destinationAddress: {
      street: rua,
      number: numero,
      district: destino.bairro || ''
    },
    // 1 = pessoa física, 2 = jurídica; CNPJ tem 14 dígitos
    recipientPersonType: documento.length > 11 ? 2 : 1,
    senderTaxId: CNPJ_FACIL_PAINEL,
    receiverTaxId: documento,

    /**
     * OS DOIS CAMPOS DO PORTAL — vão SEMPRE
     *
     *   Testado em 23/09 nos pedidos de Brasília, Maringá e Salto, quatro
     *   formas cada:
     *     sem os dois .................. 409 em todos
     *     só o nome do destinatário .... 409 em todos
     *     só registerReceiverCustomer .. 400, "informe o nome do destinatário"
     *     com os dois .................. COTOU nos três
     *
     *   Cheguei a escrever uma versão que tentava primeiro sem eles, para
     *   ganhar tempo. Não ganha: a chamada sem os campos falha sempre e
     *   ainda é lenta — um dos 409 levou 54 segundos. Mandar os dois de
     *   cara é mais rápido e mais simples.
     */
    receiverDescription: String(destino.nomeNota || destino.nomeReal ||
                                destino.recebe || '').trim(),
    registerReceiverCustomer: true,
    invoiceValue: Number(pedido.total) || 0,
    totalWeightKg: Number(pedido.peso) || 0,
    volumeCount: Number(pedido.volumes) || 1,
    contactName: RODONAVES_PAINEL.contatoNome,
    contactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
  };

  return {
    corpo: corpo,
    req: {
      url: 'https://rodonaves.com.br/api/quotations/create',
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(corpo),
      muteHttpExceptions: true
    }
  };
}


/** Lê a resposta da Rodonaves; se faltar o cadastro do cliente, faz e repete. */
function lerRespostaRodonavesPainel_(x, res, resultado, pedido, destino, doc) {
  if (!res) {
    resultado.manuais.push({ t: 'RODONAVES', obs: 'a rede da Rodonaves não respondeu' });
    return;
  }

  var codigo = res.getResponseCode();
  var texto = res.getContentText();

  /**
   * 409 É RECUSA HONESTA
   *   "Nenhum serviço de frete disponível para esta rota." Acontece em
   *   Florianópolis, por exemplo — território da Sinil. Vai para "não
   *   atendem", sem campo para digitar: não adianta cotar no portal, porque
   *   é o mesmo sistema respondendo.
   */
  /**
   * AGORA O 409 É RECUSA DE VERDADE
   *   Com os dois campos do portal indo sempre, o que sobra de 409 é rota
   *   que ela não faz mesmo — como Florianópolis, que é território da Sinil.
   */
  if (codigo === 409) {
    var motivo = 'não atende essa rota';
    try { motivo = JSON.parse(texto).detail || motivo; } catch (e409) {}
    resultado.recusadas.push({ t: 'RODONAVES', erro: '409', msg: motivo });
    return;
  }

  if (codigo !== 200) {
    var recado = texto.replace(/\s+/g, ' ').substring(0, 200);
    try {
      var j = JSON.parse(texto);
      recado = j.detail || j.title || j.Message || recado;
    } catch (eJ) {}
    resultado.manuais.push({ t: 'RODONAVES', obs: recadoCurtoRn_(recado) });
    return;
  }

  try {
    var d = JSON.parse(texto);
    var dados = d.data || d;
    var servico = (dados.services || [])[0];

    if (!servico || !servico.price) {
      resultado.manuais.push({ t: 'RODONAVES', obs: 'respondeu sem valor' });
      return;
    }
    if (servico.hasError) {
      resultado.recusadas.push({ t: 'RODONAVES', erro: '200',
                                 msg: servico.errorMessage || 'recusou a rota' });
      return;
    }

    var valor = Number(servico.price);
    resultado.cotadas.push({
      t: 'RODONAVES',
      v: valor,
      prazo: servico.deliveryDays || null,
      cotacao: dados.protocolNumber || '',
      obs: servico.isAerial ? 'aéreo' : '',
      caro: valor > TETO_ALERTA_PAINEL
    });
  } catch (e) {
    resultado.manuais.push({ t: 'RODONAVES', obs: 'resposta ilegível' });
  }
}


/**
 * A recusa deles em uma linha.
 *
 *   O texto vem longo e com rodeio: "Não foi localizada uma unidade de
 *   atendimento para a cidade 834 - Luís Eduardo Magalhães. Entre em contato
 *   com sua unidade...". Na tela do celular isso vira ruído.
 */
function recadoCurtoRn_(m) {
  var t = String(m || '');
  if (/unidade de atendimento/i.test(t)) return 'não tem unidade nessa cidade';
  if (/localizado cep/i.test(t)) return 'não entrega nesse CEP';
  if (/destinat/i.test(t) && /encontrado/i.test(t)) return 'não consegui cadastrar o comprador';
  if (/n[ãa]o respondeu|inst[áa]vel/i.test(t)) return 'a rede da Rodonaves não respondeu';
  return t.substring(0, 120);
}

function tokenRodonavesPainel_() {
  var cache = CacheService.getScriptCache();
  var c = cache.get('rn_token');
  if (c) return c;

  _motivoTokenRn = '';

  for (var i = 1; i <= 3; i++) {
    try {
      var r = UrlFetchApp.fetch('https://quotation-apigateway.rte.com.br/token', {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: 'grant_type=password' +
                 '&username=' + encodeURIComponent(RODONAVES_PAINEL.user) +
                 '&password=' + encodeURIComponent(RODONAVES_PAINEL.senha) +
                 '&companyId=' + RODONAVES_PAINEL.empresa + '&auth_type=dev',
        muteHttpExceptions: true
      });

      if (r.getResponseCode() === 200) {
        var t = JSON.parse(r.getContentText()).access_token;
        if (t) { cache.put('rn_token', t, 14400); return t; }
        _motivoTokenRn = 'respondeu sem token';
        return null;
      }

      // erro de verdade não melhora repetindo
      _motivoTokenRn = 'token recusado, HTTP ' + r.getResponseCode();
      return null;

    } catch (e) {
      _motivoTokenRn = 'rede instável (' + String(e.message).substring(0, 60) + ')';
      if (i < 3) Utilities.sleep(900 * i);
    }
  }
  return null;
}

/**
 * O id da cidade pelo CEP, guardado por 24 horas.
 *
 *   A rota vive no dne-api. O quotation-apigateway devolve 404 nela, então
 *   não adianta tentar por lá. O DNS deles falha de vez em quando, por isso
 *   a segunda tentativa.
 */
function cidadeRodonavesPainel_(token, cep) {
  var cache = CacheService.getScriptCache();
  var k = 'rn_cidade_' + cep;
  var c = cache.get(k);
  if (c) return Number(c);

  _motivoCidadeRn = '';

  /**
   * DUAS ROTAS, E O PORQUÊ
   *
   *   A especificação deles põe essa consulta no dne-api. Só que cada API da
   *   Rodonaves tem token próprio, e o que a gente tem é o da cotação — às
   *   vezes ele serve ali, às vezes não. Além disso o DNS do dne-api falha
   *   de vez em quando.
   *
   *   Então: tenta o dne-api, e se ele recusar, tenta a mesma rota no
   *   01wapi, que ainda responde. Se as duas falharem, o motivo vai para a
   *   tela em vez de um "não reconheceu o CEP" que não ajuda ninguém.
   */
  var rotas = [
    'https://dne-api.rte.com.br/api/cities/byzipcode?zipCode=' + cep,
    'https://01wapi.rte.com.br/api/cities/byzipcode?zipCode=' + cep
  ];

  for (var r = 0; r < rotas.length; r++) {
    for (var i = 1; i <= 3; i++) {
      try {
        var res = UrlFetchApp.fetch(rotas[r], {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          muteHttpExceptions: true
        });

        var codigo = res.getResponseCode();
        if (codigo !== 200) {
          _motivoCidadeRn = 'HTTP ' + codigo + ' ao buscar a cidade' +
            (codigo === 401 ? ' (essa consulta quer token próprio)' : '');
          break;                       // erro de verdade: vai para a outra rota
        }

        var d = JSON.parse(res.getContentText());
        var o = Array.isArray(d) ? d[0] : d;
        var id = o.Id || o.id;
        if (id) { cache.put(k, String(id), 86400); return id; }

        _motivoCidadeRn = 'a Rodonaves não tem cidade para o CEP ' + cep;
        return null;                   // respondeu e não achou: não insiste

      } catch (e) {
        _motivoCidadeRn = 'rede instável ao buscar a cidade';
        if (i < 3) Utilities.sleep(900 * i);
      }
    }
  }
  return null;
}


/**
 * Cadastra o comprador na base da Rodonaves, com o endereço do pedido.
 *   Roda uma vez por comprador, quando a cotação reclama que ele não existe.
 */
function cadastrarNaRodonavesPainel_(destino, doc) {
  var cache = CacheService.getScriptCache();
  var t = cache.get('rn_token_cli');
  if (!t) {
    try {
      var rt = UrlFetchApp.fetch('https://customer-apigateway.rte.com.br/token', {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: 'grant_type=password' +
                 '&username=' + encodeURIComponent(RODONAVES_PAINEL.user) +
                 '&password=' + encodeURIComponent(RODONAVES_PAINEL.senha) +
                 '&companyId=' + RODONAVES_PAINEL.empresa + '&auth_type=dev',
        muteHttpExceptions: true
      });
      if (rt.getResponseCode() !== 200) {
        return { ok: false, motivo: 'token do cadastro deu HTTP ' + rt.getResponseCode() };
      }
      t = JSON.parse(rt.getContentText()).access_token;
      if (t) cache.put('rn_token_cli', t, 14400);
    } catch (e) {
      return { ok: false, motivo: 'não alcancei o servidor de cadastro' };
    }
  }

  // o endereço vem do pedido; a rua do ML já vem com número junto
  var rua = String(destino.endereco || '');
  var numero = (rua.match(/(\d+)\s*$/) || [])[1] || 'S/N';
  rua = rua.replace(/\s*\d+\s*$/, '').trim();

  // o nome do TITULAR, que é o que está no documento — o mesmo critério da
  // nota. Quem recebe pode ser outra pessoa, e aí o cadastro não bate.
  var nome = destino.nomeNota || destino.nomeReal || destino.recebe || '';
  if (!nome) return { ok: false, motivo: 'sem o nome do comprador' };
  if (!destino.cidade || !destino.uf) {
    return { ok: false, motivo: 'endereço incompleto no pedido' };
  }

  var corpo = {
    Description: nome,
    TaxIdRegistration: doc,
    Email: RODONAVES_PAINEL.email,
    // O TELEFONE É O DA LOJA, não o do comprador
    //   No teste de 18/09, que cotou com protocolo (R$ 238,85, cotação
    //   222805983), o cadastro ia com o telefone da loja. Ao trocar pelo do
    //   comprador, o cadastro passou a ser recusado. Voltou a ser o da loja.
    Phone: String(RODONAVES_PAINEL.contatoTelefone).replace(/\D/g, ''),
    ZipCode: String(destino.cep || '').replace(/\D/g, ''),
    Street: rua,
    Number: numero,
    Supplement: destino.complemento || '',
    District: destino.bairro || '',
    City: destino.cidade || '',
    UnitFederation: destino.uf || ''
  };

  // fica registrado para o diagnóstico poder mostrar o que foi enviado
  _ultimoCadastroRn = JSON.stringify(corpo);

  var r = buscarComRepeticaoPainel_({
    url: 'https://customer-apigateway.rte.com.br/api/v1/customer/savecustomer',
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' },
    payload: JSON.stringify(corpo), muteHttpExceptions: true
  });

  if (!r) return { ok: false, motivo: 'o servidor de cadastro não respondeu' };
  if (r.getResponseCode() !== 200) {
    return { ok: false, motivo: 'cadastro recusado (HTTP ' + r.getResponseCode() +
             '): ' + r.getContentText().replace(/\s+/g, ' ').substring(0, 150) };
  }
  return { ok: true, motivo: '' };
}


/**
 * A regra de cada transportadora, lida da tabela COBERTURA_PAINEL.
 *   true  = atende, cota
 *   false = não atende, nem aparece
 *   null  = não sei pela regra, deixa a cotação responder
 */
function atendePainel_(id, uf, cidade) {
  var c = COBERTURA_PAINEL[id];
  if (!c) return false;

  if (c.tudo) return true;

  // estados atendidos por inteiro
  if (c.ufs && c.ufs.indexOf(uf) !== -1) return true;

  // estados em que ela atende só as cidades da planilha
  if (c.planilhaEm && c.planilhaEm.indexOf(uf) !== -1) {
    return cidadeNaPlanilhaPainel_(id, cidade, uf);
  }

  // planilha em qualquer lugar
  if (c.planilha) return cidadeNaPlanilhaPainel_(id, cidade, uf);

  // atende fora destes estados, mas a cidade é incerta
  if (c.foraDe) return c.foraDe.indexOf(uf) === -1 ? null : false;

  return false;
}

/**
 * Os estados por extenso, para tirar a UF do NOME DA ABA.
 *
 *   A planilha da Itoupava é dividida em abas "SÃO PAULO", "SANTA CATARINA"
 *   e "PARANÁ", cada uma com uma lista simples de cidades. O estado está no
 *   nome da aba, não numa coluna — sem isso, aquelas 117 cidades casariam só
 *   pelo nome, e Santa Cruz de SC valeria por Santa Cruz de qualquer estado.
 */
var ESTADOS_PAINEL = {
  'ACRE': 'AC', 'ALAGOAS': 'AL', 'AMAPA': 'AP', 'AMAZONAS': 'AM',
  'BAHIA': 'BA', 'CEARA': 'CE', 'DISTRITO FEDERAL': 'DF', 'ESPIRITO SANTO': 'ES',
  'GOIAS': 'GO', 'MARANHAO': 'MA', 'MATO GROSSO': 'MT',
  'MATO GROSSO DO SUL': 'MS', 'MINAS GERAIS': 'MG', 'PARA': 'PA',
  'PARAIBA': 'PB', 'PARANA': 'PR', 'PERNAMBUCO': 'PE', 'PIAUI': 'PI',
  'RIO DE JANEIRO': 'RJ', 'RIO GRANDE DO NORTE': 'RN',
  'RIO GRANDE DO SUL': 'RS', 'RONDONIA': 'RO', 'RORAIMA': 'RR',
  'SANTA CATARINA': 'SC', 'SAO PAULO': 'SP', 'SERGIPE': 'SE', 'TOCANTINS': 'TO'
};

/** A UF que o nome da aba indica, ou vazio. */
function ufDaAbaPainel_(nome) {
  var s = normalizarCidadePainel_(nome);
  if (ESTADOS_PAINEL[s]) return ESTADOS_PAINEL[s];
  // aba do tipo "REGIÃO DE CURITIBA - PR" ou "CIDADES SP"
  var m = s.match(/\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/);
  if (m) return m[1];
  var achado = '';
  Object.keys(ESTADOS_PAINEL).forEach(function (e) {
    if (!achado && s.indexOf(e) >= 0) achado = ESTADOS_PAINEL[e];
  });
  return achado;
}

/**
 * A cidade está na lista da transportadora?
 *
 *   Primeiro tenta o casamento EXATO, cidade + UF, que é o que vale quando a
 *   planilha tem coluna de estado (Arlete e Transoliveira) ou quando o nome
 *   da aba diz o estado (Itoupava). Só cai no casamento por nome solto
 *   quando não há nem uma coisa nem outra.
 */
function cidadeNaPlanilhaPainel_(transp, cidade, uf) {
  if (!cidade) return false;
  var listas = conjuntoCidadesPainel_(transp);
  if (listas.comUf[cidade + '|' + uf]) return true;
  if (listas.semUf[cidade]) return true;
  return false;
}

/**
 * Lê a planilha de cidades da transportadora e devolve dois conjuntos:
 *
 *   comUf  — "CIDADE|UF", das abas onde achei coluna de cidade e de estado.
 *            É o casamento confiável.
 *   semUf  — só o nome, das abas que são lista simples, sem estado.
 *            Aqui São José de SC e São José do RS são a mesma coisa, mas é o
 *            melhor possível quando a planilha não diz.
 *
 * COMO ACHA AS COLUNAS
 *   Procura, nas primeiras linhas de cada aba, uma célula cujo texto contenha
 *   "cidade" e outra que seja "uf" ou contenha "estado". Assim funciona tanto
 *   com cidade_destino/uf_destino (Arlete) quanto com Cidade/UF
 *   (Transoliveira), sem eu precisar fixar a posição.
 *
 * POR QUE ISSO IMPORTA
 *   A versão anterior varria TODAS as células e aceitava qualquer nome que
 *   batesse. Bastava a cidade aparecer numa observação, num cabeçalho ou numa
 *   coluna de outra coisa para a transportadora entrar na cotação. Pior: sem
 *   a UF, cidade de nome repetido entre estados casava com o estado errado.
 */
function conjuntoCidadesPainel_(transp) {
  var cache = CacheService.getScriptCache();
  var k = 'cidades2_' + transp;
  var c = cache.get(k);
  if (c) return JSON.parse(c);

  var out = { comUf: {}, semUf: {}, abas: [] };

  try {
    var ss = SpreadsheetApp.openById(PLANILHAS_CIDADES_PAINEL[transp]);
    ss.getSheets().forEach(function (aba) {
      var v = aba.getDataRange().getValues();
      if (!v.length) return;

      var ufDaAba = ufDaAbaPainel_(aba.getName());

      // ---- procura o cabeçalho nas primeiras 10 linhas ----
      var colCidade = -1, colUf = -1, linhaCab = -1;
      for (var i = 0; i < Math.min(v.length, 10); i++) {
        var achouC = -1, achouU = -1;
        v[i].forEach(function (cel, j) {
          var s = normalizarCidadePainel_(cel);
          if (achouC < 0 && s.indexOf('CIDADE') >= 0 && s.indexOf('ORIGEM') < 0) achouC = j;
          if (achouU < 0 && (s === 'UF' || s === 'ESTADO' ||
              (s.indexOf('UF') >= 0 && s.indexOf('DESTINO') >= 0))) achouU = j;
        });
        if (achouC >= 0) { colCidade = achouC; colUf = achouU; linhaCab = i; break; }
      }

      var comUf = 0, semUf = 0;

      if (colCidade >= 0) {
        // ---- aba com coluna de cidade nomeada ----
        for (var r = linhaCab + 1; r < v.length; r++) {
          var nome = normalizarCidadePainel_(v[r][colCidade]);
          if (nome.length < 3) continue;

          var e = '';
          if (colUf >= 0) {
            var bruto = normalizarCidadePainel_(v[r][colUf]);
            if (bruto.length === 2) e = bruto;
            else if (ESTADOS_PAINEL[bruto]) e = ESTADOS_PAINEL[bruto];
          }
          if (!e) e = ufDaAba;    // a coluna não disse: usa o estado da aba

          if (e) { out.comUf[nome + '|' + e] = 1; comUf++; }
          else { out.semUf[nome] = 1; semUf++; }
        }
      } else {
        // ---- lista simples: o estado vem do nome da aba, se der ----
        v.forEach(function (linha) {
          linha.forEach(function (cel) {
            var s = normalizarCidadePainel_(cel);
            if (s.length < 3 || !/^[A-Z]/.test(s) || /\d/.test(s)) return;
            if (ufDaAba) { out.comUf[s + '|' + ufDaAba] = 1; comUf++; }
            else { out.semUf[s] = 1; semUf++; }
          });
        });
      }

      out.abas.push(aba.getName() + ': ' +
        (colCidade >= 0 ? 'coluna "' + String(v[linhaCab][colCidade]).trim() + '"'
                        : 'lista simples') +
        (ufDaAba ? ', estado ' + ufDaAba + ' pelo nome da aba' : '') +
        ' — ' + comUf + ' com UF, ' + semUf + ' sem UF');
    });
  } catch (e) {
    out.abas.push('não consegui abrir a planilha: ' + e.message);
  }

  var txt = JSON.stringify(out);
  if (txt.length < 95000) cache.put(k, txt, 21600);
  return out;
}

/**
 * Mostra como o painel está lendo cada planilha de cidades: quantas abas,
 * qual coluna usou, quantas cidades saíram, e testa alguns destinos.
 * É o que responde "por que essa transportadora apareceu (ou sumiu)".
 */
function painelDiagnosticoCidades() {
  var testes = [
    ['BELO HORIZONTE', 'MG'], ['VITORIA', 'ES'], ['GOIANIA', 'GO'],
    ['SAO PAULO', 'SP'], ['CAMPINAS', 'SP'], ['JOINVILLE', 'SC'],
    ['CURITIBA', 'PR'], ['SAO JOSE', 'SC']
  ];

  Object.keys(PLANILHAS_CIDADES_PAINEL).forEach(function (t) {
    Logger.log('=== ' + t + ' ===');
    var l = conjuntoCidadesPainel_(t);
    l.abas.forEach(function (a) { Logger.log('   ' + a); });
    Logger.log('   total: ' + Object.keys(l.comUf).length + ' com UF, ' +
               Object.keys(l.semUf).length + ' sem UF');
    testes.forEach(function (x) {
      var nome = normalizarCidadePainel_(x[0]);
      var exato = !!l.comUf[nome + '|' + x[1]];
      var solto = !!l.semUf[nome];
      Logger.log('      ' + (x[0] + '/' + x[1] + '              ').substring(0, 22) +
        (exato ? 'SIM (cidade e UF batem)' :
         solto ? 'sim, mas só pelo nome — a planilha não diz a UF' : 'não'));
    });
    Logger.log('');
  });

  Logger.log('O cache dura 6 horas. Para forçar releitura depois de mexer numa');
  Logger.log('planilha, rode painelLimparCacheCidades().');
}

/**
 * DIAGNÓSTICO DA RODONAVES, para um CEP
 *
 *   Mostra, em ordem: o que está guardado, o que a consulta de cidade
 *   devolve agora (id E nome, para conferir se é a cidade certa), o corpo
 *   exato que vai na cotação, e a resposta crua dela.
 *
 *   Sem argumento, usa o CEP do primeiro pedido aberto.
 */
function painelDiagnosticoRodonaves(cep) {
  var pedido = null, destino = null;

  var lista = painelListarPedidos(false);

  if (!cep) {
    if (!lista.length) { Logger.log('Nenhum pedido aberto.'); return; }
    pedido = lista[0];
    destino = painelDetalhe(pedido.loja, pedido.ids[0], pedido.envioId);
    cep = destino.cep;
  } else {
    // PROCURA O PEDIDO DE VERDADE COM ESSE CEP
    //   Sem isso o teste usava um pedido de exemplo, sem CPF — e aí ele caía
    //   na simulação e nunca exercitava o cadastro, que é justamente o que
    //   precisa ser testado.
    var alvo = String(cep).replace(/\D/g, '');
    lista.forEach(function (x) {
      if (pedido) return;
      var d = painelDetalhe(x.loja, x.ids[0], x.envioId);
      if (String(d.cep || '').replace(/\D/g, '') === alvo) { pedido = x; destino = d; }
    });
    if (!pedido) {
      Logger.log('Não achei pedido aberto com o CEP ' + alvo + '.');
      Logger.log('Vou testar com um pedido de exemplo, SEM CPF — o que não');
      Logger.log('exercita o cadastro. Para o teste valer, use o CEP de um');
      Logger.log('pedido que esteja na lista.');
    }
  }

  if (pedido) {
    Logger.log('pedido de ' + pedido.cliente + ' — ' + destino.cidade + '/' + destino.uf +
               '   CPF ' + (destino.cpf || pedido.cpf || '(sem CPF)'));
  }
  cep = String(cep).replace(/\D/g, '');
  Logger.log('CEP ' + cep);
  Logger.log('');

  var cache = CacheService.getScriptCache();

  // ---- 1) o que está guardado ----
  Logger.log('=== O QUE ESTÁ GUARDADO ===');
  Logger.log('   id da cidade: ' + (cache.get('rn_cidade_' + cep) || '(nada)'));
  Logger.log('   token: ' + (cache.get('rn_token') ? 'guardado' : '(nada)'));

  var docTeste = String((destino && destino.cpf) || (pedido && pedido.cpf) || '')
    .replace(/\D/g, '');
  if (docTeste) {
    Logger.log('   comprador já cadastrado? ' +
               (cache.get('rn_cli_' + docTeste) ? 'sim (marcado aqui)' : 'não'));
    // no teste queremos ver o cadastro acontecer, então esquece a marca
    cache.remove('rn_cli_' + docTeste);
  }
  cache.remove('rn_cidade_' + cep);
  Logger.log('   (joguei fora, para consultar do zero)');
  Logger.log('');

  // ---- 2) o token ----
  Logger.log('=== TOKEN ===');
  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('   falhou: ' + _motivoTokenRn); return; }
  Logger.log('   ok');
  Logger.log('');

  // ---- 3a) a cidade de ORIGEM ----
  Logger.log('=== A CIDADE DE ORIGEM (' + CEP_ORIGEM_PAINEL + ') ===');
  CacheService.getScriptCache().remove('rn_cidade_' + CEP_ORIGEM_PAINEL);
  try {
    var ro = UrlFetchApp.fetch(
      'https://dne-api.rte.com.br/api/cities/byzipcode?zipCode=' + CEP_ORIGEM_PAINEL, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        muteHttpExceptions: true });
    Logger.log('   HTTP ' + ro.getResponseCode());
    Logger.log('   ' + ro.getContentText().substring(0, 300));
    Logger.log('   (a reserva chumbada é ' + RODONAVES_PAINEL.cidadeOrigemReserva + ')');
  } catch (eO) { Logger.log('   não alcancei: ' + eO.message); }
  Logger.log('');

  // ---- 3) a cidade de destino, com nome ----
  Logger.log('=== A CIDADE DESTE CEP ===');
  ['https://dne-api.rte.com.br/api/cities/byzipcode?zipCode=' + cep,
   'https://01wapi.rte.com.br/api/cities/byzipcode?zipCode=' + cep
  ].forEach(function (url) {
    Logger.log('   ' + url.replace('https://', '').split('/')[0]);
    try {
      var r = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        muteHttpExceptions: true });
      Logger.log('      HTTP ' + r.getResponseCode());
      Logger.log('      ' + r.getContentText().substring(0, 400));
    } catch (e) {
      Logger.log('      não alcancei: ' + e.message);
    }
    Utilities.sleep(400);
  });
  Logger.log('');

  // ---- 4) a cotação, com o corpo à vista ----
  Logger.log('=== A COTAÇÃO ===');
  if (!pedido) {
    pedido = { peso: 20, total: 400, volumes: 1, cpf: CPF_TESTE_PAINEL };
    destino = { cep: cep, cpf: CPF_TESTE_PAINEL };
    Logger.log('   (pedido de exemplo: 20 kg, nota de R$ 400)');
  }

  var doc = String((destino && destino.cpf) || pedido.cpf || '').replace(/\D/g, '');
  Logger.log('   documento do destinatário: ' + (doc || '(vazio — vai para simulação)'));

  var m = montarPedidoRodonavesPainel_(pedido, destino, doc);
  if (m.erro) { Logger.log('   não montei: ' + m.erro); return; }

  Logger.log('   rota: ' + m.req.url.replace('https://', ''));
  Logger.log('   enviando: ' + JSON.stringify(m.corpo));

  var r2 = buscarComRepeticaoPainel_(m.req);
  if (!r2) { Logger.log('   não alcancei, nem repetindo.'); return; }

  Logger.log('   HTTP ' + r2.getResponseCode());
  Logger.log('   ' + r2.getContentText().substring(0, 800));
  Logger.log('');

  // ---- 5) o caminho completo, com cadastro e nova tentativa ----
  //   O passo 4 é a chamada crua. O painel faz mais que isso: quando ela
  //   responde "cliente destinatário não encontrado", ele cadastra o
  //   comprador e cota de novo. É esse caminho que precisa ser testado, e
  //   não a chamada solta.
  Logger.log('=== O CAMINHO COMPLETO, COMO O PAINEL FAZ ===');
  var resultado = { cotadas: [], manuais: [], recusadas: [], avisos: [] };
  lerRespostaRodonavesPainel_(m, r2, resultado, pedido, destino, doc);

  resultado.cotadas.forEach(function (c) {
    Logger.log('   COTOU: R$ ' + c.v.toFixed(2) + '   ' + (c.prazo || '?') + ' dias' +
               (c.cotacao ? '   cotação ' + c.cotacao : '   (sem número)'));
  });
  resultado.manuais.forEach(function (x) {
    Logger.log('   para digitar: ' + x.obs);
  });
  resultado.recusadas.forEach(function (x) {
    Logger.log('   recusou (' + x.erro + '): ' + x.msg);
  });
  if (_ultimoCadastroRn) {
    Logger.log('');
    Logger.log('   o cadastro que tentei mandar:');
    Logger.log('   ' + _ultimoCadastroRn);
  }
  Logger.log('');

  Logger.log('O QUE OLHAR:');
  Logger.log('   · a cidade do passo 3 é a do pedido? o id bate com o enviado?');
  Logger.log('   · no passo 5, se disser "não consegui cadastrar", o motivo');
  Logger.log('     aparece junto — é campo faltando no endereço, quase sempre');
  Logger.log('     bairro ou número.');
}

/**
 * Esquece o id de cidade que a Rodonaves devolveu para um CEP.
 *   Use quando ela disser "não localizado CEP" num destino que você sabe que
 *   ela atende — o id guardado pode ter vindo torto numa oscilação de rede.
 *
 *   Sem argumento, limpa o token e todos os ids das cidades dos pedidos
 *   abertos.
 */
function painelLimparCidadeRodonaves(cep) {
  var cache = CacheService.getScriptCache();
  cache.remove('rn_token');

  if (cep) {
    var limpo = String(cep).replace(/\D/g, '');
    cache.remove('rn_cidade_' + limpo);
    Logger.log('Esqueci a cidade do CEP ' + limpo + '.');
    return;
  }

  var quantos = 0;
  painelListarPedidos(false).forEach(function (p) {
    if (!p.cepDestino) return;
    cache.remove('rn_cidade_' + String(p.cepDestino).replace(/\D/g, ''));
    quantos++;
  });
  Logger.log('Esqueci a cidade de ' + quantos + ' CEP(s) dos pedidos abertos.');
}

/** Esquece as listas lidas, para a próxima consulta reler as planilhas. */
function painelLimparCacheCidades() {
  var cache = CacheService.getScriptCache();
  Object.keys(PLANILHAS_CIDADES_PAINEL).forEach(function (t) {
    cache.remove('cidades2_' + t);
    cache.remove('cidades_' + t);      // o nome antigo, da versão anterior
  });
  cache.remove('painel_pedidos');
  Logger.log('Cache limpo. A próxima cotação relê as planilhas.');
}

function normalizarCidadePainel_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
}


// ===========================================================================
// O SSW — a mesma chamada testada em 14/09, batendo com a tela
// ===========================================================================

/**
 * MONTAR E LER SEPARADOS — por que a função foi partida em duas
 *
 *   Antes uma função só montava o envelope, mandava e lia a resposta. Com
 *   isso as transportadoras eram consultadas EM FILA: manda para a Sinil,
 *   espera; manda para a Azurelog, espera. Seis transportadoras a dois
 *   segundos cada davam doze segundos de botão travado.
 *
 *   Separando, dá para montar todos os pedidos, dispará-los de uma vez com
 *   UrlFetchApp.fetchAll e ler as respostas depois. O tempo passa a ser o da
 *   mais lenta, não a soma de todas.
 */
function montarPedidoSswPainel_(t, c) {
  var d = t.ssw;
  var dominio = d.dominio || dominioPainel_(t.id);

  function p(nome, tipo, valor) {
    var v = (valor === undefined || valor === null) ? '' : String(valor);
    return '<' + nome + ' xsi:type="xsd:' + tipo + '">' +
           v.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</' + nome + '>';
  }

  /**
   * CAMPO QUE PODE IR EM BRANCO
   *   A TW pede coletar, entDificil e destContribuinte vazios; as outras
   *   usam S e N. Usar `t.coletar || 'S'` faria o vazio virar S de novo,
   *   porque string vazia é falsa em JavaScript. Por isso testo se o campo
   *   foi definido, não se ele tem conteúdo.
   */
  function ou(valor, padrao) {
    return (valor === undefined || valor === null) ? padrao : valor;
  }

  // A ORDEM DOS PARÂMETROS É A DESTE SERVIÇO, não a do sswCotacao
  //   Em SOAP rpc/encoded o servidor lê por POSIÇÃO. Aqui o cnpjRemetente
  //   está na 13ª posição, não na última, e há três campos no meio que o
  //   outro serviço não tem: ciffob, observacao e trt. Copiar a ordem antiga
  //   faria cada valor cair no campo errado, sem erro aparente.
  var corpo =
    p('dominio', 'string', dominio) +
    p('login', 'string', d.login) +
    p('senha', 'string', d.senha) +
    p('cnpjPagador', 'string', CNPJ_FACIL_PAINEL) +
    p('cepOrigem', 'integer', CEP_ORIGEM_PAINEL) +
    p('cepDestino', 'integer', c.cepDestino) +
    p('valorNF', 'decimal', Number(c.valorNF || 0).toFixed(2)) +
    p('quantidade', 'integer', c.quantidade || 1) +
    p('peso', 'decimal', Number(c.peso || 0).toFixed(3)) +
    p('volume', 'decimal', Number(c.volume || 0).toFixed(4)) +
    // a TW quer o código com os zeros, como texto: 001, 003, 009
    (d.mercadoriaTexto
      ? p('mercadoria', 'string', d.mercadoria)
      : p('mercadoria', 'integer', d.mercadoria || 1)) +
    p('ciffob', 'string', 'C') +               // CIF: o frete é nosso
    p('cnpjRemetente', 'string', CNPJ_FACIL_PAINEL) +
    // O DOCUMENTO DO DESTINATÁRIO
    //   A TW em produção recusa sem ele: "Informe o CNPJ/CPF do
    //   destinatario". As outras aceitam vazio, mas mandar não atrapalha —
    //   e com o documento a tabela aplicada é a certa, pessoa física ou
    //   jurídica, o que muda o valor.
    p('cnpjDestinatario', 'string', String(c.cnpjDestinatario || '').replace(/\D/g, '')) +
    p('observacao', 'string', '') +
    p('trt', 'string', 'N') +
    p('coletar', 'string', ou(t.coletar, 'S')) +
    p('entDificil', 'string', ou(t.entDificil, 'N')) +
    p('destContribuinte', 'string', ou(t.contribuinte, 'S')) +
    p('qtdePares', 'integer', 0) +
    p('altura', 'decimal', '0.000') +
    p('largura', 'decimal', '0.000') +
    p('comprimento', 'decimal', '0.000') +
    p('fatorMultiplicador', 'integer', 1);

  var envelope =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:urn="' + NS_COTACAO_PAINEL + '"><soapenv:Body>' +
    '<urn:cotar soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    corpo + '</urn:cotar></soapenv:Body></soapenv:Envelope>';

  return {
    url: URL_COTACAO_PAINEL,
    method: 'post',
    contentType: 'text/xml; charset=utf-8',
    headers: { SOAPAction: NS_COTACAO_PAINEL + '#cotar' },
    payload: envelope,
    muteHttpExceptions: true
  };
}

/** Lê a resposta do SSW. Recebe o que o fetchAll devolveu. */
function lerSswPainel_(res) {
  if (!res) return { erro: '-9', mensagem: 'sem resposta do SSW', dados: {} };

  var texto = res.getContentText();
  var m = texto.match(/<return[^>]*>([\s\S]*?)<\/return>/i);
  if (!m) return { erro: '-9', mensagem: 'resposta sem cotação', dados: {} };

  var interno = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  var dados = {};
  var re = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g, x;
  while ((x = re.exec(interno)) !== null) dados[x[1]] = x[2].trim();

  // ESTE SERVIÇO DEVOLVE O FRETE COM VÍRGULA
  //   "52,92" em vez de "52.92". O outro usava ponto. Sem converter, o
  //   Number() devolve NaN e o frete aparece como zero.
  if (dados.frete && !dados.totalFrete) {
    dados.totalFrete = String(dados.frete).replace(/\./g, '').replace(',', '.');
  }

  return { erro: String(dados.erro), mensagem: dados.mensagem || '', dados: dados };
}


/**
 * O domínio de quem não tem domínio fixo na tabela.
 *   Hoje só a TW, que alterna entre homologação e produção.
 */
function dominioPainel_(id) {
  if (id === 'TW') {
    return (typeof DOMINIO_TW_PAINEL !== 'undefined' && DOMINIO_TW_PAINEL) || 'TW2';
  }
  return '';
}

/** O aviso que aparece ao lado da transportadora na tela. */
function obsPainel_(t) {
  if (t.id === 'TW' && dominioPainel_('TW') === 'TW2') {
    return 'homologação — preço indicativo';
  }
  return t.obs || '';
}

/**
 * Limpa a mensagem do SSW.
 *
 *   Ele mistura texto com entidades HTML, e nem sempre as mesmas: já veio
 *   "N&Atilde;O &Eacute; ATENDIDA" com maiúsculas. Em vez de listar uma por
 *   uma, a regra troca qualquer &Xacute; &Xtilde; &Xcirc; e afins pela letra
 *   base — o acento se perde, e não faz falta para ler.
 */
function limparMsgSswPainel_(m) {
  // O & VEM ESCAPADO — e por isso a ordem importa
  //   O SSW manda "n&amp;atilde;o". Trocando os acentos primeiro, nada bate;
  //   só depois o &amp; vira & e sobra "&atilde;" na tela, que foi o que
  //   apareceu em 18/09. Desescapa o & ANTES, e duas vezes, porque às vezes
  //   vem escapado em camadas.
  return String(m || '')
    .replace(/&amp;/g, '&').replace(/&amp;/g, '&')
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring|slash);/g, '$1')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
}


/**
 * SIMULAR UM DESTINO, sem precisar de pedido em aberto
 *
 *   Roda o painel inteiro contra uma cidade qualquer: aplica as regras de
 *   quem atende, cota em todas as que passarem, e mostra o resultado como
 *   ele apareceria na tela.
 *
 *     painelSimularDestino('Belo Horizonte', 'MG', '30110001')
 *     painelSimularDestino('Vitória', 'ES', '29010000', 25, 465.44)
 *
 *   Peso e valor da nota são opcionais — o padrão é uma porta de 90, 20 kg.
 */
function painelSimularDestino(cidade, uf, cep, peso, valorNF) {
  // sem argumentos (botão Executar do editor), usa o destino do topo
  var d0 = DESTINO_TESTE_PAINEL || {};
  cidade = cidade || d0.cidade;
  uf = uf || d0.uf;
  cep = cep || d0.cep;
  peso = peso || d0.peso || 20;
  valorNF = valorNF || d0.valorNF || 400;

  if (!cidade || !uf || !cep) {
    Logger.log('Falta cidade, UF ou CEP. Edite o DESTINO_TESTE_PAINEL no topo');
    Logger.log('do arquivo e rode de novo.');
    return;
  }

  var cubagem = 0.0817;   // 95 × 215 × 4 cm, a porta de 90

  var destino = { cidade: cidade, uf: String(uf).toUpperCase(),
                  cep: String(cep).replace(/\D/g, ''),
                  cpf: CPF_TESTE_PAINEL };
  var pedido = { total: valorNF, peso: peso, cubagem: cubagem, volumes: 1, skuSemPeso: [] };

  Logger.log('SIMULAÇÃO — ' + cidade + '/' + destino.uf + '   CEP ' + destino.cep);
  Logger.log(peso + ' kg   ' + cubagem + ' m³   nota R$ ' + Number(valorNF).toFixed(2));
  Logger.log('');

  // ---- o que a REGRA decide, antes de cotar ----
  Logger.log('=== A REGRA ===');
  var cidadeNorm = normalizarCidadePainel_(cidade);
  TRANSPORTADORAS_PAINEL.forEach(function (t) {
    var a = atendePainel_(t.id, destino.uf, cidadeNorm);
    Logger.log('   ' + (t.id + '            ').substring(0, 14) +
      (a === true ? 'atende' : a === false ? 'não atende — nem cota' :
                               'não sei pela regra — deixa a cotação responder') +
      (t.ssw ? '' : '   [sem API, valor digitado]'));
  });
  Logger.log('');

  // ---- cota ----
  Logger.log('=== A COTAÇÃO ===');
  var c = painelCotar(pedido, destino);

  if (c.cotadas.length) {
    c.cotadas.forEach(function (x, i) {
      Logger.log('   ' + (i === 0 ? '→ ' : '  ') + (x.t + '            ').substring(0, 14) +
        'R$ ' + x.v.toFixed(2) +
        '   ' + (x.prazo ? x.prazo + ' dias' : 'prazo não veio') +
        (x.cotacao ? '   cotação ' + x.cotacao : '') +
        (x.caro ? '   CARO' : '') + (x.obs ? '   ' + x.obs : ''));
    });
  } else {
    Logger.log('   nenhuma cotou.');
  }

  if (c.manuais.length) {
    Logger.log('');
    Logger.log('   por fora: ' + c.manuais.map(function (m) { return m.t; }).join(', '));
  }

  if (c.recusadas.length) {
    Logger.log('');
    c.recusadas.forEach(function (x) {
      Logger.log('   ' + (x.t + '            ').substring(0, 14) +
                 'recusou (erro ' + x.erro + '): ' + x.msg);
      if (x.cru) Logger.log('      cru: ' + x.cru);
    });
  }

  c.avisos.forEach(function (a) { Logger.log(''); Logger.log('   aviso: ' + a); });
}


/**
 * Despeja a resposta INTEIRA do SSW para uma transportadora e um CEP.
 * É o que responde "por que essa aí voltou sem valor".
 *
 *   painelDiagnosticoCotacao('AZURELOG', '30110001')
 */
function painelDiagnosticoCotacao(transportadora, cep, peso, valorNF) {
  var d0 = DESTINO_TESTE_PAINEL || {};
  transportadora = transportadora || 'AZURELOG';
  cep = cep || d0.cep;
  peso = peso || d0.peso || 20;
  valorNF = valorNF || d0.valorNF || 400;

  var t = null;
  TRANSPORTADORAS_PAINEL.forEach(function (x) {
    if (x.id === String(transportadora).toUpperCase()) t = x;
  });
  if (!t) { Logger.log('Não conheço a transportadora ' + transportadora + '.'); return; }
  if (!t.ssw) { Logger.log(t.id + ' não cota por API.'); return; }

  var r = cotarSswPainel_(t, {
    cepDestino: String(cep).replace(/\D/g, ''),
    valorNF: valorNF || 400, quantidade: 1,
    peso: peso || 20, volume: 0.0817,
    cnpjDestinatario: CPF_TESTE_PAINEL
  });

  Logger.log(t.id + '   domínio ' + (t.ssw.dominio || dominioPainel_(t.id)) +
             '   CEP ' + cep);
  Logger.log('erro ' + r.erro + '   ' + limparMsgSswPainel_(r.mensagem));
  Logger.log('');
  Logger.log('a resposta inteira, campo a campo:');
  Object.keys(r.dados).sort().forEach(function (k) {
    Logger.log('   ' + k + ' = ' + r.dados[k]);
  });
}


// ===========================================================================
// TESTE DA TW — homologação
// ===========================================================================
/**
 * Cota três destinos do Rio Grande do Sul pela TW e mostra a resposta
 * inteira. Serve para validar as credenciais novas antes de deixar a TW
 * cotando junto com as outras.
 *
 * Quando as três responderem com valor: DOMINIO_TW_PAINEL = 'TWT'.
 */
function testarTW() {
  var t = null;
  TRANSPORTADORAS_PAINEL.forEach(function (x) { if (x.id === 'TW') t = x; });
  if (!t || !t.ssw) { Logger.log('A TW está sem configuração de SSW.'); return; }

  Logger.log('TESTE DA TW');
  if (!CPF_TESTE_PAINEL) {
    Logger.log('ATENÇÃO: CPF_TESTE_PAINEL está vazio. Em produção (TWT) a TW');
    Logger.log('recusa com "Informe o CNPJ/CPF do destinatario". Ponha o CPF de');
    Logger.log('um cliente real no topo do arquivo.');
    Logger.log('');
  }
  var dom = t.ssw.dominio || dominioPainel_('TW');
  Logger.log('domínio ' + dom + '   login ' + t.ssw.login +
             '   mercadoria ' + t.ssw.mercadoria +
             (dom === 'TW2' ? '   [HOMOLOGAÇÃO]' : '   [PRODUÇÃO — vale de verdade]'));
  Logger.log('');

  // uma porta branca de 80, 18 kg — o envio mais comum
  var casos = [
    { nome: 'Carazinho/RS', cep: '99500000' },
    { nome: 'Porto Alegre/RS', cep: '90010000' },
    { nome: 'Caxias do Sul/RS', cep: '95010000' }
  ];

  casos.forEach(function (c) {
    var r = cotarSswPainel_(t, {
      cepDestino: c.cep, valorNF: 338.44, quantidade: 1, peso: 18, volume: 0.0731,
      cnpjDestinatario: CPF_TESTE_PAINEL
    });
    Logger.log(c.nome + '   erro ' + r.erro +
      (r.mensagem ? '   ' + limparMsgSswPainel_(r.mensagem) : ''));
    if (r.erro === '0' || r.erro === '1') {
      Logger.log('   frete R$ ' + r.dados.totalFrete +
                 '   prazo ' + (r.dados.diasUteis || r.dados.prazo || '?') + ' dias' +
                 '   cotação ' + (r.dados.cotacao || '(sem número)'));
    } else {
      Logger.log('   resposta crua: ' + JSON.stringify(r.dados).substring(0, 400));
    }
    Logger.log('');
    Utilities.sleep(400);
  });

  Logger.log('Se as três responderem com valor, troque DOMINIO_TW_PAINEL para TWT.');
  Logger.log('Lembre que a homologação pode divergir de preço e de cidade atendida.');
}


// ===========================================================================
// 4) ENVIAR — no modo de teste, só o e-mail
// ===========================================================================

function painelEnviar(dados) {
  var res = { email: false, planilha: false, mensagem: false, avisos: [] };

  // ---- alguém já despachou este pedido enquanto isso? ----
  var ja = pedidosNaPlanilhaPainel_();
  var repetido = (dados.ids || []).filter(function (id) { return ja[id]; });
  if (repetido.length) {
    res.avisos.push('Este pedido JÁ está na planilha (' + repetido.join(', ') +
      '). Alguém despachou pela extensão. Nada foi enviado.');
    return res;
  }

  var loja = LOJAS_PAINEL[dados.loja] || {};

  // O ASSUNTO NO FORMATO DA EXTENSÃO
  //   "Fácil Shop - Sthefanny Rayanne Araujo da Silva - AZURELOG"
  //   O Everton filtra a caixa dele por esse padrão; mudar quebraria o jeito
  //   como ele trabalha.
  var assunto = (loja.nome || dados.loja) + ' - ' +
    (dados.cliente || '') + ' - ' + (dados.transportadora || '') +
    (PAINEL_TESTE ? ' [TESTE DO PAINEL]' : '');

  // ---- MODO DE TESTE: só o e-mail, e só para você ----
  if (PAINEL_TESTE) {
    try {
      MailApp.sendEmail({
        to: EMAIL_TESTE_PAINEL, subject: assunto, body: dados.escopo || ''
      });
      res.email = true;
    } catch (e) {
      res.avisos.push('E-mail falhou: ' + e.message);
    }
    res.avisos.push('Modo de teste: e-mail só para ' + EMAIL_TESTE_PAINEL +
      '. A planilha não foi tocada.');
    return res;
  }

  // ---- VALENDO: quem grava e manda é o doPost da extensão ----
  //   Ele confere duplicidade, escreve a linha, copia as fórmulas de custo e
  //   margem e manda o e-mail ao faturamento. É o mesmo caminho que a
  //   extensão usa há meses — por isso o painel delega em vez de repetir.
  //   Como o doPost está neste projeto, a chamada é direta.
  if (typeof processarPedido_ !== 'function') {
    res.avisos.push('Não achei o processarPedido_ no projeto. Sem ele o pedido ' +
      'não entra na planilha, e eu não mando o e-mail sozinho para não criar ' +
      'despacho sem linha.');
    return res;
  }

  var pedido = null;
  painelListarPedidos(false).forEach(function (x) {
    if (x.loja === dados.loja && x.ids.indexOf(String(dados.ids[0])) >= 0) pedido = x;
  });
  if (!pedido) {
    res.avisos.push('Não achei esse pedido entre os abertos. Atualize a lista.');
    return res;
  }

  var destino = painelDetalhe(pedido.loja, pedido.ids[0], pedido.envioId);

  var carga = {
    loja: loja.nome || dados.loja,
    // todos os números da venda, separados por barra — é assim que a
    // extensão grava, e é o que faz os irmãos serem encontrados depois
    numeroPedido: pedido.ids.join(' / '),
    /**
     * A DATA NO FUSO DO BRASIL, só com o dia
     *
     *   pedido.criado é a data completa em horário universal, três horas à
     *   frente. Um pedido das 21h30 do dia 20 vira 00h30 do dia 21 — e a
     *   planilha gravava 21. Aconteceu em 19/09 com dois pedidos da noite.
     *
     *   A extensão manda só "yyyy-MM-dd", montada ao meio-dia para nunca
     *   virar o dia. Aqui é o mesmo formato, calculado no fuso daqui.
     */
    data: Utilities.formatDate(new Date(pedido.criado), 'GMT-3', 'yyyy-MM-dd'),
    cliente: destino.nomeNota || pedido.clienteNota || pedido.cliente,
    cpf: destino.cpf || pedido.cpf || '',
    estado: destino.uf || '',
    codigoCotacao: dados.cotacao || '',
    /**
     * O VALOR VAI MULTIPLICADO
     *   A extensão manda valorUnitario × qtd, e a planilha grava o que
     *   recebe, sem multiplicar de novo. Mandando o unitário, um pedido de
     *   duas unidades entrava na planilha com o preço de uma — foi o que
     *   aconteceu em 19/09 com a venda da Renata.
     */
    produtos: pedido.itens.map(function (x) {
      return { sku: x.sku, qtd: x.qtd, valor: x.valor };
    }),
    tipoAnuncio: (pedido.itens[0] && pedido.itens[0].tipo) || 'CLASSICO',
    transportadora: dados.transportadora,
    freteCotado: Number(dados.frete) || 0,
    // o valor bom vem do envio, somado quando há compras juntadas
    freteRecebido: freteCompradorTotalPainel_(pedido) ||
                   Number(pedido.freteRecebido) || 0,
    assuntoEmail: assunto,
    corpoEmail: dados.escopo || ''
  };

  try {
    var resposta = processarPedido_(carga) || {};

    if (resposta.ok) {
      res.planilha = true;
      res.email = true;                 // o doPost manda junto com a gravação
      res.avisos.push('Linha ' + resposta.linha + ' na planilha, e-mail enviado ' +
                      'para ' + EMAIL_FATURAMENTO_PAINEL + '.');
    } else if (resposta.duplicado) {
      res.avisos.push('Já existe na planilha, linha ' + resposta.linha +
                      '. Nada foi gravado de novo.');
    } else {
      res.avisos.push('A gravação recusou: ' + (resposta.erro || 'sem motivo'));
    }
  } catch (e) {
    res.avisos.push('A gravação falhou: ' + e.message);
  }

  // ---- a mensagem ao comprador, só se a gravação deu certo ----
  //   Se a linha não entrou, o despacho não aconteceu — avisar o comprador
  //   de um envio que não foi registrado é pior que não avisar.
  if (res.planilha) {
    var msg = enviarMensagemCompradorPainel_(pedido, destino.uf);
    res.mensagem = msg.ok;
    res.avisos.push(msg.ok
      ? 'Mensagem enviada ao comprador (prazo de ' + msg.dias + ' dias).'
      : 'A mensagem ao comprador não saiu: ' + msg.motivo);
  }

  if (!destino.freteComprador && !pedido.freteRecebido) {
    res.avisos.push('O frete pago pelo comprador veio zerado. Se essa venda ' +
                    'não era frete grátis, confira a linha na planilha.');
  }

  return res;
}


/**
 * Manda a mensagem no chat do Mercado Livre.
 *
 *   O endereço é por PACOTE, não por pedido: /messages/packs/{pack}/sellers/
 *   {vendedor}. Para compra simples o pack é o próprio número do pedido, e é
 *   assim que a extensão faz há meses.
 *
 *   O ML bloqueia mensagem em pedido antigo demais — aparece blocked_by_time,
 *   e não é erro nosso.
 */
function enviarMensagemCompradorPainel_(pedido, uf) {
  var dias = PRAZO_MENSAGEM_PAINEL[String(uf || '').toUpperCase()] || PRAZO_PADRAO_PAINEL;

  try {
    var token = painelTokenML_(pedido.loja);
    if (!token) return { ok: false, motivo: 'sem token do Mercado Livre', dias: dias };

    var loja = LOJAS_PAINEL[pedido.loja] || {};
    var comprador = pedido.compradorId;
    if (!comprador) return { ok: false, motivo: 'não sei quem é o comprador', dias: dias };

    var pack = pedido.chave || pedido.ids[0];

    var r = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/messages/packs/' + pack +
      '/sellers/' + loja.seller + '?tag=post_sale', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({
          from: { user_id: String(loja.seller) },
          to: { user_id: String(comprador) },
          text: mensagemCompradorPainel_(uf)
        }),
        muteHttpExceptions: true
      });

    var codigo = r.getResponseCode();
    if (codigo === 200 || codigo === 201) return { ok: true, motivo: '', dias: dias };

    var corpo = r.getContentText();
    if (corpo.indexOf('blocked_by_time') !== -1) {
      return { ok: false, motivo: 'o ML bloqueou — pedido antigo demais', dias: dias };
    }
    return { ok: false, motivo: 'HTTP ' + codigo + ' — ' +
             corpo.replace(/\s+/g, ' ').substring(0, 150), dias: dias };

  } catch (e) {
    return { ok: false, motivo: e.message, dias: dias };
  }
}


// ===========================================================================
// TOKEN DO ML — lê as mesmas gavetas do resto do sistema
// ===========================================================================

function painelTokenML_(loja) {
  var props = PropertiesService.getScriptProperties();
  var bruto = props.getProperty('ml_token_' + loja);
  if (!bruto) return null;
  var t = JSON.parse(bruto);

  var valido = !t.expires_at || Date.now() / 1000 < t.expires_at - 120;
  if (valido) return t.access_token;

  // expirado: renova, gravando na mesma gaveta
  var ids = credenciaisMlPainel_();
  var r = UrlFetchApp.fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'post',
    payload: { grant_type: 'refresh_token', client_id: ids.id,
               client_secret: ids.secret, refresh_token: t.refresh_token },
    muteHttpExceptions: true
  });
  var novo = JSON.parse(r.getContentText());
  if (!novo.access_token) return null;
  novo.expires_at = Date.now() / 1000 + novo.expires_in;
  props.setProperty('ml_token_' + loja, JSON.stringify(novo));
  return novo.access_token;
}

/** O app do ML, o mesmo do telegram.gs. */
function credenciaisMlPainel_() {
  return { id: '1745879855583391', secret: '4ZtzYDfqJN0DiOya5PEwioWn94IMkuAD' };
}


// ===========================================================================
// TESTE DE MESA — roda no editor, sem abrir a página
// ===========================================================================

function painelTesteDeMesa() {
  Logger.log('PAINEL — TESTE DE MESA');
  Logger.log('');

  if (typeof PESO_SKU_PAINEL === 'undefined' || typeof NOME_LOGISTICA_PAINEL === 'undefined') {
    Logger.log('FALTA O TABELAS_PAINEL.gs — as tabelas de peso e de nome para');
    Logger.log('logística não estão no projeto. Crie esse arquivo antes.');
    return;
  }

  // ---- de onde vêm e onde somem ----
  //   Quando a lista vem vazia, é preciso saber se o Mercado Livre não
  //   devolveu nada ou se o meu filtro comeu tudo. Sem isso, "0 pedidos" não
  //   diz se está certo ou quebrado.
  Logger.log('=== ANTES DOS FILTROS ===');
  var jaNaPlanilha = pedidosNaPlanilhaPainel_();
  Logger.log('   ' + Object.keys(jaNaPlanilha).length + ' pedidos já na planilha.');
  Logger.log('');

  Object.keys(LOJAS_PAINEL).forEach(function (chave) {
    var loja = LOJAS_PAINEL[chave];
    var tk = painelTokenML_(chave);
    if (!tk) { Logger.log('   ' + loja.nome + ': sem token.'); return; }

    var brutos = pedidosRecentesMlPainel_(chave, tk, loja.seller);
    var naPlanilha = brutos.filter(function (x) { return jaNaPlanilha[String(x.id)]; });

    Logger.log('   ' + loja.nome + ': ' + brutos.length +
               ' pendente(s) no ML, ' + naPlanilha.length + ' já na planilha.');
    brutos.slice(0, 8).forEach(function (x) {
      Logger.log('      ' + String(x.id) + '   ' +
                 String(x.date_created).substring(0, 10) + '   R$ ' +
                 Number(x.total_amount).toFixed(2) +
                 (jaNaPlanilha[String(x.id)] ? '   <<< descartado: está na planilha' : ''));
    });
  });
  Logger.log('');

  var lista = painelListarPedidos(true);
  Logger.log('=== DEPOIS DOS FILTROS ===');
  Logger.log(lista.length + ' pedido(s) aberto(s) — envio ainda em "' +
             STATUS_ENVIO_ABERTO_PAINEL + '", janela de ' +
             JANELA_DIAS_PAINEL + ' dias.');
  lista.slice(0, 8).forEach(function (p) {
    Logger.log('   ' + p.lojaCurto + '  ' + p.cliente +
      '   (nome veio de: ' + p.origemNome + ')' +
      '   CPF ' + (p.cpf || 'NÃO VEIO') +
      '   ' + p.itens.length + ' item(ns)   ' + p.peso + ' kg   R$ ' + p.total.toFixed(2) +
      (p.dias ? '   há ' + p.dias + ' dias' : '') +
      (p.skuSemPeso.length ? '   SEM PESO: ' + p.skuSemPeso.join(',') : ''));
  });
  if (!lista.length) {
    Logger.log('');
    Logger.log('Sem pedido aberto não dá para testar nome, CPF nem cotação.');
    Logger.log('Para testar a TW agora, rode testarTW().');
    return;
  }

  var p = lista[0];
  Logger.log('');
  Logger.log('detalhe do primeiro:');
  var d = painelDetalhe(p.loja, p.ids[0], p.envioId);
  Logger.log('   ' + d.cidade + ', ' + d.uf + ' — CEP ' + d.cep);
  Logger.log('   ' + d.endereco);
  Logger.log('   quem recebe: ' + (d.recebe || '(não veio)'));
  Logger.log('   CPF ' + (d.cpf || '(não veio — rode painelDiagnosticoComprador)'));
  Logger.log('');

  Logger.log('cotando...');
  var t0 = new Date();
  var c = painelCotar(p, d);
  Logger.log('   levou ' + ((new Date() - t0) / 1000).toFixed(1) + 's no total');
  c.cotadas.forEach(function (x) {
    Logger.log('   ' + x.t + '   R$ ' + x.v.toFixed(2) + '   ' + x.prazo + ' dias' +
      (x.cotacao ? '   cotação ' + x.cotacao : '   (sem número)') +
      (x.obs ? '   ' + x.obs : '') + (x.caro ? '   CARO' : ''));
  });
  c.manuais.forEach(function (x) { Logger.log('   ' + x.t + '   (digitar)'); });
  c.recusadas.forEach(function (x) {
    Logger.log('   ' + x.t + '   recusou (erro ' + x.erro + '): ' + x.msg);
    if (x.cru) Logger.log('      cru: ' + x.cru);
  });
  c.avisos.forEach(function (a) { Logger.log('   aviso: ' + a); });
}


/**
 * VARIAÇÕES — qual combinação o gera-cotacao aceita
 *
 *   Em 19/09 a simulação cotou R$ 147,61 para Campo Limpo e o gera-cotacao
 *   recusou os MESMOS dados com "Não localizado CEP para entrega da
 *   mercadoria" — mesmo com o comprador já cadastrado. Como a mensagem não
 *   corresponde ao que está errado, não adianta interpretá-la: é preciso
 *   variar um dado por vez e ver qual passa.
 *
 *   O que muda entre o teste que funcionou (quinta) e os que falham:
 *   lá era 1 volume e 18 kg; aqui são 2 volumes e 40 kg.
 */
function painelVariacoesRodonaves(cep) {
  var lista = painelListarPedidos(false);
  var pedido = null, destino = null;
  var alvo = String(cep || '').replace(/\D/g, '');

  lista.forEach(function (x) {
    if (pedido) return;
    var d = painelDetalhe(x.loja, x.ids[0], x.envioId);
    if (!alvo || String(d.cep || '').replace(/\D/g, '') === alvo) { pedido = x; destino = d; }
  });
  if (!pedido) { Logger.log('Não achei pedido com esse CEP.'); return; }

  var doc = String(destino.cpf || pedido.cpf || '').replace(/\D/g, '');
  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('sem token'); return; }

  var cidade = cidadeRodonavesPainel_(token, String(destino.cep).replace(/\D/g, ''));

  Logger.log('VARIAÇÕES — ' + pedido.cliente + '   ' + destino.cidade + '/' + destino.uf);
  Logger.log(pedido.peso + ' kg, ' + pedido.volumes + ' volume(s), nota R$ ' +
             pedido.total.toFixed(2));
  Logger.log('');

  function base() {
    return {
      OriginZipCode: CEP_ORIGEM_PAINEL,
      OriginCityId: RODONAVES_PAINEL.cidadeOrigemReserva,
      DestinationZipCode: String(destino.cep).replace(/\D/g, ''),
      DestinationCityId: cidade,
      TotalWeight: Number(pedido.peso),
      EletronicInvoiceValue: Number(pedido.total),
      CustomerTaxIdRegistration: CNPJ_FACIL_PAINEL,
      ReceiverCpfcnp: doc,
      Packs: [{ AmountPackages: Number(pedido.volumes) || 1, Weight: Number(pedido.peso),
                Length: 2.15, Height: 0.04, Width: 0.95 }],
      ContactName: RODONAVES_PAINEL.contatoNome,
      ContactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
    };
  }

  var testes = [];

  // 1) como o painel manda hoje
  testes.push({ nome: 'como está hoje', corpo: base() });

  // 2) um volume só
  var umVolume = base();
  umVolume.Packs = [{ AmountPackages: 1, Weight: Number(pedido.peso),
                      Length: 2.15, Height: 0.04, Width: 0.95 }];
  testes.push({ nome: '1 volume em vez de ' + pedido.volumes, corpo: umVolume });

  // 3) um Pack por volume, como talvez ela espere
  var packSeparado = base();
  packSeparado.Packs = [];
  for (var i = 0; i < (Number(pedido.volumes) || 1); i++) {
    packSeparado.Packs.push({ AmountPackages: 1,
      Weight: Number(pedido.peso) / (Number(pedido.volumes) || 1),
      Length: 2.15, Height: 0.04, Width: 0.95 });
  }
  testes.push({ nome: 'um Pack por volume', corpo: packSeparado });

  // 4) sem dimensões, como o portal deles permite
  var semDim = base();
  semDim.Packs = [{ AmountPackages: Number(pedido.volumes) || 1,
                    Weight: Number(pedido.peso) }];
  testes.push({ nome: 'sem dimensões', corpo: semDim });

  // 5) peso leve, para ver se é limite de peso
  var leve = base();
  leve.TotalWeight = 18;
  leve.Packs = [{ AmountPackages: 1, Weight: 18, Length: 2.15, Height: 0.04, Width: 0.85 }];
  testes.push({ nome: '18 kg e 1 volume (como o teste que funcionou)', corpo: leve });

  // 6) sem o documento do destinatário
  var semDoc = base();
  semDoc.ReceiverCpfcnp = '';
  testes.push({ nome: 'sem o CPF do destinatário', corpo: semDoc });

  testes.forEach(function (t) {
    var r = buscarComRepeticaoPainel_({
      url: 'https://quotation-apigateway.rte.com.br/api/v1/gera-cotacao',
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      payload: JSON.stringify(t.corpo), muteHttpExceptions: true
    });

    if (!r) { Logger.log(pdV_(t.nome) + 'não alcancei'); return; }

    var codigo = r.getResponseCode();
    if (codigo === 200) {
      var d = {};
      try { d = JSON.parse(r.getContentText()); } catch (e) {}
      Logger.log(pdV_(t.nome) + 'PASSOU — R$ ' + Number(d.Value).toFixed(2) +
                 '   protocolo ' + (d.ProtocolNumber || '?'));
    } else {
      var msg = r.getContentText();
      try { msg = JSON.parse(msg).Message || msg; } catch (e) {}
      Logger.log(pdV_(t.nome) + codigo + ' — ' + String(msg).substring(0, 90));
    }
    Utilities.sleep(600);
  });

  Logger.log('');
  Logger.log('A que PASSAR diz o que estava errado. Se nenhuma passar, o');
  Logger.log('gera-cotacao não serve para este destino e o caminho é a');
  Logger.log('simulação, sem número.');
}

function pdV_(t) {
  t = String(t);
  return (t + '                                          ').substring(0, 42);
}


/**
 * O MESMO CASO QUE O PORTAL ACEITOU
 *
 *   Em 19/09 o portal deles cotou R$ 159,45 para Mongaguá/SP, CEP
 *   11730-118, CPF 305.497.378-63, 20 kg, 1 volume, nota de R$ 568 —
 *   cotação registrada 222877522.
 *
 *   Se a API recusar ESTES dados, o problema está no que eu envio, e não no
 *   destino. Se aceitar, então o cadastro dos outros compradores é que está
 *   saindo torto.
 *
 *   Edite os valores abaixo para repetir qualquer cotação que você fizer no
 *   portal.
 */
var CASO_PORTAL_RNR = {
  cep: '11730118',
  documento: '30549737863',
  nome: 'Thabatta Villani',
  peso: 20,
  volumes: 1,
  valorNF: 568.00
};

function painelCompararComPortalRodonaves() {
  var c = CASO_PORTAL_RNR;
  var cep = String(c.cep).replace(/\D/g, '');
  var doc = String(c.documento).replace(/\D/g, '');

  Logger.log('O MESMO CASO DO PORTAL');
  Logger.log('CEP ' + cep + '   CPF ' + doc + '   ' + c.peso + ' kg   ' +
             c.volumes + ' volume(s)   nota R$ ' + c.valorNF.toFixed(2));
  Logger.log('');

  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('sem token: ' + _motivoTokenRn); return; }

  var cache = CacheService.getScriptCache();
  cache.remove('rn_cidade_' + cep);

  var cidade = cidadeRodonavesPainel_(token, cep);
  Logger.log('cidade de destino: ' + (cidade || 'NÃO ACHEI — ' + _motivoCidadeRn));
  if (!cidade) return;

  var origem = cidadeRodonavesPainel_(token, CEP_ORIGEM_PAINEL);
  Logger.log('cidade de origem: ' + (origem || '(usando a reserva ' +
             RODONAVES_PAINEL.cidadeOrigemReserva + ')'));
  origem = origem || RODONAVES_PAINEL.cidadeOrigemReserva;
  Logger.log('');

  var corpo = {
    OriginZipCode: CEP_ORIGEM_PAINEL,
    OriginCityId: origem,
    DestinationZipCode: cep,
    DestinationCityId: cidade,
    TotalWeight: Number(c.peso),
    EletronicInvoiceValue: Number(c.valorNF),
    CustomerTaxIdRegistration: CNPJ_FACIL_PAINEL,
    ReceiverCpfcnp: doc,
    Packs: [{ AmountPackages: Number(c.volumes), Weight: Number(c.peso) }],
    ContactName: RODONAVES_PAINEL.contatoNome,
    ContactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
  };

  Logger.log('enviando: ' + JSON.stringify(corpo));
  var r = buscarComRepeticaoPainel_({
    url: 'https://quotation-apigateway.rte.com.br/api/v1/gera-cotacao',
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    payload: JSON.stringify(corpo), muteHttpExceptions: true
  });

  if (!r) { Logger.log('não alcancei.'); return; }
  Logger.log('HTTP ' + r.getResponseCode());
  Logger.log(r.getContentText().substring(0, 600));
  Logger.log('');

  if (r.getResponseCode() === 200) {
    Logger.log('PASSOU. Compare com o portal: R$ 159,45, 7 dias úteis,');
    Logger.log('cotação 222877522. Se bater, a API está certa e o problema');
    Logger.log('nos outros pedidos é o CADASTRO do comprador.');
  } else {
    Logger.log('RECUSOU com os mesmos dados que o portal aceitou. Então o');
    Logger.log('erro está no que eu envio — provavelmente um campo que o');
    Logger.log('portal manda e eu não.');
  }
}


/**
 * O QUE FALTA NO CADASTRO
 *
 *   Provado em 19/09: a API cota com protocolo quando o comprador já está
 *   cadastrado NO PORTAL deles (Thabatta, R$ 159,45, igual ao portal). Falha
 *   quando o cadastro foi criado pelo nosso savecustomer.
 *
 *   Ou seja, o cadastro que eu crio é aceito mas não serve para cotar.
 *   Falta campo. Este teste manda o cadastro de várias formas e, depois de
 *   cada uma, tenta cotar — a que fizer a cotação passar diz o que faltava.
 */
function painelVariacoesCadastroRodonaves(cep) {
  var lista = painelListarPedidos(false);
  var pedido = null, destino = null;
  var alvo = String(cep || '').replace(/\D/g, '');

  lista.forEach(function (x) {
    if (pedido) return;
    var d = painelDetalhe(x.loja, x.ids[0], x.envioId);
    if (!alvo || String(d.cep || '').replace(/\D/g, '') === alvo) { pedido = x; destino = d; }
  });
  if (!pedido) { Logger.log('Não achei pedido com esse CEP.'); return; }

  var doc = String(destino.cpf || pedido.cpf || '').replace(/\D/g, '');
  var cepD = String(destino.cep).replace(/\D/g, '');
  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('sem token'); return; }

  var cidade = cidadeRodonavesPainel_(token, cepD);
  var origem = cidadeRodonavesPainel_(token, CEP_ORIGEM_PAINEL) ||
               RODONAVES_PAINEL.cidadeOrigemReserva;

  Logger.log('CADASTRO — ' + pedido.cliente + '   ' + destino.cidade + '/' + destino.uf);
  Logger.log('CPF ' + doc + '   CEP ' + cepD + '   cidade ' + cidade);
  Logger.log('');

  // ---- o token do serviço de cadastro ----
  //   com repetição: esse host cai no meio de sequências que estavam
  //   funcionando, e uma tentativa só derruba o teste inteiro
  var tCli = null;
  var rt = buscarComRepeticaoPainel_({
    url: 'https://customer-apigateway.rte.com.br/token',
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=password&username=' + encodeURIComponent(RODONAVES_PAINEL.user) +
             '&password=' + encodeURIComponent(RODONAVES_PAINEL.senha) +
             '&companyId=' + RODONAVES_PAINEL.empresa + '&auth_type=dev',
    muteHttpExceptions: true
  });
  if (rt && rt.getResponseCode() === 200) {
    try { tCli = JSON.parse(rt.getContentText()).access_token; } catch (e) {}
  }
  if (!tCli) {
    Logger.log('sem token do cadastro' +
               (rt ? ' — HTTP ' + rt.getResponseCode() : ' — não alcancei o servidor'));
    return;
  }

  // ---- O QUE JÁ ESTÁ CADASTRADO NESSE CPF ----
  //   Antes de mexer, ver o que eles têm. Se o cadastro existir com endereço
  //   diferente do pedido, é isso que derruba a cotação — e aí o conserto é
  //   ATUALIZAR, não criar de novo.
  Logger.log('=== O QUE ELES JÁ TÊM DESSE CPF ===');
  [
    'https://customer-apigateway.rte.com.br/api/v1/customer/getcustomer?taxIdRegistration=' + doc,
    'https://customer-apigateway.rte.com.br/api/v1/customer?taxIdRegistration=' + doc,
    'https://customer-apigateway.rte.com.br/api/v1/customer/' + doc
  ].forEach(function (u) {
    var rr = buscarComRepeticaoPainel_({
      url: u, headers: { Authorization: 'Bearer ' + tCli, Accept: 'application/json' },
      muteHttpExceptions: true
    });
    if (!rr) { Logger.log('   ' + u.split('/api/v1/')[1] + ': não alcancei'); return; }
    Logger.log('   ' + u.split('/api/v1/')[1] + ': HTTP ' + rr.getResponseCode() +
               '   ' + rr.getContentText().replace(/\s+/g, ' ').substring(0, 300));
    Utilities.sleep(400);
  });
  Logger.log('');

  var rua = String(destino.endereco || '');
  var numero = (rua.match(/(\d+)\s*$/) || [])[1] || 'S/N';
  rua = rua.replace(/\s*\d+\s*$/, '').trim();
  var nome = destino.nomeNota || destino.nomeReal || destino.recebe || 'Cliente';

  function baseCad() {
    return {
      Description: nome,
      TaxIdRegistration: doc,
      Email: RODONAVES_PAINEL.email,
      Phone: String(RODONAVES_PAINEL.contatoTelefone).replace(/\D/g, ''),
      ZipCode: cepD,
      Street: rua,
      Number: numero,
      Supplement: '',
      District: destino.bairro || '',
      City: destino.cidade || '',
      UnitFederation: destino.uf || ''
    };
  }

  var variacoes = [];

  var comId = baseCad(); comId.CityId = cidade;
  variacoes.push({ nome: 'com CityId', corpo: comId });

  var comIdEUf = baseCad(); comIdEUf.CityId = cidade; comIdEUf.UnitFederationId = destino.uf;
  variacoes.push({ nome: 'com CityId e UnitFederationId', corpo: comIdEUf });

  var comCidadeReduzida = baseCad();
  comCidadeReduzida.CityId = cidade;
  comCidadeReduzida.City = destino.cidade;
  comCidadeReduzida.IbgeCityCode = '';
  variacoes.push({ nome: 'com CityId e cidade por extenso', corpo: comCidadeReduzida });

  variacoes.push({ nome: 'como está hoje (sem CityId)', corpo: baseCad() });

  variacoes.forEach(function (v) {
    var rc = buscarComRepeticaoPainel_({
      url: 'https://customer-apigateway.rte.com.br/api/v1/customer/savecustomer',
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + tCli, Accept: 'application/json' },
      payload: JSON.stringify(v.corpo), muteHttpExceptions: true
    });

    var comoFoi = rc ? ('HTTP ' + rc.getResponseCode()) : 'não alcancei';
    if (rc && rc.getResponseCode() !== 200) {
      comoFoi += ' — ' + rc.getContentText().replace(/\s+/g, ' ').substring(0, 80);
    }

    Utilities.sleep(1200);   // dá um tempo para o cadastro valer do lado deles

    // agora cota, que é o que importa
    var rq = buscarComRepeticaoPainel_({
      url: 'https://quotation-apigateway.rte.com.br/api/v1/gera-cotacao',
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      payload: JSON.stringify({
        OriginZipCode: CEP_ORIGEM_PAINEL, OriginCityId: origem,
        DestinationZipCode: cepD, DestinationCityId: cidade,
        TotalWeight: Number(pedido.peso),
        EletronicInvoiceValue: Number(pedido.total),
        CustomerTaxIdRegistration: CNPJ_FACIL_PAINEL,
        ReceiverCpfcnp: doc,
        Packs: [{ AmountPackages: Number(pedido.volumes) || 1, Weight: Number(pedido.peso) }],
        ContactName: RODONAVES_PAINEL.contatoNome,
        ContactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
      }),
      muteHttpExceptions: true
    });

    var cotou = 'não alcancei';
    if (rq) {
      if (rq.getResponseCode() === 200) {
        var d = {};
        try { d = JSON.parse(rq.getContentText()); } catch (e) {}
        cotou = 'COTOU R$ ' + Number(d.Value).toFixed(2) +
                '   protocolo ' + (d.ProtocolNumber || '?');
      } else {
        var m = rq.getContentText();
        try { m = JSON.parse(m).Message || m; } catch (e) {}
        cotou = rq.getResponseCode() + ' — ' + String(m).substring(0, 70);
      }
    }

    Logger.log(pdV_(v.nome) + 'cadastro ' + comoFoi);
    Logger.log(pdV_('') + 'cotação  ' + cotou);
    Logger.log('');
    Utilities.sleep(800);
  });

  Logger.log('A variação em que a COTAÇÃO passar diz o que faltava no cadastro.');
}


/**
 * AS FAIXAS DE CEP DE CADA CIDADE — o que separa quem cota de quem não cota
 *
 *   A resposta da consulta de cidade traz ZipCodeRanges, cada faixa com um
 *   Type. Campo Limpo Paulista, que o gera-cotacao recusa, tem faixas C e T.
 *   Mongaguá, que cotou com protocolo, deve ter outra — e se for assim, o
 *   Type é o que diz onde eles ENTREGAM.
 *
 *   Compare os dois e a dúvida acaba.
 */
function painelFaixasRodonaves() {
  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('sem token'); return; }

  var ceps = [
    { cep: '11730118', nome: 'Mongaguá — COTOU com protocolo' },
    { cep: '13232282', nome: 'Campo Limpo Paulista — RECUSA' },
    { cep: '47864364', nome: 'Luís Eduardo Magalhães — sem unidade' },
    { cep: '07607502', nome: 'Mairiporã — cotou no teste de quinta' },
    { cep: '89136000', nome: 'Rodeio — nossa origem' }
  ];

  ceps.forEach(function (c) {
    var r = buscarComRepeticaoPainel_({
      url: 'https://dne-api.rte.com.br/api/cities/byzipcode?zipCode=' + c.cep,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      muteHttpExceptions: true
    });

    Logger.log(c.nome);
    if (!r || r.getResponseCode() !== 200) {
      Logger.log('   não consegui consultar');
      Logger.log('');
      return;
    }

    var d = {};
    try { d = JSON.parse(r.getContentText()); } catch (e) {}
    var o = Array.isArray(d) ? d[0] : d;

    Logger.log('   ' + (o.Description || '?') + '   id ' + (o.Id || '?') +
               '   status ' + (o.Status || '?') + '   tipo ' + (o.Type || '?'));

    (o.ZipCodeRanges || []).forEach(function (f) {
      var dentro = (String(c.cep) >= String(f.StartingZipCode) &&
                    String(c.cep) <= String(f.EndingZipCode));
      Logger.log('   faixa tipo ' + f.Type + ': ' + f.StartingZipCode + ' a ' +
                 f.EndingZipCode + (dentro ? '   <<< o CEP está nesta' : ''));
    });
    Logger.log('');
    Utilities.sleep(500);
  });

  Logger.log('O QUE OLHAR: o tipo de faixa que Mongaguá e Mairiporã têm e');
  Logger.log('Campo Limpo não. Esse tipo é o que autoriza a entrega.');
}


/**
 * O TESTE CRUZADO — é o CPF ou é a cidade?
 *
 *   Mongaguá cota, Campo Limpo não. As faixas de CEP das duas são iguais, e
 *   a Rodonaves atende São Paulo inteiro. Então a diferença não é o destino:
 *   é que a Thabatta foi cadastrada PELO PORTAL e a Renata pelo nosso
 *   savecustomer.
 *
 *   Trocando um pelo outro, a dúvida morre:
 *     CPF do portal + CEP que recusa   -> se cotar, o destino está certo
 *     CPF nosso     + CEP que cota     -> se recusar, o cadastro é o culpado
 *
 *   E testa também o token SEM auth_type=dev. Se esse parâmetro estiver
 *   gravando o cliente numa base de desenvolvimento, o cadastro existe para
 *   eles e não existe para a cotação — o que explicaria tudo.
 */
var CPF_DO_PORTAL_RNR = '30549737863';   // Thabatta, cadastrada no portal
var CPF_NOSSO_RNR = '31538572885';       // Renata, cadastrada pela nossa API
var CEP_QUE_COTA_RNR = '11730118';       // Mongaguá
var CEP_QUE_RECUSA_RNR = '13232282';     // Campo Limpo Paulista

function painelTesteCruzadoRodonaves() {
  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('sem token'); return; }

  var origem = cidadeRodonavesPainel_(token, CEP_ORIGEM_PAINEL) ||
               RODONAVES_PAINEL.cidadeOrigemReserva;

  function cotar(doc, cep, rotulo) {
    var cidade = cidadeRodonavesPainel_(token, cep);
    var r = buscarComRepeticaoPainel_({
      url: 'https://quotation-apigateway.rte.com.br/api/v1/gera-cotacao',
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      payload: JSON.stringify({
        OriginZipCode: CEP_ORIGEM_PAINEL, OriginCityId: origem,
        DestinationZipCode: cep, DestinationCityId: cidade,
        TotalWeight: 20, EletronicInvoiceValue: 400,
        CustomerTaxIdRegistration: CNPJ_FACIL_PAINEL,
        ReceiverCpfcnp: doc,
        Packs: [{ AmountPackages: 1, Weight: 20 }],
        ContactName: RODONAVES_PAINEL.contatoNome,
        ContactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
      }),
      muteHttpExceptions: true
    });

    if (!r) { Logger.log(pdV_(rotulo) + 'não alcancei'); return; }
    if (r.getResponseCode() === 200) {
      var d = {};
      try { d = JSON.parse(r.getContentText()); } catch (e) {}
      Logger.log(pdV_(rotulo) + 'COTOU R$ ' + Number(d.Value).toFixed(2) +
                 '   protocolo ' + (d.ProtocolNumber || '?'));
    } else {
      var m = r.getContentText();
      try { m = JSON.parse(m).Message || m; } catch (e) {}
      Logger.log(pdV_(rotulo) + r.getResponseCode() + ' — ' + String(m).substring(0, 70));
    }
    Utilities.sleep(700);
  }

  Logger.log('=== CRUZANDO CPF E DESTINO ===');
  cotar(CPF_DO_PORTAL_RNR, CEP_QUE_COTA_RNR,   'portal + Mongaguá (controle)');
  cotar(CPF_DO_PORTAL_RNR, CEP_QUE_RECUSA_RNR, 'portal + Campo Limpo');
  cotar(CPF_NOSSO_RNR,     CEP_QUE_COTA_RNR,   'nosso + Mongaguá');
  cotar(CPF_NOSSO_RNR,     CEP_QUE_RECUSA_RNR, 'nosso + Campo Limpo');
  Logger.log('');

  // ---- o cadastro sem auth_type=dev ----
  Logger.log('=== O CADASTRO EM PRODUÇÃO, SEM auth_type=dev ===');
  [
    { nome: 'sem auth_type', extra: '' },
    { nome: 'auth_type=prod', extra: '&auth_type=prod' },
    { nome: 'auth_type=dev (como está hoje)', extra: '&auth_type=dev' }
  ].forEach(function (v) {
    var rt = buscarComRepeticaoPainel_({
      url: 'https://customer-apigateway.rte.com.br/token',
      method: 'post', contentType: 'application/x-www-form-urlencoded',
      payload: 'grant_type=password&username=' + encodeURIComponent(RODONAVES_PAINEL.user) +
               '&password=' + encodeURIComponent(RODONAVES_PAINEL.senha) +
               '&companyId=' + RODONAVES_PAINEL.empresa + v.extra,
      muteHttpExceptions: true
    });
    Logger.log('   ' + pdV_(v.nome) +
               (rt ? 'HTTP ' + rt.getResponseCode() : 'não alcancei'));
    Utilities.sleep(500);
  });

  Logger.log('');
  Logger.log('COMO LER:');
  Logger.log('   portal + Campo Limpo COTOU  -> o destino está certo, o');
  Logger.log('      problema é o nosso cadastro');
  Logger.log('   nosso + Mongaguá RECUSOU    -> confirma: é o CPF cadastrado');
  Logger.log('      por nós que não vale para cotar');
}


/**
 * COTAR SEM CADASTRAR NADA
 *
 *   A suspeita: o nosso savecustomer não FALTA — ele ESTRAGA. A Thabatta,
 *   em que nunca tocamos, cota. A Renata, que cadastramos várias vezes hoje,
 *   não cota em destino nenhum, nem no que funciona para a Thabatta.
 *
 *   E o comportamento mudou justamente quando passou a valer a versão em que
 *   o cadastro acontece ANTES de cada cotação — daí todo comprador novo
 *   passou a receber o nosso cadastro antes da primeira tentativa.
 *
 *   Este teste cota os pedidos abertos SEM cadastrar nada. Se algum CPF
 *   virgem cotar, está provado: o problema é o cadastro, e a saída é não
 *   cadastrar.
 */
function painelCotarSemCadastrarRodonaves() {
  var lista = painelListarPedidos(false);
  if (!lista.length) { Logger.log('Nenhum pedido aberto.'); return; }

  var token = tokenRodonavesPainel_();
  if (!token) { Logger.log('sem token'); return; }

  var origem = cidadeRodonavesPainel_(token, CEP_ORIGEM_PAINEL) ||
               RODONAVES_PAINEL.cidadeOrigemReserva;

  var jaMexidos = { '31538572885': 'Renata — cadastramos hoje',
                    '02460312555': 'alis — cadastramos hoje',
                    '32004157895': 'Felipe — cadastramos quinta' };

  Logger.log('COTANDO SEM CADASTRAR — ' + lista.length + ' pedido(s)');
  Logger.log('');

  lista.forEach(function (p) {
    var d = painelDetalhe(p.loja, p.ids[0], p.envioId);
    var doc = String(d.cpf || p.cpf || '').replace(/\D/g, '');
    if (!doc) { Logger.log(p.cliente + ': sem CPF'); return; }

    var cidade = cidadeRodonavesPainel_(token, String(d.cep).replace(/\D/g, ''));
    if (!cidade) { Logger.log(p.cliente + ': sem cidade'); return; }

    var r = buscarComRepeticaoPainel_({
      url: 'https://quotation-apigateway.rte.com.br/api/v1/gera-cotacao',
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      payload: JSON.stringify({
        OriginZipCode: CEP_ORIGEM_PAINEL, OriginCityId: origem,
        DestinationZipCode: String(d.cep).replace(/\D/g, ''),
        DestinationCityId: cidade,
        TotalWeight: Number(p.peso), EletronicInvoiceValue: Number(p.total),
        CustomerTaxIdRegistration: CNPJ_FACIL_PAINEL,
        ReceiverCpfcnp: doc,
        Packs: [{ AmountPackages: Number(p.volumes) || 1, Weight: Number(p.peso) }],
        ContactName: RODONAVES_PAINEL.contatoNome,
        ContactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
      }),
      muteHttpExceptions: true
    });

    var resposta;
    if (!r) {
      resposta = 'não alcancei';
    } else if (r.getResponseCode() === 200) {
      var dd = {};
      try { dd = JSON.parse(r.getContentText()); } catch (e) {}
      resposta = 'COTOU R$ ' + Number(dd.Value).toFixed(2) +
                 '   protocolo ' + (dd.ProtocolNumber || '?');
    } else {
      var m = r.getContentText();
      try { m = JSON.parse(m).Message || m; } catch (e) {}
      resposta = r.getResponseCode() + ' — ' + String(m).substring(0, 60);
    }

    Logger.log(pdV_(p.cliente.substring(0, 28)) +
               (d.cidade || '?') + '/' + (d.uf || '?'));
    Logger.log(pdV_('') + resposta +
               (jaMexidos[doc] ? '   [' + jaMexidos[doc] + ']' : '   [CPF virgem]'));
    Logger.log('');
    Utilities.sleep(700);
  });

  Logger.log('COMO LER: se um CPF VIRGEM cotar, o cadastro é que estraga —');
  Logger.log('e a saída é simplesmente não cadastrar ninguém.');
}


// ===========================================================================
// A RODONAVES PELO CAMINHO DO PORTAL
// ===========================================================================
/**
 * DESCOBERTO EM 19/09, olhando a aba de rede do navegador
 *
 *   O portal deles NÃO usa o gera-cotacao da documentação. Ele chama
 *   https://rodonaves.com.br/api/quotations/create, com um corpo
 *   completamente diferente: origem e destino como objetos, os endereços
 *   dos dois lados por extenso, totalWeightKg, volumeCount — e NENHUM id de
 *   cidade, que era justamente o que eu vinha consultando e enviando.
 *
 *   É por isso que o portal cota tudo e a API documentada recusava metade.
 *
 *   O endereço de origem é fixo: é o galpão.
 */
var ORIGEM_PORTAL_RNR = {
  street: 'BARAO DO RIO BRANCO',
  number: '2490',
  complement: 'GALPAO FUNDOS',
  district: 'GAVEA'
};

/**
 * Cota pelo caminho do portal.
 *   destino: { cep, endereco, bairro }   documento: CPF ou CNPJ de quem recebe
 */
function cotarPortalRodonaves_(destino, doc, peso, volumes, valorNF) {
  var cep = String(destino.cep || '').replace(/\D/g, '');

  var rua = String(destino.endereco || '');
  var numero = (rua.match(/(\d+)\s*$/) || [])[1] || 'S/N';
  rua = rua.replace(/\s*\d+\s*$/, '').trim();

  var documento = String(doc || '').replace(/\D/g, '');

  var corpo = {
    origin: { zipCode: CEP_ORIGEM_PAINEL },
    originAddress: ORIGEM_PORTAL_RNR,
    destination: { zipCode: cep },
    destinationAddress: {
      street: rua,
      number: numero,
      district: destino.bairro || ''
    },
    // 1 = pessoa física, 2 = jurídica. CNPJ tem 14 dígitos.
    recipientPersonType: documento.length > 11 ? 2 : 1,
    senderTaxId: CNPJ_FACIL_PAINEL,
    receiverTaxId: documento,
    invoiceValue: Number(valorNF) || 0,
    totalWeightKg: Number(peso) || 0,
    volumeCount: Number(volumes) || 1,
    contactName: RODONAVES_PAINEL.contatoNome,
    contactPhoneNumber: RODONAVES_PAINEL.contatoTelefone
  };

  var r = buscarComRepeticaoPainel_({
    url: 'https://rodonaves.com.br/api/quotations/create',
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(corpo),
    muteHttpExceptions: true
  });

  return { corpo: corpo, resposta: r };
}

/** Testa o caminho do portal nos pedidos abertos. */
function painelTestarPortalRodonaves() {
  var lista = painelListarPedidos(false);
  if (!lista.length) { Logger.log('Nenhum pedido aberto.'); return; }

  Logger.log('RODONAVES PELO CAMINHO DO PORTAL');
  Logger.log('');

  lista.forEach(function (p) {
    var d = painelDetalhe(p.loja, p.ids[0], p.envioId);
    var doc = String(d.cpf || p.cpf || '').replace(/\D/g, '');
    if (!d.cep) { Logger.log(p.cliente + ': sem endereço'); return; }

    var r = cotarPortalRodonaves_(d, doc, p.peso, p.volumes, p.total);

    Logger.log(pdV_(p.cliente.substring(0, 28)) + (d.cidade || '?') + '/' + (d.uf || '?'));
    Logger.log(pdV_('') + 'enviei: ' + JSON.stringify(r.corpo).substring(0, 220));

    if (!r.resposta) {
      Logger.log(pdV_('') + 'não alcancei');
    } else {
      Logger.log(pdV_('') + 'HTTP ' + r.resposta.getResponseCode() + '   ' +
                 r.resposta.getContentText().replace(/\s+/g, ' ').substring(0, 300));
    }
    Logger.log('');
    Utilities.sleep(800);
  });

  Logger.log('Se vier 200 com valor, é por aqui que a Rodonaves passa a cotar.');
  Logger.log('Se vier 401 ou 403, o portal manda um token que eu não tenho —');
  Logger.log('e aí eu preciso ver os cabeçalhos daquela mesma chamada.');
}


/**
 * DE ONDE SAI O FRETE QUE O COMPRADOR PAGOU
 *   Mostra os três caminhos lado a lado, em cada pedido aberto, para ver
 *   qual deles o Mercado Livre está preenchendo hoje.
 */
function painelConferirFreteRecebido() {
  Object.keys(LOJAS_PAINEL).forEach(function (chave) {
    var loja = LOJAS_PAINEL[chave];
    var token = painelTokenML_(chave);
    if (!token) return;

    var desde = new Date(Date.now() - 7 * 86400000);
    var iso = Utilities.formatDate(desde, 'GMT-3', "yyyy-MM-dd'T'00:00:00.000-03:00");
    var r = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/orders/search?seller=' + loja.seller +
      '&order.status=paid&sort=date_desc&order.date_created.from=' +
      encodeURIComponent(iso) + '&limit=8', {
        headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return;

    Logger.log('## ' + loja.nome);
    (JSON.parse(r.getContentText()).results || []).forEach(function (p) {
      var porPagamento = 0;
      (p.payments || []).forEach(function (pg) {
        porPagamento += Number(pg.shipping_cost || 0);
      });
      var porDiferenca = Number(p.paid_amount || 0) - Number(p.total_amount || 0);
      var porEnvio = (p.shipping && p.shipping.cost) ? Number(p.shipping.cost) : 0;

      Logger.log('   ' + p.id +
                 '   produtos R$ ' + Number(p.total_amount || 0).toFixed(2) +
                 '   pago R$ ' + Number(p.paid_amount || 0).toFixed(2));
      Logger.log('      pelo pagamento: ' + porPagamento.toFixed(2) +
                 '   pela diferença: ' + porDiferenca.toFixed(2) +
                 '   pelo envio: ' + porEnvio.toFixed(2));
    });
    Logger.log('');
  });
}


/**
 * ONDE ESTÁ O FRETE QUE O COMPRADOR PAGOU
 *
 *   A extensão lê da PÁGINA, no bloco "Envios" do extrato da venda — e
 *   acerta. A API de pedidos não traz isso: em 19/09, a venda da Renata
 *   apareceu como frete grátis quando ela pagou R$ 189.
 *
 *   O equivalente público é /shipments/{id}/costs, que separa o que o
 *   comprador pagou do que foi debitado do vendedor. Este teste mostra a
 *   resposta crua de cada pedido aberto, para conferir contra o que você vê
 *   na tela do Mercado Livre antes de eu ligar isso no painel.
 */
function painelOndeEstaOFrete() {
  var lista = painelListarPedidos(false);
  if (!lista.length) { Logger.log('Nenhum pedido aberto.'); return; }

  lista.forEach(function (p) {
    var token = painelTokenML_(p.loja);
    var h = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };

    Logger.log(p.cliente + '   ' + p.lojaCurto + '   produtos R$ ' + p.total.toFixed(2));

    if (!p.envioId) { Logger.log('   sem envio'); Logger.log(''); return; }

    // 1) os custos do envio
    var r = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/shipments/' + p.envioId + '/costs', h);
    Logger.log('   costs: HTTP ' + r.getResponseCode() + '   ' +
               r.getContentText().replace(/\s+/g, ' ').substring(0, 400));

    // 2) o envio inteiro, campos de valor
    var rs = UrlFetchApp.fetch(
      'https://api.mercadolibre.com/shipments/' + p.envioId, h);
    if (rs.getResponseCode() === 200) {
      try {
        var e = JSON.parse(rs.getContentText());
        Logger.log('   envio: modo ' + (e.mode || '?') +
                   '   base_cost ' + (e.base_cost === undefined ? '-' : e.base_cost) +
                   '   option.cost ' +
                   ((e.shipping_option && e.shipping_option.cost) === undefined
                     ? '-' : e.shipping_option.cost) +
                   '   option.list_cost ' +
                   ((e.shipping_option && e.shipping_option.list_cost) === undefined
                     ? '-' : e.shipping_option.list_cost));
      } catch (eE) {}
    }
    Logger.log('');
    Utilities.sleep(400);
  });

  Logger.log('Compare com o que a tela do ML mostra em "Envios" na venda.');
}


// ===========================================================================
// ATALHOS DE TESTE
// ===========================================================================
/**
 * O botão Executar do editor roda a função SEM argumentos. Por isso estes
 * atalhos: troque o CEP aqui dentro e execute.
 *
 * Ficam DENTRO do arquivo de propósito — escritos à mão no editor, somem
 * toda vez que o PAINEL.gs é colado por cima.
 */
function testarRodonavesCampoLimpo() {
  painelDiagnosticoRodonaves('13232282');
}

/** Varia um dado por vez, para achar o que o gera-cotacao recusa. */
function testarVariacoesCampoLimpo() {
  painelVariacoesRodonaves('13232282');
}

/** Descobre o que falta no cadastro do comprador. */
function testarCadastroCampoLimpo() {
  painelVariacoesCadastroRodonaves('13232282');
}

/** O primeiro pedido aberto, seja ele qual for. */
function testarRodonavesPrimeiroPedido() {
  painelDiagnosticoRodonaves();
}
