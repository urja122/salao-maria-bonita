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
  percCabeleireiraQuimica: 0.40,
  percCabeleireiraHenna: 0.60
};

// Lê as porcentagens configuráveis do banco (com fallback nos padrões)
async function getConfig() {
  let row = {};
  try { row = (await sb("config?select=*&id=eq.1"))[0] || {}; } catch (e) {}
  return {
    empresa: CONFIG.empresa,
    comissaoManicure: Number(row.comissao_manicure ?? CONFIG.comissaoManicure),
    percCabeleireira: Number(row.perc_cab ?? CONFIG.percCabeleireira),
    percCabeleireiraQuimica: Number(row.perc_cab_quimica ?? CONFIG.percCabeleireiraQuimica),
    percCabeleireiraHenna: Number(row.perc_cab_henna ?? CONFIG.percCabeleireiraHenna),
    descontoCartao: Number(row.desconto_cartao ?? CONFIG.descontoCartao)
  };
}

// ---------- utilidades ----------
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function novoId(pref) { return pref + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function calcularComissao(tipo, descricao, valor, cfg, servicos) {
  cfg = cfg || CONFIG;
  valor = Number(valor) || 0;
  const desc = descricao || "";
  // serviço com comissão própria (por nome) tem prioridade sobre a regra normal
  const serv = (servicos || []).find(s => s.nome && s.ativo !== false &&
    desc.toLowerCase().includes(String(s.nome).toLowerCase()));
  if (serv) {
    if (serv.tipo_comissao === "percentual") {
      const comissao = round2(valor * Number(serv.valor));
      return { comissaoSalao: comissao, valorFuncionaria: round2(valor - comissao), regra: `${Math.round(Number(serv.valor) * 10000) / 100}% (serviço)` };
    }
    const comissao = round2(Number(serv.valor));
    return { comissaoSalao: comissao, valorFuncionaria: round2(valor - comissao), regra: `R$${comissao} fixo (serviço)` };
  }
  if (tipo === "cabeleireira") {
    let perc, regra;
    if (/henna/i.test(desc)) { perc = cfg.percCabeleireiraHenna; regra = `${Math.round(perc * 100)}% (henna)`; }
    else if (/qu[ií]mica/i.test(desc)) { perc = cfg.percCabeleireiraQuimica; regra = `${Math.round(perc * 100)}% (química)`; }
    else { perc = cfg.percCabeleireira; regra = `${Math.round(perc * 100)}%`; }
    const comissao = round2(valor * perc);
    return { comissaoSalao: comissao, valorFuncionaria: round2(valor - comissao), regra };
  }
  const c = cfg.comissaoManicure;
  return { comissaoSalao: c, valorFuncionaria: round2(valor - c), regra: `R$${c} fixo` };
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
    regra: row.regra, comprovante: row.comprovante, pago: row.pago, criadoEm: row.criado_em,
    commQuitada: row.comm_quitada !== false, grupo: row.grupo || null
  };
}

function demApi(row) {
  return {
    id: row.id, descricao: row.descricao, status: row.status,
    comprovante: row.comprovante, criadoEm: row.criado_em, concluidoEm: row.concluido_em
  };
}

