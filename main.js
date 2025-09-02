import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

// Aceptamos SOLO URLs que contengan un expediente real "expjasoNNNNN"
const DETAIL_RE = /(\/contenidos\/anuncio_contratacion\/expjaso\d+\/|\/anuncio_contratacion\/expjaso\d+\/|expjaso\d+\/es_doc\/|expjaso\d+\.html)/i;

// Límite para no agotar tiempo (ajusta a 40/60 si quieres)
const MAX_DETAILS = 30;

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const waitIdle = async (ms = 12000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // --- Utils de detalle ---
  const extractFirstDate = (txt) => {
    if (!txt) return null;
    const m = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
    return m ? m[0] : null;
  };

  const readBlockByLabel = async (ctx, variants) => {
    for (const labelText of variants) {
      try {
        let node = ctx.locator(`text="${labelText}"`).first();
        if (!(await node.isVisible().catch(() => false))) {
          node = ctx.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]`).first();
        }
        if (!(await node.isVisible().catch(() => false))) continue;
        const block = await node.locator("xpath=..").innerText().catch(() => "");
        if (!block) continue;
        return block.replace(/\s+/g, " ").trim();
      } catch {}
    }
    return null;
  };

  const readHrefByLabel = async (ctx, variants) => {
    for (const labelText of variants) {
      try {
        const linkNear = ctx.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]/following::a[1]`).first();
        if (await linkNear.isVisible().catch(() => false)) {
          const href = await linkNear.getAttribute("href").catch(() => null);
          if (href) return new URL(href, ctx.url()).toString();
        }
      } catch {}
    }
    return null;
  };

  const scrapeDetail = async (ctx, enlace, tituloHint) => {
    const titulo = (await ctx.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || tituloHint || null;

    const expedienteTxt        = await readBlockByLabel(ctx, ["Expediente", "Nº de expediente", "Número de expediente"]);
    const fechaPrimeraTxt      = await readBlockByLabel(ctx, ["Fecha primera publicación", "Primera publicación"]);
    const fechaUltimaTxt       = await readBlockByLabel(ctx, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
    const tipoContratoTxt      = await readBlockByLabel(ctx, ["Tipo de contrato", "Tipo contrato"]);
    const estadoTramTxt        = await readBlockByLabel(ctx, ["Estado de la tramitación", "Estado", "Situación"]);
    const plazoPresentacionTxt = await readBlockByLabel(ctx, ["Plazo de presentación", "Plazo presentación"]);
    const fechaLimiteTxt       = await readBlockByLabel(ctx, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
    const presupuestoSinIvaTxt = await readBlockByLabel(ctx, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
    const poderAdjudicadorTxt  = await readBlockByLabel(ctx, ["Poder adjudicador", "Tipo de poder adjudicador"]);
    const entidadImpulsoraTxt  = await readBlockByLabel(ctx, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
    const urlLicitacion        = await readHrefByLabel(ctx, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

    const expediente = expedienteTxt ? (expedienteTxt.match(/expediente[:\s]*([A-Za-z0-9\/\-\._]+)/i)?.[1] || expedienteTxt) : null;

    await Actor.pushData({
      titulo,
      enlace,
      expediente,
      fechaPrimeraPublicacion: extractFirstDate(fechaPrimeraTxt),
      fechaUltimaPublicacion : extractFirstDate(fechaUltimaTxt),
      tipoContrato           : tipoContratoTxt || null,
      estadoTramitacion      : estadoTramTxt || null,
      plazoPresentacion      : plazoPresentacionTxt || null,
      fechaLimitePresentacion: extractFirstDate(fechaLimiteTxt),
      presupuestoSinIVA      : presupuestoSinIvaTxt || null,
      poderAdjudicador       : poderAdjudicadorTxt || null,
      entidadImpulsora       : entidadImpulsoraTxt || null,
      direccionLicitacionElectronica: urlLicitacion || null,
    });
  };

  // --- 1) Abrir y cookies ---
  log.info("Abriendo buscador…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click(); await waitIdle();
    }
  } catch {}

  // --- 2) Aplicar filtros (Suministros + Abierto) ---
  async function forceSelectByOptionText(optionTextContains) {
    return page.evaluate((optText) => {
      function norm(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
      const wants = norm(optText);
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opts = Array.from(sel.options);
        const found = opts.find(o => norm(o.textContent||"").includes(wants));
        if (found) {
          sel.value = found.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, optionTextContains);
  }

  let okTipo = false, okEstado = false;
  try {
    const ctrl = page.getByLabel("Tipo de contrato", { exact: false });
    if (await ctrl.isVisible({ timeout: 800 }).catch(() => false)) {
      await ctrl.selectOption({ label: "Suministros" }, { timeout: 3500 });
      okTipo = true;
    }
  } catch {}
  if (!okTipo) okTipo = await forceSelectByOptionText("Suministros");

  try {
    const ctrlE = page.getByLabel("Estado", { exact: false });
    if (await ctrlE.isVisible({ timeout: 800 }).catch(() => false)) {
      await ctrlE.selectOption({ label: "Abierto" }, { timeout: 3500 });
      okEstado = true;
    }
  } catch {}
  if (!okEstado) okEstado = await forceSelectByOptionText("Abierto");

  log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);

  // --- 3) Buscar ---
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
  } catch {}
  await waitIdle(15000);
  await page.waitForTimeout(1000);

  // --- 4) Escanear todos los <a> (página + iframes) y FILTRAR por expjaso ---
  const collectLinks = async (ctx) => {
    return await ctx.evaluate((DETAIL_RE_STR) => {
      const DETAIL_RE = new RegExp(DETAIL_RE_STR, "i");
      const abs = (u) => new URL(u, location.href).toString();

      // intentar restringir a contenedores típicos de resultados
      const scopes = [
        document.querySelector("#resultados"),
        document.querySelector("#main"),
        document.querySelector("main"),
        document.querySelector(".resultadoBusqueda"),
        document.querySelector(".resultados"),
        document.body, // fallback
      ].filter(Boolean);

      const urls = new Set();
      for (const root of scopes) {
        const anchors = Array.from(root.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          if (!href || href.startsWith("#")) continue;
          if (/^javascript:/i.test(href)) continue;
          const url = abs(href);
          if (url.includes("busquedaAnuncios")) continue;
          if (!DETAIL_RE.test(url)) continue; // ← SOLO expjaso/anuncio_contratacion
          urls.add(url);
          if (urls.size >= 250) break;
        }
        if (urls.size >= 250) break;
      }
      return Array.from(urls);
    }, DETAIL_RE.source);
  };

  // scroll para forzar cargas perezosas
  try { await page.mouse.wheel(0, 2000); await page.waitForTimeout(400); await page.mouse.wheel(0, -2000); } catch {}

  const allLinks = new Set(await collectLinks(page));
  for (const fr of page.frames()) {
    try { (await collectLinks(fr)).forEach(u => allLinks.add(u)); } catch {}
  }

  // filtro final + limitar a MAX_DETAILS
  const links = Array.from(allLinks).filter(u => DETAIL_RE.test(u)).slice(0, MAX_DETAILS);
  log.info(`Enlaces de detalle VÁLIDOS: ${links.length}`);

  if (!links.length) {
    await Actor.setValue("debug_no_valid_links.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
    await Actor.setValue("debug_no_valid_links.html", await page.content(), { contentType: "text/html; charset=utf-8" });
    log.error("No se detectaron enlaces de expediente (expjaso…). Revisa debug_no_valid_links.*");
    await browser.close();
    return;
  }

  // --- 5) Visitar detalle y extraer tus 11 campos ---
  for (const enlace of links) {
    log.info(`Procesando → ${enlace}`);
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();
    await scrapeDetail(page, enlace, null);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
