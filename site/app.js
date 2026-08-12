/* ============================================================
   Empresa 1 — funcionamento (frontend)
   ============================================================ */

let USUARIO = null;          // { id, nome, tipo, token }
let TOKEN = null;            // token de autenticação (online)
let CONFIG = { descontoCartao: 0.10 };

// ---------- Atalhos ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// fundo rotativo: sorteia 1 das 3 fotos a cada carregamento
try { document.documentElement.style.setProperty("--fundo", `url("fundo${1 + Math.floor(Math.random() * 3)}.jpg")`); } catch (e) {}

// quem é funcionária de fato (aparece nos painéis de pagamento/cartão/lucro)
function ehFuncionaria(u) { return u.tipo === "manicure" || u.tipo === "cabeleireira"; }

let FUNCIONARIAS = []; // lista para o dropdown do pagamento conjunto

// ---------- método "compensar comissão pelo cartão" (afeta só dinheiro) ----------
// quanto o salão PAGA à funcionária por esse lançamento no dia
function receberDe(l, compensa) {
  if (l.forma === "cartao") return 0;                      // cartão acumula, não é do dia
  if (compensa && l.forma === "dinheiro") return 0;        // recebeu na hora, não entra no pagamento do dia
  return l.valorFuncionaria;
}
// comissão de dinheiro que fica "pendurada" no cartão (ainda não quitada)
function dividaCartaoDe(lancs, compensa) {
  if (!compensa) return 0;
  return lancs.filter(l => l.forma === "dinheiro" && l.commQuitada === false)
              .reduce((s, l) => s + l.comissaoSalao, 0);
}

function reais(n) {
  return "R$ " + (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function hojeStr() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}
function dataBonita(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

// ---------- Chamada à API ----------
async function api(rota, opcoes = {}) {
  opcoes.headers = Object.assign(
    { "Content-Type": "application/json" },
    TOKEN ? { "Authorization": "Bearer " + TOKEN } : {},
    opcoes.headers || {}
  );
  const r = await fetch(rota, opcoes);
  let dados = null;
  try { dados = await r.json(); } catch (e) { dados = {}; }
  if (!r.ok) throw new Error(dados.erro || "Erro na operação.");
  return dados;
}

// ---------- Sessão ----------
function salvarSessao(u) {
  USUARIO = u;
  TOKEN = u.token || null;
  try { sessionStorage.setItem("usuario", JSON.stringify(u)); } catch (e) {}
}
function recuperarSessao() {
  try {
    const s = sessionStorage.getItem("usuario");
    if (s) { USUARIO = JSON.parse(s); TOKEN = USUARIO.token || null; }
  } catch (e) {}
}
function sair() {
  USUARIO = null;
  TOKEN = null;
  try { sessionStorage.removeItem("usuario"); } catch (e) {}
  mostrarTela("login");
}

// ---------- Navegação entre telas ----------
function mostrarTela(qual) {
  $("#tela-login").classList.toggle("ativa", qual === "login");
  $("#tela-funcionaria").classList.toggle("ativa", qual === "funcionaria");
  $("#tela-admin").classList.toggle("ativa", qual === "admin");
  $("#topo").classList.toggle("oculto", qual === "login");
  if (qual !== "login") {
    $("#topo-usuario").textContent = USUARIO.nome + " · " +
      (USUARIO.tipo === "admin" ? "Administradora"
        : USUARIO.tipo === "assistente" ? "Assistente ADM" : USUARIO.tipo);
  }
}

async function entrarNoSistema() {
  try { CONFIG = await api("/api/config"); } catch (e) {}
  if (USUARIO.tipo === "admin" || USUARIO.tipo === "assistente") {
    mostrarTela("admin");
    ajustarPapel();
    $("#adm-data").value = hojeStr();
    $("#lucro-de").value = hojeStr();
    $("#lucro-ate").value = hojeStr();
    await Promise.all([carregarPagamentos(), carregarFuncionarias()]);
  } else {
    mostrarTela("funcionaria");
    await carregarMeuDia();
    carregarRankingFunc();
    try { FUNCIONARIAS = await api("/api/funcionarias"); } catch (e) {}
  }
}

// Ajusta o que cada papel pode ver. Assistente não vê "Meu lucro".
function ajustarPapel() {
  const assistente = USUARIO.tipo === "assistente";
  // Assistente não vê "Meu lucro", "Resumo mês" (lucro) nem "Funcionárias"
  ["lucro", "resumo", "funcionarias"].forEach(nome => {
    const aba = document.querySelector(`.aba[data-aba="${nome}"]`);
    if (aba) {
      aba.classList.toggle("oculto", assistente);
      if (assistente && aba.classList.contains("ativa")) {
        document.querySelector('.aba[data-aba="pagamentos"]').click();
      }
    }
  });
  // Bira (assistente) vê as demandas, mas não pode designar (só concluir)
  const demForm = $("#dem-form-bloco");
  if (demForm) demForm.classList.toggle("oculto", assistente);
}

// ---------- meses ----------
function mesAtual() { return hojeStr().slice(0, 7); } // YYYY-MM
function limitesMes(mes) {
  const [a, m] = mes.split("-").map(Number);
  const ultimo = new Date(a, m, 0).getDate();
  return { de: `${mes}-01`, ate: `${mes}-${String(ultimo).padStart(2, "0")}` };
}

// ============================================================
//  LOGIN
// ============================================================
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-erro").textContent = "";
  try {
    const u = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ nome: $("#login-nome").value, senha: $("#login-senha").value })
    });
    salvarSessao(u);
    $("#form-login").reset();
    await entrarNoSistema();
  } catch (err) {
    $("#login-erro").textContent = err.message;
  }
});
$("#btn-sair").addEventListener("click", sair);

// ============================================================
//  PAINEL DA FUNCIONÁRIA
// ============================================================
let fotoBase64 = null;

$("#serv-foto").addEventListener("change", (e) => {
  const arq = e.target.files[0];
  fotoBase64 = null;
  const previa = $("#serv-previa");
  if (!arq) { previa.classList.add("oculto"); return; }
  const leitor = new FileReader();
  leitor.onload = () => {
    fotoBase64 = leitor.result;
    previa.src = fotoBase64;
    previa.classList.remove("oculto");
  };
  leitor.readAsDataURL(arq);
});

