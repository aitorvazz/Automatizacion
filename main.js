import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 10000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // ---------------- Utils de lectura en detalle ----------------
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

  // --------------- 1) Abrir buscador y cookies -------------------
  log.info("Abriendo buscador…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click(); 
      await waitIdle();
    }
  } catch {}

  // --------------- 2) Aplicar filtros ----------------------------
  // Intento directo por label; si no, fuerza por texto de option
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

  // --------------- 3) Buscar ------------------------------------
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Buscar disparado");
  } catch {}
  await waitIdle();
  await page.waitForTimeout(800);

  // --------------- 4) Paginación + scraping de cada página -------
  // Selectores de filas de resultados y de paginación
  const ROWS_SEL = ".filaResultado, .resultado, [data-anuncio], table tbody tr";
  const visited = new Set();

  const getPageDetailLinks = async () => {
    // intentar links que apunten a anuncio/expediente
    const links = await page.evaluate(() => {
      const abs = (u) => new URL(u, location.href).toString();
      const as = Array.from(document.querySelectorAll(".filaResultado a[href], .resultado a[href], [data-anuncio] a[href], table tbody tr a[href]"));
      const urls = as
        .map(a => abs(a.getAttribute("href") || ""))
        .filter(u => u && !u.includes("busquedaAnuncios"))
        .filter(u => /(contenidos\/anuncio_contratacion\/expjaso\d+|anuncio_contratacion\/expjaso\d+|expjaso\d+\/es_doc\/|expjaso\d+\.html)/i.test(u));
      return Array.from(new Set(urls));
    });
    return links;
  };

  const gotoNextPage = async () => {
    // intenta varios selectores de “Siguiente” habilitado
    const candidates = [
      "a[rel='next']:not([aria-disabled='true'])",
      "button[rel='next']:not([disabled])",
      "a[aria-label*='Siguiente']:not(.disabled)",
      "button[aria-label*='Siguiente']:not([disabled])",
      "a:has-text('Siguiente')",
      "a:has-text('Hurrengoa')",
      "a.paginacionSiguiente:not(.disabled)",
      ".pagination a[title*='Siguiente']:not(.disabled)",
      "li.next:not(.disabled) a",
    ];

    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(()=>false)) {
        const disabled = await el.getAttribute("aria-disabled").catch(()=>null);
        if (disabled === "true") continue;
        await el.click({ timeout: 2000 }).catch(()=>{});
        await waitIdle();
        await page.waitForTimeout(500);
        return true;
      }
    }

    // Fallback: buscar por XPATH el enlace Siguiente que no esté deshabilitado
    try {
      const link = page.locator("xpath=//a[contains(.,'Siguiente') or contains(.,'Hurrengoa')][not(contains(@class,'disabled'))]").first();
      if (await link.isVisible().catch(()=>false)) {
        await link.click();
        await waitIdle();
        await page.waitForTimeout(500);
        return true;
      }
    } catch {}

    return false; // no hay más páginas
  };

  let pageIndex = 1;
  while (true) {
    // 4.1) Filas visibles
    const n = await page.locator(ROWS_SEL).count().catch(() => 0);
    log.info(`Página ${pageIndex}: filas detectadas = ${n}`);

    // 4.2) Enlaces de detalle en esta página
    const links = await getPageDetailLinks();
    log.info(`Página ${pageIndex}: enlaces de detalle = ${links.length}`);

    // 4.3) Procesar cada enlace (evitando duplicados)
    for (const href of links) {
      if (visited.has(href)) continue;
      visited.add(href);
      log.info(`→ Detalle: ${href}`);
      await scrapeDetail(href);
    }

    // 4.4) Intentar pasar a la siguiente página
    const hasNext = await gotoNextPage();
    if (!hasNext) break;
    pageIndex++;
    // pequeña espera extra por si la paginación es AJAX
    await waitIdle();
    await page.waitForTimeout(500);
  }

  await browser.close();
  log.info(`Hecho. Total enlaces únicos procesados: ${visited.size}`);
});