function servApi(row) {
  return { id: row.id, nome: row.nome, tipoComissao: row.tipo_comissao, valor: Number(row.valor), ativo: row.ativo !== false };
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
      const compensa = !!u.compensa_dinheiro;
      const token = assinar({ id: u.id, nome: u.nome, tipo: u.tipo, compensa });
      return resp(200, { id: u.id, nome: u.nome, tipo: u.tipo, compensa, token });
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

    if (sub === "/config" && metodo === "GET") return resp(200, await getConfig());
    if (sub === "/config" && metodo === "PUT") {
      if (!ehAdmin) return resp(403, { erro: "Sem permissão." });
      const patch = {};
      if (corpo.comissaoManicure != null) patch.comissao_manicure = Number(corpo.comissaoManicure);
      if (corpo.percCabeleireira != null) patch.perc_cab = Number(corpo.percCabeleireira);
      if (corpo.percCabeleireiraQuimica != null) patch.perc_cab_quimica = Number(corpo.percCabeleireiraQuimica);
      if (corpo.percCabeleireiraHenna != null) patch.perc_cab_henna = Number(corpo.percCabeleireiraHenna);
      if (corpo.descontoCartao != null) patch.desconto_cartao = Number(corpo.descontoCartao);
      if (Object.keys(patch).length) await sb("config?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return resp(200, await getConfig());
    }

    // ---------- SERVIÇOS com comissão própria ----------
    if (sub === "/servicos" && metodo === "GET") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const rows = await sb("servicos?select=*&order=nome");
      return resp(200, rows.map(servApi));
    }
    if (sub === "/servicos" && metodo === "POST") {
      if (!ehAdmin) return resp(403, { erro: "Sem permissão." });
      const nome = (corpo.nome || "").trim();
      const tipo = corpo.tipoComissao === "percentual" ? "percentual" : "fixo";
      let valor = Number(corpo.valor) || 0;
      if (tipo === "percentual") valor = valor / 100; // recebe % e guarda fração
      if (!nome) return resp(400, { erro: "Informe o nome do serviço." });
      if (!(valor > 0)) return resp(400, { erro: "Informe um valor válido." });
      const row = { id: novoId("s"), nome, tipo_comissao: tipo, valor, ativo: true };
      await sb("servicos", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      return resp(200, servApi(row));
    }
    if (sub.startsWith("/servicos/") && metodo === "DELETE") {
      if (!ehAdmin) return resp(403, { erro: "Sem permissão." });
      const id = decodeURIComponent(sub.split("/").pop());
      await sb(`servicos?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return resp(200, { ok: true });
    }

    // ---------- RANKING DO MÊS (qualquer usuário logado) ----------
    // Retorna SÓ a quantidade de serviços por funcionária (nunca valores).
    // O faturamento é usado apenas como critério de desempate, no servidor.
    if (sub === "/ranking" && metodo === "GET") {
      const filtros = ["select=id,usuario_id,nome,tipo,valor,grupo"];
      if (q.de) filtros.push(`data=gte.${q.de}`);
      if (q.ate) filtros.push(`data=lte.${q.ate}`);
      const rows = await sb("lancamentos?" + filtros.join("&"));
      const mapa = {};
      const vistos = {}; // por funcionária: chaves de serviço já contados (dividido conta 1x)
      rows.forEach(r => {
        if (r.tipo !== "manicure" && r.tipo !== "cabeleireira") return;
        const k = r.usuario_id;
        if (!mapa[k]) { mapa[k] = { nome: r.nome, quantidade: 0, _fat: 0 }; vistos[k] = new Set(); }
        mapa[k]._fat += Number(r.valor) || 0;           // faturamento soma todas as partes
        const chave = r.grupo || r.id;                  // serviço dividido = 1 só no ranking
        if (!vistos[k].has(chave)) { vistos[k].add(chave); mapa[k].quantidade++; }
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

    // ---------- FUNCIONÁRIAS (para o dropdown do pagamento conjunto) ----------
    if (sub === "/funcionarias" && metodo === "GET") {
      const rows = await sb("usuarios?select=id,nome,tipo&order=nome");
      return resp(200, rows.filter(u => u.tipo === "manicure" || u.tipo === "cabeleireira").map(u => ({ id: u.id, nome: u.nome })));
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
      const usuarios = await sb("usuarios?select=id,nome,tipo,compensa_dinheiro&order=nome");
      return resp(200, usuarios.map(u => ({ id: u.id, nome: u.nome, tipo: u.tipo, compensa: !!u.compensa_dinheiro })));
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
      if (corpo.compensa !== undefined) patch.compensa_dinheiro = !!corpo.compensa;
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
      if (!descricao) return resp(400, { erro: "Descreva o serviço." });

      // Uma ou várias formas de pagamento na MESMA venda.
      // corpo.pagamentos = [{forma, valor}, ...]  (dividido)  OU  corpo.forma + corpo.valor (forma única)
      let pagamentos;
      if (Array.isArray(corpo.pagamentos) && corpo.pagamentos.length) {
        pagamentos = corpo.pagamentos
          .map(p => ({ forma: ["pix", "cartao", "dinheiro"].includes(p.forma) ? p.forma : "pix", valor: round2(p.valor) }))
          .filter(p => p.valor > 0);
      } else {
        const forma = ["pix", "cartao", "dinheiro"].includes(corpo.forma) ? corpo.forma : "pix";
        pagamentos = [{ forma, valor: round2(corpo.valor) }];
      }
      if (!pagamentos.length) return resp(400, { erro: "Informe um valor válido." });
      const total = round2(pagamentos.reduce((s, p) => s + p.valor, 0));
      if (!(total > 0)) return resp(400, { erro: "Informe um valor válido." });

      let dono = { id: atual.id, nome: atual.nome, tipo: atual.tipo, compensa: atual.compensa };
      if (ehAdmin && corpo.usuarioId) {
        const outro = (await sb(`usuarios?select=*&id=eq.${corpo.usuarioId}`))[0];
        if (outro) dono = outro;
      }
      const cfg = await getConfig();
      const servicos = await sb("servicos?select=*&ativo=eq.true");
      // Comissão é calculada UMA vez sobre o valor total do serviço.
      const cTotal = calcularComissao(dono.tipo, descricao, total, cfg, servicos);
      const compensaDono = dono.compensa_dinheiro !== undefined ? !!dono.compensa_dinheiro : !!dono.compensa;

      // Comprovante é enviado uma vez e vale para todas as partes.
      let comprovante = null, comprovanteHash = null;
      if (corpo.comprovanteBase64) {
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(corpo.comprovanteBase64);
        if (m) {
          const buf = Buffer.from(m[2], "base64");
          comprovanteHash = crypto.createHash("sha256").update(buf).digest("hex");
          // duplicado só é checado quando é forma única (no dividido a mesma foto é reutilizada de propósito)
          if (pagamentos.length === 1) {
            try {
              const iguais = await sb(`lancamentos?select=nome,descricao&comprovante_hash=eq.${comprovanteHash}&limit=1`);
              if (iguais.length) {
                const d = iguais[0];
                return resp(409, { erro: `Esse comprovante já foi enviado (serviço "${d.descricao}" de ${d.nome}). Se for outro serviço, tire outra foto.` });
              }
            } catch (e) {}
          }
          const ext = "." + m[1].split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
          comprovante = await sbUpload(novoId("cmp") + ext, buf, m[1]);
        }
      }

      // Rateia a comissão do serviço proporcionalmente entre as formas de pagamento.
      // A última parte absorve o arredondamento para o total bater exatamente.
      const grupo = pagamentos.length > 1 ? novoId("g") : null;
      const dataLanc = corpo.data || new Date().toISOString().slice(0, 10);
      const rows = [];
      let comAcc = 0;
      pagamentos.forEach((p, i) => {
        const comissao = i === pagamentos.length - 1
          ? round2(cTotal.comissaoSalao - comAcc)
          : round2(cTotal.comissaoSalao * p.valor / total);
        comAcc = round2(comAcc + comissao);
        rows.push({
          id: novoId("l"), usuario_id: dono.id, nome: dono.nome, tipo: dono.tipo,
          data: dataLanc, descricao, valor: p.valor, forma: p.forma,
          comissao_salao: comissao, valor_funcionaria: round2(p.valor - comissao),
          regra: cTotal.regra, comprovante, comprovante_hash: comprovanteHash,
          grupo, pago: false,
          comm_quitada: !(compensaDono && p.forma === "dinheiro")
        });
      });
      const inseridos = await sb("lancamentos", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows) });
      return resp(200, pagamentos.length === 1 ? toApi(inseridos[0]) : inseridos.map(toApi));
    }

    // ---------- PAGAMENTO CONJUNTO (uma pessoa lança, vai para todas) ----------
    if (sub === "/lancamentos-conjunto" && metodo === "POST") {
      const forma = ["pix", "cartao", "dinheiro"].includes(corpo.forma) ? corpo.forma : "pix";
      const data = corpo.data || new Date().toISOString().slice(0, 10);
      const parts = Array.isArray(corpo.participantes) ? corpo.participantes : [];
      if (parts.length < 1) return resp(400, { erro: "Informe as funcionárias do pagamento conjunto." });
      for (const p of parts) {
        if (!String(p.descricao || "").trim()) return resp(400, { erro: "Descreva o serviço de cada funcionária." });
        if (!(Number(p.valor) > 0)) return resp(400, { erro: "Informe um valor válido para cada funcionária." });
      }
      const usuarios = await sb("usuarios?select=*");
      const cfg = await getConfig();
      const servicos = await sb("servicos?select=*&ativo=eq.true");
      let comprovante = null, comprovanteHash = null;
      if (corpo.comprovanteBase64) {
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(corpo.comprovanteBase64);
        if (m) {
          const buf = Buffer.from(m[2], "base64");
          comprovanteHash = crypto.createHash("sha256").update(buf).digest("hex");
          const ext = "." + m[1].split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
          comprovante = await sbUpload(novoId("cmp") + ext, buf, m[1]);
        }
      }
      // marca todas as partes como do mesmo pagamento conjunto (prefixo "cj_")
      const grupoConj = parts.length > 1 ? novoId("cj") : null;
      const rows = [];
      for (const p of parts) {
        const dono = usuarios.find(u => u.id === p.usuarioId);
        if (!dono || !(dono.tipo === "manicure" || dono.tipo === "cabeleireira")) return resp(400, { erro: "Funcionária inválida no pagamento conjunto." });
        const valor = round2(p.valor);
        const c = calcularComissao(dono.tipo, p.descricao, valor, cfg, servicos);
        rows.push({
          id: novoId("l"), usuario_id: dono.id, nome: dono.nome, tipo: dono.tipo,
          data, descricao: String(p.descricao).trim(), valor, forma,
          comissao_salao: c.comissaoSalao, valor_funcionaria: c.valorFuncionaria, regra: c.regra,
          comprovante, comprovante_hash: comprovanteHash, grupo: grupoConj, pago: false,
          comm_quitada: !(!!dono.compensa_dinheiro && forma === "dinheiro")
        });
      }
      const inseridos = await sb("lancamentos", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows) });
      return resp(200, inseridos.map(toApi));
    }

    if (sub === "/lancamentos" && metodo === "GET") {
      const filtros = ["select=*", "order=criado_em.desc"];
      if (!ehGestor) filtros.push(`usuario_id=eq.${atual.id}`);
      else if (q.usuarioId) filtros.push(`usuario_id=eq.${q.usuarioId}`);
      if (q.data) filtros.push(`data=eq.${q.data}`);
      if (q.de) filtros.push(`data=gte.${q.de}`);
      if (q.ate) filtros.push(`data=lte.${q.ate}`);
      const rows = await sb("lancamentos?" + filtros.join("&"));
      // enriquece os lançamentos de pagamento conjunto (cj_) com os nomes dos outros participantes
      const gruposCj = [...new Set(rows.filter(r => r.grupo && String(r.grupo).startsWith("cj_")).map(r => r.grupo))];
      const membros = {};
      if (gruposCj.length) {
        const lista = gruposCj.map(g => `"${g}"`).join(",");
        const ms = await sb(`lancamentos?select=grupo,usuario_id,nome&grupo=in.(${lista})`);
        ms.forEach(m => { (membros[m.grupo] = membros[m.grupo] || []).push(m); });
      }
      const out = rows.map(r => {
        const a = toApi(r);
        if (r.grupo && membros[r.grupo]) {
          a.conjuntoCom = [...new Set(membros[r.grupo].filter(m => m.usuario_id !== r.usuario_id).map(m => m.nome))];
        }
        return a;
      });
      return resp(200, out);
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
      const cfg = await getConfig();
      const servicos = await sb("servicos?select=*&ativo=eq.true");
      const c = calcularComissao(l.tipo, descricao, valor, cfg, servicos);
      const dono2 = (await sb(`usuarios?select=compensa_dinheiro&id=eq.${l.usuario_id}`))[0] || {};
      const patch = {
        descricao, valor, forma, comissao_salao: c.comissaoSalao, valor_funcionaria: c.valorFuncionaria, regra: c.regra,
        comm_quitada: !(!!dono2.compensa_dinheiro && forma === "dinheiro")
      };
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

    // ---------- ACERTAR COMISSÃO DO DINHEIRO (método cartão), uma a uma ----------
    // Marca (ou desmarca) a comissão de um lançamento de dinheiro como já quitada,
    // pra ela parar (ou voltar) a descontar do cartão. Corrige débito duplicado.
    if (sub === "/comissao-acertar" && metodo === "POST") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const id = corpo.id;
      if (!id) return resp(400, { erro: "Informe o lançamento." });
      const l = (await sb(`lancamentos?select=*&id=eq.${id}`))[0];
      if (!l) return resp(404, { erro: "Lançamento não encontrado." });
      if (l.forma !== "dinheiro") return resp(400, { erro: "Só comissões de dinheiro entram nesse acerto." });
      const quitada = corpo.quitada !== false; // padrão: marcar como quitada
      const upd = await sb(`lancamentos?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ comm_quitada: quitada }) });
      return resp(200, toApi(upd[0]));
    }

    // ---------- PAGAR / REABRIR ----------
    if (sub === "/pagar" && metodo === "POST") {
      if (!ehGestor) return resp(403, { erro: "Sem permissão." });
      const uid = corpo.usuarioId;
      if (corpo.escopo === "dia") {
        await sb(`lancamentos?usuario_id=eq.${uid}&pago=eq.false&data=eq.${corpo.data}&forma=neq.cartao`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pago: true }) });
      } else if (corpo.escopo === "cartao") {
        await sb(`lancamentos?usuario_id=eq.${uid}&pago=eq.false&forma=eq.cartao`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pago: true }) });
        // método do cartão: quita as comissões de dinheiro que estavam penduradas
        await sb(`lancamentos?usuario_id=eq.${uid}&forma=eq.dinheiro&comm_quitada=eq.false`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ comm_quitada: true }) });
      } else return resp(400, { erro: "Escopo inválido." });
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