$("#form-servico").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#serv-msg");
  msg.textContent = ""; msg.className = "msg";
  const botao = e.target.querySelector('button[type="submit"]');
  if (botao.disabled) return;                 // trava contra duplo clique
  botao.disabled = true; botao.textContent = "Salvando...";
  const forma = document.querySelector('input[name="forma"]:checked').value;
  const ehConjunto = $("#serv-conjunto") && $("#serv-conjunto").checked;
  const ehMulti = $("#serv-multi") && $("#serv-multi").checked;
  try {
    if (ehConjunto) {
      const participantes = [{ usuarioId: USUARIO.id, descricao: $("#serv-descricao").value, valor: $("#serv-valor").value }];
      $$(".participante").forEach(p => participantes.push({
        usuarioId: p.querySelector(".cj-func").value,
        descricao: p.querySelector(".cj-desc").value,
        valor: p.querySelector(".cj-valor").value
      }));
      await api("/api/lancamentos-conjunto", {
        method: "POST",
        body: JSON.stringify({ forma, data: hojeStr(), comprovanteBase64: fotoBase64, participantes })
      });
    } else if (ehMulti) {
      const pagamentos = [
        { forma: "pix", valor: Number($("#mv-pix").value) || 0 },
        { forma: "dinheiro", valor: Number($("#mv-dinheiro").value) || 0 },
        { forma: "cartao", valor: Number($("#mv-cartao").value) || 0 }
      ].filter(p => p.valor > 0);
      if (pagamentos.length < 2) throw new Error("No pagamento dividido, preencha ao menos duas formas. Se for uma só, desmarque a opção.");
      await api("/api/lancamentos", {
        method: "POST",
        body: JSON.stringify({
          descricao: $("#serv-descricao").value,
          pagamentos,
          data: hojeStr(),
          comprovanteBase64: fotoBase64
        })
      });
    } else {
      await api("/api/lancamentos", {
        method: "POST",
        body: JSON.stringify({
          descricao: $("#serv-descricao").value,
          valor: $("#serv-valor").value,
          forma,
          data: hojeStr(), // usa a data local do aparelho (corrige o fuso à noite)
          comprovanteBase64: fotoBase64
        })
      });
    }
    $("#form-servico").reset();
    $("#conjunto-box").classList.add("oculto");
    $("#conjunto-lista").innerHTML = "";
    resetMultiPagamento();
    $("#serv-previa").classList.add("oculto");
    fotoBase64 = null;
    msg.textContent = "Serviço salvo! ✔";
    msg.className = "msg ok";
    await carregarMeuDia();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg ruim";
  } finally {
    botao.disabled = false; botao.textContent = "Salvar serviço";
  }
});

// ---------- Pagamento conjunto (UI) ----------
if ($("#serv-conjunto")) $("#serv-conjunto").addEventListener("change", (e) => {
  $("#conjunto-box").classList.toggle("oculto", !e.target.checked);
  if (e.target.checked) {
    // conjunto e dividido não se combinam: desliga o dividido
    if ($("#serv-multi") && $("#serv-multi").checked) { $("#serv-multi").checked = false; aplicarMultiPagamento(false); }
    if (!$("#conjunto-lista").children.length) addParticipante();
  }
});

// ---------- Pagamento dividido / várias formas (UI) ----------
function aplicarMultiPagamento(ligado) {
  $("#multi-box").classList.toggle("oculto", !ligado);
  $("#bloco-forma").classList.toggle("oculto", ligado);   // no dividido, a forma vem dos campos
  $("#bloco-valor").classList.toggle("oculto", ligado);   // no dividido, o total é a soma
  const val = $("#serv-valor");
  if (ligado) val.removeAttribute("required"); else val.setAttribute("required", "");
}
function resetMultiPagamento() {
  if (!$("#serv-multi")) return;
  $("#serv-multi").checked = false;
  ["#mv-pix", "#mv-dinheiro", "#mv-cartao"].forEach(s => { if ($(s)) $(s).value = ""; });
  atualizarTotalMulti();
  aplicarMultiPagamento(false);
}
function atualizarTotalMulti() {
  if (!$("#mv-total-val")) return;
  const t = ["#mv-pix", "#mv-dinheiro", "#mv-cartao"].reduce((s, sel) => s + (Number($(sel).value) || 0), 0);
  $("#mv-total-val").textContent = reais(t);
}
if ($("#serv-multi")) $("#serv-multi").addEventListener("change", (e) => {
  aplicarMultiPagamento(e.target.checked);
  if (e.target.checked && $("#serv-conjunto") && $("#serv-conjunto").checked) {
    $("#serv-conjunto").checked = false;
    $("#conjunto-box").classList.add("oculto");
  }
});
["#mv-pix", "#mv-dinheiro", "#mv-cartao"].forEach(sel => {
  if ($(sel)) $(sel).addEventListener("input", atualizarTotalMulti);
});
if ($("#conjunto-add")) $("#conjunto-add").addEventListener("click", () => addParticipante());
function addParticipante() {
  const opts = FUNCIONARIAS.filter(f => f.id !== USUARIO.id)
    .map(f => `<option value="${f.id}">${escapar(f.nome)}</option>`).join("");
  const div = document.createElement("div");
  div.className = "participante";
  div.innerHTML = `
    <label>Funcionária</label>
    <select class="cj-func">${opts}</select>
    <label>Serviço dela</label>
    <input class="cj-desc" type="text" placeholder="Ex.: pé e mão" />
    <label>Valor dela (R$)</label>
    <input class="cj-valor" type="number" step="0.01" min="0" placeholder="0,00" />
    <button type="button" class="btn-vermelho cj-remove" style="margin-top:8px">remover</button>`;
  div.querySelector(".cj-remove").addEventListener("click", () => div.remove());
  $("#conjunto-lista").appendChild(div);
}

async function carregarMeuDia() {
  const hoje = hojeStr();
  const doDia = await api("/api/lancamentos?data=" + hoje);
  const cartaoTudo = await api("/api/lancamentos"); // todos os meus (para acumulado de cartão)

  const compensa = !!USUARIO.compensa;
  const receberHoje = doDia
    .filter(l => l.forma !== "cartao")
    .reduce((s, l) => s + receberDe(l, compensa), 0);
  const dinheiroHoje = compensa
    ? doDia.filter(l => l.forma === "dinheiro").reduce((s, l) => s + l.valor, 0)
    : 0;
  const cartaoBase = cartaoTudo
    .filter(l => l.forma === "cartao" && !l.pago)
    .reduce((s, l) => s + l.valorFuncionaria, 0);
  const cartaoAcum = Math.max(0, cartaoBase - dividaCartaoDe(cartaoTudo, compensa));

  const lblRec = $("#func-receber-label"); if (lblRec) lblRec.textContent = compensa ? "A receber hoje (Pix)" : "A receber hoje";
  $("#func-receber").textContent = reais(receberHoje);
  const chipDin = $("#chip-func-dinheiro");
  if (chipDin) { chipDin.classList.toggle("oculto", !compensa); $("#func-dinheiro").textContent = reais(dinheiroHoje); }
  $("#func-cartao").textContent = reais(cartaoAcum);

  const lista = $("#func-lista");
  if (!doDia.length) {
    lista.innerHTML = '<div class="vazio">Nenhum serviço lançado hoje ainda.</div>';
    return;
  }
  lista.innerHTML = doDia.map(l => itemLancamentoHtml(l, true, compensa)).join("");
  ligarBotoesExcluir(lista, carregarMeuDia);
  ligarEditar(lista, carregarMeuDia);
  ligarFotos(lista);
}

