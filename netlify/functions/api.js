/* ============================================================
   Salão Maria Bonita — Backend (Netlify Function + Supabase)
   Sem dependências externas: usa fetch e crypto (nativos).
   Variáveis de ambiente necessárias (configurar no Netlify):
     SUPABASE_URL          -> https://xxxxx.supabase.co
     SUPABASE_SERVICE_KEY  -> chave service_role (secreta)
     APP_SECRET            -> qualquer frase secreta longa
   ============================================================ */

const crypto = require("crypto");

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const SECRET = process.env.APP_SECRET || process.env.SUPABASE_SERVICE_KEY || "troque-este-segredo";

const CONFIG = {
  empresa: "Salão Maria Bonita",
  descontoCartao: 0.10,
  comissaoManicure: 5,
  percCabeleireira: 0.50,
  percCabeleireiraQuimica: 0.40
};

// ---------- utilidades ----------
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function novoId(pref) { return pref + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function calcularComissao(tipo, descricao, valor) {
  valor = Number(valor) || 0;
  if (tipo === "cabeleireira") {
    const temQuimica = /qu[ií]mica/i.test(descricao || "");
    const perc = temQuimica ? CONFIG.percCabeleireiraQuimica : CONFIG.percCabeleireira;
    const comissao = round2(valor * perc);
    return { comissaoSalao: comissao, valorFuncionaria: round2(valor - comissao), regra: temQuimica ? "40% (química)" : "50%" };
  }
  return { comissaoSalao: CONFIG.comissaoManicure, valorFuncionaria: round2(valor - CONFIG.comissaoManicure), regra: "R$5 fixo" };
}

// ---------- token (HMAC, sem sessão no servidor) ----------
function assinar(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const h = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  return p + "." + h;
}
function verificar(token) {
  if (!token) return null;
  const [p, h] = token.split(".");
  if (!p || !h) return null;
  const h2 = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  if (h !== h2) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()); } catch (e) { return null; }
}

