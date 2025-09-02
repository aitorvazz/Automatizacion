import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

// patrones de URLs de detalle de expediente (muy restrictivo)
const DETAIL_RE = /(\/contenidos\/anuncio_contratacion\/expjaso\d+\/|\/anuncio_contratacion\/expjaso\d+\/|expjaso\d+\/es_doc\/|expjaso\d+\.html)/i;

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 10000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };
  const shortPause = async (ms = 400) => { try { await page.waitForTimeout(ms); } catch {} };

  // ---- utilidades de extracción en detalle ----
  const extractFirstDate = (txt) => txt?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || null;

  const readBlockByLabel = async (ctx, labels) => {
    for (const lbl of labels) {
      try {
        let node = ctx.locator(`text="${lbl}"`).first();
        if (!(await node.isVisible().catch(() => false))) {
          node = ctx.locator(`xpath=//*[contains(normalize-space(.),'${lbl}')]`).first();
        }
        if (!(await node.isVisible().catch(() => false))) continue;
        const block = await node.locator("xpath=..").innerText().catch(() => "");
        if (block) return block.replace(/\s+/g, " ").trim();
      } catch {}
    }
    return null;
  };

  const readHrefByLabel = async (ctx, labels) => {
    for (const lbl of labels) {
      try {
        const link = ctx.locator(`xpath=//*[contains(normalize-space(.),'${lbl}')]/following::a[1]`).first();
        if (await link.isVisible().catch(() => false)) {
          const href = await link.getAttribute("href").catch(() => null);
          if (href) return new URL(href, ctx.url()).toString();
        }
      } catch {}
    }
    return null;
  };

  const scrapeDetail = async (detailUrl) => {
    const detail = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await detail.goto(detailUrl, { waitUntil: "domcontentloaded" });
      await waitIdle();

      const titulo = (await detail.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || null;

      const expedienteTxt        = await readBlockByLabel(detail, ["Expediente", "Nº de expediente", "Número de expediente"]);
      const fechaPrimeraTxt      = await readBlockByLabel(detail, ["Fecha primera publicación", "Primera publicación"]);
      const fechaUltimaTxt       = await readBlockByLabel(detail, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
      const tipoContratoTxt      = await readBlockByLabel(detail, ["Tipo de contrato", "Tipo contrato"]);
      const estadoTramTxt        = await readBlockByLabel(detail, ["Estado de la tramitación", "Estado", "Situación"]);
      const plazoPresentacionTxt = await readBlockByLabel(detail, ["Plazo de presentación", "Plazo presentación"]);
      const fechaLimiteTxt       = await readBlockByLabel(detail, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
      const presupuestoSinIvaTxt = await readBlockByLabel(detail, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
      const poderAdjudicadorTxt  = await readBlockByLabel(detail, ["Poder adjudicador", "Tipo de poder adjudicador"]);
      const entidadImpulsoraTxt  = await readBlockByLabel(detail, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
      const urlLicitacion        = await readHrefByLabel(detail, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

      const expediente = expedienteTxt ? (expedienteTxt.match(/expediente[:\s]*([A-Za-z0-9\/\-\._]+)/i)?.[1] || expedienteTxt) : null;

      await Actor.pushData({
        titulo,
        enlace: detailUrl,
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
    } finally {
      await detail.close().catch(()=>{});
    }
  };

  // ---- 1) Abrir buscador + cookies ----
  log.info("Abriendo buscador…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click(); await waitIdle();
    }
  } catch {}

  // ---- 2) Aplicar filtros (Suministros + Abierto) ----
  const forceSelectByOptionText = async (text) => {
    return page.evaluate((optText) => {
      function norm(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
      const wants = norm(optText);
      for (const sel of Array.from(document.querySelectorAll("select"))) {
        const found = Array.from(sel.options).find(o => norm(o.textContent||"").includes(wants));
        if (found) {
          sel.value = found.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, text);
  };

  let okTipo=false, okEstado=false;
  try { const c = page.getByLabel("Tipo de contrato", { exact:false }); if (await c.isVisible({ timeout:800 }).catch(()=>false)) { await c.selectOption({ label:"Suministros" }); okTipo=true; } } catch {}
  if (!okTipo) okTipo = await forceSelectByOptionText("Suministros");

  try { const e = page.getByLabel("Estado", { exact:false }); if (await e.isVisible({ timeout:800 }).catch(()=>false)) { await e.selectOption({ label:"Abierto" }); okEstado=true; } } catch {}
  if (!okEstado) okEstado = await forceSelectByOptionText("Abierto");

  log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);

  // ---- 3) Buscar ----
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Buscar disparado");
  } catch {}
  await waitIdle(12000);
  await shortPause(600);

  // ---- helpers de recolección de enlaces y paginación ----
  const collectDetailLinks = async (ctx) => {
    return await ctx.evaluate((DETAIL_RE_STR) => {
      const DETAIL_RE = new RegExp(DETAIL_RE_STR, "i");
      const abs = (u) => new URL(u, location.href).toString();

      const scopes = [
        document.querySelector("#resultados"),
        document.querySelector("main"),
        document.body,
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
          if (!DETAIL_RE.test(url)) continue;
          urls.add(url);
          if (urls.size >= 500) break;
        }
        if (urls.size >= 500) break;
      }
      return Array.from(urls);
    }, DETAIL_RE.source);
  };

  const gotoNextPage = async () => {
    const tries = [
      "a[rel='next']:not([aria-disabled='true'])",
      "button[rel='next']:not([disabled])",
      "a[aria-label*='Siguiente']:not(.disabled)",
      "button[aria-label*='Siguiente']:not([disabled])",
      "a.paginacionSiguiente:not(.disabled)",
      "li.next:not(.disabled) a",
      "xpath=//a[contains(.,'Siguiente') or contains(.,'Hurrengoa')][not(contains(@class,'disabled'))]"
    ];
    for (const sel of tries) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(()=>false)) {
        await el.click().catch(()=>{});
        await waitIdle(8000);
        await shortPause(400);
        return true;
      }
    }
    return false;
  };

  // ---- 4) Paginación completa y scraping de cada anuncio ----
  const visited = new Set();
  let pageIndex = 1;

  while (true) {
    // recolectar enlaces en la página y en sus iframes (si existen)
    let links = new Set(await collectDetailLinks(page));
    for (const fr of page.frames()) {
      try { (await collectDetailLinks(fr)).forEach(u => links.add(u)); } catch {}
    }

    const list = Array.from(links);
    log.info(`Página ${pageIndex}: enlaces de expediente detectados = ${list.length}`);

    if (!list.length && pageIndex === 1) {
      // si en la primera página no detecta nada, guardo debug y salgo (así no “parece” que no hace nada)
      await Actor.setValue("debug_no_results_first.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      await Actor.setValue("debug_no_results_first.html", await page.content(), { contentType: "text/html; charset=utf-8" });
      log.error("No se detectaron anuncios en la primera página. Revisa debug_no_results_first.*");
      break;
    }

    // visitar cada detalle (evitando duplicados)
    for (const href of list) {
      if (visited.has(href)) continue;
      visited.add(href);
      log.info(`→ Detalle: ${href}`);
      await scrapeDetail(href);
    }

    // siguiente página
    const hasNext = await gotoNextPage();
    if (!hasNext) break;
    pageIndex++;
  }

  await browser.close();
  log.info(`Hecho. Total anuncios procesados: ${visited.size}`);
});