// HTML de um lançamento na lista
// selo de agrupamento: "conjunto" (prefixo cj_) ou "dividido" (demais grupos)
function tagGrupoHtml(l) {
  if (!l.grupo) return "";
  return String(l.grupo).startsWith("cj_")
    ? ' <span class="tag tag-conjunto">conjunto</span>'
    : ' <span class="tag tag-dividido">dividido</span>';
}
function itemLancamentoHtml(l, podeExcluir, compensa) {
  const foto = l.comprovante
    ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}" alt="comprovante">`
    : `<div class="sem-foto">—</div>`;
  const tag = `<span class="tag tag-${l.forma}">${l.forma === "cartao" ? "Cartão" : l.forma === "pix" ? "Pix" : "Dinheiro"}</span>`;
  const pago = l.pago ? ' <span class="tag tag-pago">pago</span>' : "";
  const podeMexer = podeExcluir && !l.pago;
  const editar = podeMexer ? linkEditarHtml(l) : "";
  const excluir = podeMexer
    ? `<button class="link-excluir" data-excluir="${l.id}">excluir</button>` : "";
  return `<div class="item">
    ${foto}
    <div class="item-info">
      <div class="item-desc">${escapar(l.descricao)}${tagGrupoHtml(l)}</div>
      <div class="item-sub">${tag}${pago} · ${(compensa && l.forma === "dinheiro") ? `recebido na hora ${reais(l.valor)}` : `você recebe ${reais(receberDe(l, compensa))}`} ${editar} ${excluir}</div>
    </div>
    <div class="item-valor">${reais(l.valor)}</div>
  </div>`;
}

function ligarBotoesExcluir(container, recarregar) {
  container.querySelectorAll("[data-excluir]").forEach(b => {
    b.addEventListener("click", async () => {
      if (!confirm("Excluir este lançamento?")) return;
      try { await api("/api/lancamentos/" + b.dataset.excluir, { method: "DELETE" }); recarregar(); }
      catch (e) { alert(e.message); }
    });
  });
}

// ---------- editar um lançamento ----------
function linkEditarHtml(l) {
  return `<button class="link-editar" data-edl="${l.id}" data-desc="${escapar(l.descricao)}" data-valor="${l.valor}" data-forma="${l.forma}">editar</button>`;
}

// Mostra a "conta por trás" do valor pago: total cobrado − comissão do salão
function contaHtml(l, compensa) {
  if (compensa && l.forma === "dinheiro")
    return `<small class="conta">não entra no pagamento · comissão ${reais(l.comissaoSalao)} sai do cartão</small>`;
  return `<small class="conta">${reais(l.valor)} − ${reais(l.comissaoSalao)} · ${l.regra}</small>`;
}
function ligarEditar(container, recarregar) {
  container.querySelectorAll("[data-edl]").forEach(b => {
    b.addEventListener("click", async () => {
      const desc = prompt("Descrição do serviço:", b.dataset.desc);
      if (desc === null) return;
      const valorStr = prompt("Valor cobrado (R$):", b.dataset.valor);
      if (valorStr === null) return;
      const forma = prompt('Forma de pagamento — digite "pix", "cartao" ou "dinheiro":', b.dataset.forma);
      if (forma === null) return;
      try {
        await api("/api/lancamentos/" + b.dataset.edl, {
          method: "PUT",
          body: JSON.stringify({ descricao: desc, valor: valorStr, forma: (forma || "").trim().toLowerCase() })
        });
        recarregar();
      } catch (e) { alert(e.message); }
    });
  });
}

// ============================================================
//  PAINEL DO ADMINISTRADOR — abas
// ============================================================
$$(".aba").forEach(aba => {
  aba.addEventListener("click", () => {
    $$(".aba").forEach(a => a.classList.remove("ativa"));
    aba.classList.add("ativa");
    const alvo = aba.dataset.aba;
    $$(".painel").forEach(p => p.classList.remove("ativo"));
    $("#painel-" + alvo).classList.add("ativo");
    if (alvo === "pagamentos") carregarPagamentos();
    if (alvo === "diaspagos") carregarDiasPagos();
    if (alvo === "cartao") carregarCartaoAcumulado();
    if (alvo === "lucro") carregarLucro();
    if (alvo === "resumo") carregarResumoMes();
    if (alvo === "ranking") carregarRankingAdmin();
    if (alvo === "backup") iniciarBackup();
    if (alvo === "funcionarias") carregarFuncionarias();
    if (alvo === "demandas") carregarDemandas();
  });
});

// ---------- Aba: pagamentos do dia ----------
$("#adm-data").addEventListener("change", carregarPagamentos);
$("#adm-hoje").addEventListener("click", () => { $("#adm-data").value = hojeStr(); carregarPagamentos(); });

async function carregarPagamentos() {
  const data = $("#adm-data").value || hojeStr();
  const lancs = await api("/api/lancamentos?data=" + data);
  const usuarios = await api("/api/usuarios");

  // agrupa por funcionária, só Pix + Dinheiro contam no pagamento do dia
  const porFunc = {};
  lancs.forEach(l => {
    if (l.forma === "cartao") return;
    (porFunc[l.usuarioId] = porFunc[l.usuarioId] || []).push(l);
  });

  let totalDia = 0;
  const cont = $("#adm-pagamentos");
  const cards = [];
  usuarios.filter(ehFuncionaria).forEach(u => {
    const itens = porFunc[u.id] || [];
    if (!itens.length) return;
    const total = itens.reduce((s, l) => s + receberDe(l, u.compensa), 0);
    const tudoPago = itens.every(l => l.pago);
    totalDia += total;
    cards.push(cardPagamentoHtml(u, itens, total, tudoPago, data));
  });

  $("#adm-total-dia").textContent = reais(totalDia);
  cont.innerHTML = cards.length ? cards.join("") :
    '<div class="vazio">Nenhum serviço (Pix/Dinheiro) neste dia.</div>';
  ligarFotos(cont);
  ligarAcoesPagamento(cont, data);
  ligarEditar(cont, carregarPagamentos);
  ligarToggles(cont);
  carregarAlertaPendentes();
}