// ---------- Supabase REST ----------
async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) throw new Error((data && data.message) || "Erro no banco de dados.");
  return data;
}
async function sbUpload(nome, buffer, contentType) {
  const r = await fetch(`${SB}/storage/v1/object/comprovantes/${nome}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": contentType, "x-upsert": "true" },
    body: buffer
  });
  if (!r.ok) throw new Error("Falha ao salvar a foto: " + (await r.text()));
  return `${SB}/storage/v1/object/public/comprovantes/${nome}`;
}
async function sbDeleteObj(url) {
  if (!url) return;
  const p = url.split("/comprovantes/")[1];
  if (!p) return;
  try {
    await fetch(`${SB}/storage/v1/object/comprovantes/${p}`, {
      method: "DELETE", headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
    });
  } catch (e) {}
}

// ---------- mapeamento linha <-> API ----------
function toApi(row) {
  return {
    id: row.id, usuarioId: row.usuario_id, nome: row.nome, tipo: row.tipo,
    data: row.data, descricao: row.descricao, valor: Number(row.valor), forma: row.forma,
    comissaoSalao: Number(row.comissao_salao), valorFuncionaria: Number(row.valor_funcionaria),
    regra: row.regra, comprovante: row.comprovante, pago: row.pago, criadoEm: row.criado_em
  };
}

function demApi(row) {
  return {
    id: row.id, descricao: row.descricao, status: row.status,
    comprovante: row.comprovante, criadoEm: row.criado_em, concluidoEm: row.concluido_em
  };
}

const resp = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(obj)
});

// ============================================================
//  HANDLER
// ============================================================
exports.handler = async (event) => {
  try {
    if (!SB || !KEY) return resp(500, { erro: "Servidor sem configuração do Supabase (variáveis de ambiente)." });

    // rota depois de /api
    let sub = (event.path || "").split("/api")[1] || "/";
    sub = sub.split("?")[0];
    if (sub === "") sub = "/";
    const metodo = event.httpMethod;
    const q = event.queryStringParameters || {};
    let corpo = {};
    if (event.body) { try { corpo = JSON.parse(event.body); } catch (e) { corpo = {}; } }

    // ---------- LOGIN (público) ----------
    if (sub === "/login" && metodo === "POST") {
      const nome = (corpo.nome || "").trim().toLowerCase();
      const senha = corpo.senha || "";
      const usuarios = await sb("usuarios?select=*");
      const u = usuarios.find(x => x.nome.trim().toLowerCase() === nome && x.senha === senha);
      if (!u) return resp(401, { erro: "Nome ou senha incorretos." });
      const token = assinar({ id: u.id, nome: u.nome, tipo: u.tipo });
      return resp(200, { id: u.id, nome: u.nome, tipo: u.tipo, token });
    }

    // ---------- NOMES (público, para o dropdown) ----------
    if (sub === "/nomes" && metodo === "GET") {
      const usuarios = await sb("usuarios?select=nome");
      const nomes = usuarios.map(u => u.nome).sort((a, b) => a.localeCompare(b, "pt-BR"));
      return resp(200, nomes);
    }

    // ---------- daqui pra frente exige token ----------
    const auth = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    const atual = verificar(auth);
    if (!atual) return resp(401, { erro: "Faça login novamente." });
    const ehAdmin = atual.tipo === "admin";
    const ehGestor = ehAdmin || atual.tipo === "assistente"; // admin ou assistente

    if (sub === "/config" && metodo === "GET") return resp(200, CONFIG);

    // ---------- RANKING DO MÊS (qualquer usuário logado) ----------
    // Retorna SÓ a quantidade de serviços por funcionária (nunca valores).
    // O faturamento é usado apenas como critério de desempate, no servidor.
    if (sub === "/ranking" && metodo === "GET") {
      const filtros = ["select=usuario_id,nome,tipo,valor"];
      if (q.de) filtros.push(`data=gte.${q.de}`);
      if (q.ate) filtros.push(`data=lte.${q.ate}`);
      const rows = await sb("lancamentos?" + filtros.join("&"));
      const mapa = {};
      rows.forEach(r => {
        if (r.tipo !== "manicure" && r.tipo !== "cabeleireira") return;
        const k = r.usuario_id;
        if (!mapa[k]) mapa[k] = { nome: r.nome, quantidade: 0, _fat: 0 };
        mapa[k].quantidade++;
        mapa[k]._fat += Number(r.valor) || 0;
      });
      const arr = Object.values(mapa);
      const porServicos = arr.slice()
        .sort((a, b) => b.quantidade - a.quantidade || b._fat - a._fat)
        .map((x, i) => ({ posicao: i + 1, nome: x.nome, quantidade: x.quantidade }));
      const porFaturamento = arr.slice()
        .sort((a, b) => b._fat - a._fat || b.quantidade - a.quantidade)
        .map((x, i) => ({ posicao: i + 1, nome: x.nome })); // sem valores
      return resp(200, { porServicos, porFaturamento });
    }

    // ---------- DEMANDAS (admin designa, Bira conclui) ----------
    if (sub === "/demandas" && metodo === "GET") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const rows = await sb("demandas?select=*&order=criado_em.desc");
      return resp(200, rows.map(demApi));
    }
    if (sub === "/demandas" && metodo === "POST") {
      if (!ehAdmin) return resp(403, { erro: "Sem permissão." });
      const descricao = (corpo.descricao || "").trim();
      if (!descricao) return resp(400, { erro: "Descreva a demanda." });
      const row = { id: novoId("d"), descricao, status: "pendente" };
      const ins = await sb("demandas", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      return resp(200, demApi(ins[0]));
    }
    if (sub.startsWith("/demandas/") && metodo === "PUT") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const id = decodeURIComponent(sub.split("/").pop());
      const d = (await sb(`demandas?select=*&id=eq.${id}`))[0];
      if (!d) return resp(404, { erro: "Demanda não encontrada." });
      const patch = {};
      if (corpo.status === "concluida") { patch.status = "concluida"; patch.concluido_em = new Date().toISOString(); }
      else if (corpo.status === "pendente") { patch.status = "pendente"; patch.concluido_em = null; }
      if (corpo.comprovanteBase64) {
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(corpo.comprovanteBase64);
        if (m) {
          const ext = "." + m[1].split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
          patch.comprovante = await sbUpload(novoId("dem") + ext, Buffer.from(m[2], "base64"), m[1]);
        }
      }
      const upd = await sb(`demandas?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
      return resp(200, demApi(upd[0]));
    }
    if (sub.startsWith("/demandas/") && metodo === "DELETE") {
      if (!ehAdmin) return resp(403, { erro: "Sem permissão." });
      const id = decodeURIComponent(sub.split("/").pop());
      const d = (await sb(`demandas?select=*&id=eq.${id}`))[0];
      if (d && d.comprovante) await sbDeleteObj(d.comprovante);
      await sb(`demandas?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return resp(200, { ok: true });
    }

    // ---------- USUÁRIOS ----------
    if (sub === "/usuarios" && metodo === "GET") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const usuarios = await sb("usuarios?select=id,nome,tipo&order=nome");
      return resp(200, usuarios);
    }
    if (sub === "/usuarios" && metodo === "POST") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const nome = (corpo.nome || "").trim();
      const senha = (corpo.senha || "").trim();
      const tipo = corpo.tipo === "cabeleireira" ? "cabeleireira" : "manicure";
      if (!nome || !senha) return resp(400, { erro: "Informe nome e senha." });
      const existentes = await sb(`usuarios?select=id&nome=ilike.${encodeURIComponent(nome)}`);
      if (existentes.length) return resp(400, { erro: "Já existe uma funcionária com esse nome." });
      const novo = { id: novoId("u"), nome, senha, tipo };
      await sb("usuarios", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(novo) });
      return resp(200, { id: novo.id, nome: novo.nome, tipo: novo.tipo });
    }
    if (sub.startsWith("/usuarios/") && metodo === "PUT") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const id = decodeURIComponent(sub.split("/").pop());
      const alvo = (await sb(`usuarios?select=*&id=eq.${id}`))[0];
      if (!alvo) return resp(404, { erro: "Funcionária não encontrada." });
      if (!ehAdmin && (alvo.tipo === "admin" || alvo.tipo === "assistente")) return resp(403, { erro: "Sem permissão para editar esta conta." });
      const patch = {};
      if (corpo.nome !== undefined && corpo.nome.trim()) patch.nome = corpo.nome.trim();
      if (corpo.senha !== undefined && corpo.senha.trim()) patch.senha = corpo.senha.trim();
      if (corpo.tipo !== undefined && alvo.tipo !== "admin") patch.tipo = corpo.tipo === "cabeleireira" ? "cabeleireira" : "manicure";
      if (Object.keys(patch).length) await sb(`usuarios?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return resp(200, { id, nome: patch.nome || alvo.nome, tipo: patch.tipo || alvo.tipo });
    }
    if (sub.startsWith("/usuarios/") && metodo === "DELETE") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const id = decodeURIComponent(sub.split("/").pop());
      const alvo = (await sb(`usuarios?select=*&id=eq.${id}`))[0];
      if (!alvo) return resp(404, { erro: "Funcionária não encontrada." });
      if (alvo.tipo === "admin") return resp(400, { erro: "Não é possível excluir o administrador." });
      if (!ehAdmin && alvo.tipo === "assistente") return resp(403, { erro: "Sem permissão para excluir esta conta." });
      await sb(`usuarios?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return resp(200, { ok: true });
    }

    // ---------- LANÇAMENTOS ----------
    if (sub === "/lancamentos" && metodo === "POST") {
      const descricao = (corpo.descricao || "").trim();
      const valor = round2(corpo.valor);
      const forma = ["pix", "cartao", "dinheiro"].includes(corpo.forma) ? corpo.forma : "pix";
      if (!descricao) return resp(400, { erro: "Descreva o serviço." });
      if (!(valor > 0)) return resp(400, { erro: "Informe um valor válido." });

      let dono = { id: atual.id, nome: atual.nome, tipo: atual.tipo };
      if (ehAdmin && corpo.usuarioId) {
        const outro = (await sb(`usuarios?select=*&id=eq.${corpo.usuarioId}`))[0];
        if (outro) dono = outro;
      }
      const c = calcularComissao(dono.tipo, descricao, valor);

      let comprovante = null;
      if (corpo.comprovanteBase64) {
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(corpo.comprovanteBase64);
        if (m) {
          const ext = "." + m[1].split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
          comprovante = await sbUpload(novoId("cmp") + ext, Buffer.from(m[2], "base64"), m[1]);
        }
      }
      const row = {
        id: novoId("l"), usuario_id: dono.id, nome: dono.nome, tipo: dono.tipo,
        data: corpo.data || new Date().toISOString().slice(0, 10),
        descricao, valor, forma, comissao_salao: c.comissaoSalao, valor_funcionaria: c.valorFuncionaria,
        regra: c.regra, comprovante, pago: false
      };
      const inserido = await sb("lancamentos", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      return resp(200, toApi(inserido[0]));
    }

    if (sub === "/lancamentos" && metodo === "GET") {
      const filtros = ["select=*", "order=criado_em.desc"];
      if (!ehGestor) filtros.push(`usuario_id=eq.${atual.id}`);
      else if (q.usuarioId) filtros.push(`usuario_id=eq.${q.usuarioId}`);
      if (q.data) filtros.push(`data=eq.${q.data}`);
      if (q.de) filtros.push(`data=gte.${q.de}`);
      if (q.ate) filtros.push(`data=lte.${q.ate}`);
      const rows = await sb("lancamentos?" + filtros.join("&"));
      return resp(200, rows.map(toApi));
    }

    if (sub.startsWith("/lancamentos/") && metodo === "PUT") {
      const id = decodeURIComponent(sub.split("/").pop());
      const l = (await sb(`lancamentos?select=*&id=eq.${id}`))[0];
      if (!l) return resp(404, { erro: "Lançamento não encontrado." });
      const podeEditar = ehGestor || (l.usuario_id === atual.id && !l.pago);
      if (!podeEditar) return resp(403, { erro: "Você não pode editar este lançamento." });
      const descricao = corpo.descricao !== undefined ? String(corpo.descricao).trim() : l.descricao;
      const valor = corpo.valor !== undefined ? round2(corpo.valor) : Number(l.valor);
      const forma = ["pix", "cartao", "dinheiro"].includes(corpo.forma) ? corpo.forma : l.forma;
      if (!descricao) return resp(400, { erro: "Descreva o serviço." });
      if (!(valor > 0)) return resp(400, { erro: "Informe um valor válido." });
      const c = calcularComissao(l.tipo, descricao, valor);
      const patch = { descricao, valor, forma, comissao_salao: c.comissaoSalao, valor_funcionaria: c.valorFuncionaria, regra: c.regra };
      const upd = await sb(`lancamentos?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
      return resp(200, toApi(upd[0]));
    }

    if (sub.startsWith("/lancamentos/") && metodo === "DELETE") {
      const id = decodeURIComponent(sub.split("/").pop());
      const l = (await sb(`lancamentos?select=*&id=eq.${id}`))[0];
      if (!l) return resp(404, { erro: "Lançamento não encontrado." });
      if (!ehAdmin && (l.usuario_id !== atual.id || l.pago)) return resp(403, { erro: "Você não pode excluir este lançamento." });
      await sbDeleteObj(l.comprovante);
      await sb(`lancamentos?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return resp(200, { ok: true });
    }

    // ---------- PAGAR / REABRIR ----------
    if (sub === "/pagar" && metodo === "POST") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      let filtro = `usuario_id=eq.${corpo.usuarioId}&pago=eq.false`;
      if (corpo.escopo === "dia") filtro += `&data=eq.${corpo.data}&forma=neq.cartao`;
      else if (corpo.escopo === "cartao") filtro += `&forma=eq.cartao`;
      else return resp(400, { erro: "Escopo inválido." });
      await sb(`lancamentos?${filtro}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pago: true }) });
      return resp(200, { ok: true });
    }
    if (sub === "/reabrir" && metodo === "POST") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      let filtro = `usuario_id=eq.${corpo.usuarioId}&pago=eq.true`;
      if (corpo.escopo === "dia") filtro += `&data=eq.${corpo.data}&forma=neq.cartao`;
      else if (corpo.escopo === "cartao") filtro += `&forma=eq.cartao`;
      else return resp(400, { erro: "Escopo inválido." });
      await sb(`lancamentos?${filtro}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pago: false }) });
      return resp(200, { ok: true });
    }

    // ---------- LIMPAR PERÍODO (backup já baixado) ----------
    if (sub === "/limpar" && metodo === "POST") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const de = corpo.de, ate = corpo.ate;
      if (!de || !ate) return resp(400, { erro: "Informe o período." });
      const rows = await sb(`lancamentos?select=id,comprovante&data=gte.${de}&data=lte.${ate}`);
      for (const r of rows) await sbDeleteObj(r.comprovante);
      await sb(`lancamentos?data=gte.${de}&data=lte.${ate}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return resp(200, { ok: true, excluidos: rows.length });
    }

    return resp(404, { erro: "Rota não encontrada." });
  } catch (e) {
    return resp(500, { erro: "Erro interno: " + (e.message || e) });
  }
};
