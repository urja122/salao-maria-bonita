/* ============================================================
   Empresa 1 — funcionamento (frontend)
   ============================================================ */

let USUARIO = null;          // { id, nome, tipo, token }
let TOKEN = null;            // token de autenticação (online)
let CONFIG = { descontoCartao: 0.10 };

// ---------- Atalhos ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
      (USUARIO.tipo === "admin" ? "Administradora" : USUARIO.tipo);
  }
}

async function entrarNoSistema() {
  try { CONFIG = await api("/api/config"); } catch (e) {}
  if (USUARIO.tipo === "admin") {
    mostrarTela("admin");
    $("#adm-data").value = hojeStr();
    $("#lucro-de").value = hojeStr();
    $("#lucro-ate").value = hojeStr();
    await Promise.all([carregarPagamentos(), carregarFuncionarias()]);
  } else {
    mostrarTela("funcionaria");
    await carregarMeuDia();
  }
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
  const forma = document.querySelector('input[name="forma"]:checked').value;
  try {
    await api("/api/lancamentos", {
      method: "POST",
      body: JSON.stringify({
        descricao: $("#serv-descricao").value,
        valor: $("#serv-valor").value,
        forma,
        comprovanteBase64: fotoBase64
      })
    });
    $("#form-servico").reset();
    $("#serv-previa").classList.add("oculto");
    fotoBase64 = null;
    msg.textContent = "Serviço salvo! ✔";
    msg.className = "msg ok";
    await carregarMeuDia();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg ruim";
  }
});

async function carregarMeuDia() {
  const hoje = hojeStr();
  const doDia = await api("/api/lancamentos?data=" + hoje);
  const cartaoTudo = await api("/api/lancamentos"); // todos os meus (para acumulado de cartão)

  const receberHoje = doDia
    .filter(l => l.forma !== "cartao")
    .reduce((s, l) => s + l.valorFuncionaria, 0);
  const cartaoAcum = cartaoTudo
    .filter(l => l.forma === "cartao" && !l.pago)
    .reduce((s, l) => s + l.valorFuncionaria, 0);

  $("#func-receber").textContent = reais(receberHoje);
  $("#func-cartao").textContent = reais(cartaoAcum);

  const lista = $("#func-lista");
  if (!doDia.length) {
    lista.innerHTML = '<div class="vazio">Nenhum serviço lançado hoje ainda.</div>';
    return;
  }
  lista.innerHTML = doDia.map(l => itemLancamentoHtml(l, true)).join("");
  ligarBotoesExcluir(lista, carregarMeuDia);
  ligarFotos(lista);
}