function cardPagamentoHtml(u, itens, total, tudoPago, data) {
  const linhas = itens.map(l => {
    const dinCompensa = u.compensa && l.forma === "dinheiro";      // dinheiro já recebido na hora
    const valExib = dinCompensa ? l.valor : receberDe(l, u.compensa);
    return `<div class="linha-detalhe ${dinCompensa ? "linha-cinza" : ""}">
      <span>${l.comprovante ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}">` : ""}
        ${escapar(l.descricao)} <span class="tag tag-${l.forma}">${l.forma === "pix" ? "Pix" : "Dinheiro"}</span>${tagGrupoHtml(l)}
        ${dinCompensa ? '<span class="mini-cinza">recebido na hora</span>' : ""}
        ${l.pago ? "" : linkEditarHtml(l)}</span>
      <span class="valor-conta"><strong>${reais(valExib)}</strong>${contaHtml(l, u.compensa)}</span>
    </div>`;
  }).join("");
  const acao = tudoPago
    ? `<span class="pago-selo">✔ Pago</span>
       <button class="btn-cinza" data-reabrir="${u.id}">Desfazer</button>`
    : `<button class="btn-verde" data-pagar="${u.id}">Marcar como pago</button>`;
  const selo = tudoPago ? ` <span class="mini-tag-pago">✔ pago</span>` : "";
  return `<div class="card-func">
    <div class="card-cab card-toggle">
      <span class="card-nome"><span class="seta">▸</span> ${escapar(u.nome)}${selo}</span>
      <span class="card-valor-grande">${reais(total)}</span>
    </div>
    <div class="card-detalhe oculto">
      ${linhas}
      <div class="acoes">${acao}</div>
    </div>
  </div>`;
}

// abre/fecha os painéis ao clicar no cabeçalho
function ligarToggles(cont) {
  cont.querySelectorAll(".card-toggle").forEach(cab => {
    cab.addEventListener("click", () => {
      const det = cab.nextElementSibling;
      if (!det) return;
      const abrindo = det.classList.contains("oculto");
      det.classList.toggle("oculto");
      const seta = cab.querySelector(".seta");
      if (seta) seta.textContent = abrindo ? "▾" : "▸";
    });
  });
}

function ligarAcoesPagamento(cont, data) {
  cont.querySelectorAll("[data-pagar]").forEach(b => b.addEventListener("click", async () => {
    await api("/api/pagar", { method: "POST", body: JSON.stringify({ usuarioId: b.dataset.pagar, escopo: "dia", data }) });
    carregarPagamentos();
  }));
  cont.querySelectorAll("[data-reabrir]").forEach(b => b.addEventListener("click", async () => {
    await api("/api/reabrir", { method: "POST", body: JSON.stringify({ usuarioId: b.dataset.reabrir, escopo: "dia", data }) });
    carregarPagamentos();
  }));
}

// ---------- Aba: cartão acumulado ----------
$("#cartao-de").addEventListener("change", carregarCartaoAcumulado);
$("#cartao-ate").addEventListener("change", carregarCartaoAcumulado);
$("#cartao-tudo").addEventListener("click", () => {
  $("#cartao-de").value = ""; $("#cartao-ate").value = ""; carregarCartaoAcumulado();
});

async function carregarCartaoAcumulado() {
  const de = $("#cartao-de").value, ate = $("#cartao-ate").value;
  const lancs = await api("/api/lancamentos");
  const usuarios = await api("/api/usuarios");
  const porFunc = {};
  lancs.forEach(l => {
    if (l.forma !== "cartao" || l.pago) return;
    if (de && l.data < de) return;
    if (ate && l.data > ate) return;
    (porFunc[l.usuarioId] = porFunc[l.usuarioId] || []).push(l);
  });

  const cont = $("#adm-cartao");
  const cards = [];
  let totalGeral = 0;
  usuarios.filter(ehFuncionaria).forEach(u => {
    const itens = (porFunc[u.id] || []).slice().sort((a, b) => a.data.localeCompare(b.data));
    if (!itens.length) return;
    const brutoBase = itens.reduce((s, l) => s + l.valorFuncionaria, 0);
    const divida = dividaCartaoDe(lancs.filter(l => l.usuarioId === u.id), u.compensa);
    const bruto = Math.max(0, brutoBase - divida);
    const falta = Math.max(0, divida - brutoBase);
    const liquido = bruto * (1 - (CONFIG.descontoCartao || 0.10));
    totalGeral += bruto;
    const linhas = itens.map(l => `
      <div class="linha-detalhe">
        <span>${dataBonita(l.data)} · ${escapar(l.descricao)}
          ${l.comprovante ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}">` : ""}</span>
        <span class="valor-conta"><strong>${reais(l.valorFuncionaria)}</strong>${contaHtml(l, u.compensa)}</span>
      </div>`).join("");
    const linhaDivida = divida > 0
      ? `<div class="linha-detalhe"><span>− Comissão do dinheiro (método cartão)</span><strong>-${reais(divida)}</strong></div>` : "";
    const avisoFalta = falta > 0
      ? `<div class="alerta" style="margin-top:8px">⚠️ Faltou ${reais(falta)} de comissão além do cartão — descontar do Pix da funcionária.</div>` : "";
    cards.push(`<div class="card-func">
      <div class="card-cab card-toggle">
        <span class="card-nome"><span class="seta">▸</span> ${escapar(u.nome)}</span>
        <span class="card-valor-grande">${reais(bruto)}</span>
      </div>
      <div class="card-detalhe oculto">
        ${linhas}
        ${linhaDivida}
        <div class="linha-detalhe"><span>Líquido a sacar (−${Math.round((CONFIG.descontoCartao||0.10)*100)}% maquineta)</span><strong>${reais(liquido)}</strong></div>
        ${avisoFalta}
        <div class="acoes"><button class="btn-verde" data-pagar-cartao="${u.id}">Pagar acumulado e zerar</button></div>
      </div>
    </div>`);
  });

  $("#cartao-total").textContent = reais(totalGeral);
  cont.innerHTML = cards.length ? cards.join("") :
    '<div class="vazio">Nenhum valor de cartão acumulado neste período.</div>';
  ligarFotos(cont);
  ligarToggles(cont);
  cont.querySelectorAll("[data-pagar-cartao]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Confirmar pagamento do cartão acumulado e zerar? (paga TODO o cartão pendente da funcionária)")) return;
    await api("/api/pagar", { method: "POST", body: JSON.stringify({ usuarioId: b.dataset.pagarCartao, escopo: "cartao" }) });
    carregarCartaoAcumulado();
  }));
}

// ---------- Aba: meu lucro ----------
$("#lucro-de").addEventListener("change", carregarLucro);
$("#lucro-ate").addEventListener("change", carregarLucro);
$("#lucro-hoje").addEventListener("click", () => { $("#lucro-de").value = hojeStr(); $("#lucro-ate").value = hojeStr(); carregarLucro(); });
$("#lucro-mes").addEventListener("click", () => {
  const h = hojeStr(); $("#lucro-de").value = h.slice(0, 8) + "01"; $("#lucro-ate").value = h; carregarLucro();
});

async function carregarLucro() {
  const de = $("#lucro-de").value || hojeStr();
  const ate = $("#lucro-ate").value || hojeStr();
  const lancs = await api(`/api/lancamentos?de=${de}&ate=${ate}`);
  const usuarios = await api("/api/usuarios");

  const grupos = {};
  let total = 0;
  lancs.forEach(l => {
    (grupos[l.usuarioId] = grupos[l.usuarioId] || []).push(l);
    total += l.comissaoSalao;
  });

  $("#lucro-total").textContent = reais(total);
  const cont = $("#adm-lucro");
  const cards = [];
  usuarios.filter(ehFuncionaria).forEach(u => {
    const itens = (grupos[u.id] || []).slice().sort((a, b) => a.data.localeCompare(b.data));
    if (!itens.length) return;
    const lucro = itens.reduce((s, l) => s + l.comissaoSalao, 0);
    const fat = itens.reduce((s, l) => s + l.valor, 0);
    const linhas = itens.map(l => `
      <div class="linha-detalhe">
        <span>${dataBonita(l.data)} · ${escapar(l.descricao)}
          <span class="tag tag-${l.forma}">${l.forma === "pix" ? "Pix" : l.forma === "cartao" ? "Cartão" : "Dinheiro"}</span>
          ${l.comprovante ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}">` : ""}</span>
        <strong>${reais(l.comissaoSalao)}</strong>
      </div>`).join("");
    cards.push(`<div class="card-func">
      <div class="card-cab card-toggle">
        <span class="card-nome"><span class="seta">▸</span> ${escapar(u.nome)} <small>(${u.tipo})</small></span>
        <span class="card-valor-grande">${reais(lucro)}</span>
      </div>
      <div class="card-detalhe oculto">
        ${linhas}
        <div class="linha-detalhe"><span>Faturamento dela no período</span><strong>${reais(fat)}</strong></div>
      </div>
    </div>`);
  });
  cont.innerHTML = cards.length ? cards.join("") :
    '<div class="vazio">Sem comissões no período.</div>';
  ligarFotos(cont);
  ligarToggles(cont);
}

// ---------- Aba: resumo do mês (só admin) ----------
$("#resumo-mes").addEventListener("change", carregarResumoMes);
async function carregarResumoMes() {
  if (!$("#resumo-mes").value) $("#resumo-mes").value = mesAtual();
  const { de, ate } = limitesMes($("#resumo-mes").value);
  const lancs = await api(`/api/lancamentos?de=${de}&ate=${ate}`);
  const usuarios = await api("/api/usuarios");
  const grupos = {};
  let lucroTotal = 0;
  lancs.forEach(l => {
    (grupos[l.usuarioId] = grupos[l.usuarioId] || []).push(l);
    lucroTotal += l.comissaoSalao;
  });
  $("#resumo-lucro-total").textContent = reais(lucroTotal);
  const cont = $("#adm-resumo");
  const linhas = usuarios.filter(ehFuncionaria).map(u => {
    const itens = grupos[u.id] || [];
    return {
      nome: u.nome, tipo: u.tipo, qtd: itens.length,
      fat: itens.reduce((s, l) => s + l.valor, 0),
      recebido: itens.reduce((s, l) => s + l.valorFuncionaria, 0),
      lucro: itens.reduce((s, l) => s + l.comissaoSalao, 0)
    };
  }).filter(x => x.qtd > 0)
    .sort((a, b) => b.fat - a.fat || b.qtd - a.qtd); // maior faturamento (e serviços) primeiro
  cont.innerHTML = linhas.length ? linhas.map((x, i) => `
    <div class="card-func">
      <div class="card-cab">
        <span class="card-nome">${i + 1}º ${escapar(x.nome)} <small>(${x.tipo})</small></span>
        <span class="card-valor-grande">${reais(x.fat)}</span>
      </div>
      <div class="linha-detalhe"><span>Serviços no mês</span><strong>${x.qtd}</strong></div>
      <div class="linha-detalhe"><span>Faturamento</span><strong>${reais(x.fat)}</strong></div>
      <div class="linha-detalhe"><span>Recebido pela funcionária</span><strong>${reais(x.recebido)}</strong></div>
      <div class="linha-detalhe"><span>Lucro do salão (comissão)</span><strong>${reais(x.lucro)}</strong></div>
    </div>`).join("") :
    '<div class="vazio">Sem serviços neste mês.</div>';
}

// ---------- Ranking do mês (todas veem — só quantidade, sem valores) ----------
$("#ranking-mes").addEventListener("change", carregarRankingAdmin);
async function carregarRankingAdmin() {
  if (!$("#ranking-mes").value) $("#ranking-mes").value = mesAtual();
  const { de, ate } = limitesMes($("#ranking-mes").value);
  await pintarRanking($("#adm-ranking"), de, ate);
}
async function carregarRankingFunc() {
  const { de, ate } = limitesMes(mesAtual());
  await pintarRanking($("#func-ranking"), de, ate);
}

// ---------- Abas da funcionária (Hoje / Meu mês) ----------
$$(".faba").forEach(aba => {
  aba.addEventListener("click", () => {
    $$(".faba").forEach(a => a.classList.remove("ativa"));
    aba.classList.add("ativa");
    const alvo = aba.dataset.faba;
    document.querySelectorAll(".fpainel").forEach(p => p.classList.remove("ativo"));
    $("#fpainel-" + alvo).classList.add("ativo");
    if (alvo === "mes") carregarMeuMes();
  });
});
$("#func-mes").addEventListener("change", carregarMeuMes);

async function carregarMeuMes() {
  if (!$("#func-mes").value) $("#func-mes").value = mesAtual();
  const { de, ate } = limitesMes($("#func-mes").value);
  const lancs = await api(`/api/lancamentos?de=${de}&ate=${ate}`);
  const compensa = !!USUARIO.compensa;
  // "Já recebi" = dinheiro (sempre, pego na hora) + pix e cartão SÓ quando marcados como pago.
  // O método cartão NÃO muda isso — ele só decide se a comissão do dinheiro sai do cartão.
  let recebido = 0, pendente = 0, dividaDin = 0;
  const porDia = {};
  lancs.forEach(l => {
    let recNow = 0;
    if (l.forma === "dinheiro") {
      // dinheiro conta sempre, nos dois métodos.
      // método ligado: pegou o valor cheio (a comissão sai do cartão). método desligado: a parte dela.
      recNow = compensa ? l.valor : l.valorFuncionaria;
      recebido += recNow;
      if (compensa && l.commQuitada === false) dividaDin += l.comissaoSalao;
    } else {
      // pix e cartão: só contam depois de marcados como pago
      if (l.pago) { recNow = l.valorFuncionaria; recebido += recNow; }
      else pendente += l.valorFuncionaria;
    }
    if (recNow > 0) {
      const d = porDia[l.data] = porDia[l.data] || { data: l.data, total: 0 };
      d.total += recNow;
    }
  });
  pendente = Math.max(0, pendente - dividaDin);
  $("#func-mes-recebido").textContent = reais(recebido);
  $("#func-mes-pendente").textContent = reais(pendente);
  const dias = Object.values(porDia).sort((a, b) => b.data.localeCompare(a.data));
  const cont = $("#func-mes-lista");
  cont.innerHTML = dias.length ? dias.map(d => `
    <div class="card-func rank-linha">
      <span class="rank-nome">${dataBonita(d.data)}</span>
      <span class="rank-qtd">${reais(d.total)}</span>
    </div>`).join("") :
    '<div class="vazio">Nenhum serviço neste mês.</div>';
}

// ---------- Aba: dias pagos (admin/assistente) ----------
$("#diaspagos-de").addEventListener("change", carregarDiasPagos);
$("#diaspagos-ate").addEventListener("change", carregarDiasPagos);
$("#diaspagos-tudo").addEventListener("click", () => {
  $("#diaspagos-de").value = ""; $("#diaspagos-ate").value = ""; carregarDiasPagos();
});
async function carregarDiasPagos() {
  const de = $("#diaspagos-de").value, ate = $("#diaspagos-ate").value;
  const qs = [];
  if (de) qs.push("de=" + de);
  if (ate) qs.push("ate=" + ate);
  const lancs = await api("/api/lancamentos" + (qs.length ? "?" + qs.join("&") : ""));
  const usuarios = await api("/api/usuarios");
  const compMap = {}; usuarios.forEach(u => compMap[u.id] = u.compensa);
  const grupos = {};
  lancs.filter(l => l.forma !== "cartao" && l.pago).forEach(l => {
    const k = l.usuarioId + "|" + l.data;
    (grupos[k] = grupos[k] || { data: l.data, nome: l.nome, valor: 0 }).valor += receberDe(l, compMap[l.usuarioId]);
  });
  const lista = Object.values(grupos).sort((a, b) => b.data.localeCompare(a.data) || a.nome.localeCompare(b.nome));
  const cont = $("#adm-diaspagos");
  cont.innerHTML = lista.length ? lista.map(x => `
    <div class="card-func rank-linha">
      <span class="pago-selo">✔ pago</span>
      <span class="rank-nome">${escapar(x.nome)} <small style="color:var(--texto-fraco)">· ${dataBonita(x.data)}</small></span>
      <span class="rank-qtd">${reais(x.valor)}</span>
    </div>`).join("") :
    '<div class="vazio">Nenhum dia pago ainda.</div>';
}

// ---------- Aviso de dias anteriores não pagos ----------
async function carregarAlertaPendentes() {
  const el = $("#alerta-pendentes");
  if (!el) return;
  const hoje = hojeStr();
  let lancs = [], usuarios = [];
  try { lancs = await api("/api/lancamentos"); usuarios = await api("/api/usuarios"); } catch (e) { return; }
  const compMap = {}; usuarios.forEach(u => compMap[u.id] = u.compensa);
  const grupos = {};
  lancs.filter(l => l.forma !== "cartao" && !l.pago && l.data < hoje).forEach(l => {
    const k = l.usuarioId + "|" + l.data;
    (grupos[k] = grupos[k] || { data: l.data, nome: l.nome, valor: 0 }).valor += receberDe(l, compMap[l.usuarioId]);
  });
  const lista = Object.values(grupos).filter(x => x.valor > 0.005).sort((a, b) => a.data.localeCompare(b.data));
  if (!lista.length) { el.classList.add("oculto"); el.innerHTML = ""; return; }
  el.classList.remove("oculto");
  el.innerHTML = `⚠️ <strong>Atenção:</strong> há dias anteriores não pagos. Clique para ir até o dia e pagar:
    <div class="pend-chips">${lista.map(x =>
      `<button class="pend-chip" data-dia="${x.data}">${escapar(x.nome)} · ${dataBonita(x.data)} · ${reais(x.valor)}</button>`).join("")}</div>`;
  el.querySelectorAll("[data-dia]").forEach(b => b.addEventListener("click", () => {
    $("#adm-data").value = b.dataset.dia; carregarPagamentos();
  }));
}
async function pintarRanking(el, de, ate) {
  let d = { porServicos: [], porFaturamento: [] };
  try { d = await api(`/api/ranking?de=${de}&ate=${ate}`); } catch (e) {}
  const medalha = p => p === 1 ? "🥇" : p === 2 ? "🥈" : p === 3 ? "🥉" : `${p}º`;
  const linhas = (lista, extra) => lista.length ? lista.map(x => `
    <div class="card-func rank-linha">
      <span class="rank-pos">${medalha(x.posicao)}</span>
      <span class="rank-nome">${escapar(x.nome)}</span>
      ${extra ? `<span class="rank-qtd">${extra(x)}</span>` : ""}
    </div>`).join("") : '<div class="vazio">Sem serviços neste mês ainda.</div>';
  el.innerHTML = `
    <div class="rank-grupo">
      <h3 class="rank-titulo">🏆 Mais serviços</h3>
      ${linhas(d.porServicos, x => `${x.quantidade} ${x.quantidade === 1 ? "serviço" : "serviços"}`)}
    </div>
    <div class="rank-grupo">
      <h3 class="rank-titulo">💰 Maior faturamento</h3>
      ${linhas(d.porFaturamento, null)}
    </div>`;
}

// ---------- Aba: funcionárias (CRUD) ----------
$("#form-nova-func").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#nf-msg"); msg.textContent = ""; msg.className = "msg";
  try {
    await api("/api/usuarios", {
      method: "POST",
      body: JSON.stringify({ nome: $("#nf-nome").value, senha: $("#nf-senha").value, tipo: $("#nf-tipo").value })
    });
    $("#form-nova-func").reset();
    msg.textContent = "Funcionária adicionada! ✔"; msg.className = "msg ok";
    carregarFuncionarias();
  } catch (err) { msg.textContent = err.message; msg.className = "msg ruim"; }
});

async function carregarFuncionarias() {
  const usuarios = await api("/api/usuarios");
  const cont = $("#adm-funcionarias");
  const souAssistente = USUARIO.tipo === "assistente";
  cont.innerHTML = usuarios.map(u => {
    const chefia = u.tipo === "admin" || u.tipo === "assistente";
    const badge = u.tipo === "admin"
      ? '<span class="badge-tipo">Administradora</span>'
      : u.tipo === "assistente"
        ? '<span class="badge-tipo">Assistente ADM</span>'
        : `<span class="badge-tipo ${u.tipo === "manicure" ? "badge-manicure" : ""}">${u.tipo}</span>`;
    let botoes;
    if (souAssistente && chefia) {
      botoes = ""; // assistente não mexe nas contas de chefia
    } else if (u.tipo === "admin") {
      botoes = `<button class="btn-azul" data-editar="${u.id}">Alterar nome/senha</button>`;
    } else {
      botoes = `<button class="btn-azul" data-editar="${u.id}">Editar</button>
         <button class="btn-vermelho" data-remover="${u.id}" data-nome="${escapar(u.nome)}">Excluir</button>`;
    }
    const metodo = ehFuncionaria(u)
      ? `<button class="btn-cinza" data-metodo="${u.id}" data-atual="${u.compensa ? 1 : 0}">Método cartão: ${u.compensa ? "LIGADO ✔" : "desligado"}</button>`
      : "";
    const acoes = [botoes, metodo].filter(Boolean).join(" ");
    return `<div class="card-func">
      <div class="card-cab">
        <div class="info-funcionaria"><span class="card-nome">${escapar(u.nome)}</span>${badge}</div>
      </div>
      ${acoes ? `<div class="acoes">${acoes}</div>` : ""}
    </div>`;
  }).join("");

  cont.querySelectorAll("[data-editar]").forEach(b => b.addEventListener("click", () => editarFuncionaria(b.dataset.editar, usuarios)));
  cont.querySelectorAll("[data-remover]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(`Excluir "${b.dataset.nome}"? Os lançamentos dela continuam no histórico.`)) return;
    try { await api("/api/usuarios/" + b.dataset.remover, { method: "DELETE" }); carregarFuncionarias(); }
    catch (e) { alert(e.message); }
  }));
  cont.querySelectorAll("[data-metodo]").forEach(b => b.addEventListener("click", async () => {
    const novo = b.dataset.atual !== "1";
    try { await api("/api/usuarios/" + b.dataset.metodo, { method: "PUT", body: JSON.stringify({ compensa: novo }) }); carregarFuncionarias(); }
    catch (e) { alert(e.message); }
  }));

  carregarConfigForm();
  // mantém o dropdown de login sincronizado
  carregarNomesLogin();
}

// ---------- Configurações (porcentagens) ----------
async function carregarConfigForm() {
  if (!$("#form-config")) return;
  const pct = x => Math.round(x * 10000) / 100; // mantém casas decimais (ex.: 62,5)
  try {
    const c = await api("/api/config");
    $("#cfg-manicure").value = c.comissaoManicure;
    $("#cfg-cab").value = pct(c.percCabeleireira);
    $("#cfg-quim").value = pct(c.percCabeleireiraQuimica);
    $("#cfg-henna").value = pct(c.percCabeleireiraHenna);
    $("#cfg-desc").value = pct(c.descontoCartao);
  } catch (e) {}
  carregarServicos();
}

// ---------- Serviços com comissão própria ----------
if ($("#form-servico-com")) $("#form-servico-com").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#sc-msg"); msg.textContent = ""; msg.className = "msg";
  try {
    await api("/api/servicos", {
      method: "POST",
      body: JSON.stringify({ nome: $("#sc-nome").value, tipoComissao: $("#sc-tipo").value, valor: Number($("#sc-valor").value) })
    });
    $("#form-servico-com").reset();
    msg.textContent = "Serviço adicionado! ✔"; msg.className = "msg ok";
    carregarServicos();
  } catch (err) { msg.textContent = err.message; msg.className = "msg ruim"; }
});

async function carregarServicos() {
  const cont = $("#lista-servicos");
  if (!cont) return;
  let lista = [];
  try { lista = await api("/api/servicos"); } catch (e) { return; }
  cont.innerHTML = lista.length ? lista.map(s => {
    const regra = s.tipoComissao === "percentual"
      ? `${Math.round(s.valor * 10000) / 100}% pra você`
      : `${reais(s.valor)} pra você`;
    return `<div class="card-func rank-linha">
      <span class="rank-nome">${escapar(s.nome)}</span>
      <span class="rank-qtd">${regra}</span>
      <button class="btn-vermelho" data-del-serv="${s.id}">Excluir</button>
    </div>`;
  }).join("") : '<div class="vazio">Nenhum serviço com comissão própria.</div>';
  cont.querySelectorAll("[data-del-serv]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Excluir este serviço?")) return;
    try { await api("/api/servicos/" + b.dataset.delServ, { method: "DELETE" }); carregarServicos(); }
    catch (e) { alert(e.message); }
  }));
}
if ($("#form-config")) $("#form-config").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#cfg-msg"); msg.textContent = ""; msg.className = "msg";
  try {
    const c = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        comissaoManicure: Number($("#cfg-manicure").value),
        percCabeleireira: Number($("#cfg-cab").value) / 100,
        percCabeleireiraQuimica: Number($("#cfg-quim").value) / 100,
        percCabeleireiraHenna: Number($("#cfg-henna").value) / 100,
        descontoCartao: Number($("#cfg-desc").value) / 100
      })
    });
    CONFIG = c;
    msg.textContent = "Configurações salvas! ✔"; msg.className = "msg ok";
  } catch (err) { msg.textContent = err.message; msg.className = "msg ruim"; }
});

async function editarFuncionaria(id, usuarios) {
  const u = usuarios.find(x => x.id === id);
  const novoNome = prompt("Nome:", u.nome);
  if (novoNome === null) return;
  const novaSenha = prompt("Nova senha (deixe em branco para não mudar):", "");
  const corpo = {};
  if (novoNome.trim()) corpo.nome = novoNome.trim();
  if (novaSenha && novaSenha.trim()) corpo.senha = novaSenha.trim();
  if (u.tipo !== "admin") {
    const t = prompt('Tipo — digite "manicure" ou "cabeleireira":', u.tipo);
    if (t && (t.trim() === "manicure" || t.trim() === "cabeleireira")) corpo.tipo = t.trim();
  }
  try { await api("/api/usuarios/" + id, { method: "PUT", body: JSON.stringify(corpo) }); carregarFuncionarias(); }
  catch (e) { alert(e.message); }
}

// ============================================================
//  ABA BACKUP (só admin)
// ============================================================
let backupPronto = false;
function iniciarBackup() {
  if (!backupPronto) {
    const h = hojeStr();
    const seteAtras = new Date(Date.now() - 6 * 86400000);
    const off = seteAtras.getTimezoneOffset() * 60000;
    $("#bkp-de").value = new Date(seteAtras - off).toISOString().slice(0, 10);
    $("#bkp-ate").value = h;
    $("#bkp-semana").addEventListener("click", () => {
      const hj = hojeStr();
      const d = new Date(Date.now() - 6 * 86400000);
      const o = d.getTimezoneOffset() * 60000;
      $("#bkp-de").value = new Date(d - o).toISOString().slice(0, 10);
      $("#bkp-ate").value = hj;
    });
    $("#bkp-relatorio").addEventListener("click", () => baixarBackup("html"));
    $("#bkp-csv").addEventListener("click", () => baixarBackup("csv"));
    $("#bkp-excluir").addEventListener("click", excluirPeriodo);
    backupPronto = true;
  }
}

async function buscarPeriodo() {
  const de = $("#bkp-de").value, ate = $("#bkp-ate").value;
  if (!de || !ate) { alert("Escolha o período (de / até)."); return null; }
  const rows = await api(`/api/lancamentos?de=${de}&ate=${ate}`);
  return { de, ate, rows };
}

function baixarArquivo(nome, conteudo, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function baixarBackup(formato) {
  const p = await buscarPeriodo();
  if (!p) return;
  if (!p.rows.length) { alert("Não há lançamentos nesse período."); return; }

  // agrupa por funcionária
  const grupos = {};
  p.rows.forEach(l => { (grupos[l.nome] = grupos[l.nome] || []).push(l); });

  if (formato === "csv") {
    const linhas = [["Data", "Funcionaria", "Tipo", "Servico", "Forma", "Valor", "Comissao Salao", "Valor Funcionaria", "Pago"].join(";")];
    p.rows.slice().sort((a, b) => a.data.localeCompare(b.data)).forEach(l => {
      linhas.push([
        dataBonita(l.data), l.nome, l.tipo, l.descricao.replace(/;/g, ","), l.forma,
        num(l.valor), num(l.comissaoSalao), num(l.valorFuncionaria), l.pago ? "Sim" : "Nao"
      ].map(c => `"${String(c)}"`).join(";"));
    });
    baixarArquivo(`backup_${p.de}_a_${p.ate}.csv`, "﻿" + linhas.join("\r\n"), "text/csv;charset=utf-8");
    return;
  }

  // HTML
  let totalLucro = 0, totalFat = 0;
  let corpo = "";
  Object.keys(grupos).sort((a, b) => a.localeCompare(b, "pt-BR")).forEach(nome => {
    const itens = grupos[nome].slice().sort((a, b) => a.data.localeCompare(b.data));
    const receber = itens.filter(l => l.forma !== "cartao").reduce((s, l) => s + l.valorFuncionaria, 0);
    const cartao = itens.filter(l => l.forma === "cartao").reduce((s, l) => s + l.valorFuncionaria, 0);
    const comissao = itens.reduce((s, l) => s + l.comissaoSalao, 0);
    const fat = itens.reduce((s, l) => s + l.valor, 0);
    totalLucro += comissao; totalFat += fat;
    corpo += `<h2>${escapar(nome)}</h2>
      <table><thead><tr><th>Data</th><th>Serviço</th><th>Forma</th><th>Valor</th><th>Comissão salão</th><th>Funcionária</th><th>Pago</th></tr></thead><tbody>`;
    itens.forEach(l => {
      corpo += `<tr><td>${dataBonita(l.data)}</td><td>${escapar(l.descricao)}</td><td>${l.forma}</td>
        <td>${reais(l.valor)}</td><td>${reais(l.comissaoSalao)}</td><td>${reais(l.valorFuncionaria)}</td>
        <td>${l.pago ? "Sim" : "—"}</td></tr>`;
    });
    corpo += `</tbody></table>
      <p class="tot">A receber (Pix+Dinheiro): <b>${reais(receber)}</b> &nbsp;|&nbsp; Cartão: <b>${reais(cartao)}</b> &nbsp;|&nbsp; Comissão do salão: <b>${reais(comissao)}</b></p>`;
  });

  const html = `<!DOCTYPE html><html lang="pt-br"><head><meta charset="utf-8">
    <title>Backup ${p.de} a ${p.ate} — Salão Maria Bonita</title>
    <style>body{font-family:Arial,sans-serif;color:#222;max-width:900px;margin:20px auto;padding:0 16px}
    h1{color:#a5821c}h2{color:#8a6d1a;margin-top:26px;border-bottom:2px solid #e6cf7a;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
    th{background:#f5eecf}.tot{background:#faf6e6;padding:8px 10px;border-radius:6px}
    .resumo{background:#111;color:#e6cf7a;padding:14px 16px;border-radius:8px;font-size:16px}</style></head>
    <body><h1>Salão Maria Bonita — Backup das contas</h1>
    <p>Período: <b>${dataBonita(p.de)}</b> a <b>${dataBonita(p.ate)}</b> · gerado em ${dataBonita(hojeStr())}</p>
    <div class="resumo">Faturamento total: <b>${reais(totalFat)}</b> &nbsp;•&nbsp; Lucro de comissão do salão: <b>${reais(totalLucro)}</b></div>
    ${corpo}</body></html>`;
  baixarArquivo(`backup_${p.de}_a_${p.ate}.html`, html, "text/html;charset=utf-8");
}

function num(n) { return (Number(n) || 0).toFixed(2).replace(".", ","); }

async function excluirPeriodo() {
  const de = $("#bkp-de").value, ate = $("#bkp-ate").value;
  const msg = $("#bkp-msg"); msg.textContent = ""; msg.className = "msg";
  if (!de || !ate) { alert("Escolha o período."); return; }
  if (!confirm(`ATENÇÃO: isso vai apagar do site TODOS os lançamentos e fotos de ${dataBonita(de)} a ${dataBonita(ate)}. Você já baixou o backup? Esta ação não pode ser desfeita.`)) return;
  if (!confirm("Confirma mesmo a exclusão definitiva?")) return;
  try {
    const r = await api("/api/limpar", { method: "POST", body: JSON.stringify({ de, ate }) });
    msg.textContent = `${r.excluidos} lançamento(s) excluído(s). Espaço liberado.`;
    msg.className = "msg ok";
  } catch (e) { msg.textContent = e.message; msg.className = "msg ruim"; }
}

// ============================================================
//  ABA DEMANDAS (admin designa, Bira conclui)
// ============================================================
$("#form-demanda").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#dem-msg"); msg.textContent = ""; msg.className = "msg";
  try {
    await api("/api/demandas", { method: "POST", body: JSON.stringify({ descricao: $("#dem-desc").value }) });
    $("#form-demanda").reset();
    msg.textContent = "Demanda designada! ✔"; msg.className = "msg ok";
    carregarDemandas();
  } catch (err) { msg.textContent = err.message; msg.className = "msg ruim"; }
});

function lerArquivoInput(input) {
  return new Promise(res => {
    const f = input && input.files && input.files[0];
    if (!f) return res(null);
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  });
}

async function carregarDemandas() {
  let lista = [];
  try { lista = await api("/api/demandas"); } catch (e) {}
  const cont = $("#adm-demandas");
  if (!lista.length) { cont.innerHTML = '<div class="vazio">Nenhuma demanda ainda.</div>'; return; }
  const souAdmin = USUARIO.tipo === "admin";
  cont.innerHTML = lista.map(d => {
    const concl = d.status === "concluida";
    const badge = concl
      ? '<span class="pago-selo">✔ concluída</span>'
      : '<span class="tag" style="background:var(--amarelo-bg);color:var(--amarelo)">pendente</span>';
    const foto = d.comprovante ? `<div style="margin-top:8px"><img class="mini-foto" src="${d.comprovante}" data-full="${d.comprovante}"></div>` : "";
    let acoes;
    if (!concl) {
      acoes = `<label class="btn-cinza" style="cursor:pointer">📎 Anexar foto
                 <input type="file" accept="image/*" class="dem-foto" data-id="${d.id}" style="display:none"></label>
               <button class="btn-verde" data-concluir="${d.id}">Marcar como concluída</button>`;
    } else {
      acoes = `<button class="btn-cinza" data-reabrir-dem="${d.id}">Reabrir</button>`;
    }
    const excluir = souAdmin ? `<button class="btn-vermelho" data-excluir-dem="${d.id}">Excluir</button>` : "";
    return `<div class="card-func">
      <div class="card-cab"><span class="card-nome">${escapar(d.descricao)}</span>${badge}</div>
      ${concl && d.concluidoEm ? `<div class="linha-detalhe"><span>Concluída em</span><strong>${dataBonita((d.concluidoEm || "").slice(0, 10))}</strong></div>` : ""}
      ${foto}
      <div class="acoes">${acoes} ${excluir}</div>
    </div>`;
  }).join("");
  ligarFotos(cont);
  cont.querySelectorAll(".dem-foto").forEach(inp => inp.addEventListener("change", () => {
    const lab = inp.closest("label"); if (lab && inp.files[0]) lab.style.borderColor = "var(--gold)";
  }));
  cont.querySelectorAll("[data-concluir]").forEach(b => b.addEventListener("click", async () => {
    const input = cont.querySelector(`.dem-foto[data-id="${b.dataset.concluir}"]`);
    const foto = await lerArquivoInput(input);
    try {
      await api("/api/demandas/" + b.dataset.concluir, { method: "PUT", body: JSON.stringify({ status: "concluida", comprovanteBase64: foto }) });
      carregarDemandas();
    } catch (e) { alert(e.message); }
  }));
  cont.querySelectorAll("[data-reabrir-dem]").forEach(b => b.addEventListener("click", async () => {
    try { await api("/api/demandas/" + b.dataset.reabrirDem, { method: "PUT", body: JSON.stringify({ status: "pendente" }) }); carregarDemandas(); }
    catch (e) { alert(e.message); }
  }));
  cont.querySelectorAll("[data-excluir-dem]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Excluir esta demanda?")) return;
    try { await api("/api/demandas/" + b.dataset.excluirDem, { method: "DELETE" }); carregarDemandas(); }
    catch (e) { alert(e.message); }
  }));
}

// ============================================================
//  MODAL DE FOTO
// ============================================================
function ligarFotos(container) {
  container.querySelectorAll("[data-full]").forEach(img => {
    img.addEventListener("click", () => {
      $("#modal-img").src = img.dataset.full;
      $("#modal-foto").classList.remove("oculto");
    });
  });
}
$("#modal-fechar").addEventListener("click", () => $("#modal-foto").classList.add("oculto"));
$(".modal-fundo").addEventListener("click", () => $("#modal-foto").classList.add("oculto"));

// ---------- Segurança básica de texto ----------
function escapar(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
//  INÍCIO
// ============================================================
async function carregarNomesLogin() {
  try {
    const nomes = await api("/api/nomes");
    const sel = $("#login-nome");
    sel.innerHTML = '<option value="" disabled selected>Selecione seu nome</option>' +
      nomes.map(n => `<option value="${escapar(n)}">${escapar(n)}</option>`).join("");
  } catch (e) {}
}

(async function iniciar() {
  await carregarNomesLogin();
  recuperarSessao();
  if (USUARIO) {
    try { await entrarNoSistema(); return; } catch (e) { USUARIO = null; }
  }
  mostrarTela("login");
})();