// HTML de um lançamento na lista
function itemLancamentoHtml(l, podeExcluir) {
  const foto = l.comprovante
    ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}" alt="comprovante">`
    : `<div class="sem-foto">—</div>`;
  const tag = `<span class="tag tag-${l.forma}">${l.forma === "cartao" ? "Cartão" : l.forma === "pix" ? "Pix" : "Dinheiro"}</span>`;
  const pago = l.pago ? ' <span class="tag tag-pago">pago</span>' : "";
  const excluir = podeExcluir && !l.pago
    ? `<button class="link-excluir" data-excluir="${l.id}">excluir</button>` : "";
  return `<div class="item">
    ${foto}
    <div class="item-info">
      <div class="item-desc">${escapar(l.descricao)}</div>
      <div class="item-sub">${tag}${pago} · você recebe ${reais(l.valorFuncionaria)} ${excluir}</div>
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
    if (alvo === "cartao") carregarCartaoAcumulado();
    if (alvo === "lucro") carregarLucro();
    if (alvo === "backup") iniciarBackup();
    if (alvo === "funcionarias") carregarFuncionarias();
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
  usuarios.filter(u => u.tipo !== "admin").forEach(u => {
    const itens = porFunc[u.id] || [];
    if (!itens.length) return;
    const total = itens.reduce((s, l) => s + l.valorFuncionaria, 0);
    const tudoPago = itens.every(l => l.pago);
    totalDia += total;
    cards.push(cardPagamentoHtml(u, itens, total, tudoPago, data));
  });

  $("#adm-total-dia").textContent = reais(totalDia);
  cont.innerHTML = cards.length ? cards.join("") :
    '<div class="vazio">Nenhum serviço (Pix/Dinheiro) neste dia.</div>';
  ligarFotos(cont);
  ligarAcoesPagamento(cont, data);
  ligarToggles(cont);
}

function cardPagamentoHtml(u, itens, total, tudoPago, data) {
  const linhas = itens.map(l => `
    <div class="linha-detalhe">
      <span>${l.comprovante ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}">` : ""}
        ${escapar(l.descricao)} <span class="tag tag-${l.forma}">${l.forma === "pix" ? "Pix" : "Dinheiro"}</span></span>
      <strong>${reais(l.valorFuncionaria)}</strong>
    </div>`).join("");
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
async function carregarCartaoAcumulado() {
  const lancs = await api("/api/lancamentos");
  const usuarios = await api("/api/usuarios");
  const porFunc = {};
  lancs.forEach(l => {
    if (l.forma !== "cartao" || l.pago) return;
    (porFunc[l.usuarioId] = porFunc[l.usuarioId] || []).push(l);
  });

  const cont = $("#adm-cartao");
  const cards = [];
  usuarios.filter(u => u.tipo !== "admin").forEach(u => {
    const itens = porFunc[u.id] || [];
    if (!itens.length) return;
    const bruto = itens.reduce((s, l) => s + l.valorFuncionaria, 0);
    const liquido = bruto * (1 - (CONFIG.descontoCartao || 0.10));
    const linhas = itens.map(l => `
      <div class="linha-detalhe">
        <span>${dataBonita(l.data)} · ${escapar(l.descricao)}
          ${l.comprovante ? `<img class="mini-foto" src="${l.comprovante}" data-full="${l.comprovante}">` : ""}</span>
        <strong>${reais(l.valorFuncionaria)}</strong>
      </div>`).join("");
    cards.push(`<div class="card-func">
      <div class="card-cab">
        <span class="card-nome">${escapar(u.nome)}</span>
        <span class="card-valor-grande">${reais(bruto)}</span>
      </div>
      ${linhas}
      <div class="linha-detalhe"><span>Líquido a sacar (−${Math.round((CONFIG.descontoCartao||0.10)*100)}% maquineta)</span><strong>${reais(liquido)}</strong></div>
      <div class="acoes"><button class="btn-verde" data-pagar-cartao="${u.id}">Pagar acumulado e zerar</button></div>
    </div>`);
  });

  cont.innerHTML = cards.length ? cards.join("") :
    '<div class="vazio">Nenhum valor de cartão acumulado.</div>';
  ligarFotos(cont);
  cont.querySelectorAll("[data-pagar-cartao]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Confirmar pagamento do cartão acumulado e zerar?")) return;
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
  usuarios.filter(u => u.tipo !== "admin").forEach(u => {
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
  cont.innerHTML = usuarios.map(u => {
    const ehAdmin = u.tipo === "admin";
    const badge = ehAdmin
      ? '<span class="badge-tipo">Administradora</span>'
      : `<span class="badge-tipo ${u.tipo === "manicure" ? "badge-manicure" : ""}">${u.tipo}</span>`;
    const botoes = ehAdmin
      ? `<button class="btn-azul" data-editar="${u.id}">Alterar nome/senha</button>`
      : `<button class="btn-azul" data-editar="${u.id}">Editar</button>
         <button class="btn-vermelho" data-remover="${u.id}" data-nome="${escapar(u.nome)}">Excluir</button>`;
    return `<div class="card-func">
      <div class="card-cab">
        <div class="info-funcionaria"><span class="card-nome">${escapar(u.nome)}</span>${badge}</div>
      </div>
      <div class="acoes">${botoes}</div>
    </div>`;
  }).join("");

  cont.querySelectorAll("[data-editar]").forEach(b => b.addEventListener("click", () => editarFuncionaria(b.dataset.editar, usuarios)));
  cont.querySelectorAll("[data-remover]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(`Excluir "${b.dataset.nome}"? Os lançamentos dela continuam no histórico.`)) return;
    try { await api("/api/usuarios/" + b.dataset.remover, { method: "DELETE" }); carregarFuncionarias(); }
    catch (e) { alert(e.message); }
  }));

  // mantém o dropdown de login sincronizado
  carregarNomesLogin();
}

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
