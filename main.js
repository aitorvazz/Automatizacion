import { Actor, log } from "apify";
import { chromium } from "playwright";
import { XMLParser } from "fast-xml-parser";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // 0) Utilidades comunes ------------------------------------------------------
  const extractFirstDate = (txt) => {
    if (!txt) return null;
    const m = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
    return m ? m[0] : null;
  };

  const readBlockByLabel = async (detailPage, variants) => {
    for (const labelText of variants) {
      try {
        let node = detailPage.locator(`text="${labelText}"`).first();
        if (!(await node.isVisible().catch(() => false))) {
          node = detailPage.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]`).first();
        }
        if (!(await node.isVisible().catch(() => false))) continue;
        const block = await node.locator("xpath=..").innerText().catch(() => "");
        if (!block) continue;
        return block.replace(/\s+/g, " ").trim();
      } catch {}
    }
    return null;
  };

  const readHrefByLabel = async (detailPage, variants) => {
    for (const labelText of variants) {
      try {
        const linkNear = detailPage.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]/following::a[1]`).first();
        if (await linkNear.isVisible().catch(() => false)) {
          const href = await linkNear.getAttribute("href").catch(() => null);
          if (href) return new URL(href, detailPage.url()).toString();
        }
      } catch {}
    }
    return null;
  };

  async function scrapeDetail(detailPage, enlace, tituloHint) {
    const titulo = (await detailPage.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || tituloHint || null;

    const expedienteTxt = await readBlockByLabel(detailPage, ["Expediente", "Nº de expediente", "Número de expediente"]);
    const fechaPrimeraTxt = await readBlockByLabel(detailPage, ["Fecha primera publicación", "Primera publicación"]);
    const fechaUltimaTxt = await readBlockByLabel(detailPage, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
    const tipoContratoTxt = await readBlockByLabel(detailPage, ["Tipo de contrato", "Tipo contrato"]);
    const estadoTramTxt = await readBlockByLabel(detailPage, ["Estado de la tramitación", "Estado", "Situación"]);
    const plazoPresentacionTxt = await readBlockByLabel(detailPage, ["Plazo de presentación", "Plazo presentación"]);
    const fechaLimiteTxt = await readBlockByLabel(detailPage, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
    const presupuestoSinIvaTxt = await readBlockByLabel(detailPage, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
    const poderAdjudicadorTxt = await readBlockByLabel(detailPage, ["Poder adjudicador", "Tipo de poder adjudicador"]);
    const entidadImpulsoraTxt = await readBlockByLabel(detailPage, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
    const urlLicitacion = await readHrefByLabel(detailPage, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

    const expediente = expedienteTxt ? (expedienteTxt.match(/expediente[:\s]*([A-Za-z0-9\/\-\._]+)/i)?.[1] || expedienteTxt) : null;

    const item = {
      titulo,
      enlace,
      expediente,
      fechaPrimeraPublicacion: extractFirstDate(fechaPrimeraTxt),
      fechaUltimaPublicacion: extractFirstDate(fechaUltimaTxt),
      tipoContrato: tipoContratoTxt || null,
      estadoTramitacion: estadoTramTxt || null,
      plazoPresentacion: plazoPresentacionTxt || null,
      fechaLimitePresentacion: extractFirstDate(fechaLimiteTxt),
      presupuestoSinIVA: presupuestoSinIvaTxt || null,
      poderAdjudicador: poderAdjudicadorTxt || null,
      entidadImpulsora: entidadImpulsoraTxt || null,
      direccionLicitacionElectronica: urlLicitacion || null,
    };

    await Actor.pushData(item);
  }

  // 1) Abrir buscador y aceptar cookies ---------------------------------------
  log.info("Abriendo buscador…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click(); await waitIdle();
      log.info("Cookies aceptadas");
    }
  } catch {}

  // 2) Aplicar filtros (Suministros + Abierto) --------------------------------
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

  // 3) Buscar ------------------------------------------------------------------
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}
  await waitIdle();
  await page.waitForTimeout(1000);

  // 4) Intentar capturar el RSS real (varios métodos) -------------------------
  let rssUrl = null;
  try {
    // a) anchors con rssFeed o rss
    const a1 = page.locator("a[href*='rssFeed'], a[href*='rss']").first();
    if (await a1.isVisible({ timeout: 1000 }).catch(() => false)) {
      const href = await a1.getAttribute("href");
      if (href) rssUrl = new URL(href, page.url()).toString();
    }
    // b) <link type="application/rss+xml">
    if (!rssUrl) {
      const href = await page.evaluate(() => {
        const el = document.querySelector('link[type="application/rss+xml"], link[type="application/atom+xml"]');
        return el?.getAttribute("href") || null;
      });
      if (href) rssUrl = new URL(href, location.href).toString();
    }
    // c) Búsqueda global en el DOM por cadenas 'rss'
    if (!rssUrl) {
      rssUrl = await page.evaluate(() => {
        const abs = (u) => new URL(u, location.href).toString();
        const attrs = ["href","src","data-href"];
        for (const el of Array.from(document.querySelectorAll("*"))) {
          for (const at of attrs) {
            const v = el.getAttribute?.(at);
            if (v && /rss|rssFeed/i.test(v)) return abs(v);
          }
        }
        // también dentro de scripts inline
        for (const sc of Array.from(document.querySelectorAll("script"))) {
          const t = sc.textContent || "";
          const m = t.match(/https?:[^\s"']*rss[^\s"']*/i) || t.match(/\/r01PubWar\/rssFeed[^\s"']*/i);
          if (m) return abs(m[0]);
        }
        return null;
      });
    }
  } catch {}

  // 5) Si hay RSS, úsalo. Si no, Fallback a scraping directo ------------------
  let detailLinks = [];

  if (rssUrl) {
    log.info(`RSS detectado: ${rssUrl}`);
    const res = await fetch(rssUrl);
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const rss = parser.parse(xml);
    let items = rss?.rss?.channel?.item || [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    log.info(`Items RSS detectados: ${items.length}`);
    detailLinks = items.map(it => it.link).filter(Boolean);
  } else {
    log.warning("No se encontró RSS. Aplico Fallback: scraping directo de resultados.");
    // localizar filas / tarjetas
    const containers = [
      "table tbody tr",
      ".resultados tbody tr",
      ".listado tbody tr",
      ".resultado",
      ".filaResultado",
      "[data-anuncio]"
    ];
    let rows = null, total = 0;
    for (const sel of containers) {
      const cand = page.locator(sel);
      const n = await cand.count().catch(() => 0);
      if (n) { rows = cand; total = n; log.info(`Contenedor detectado: "${sel}" (${n} filas)`); break; }
    }
    if (!rows) {
      await Actor.setValue("debug_no_rows.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      log.error("No se detectaron filas de resultados. Captura guardada (debug_no_rows.png).");
      await browser.close();
      return;
    }

    // extraer anchors de detalle desde cada fila/tarjeta
    const maxRows = Math.min(total, 200);
    for (let i = 0; i < maxRows; i++) {
      const row = rows.nth(i);
      const a = row.locator("a[href]").first();
      const href = await a.getAttribute("href").catch(() => null);
      if (!href) continue;
      const abs = new URL(href, page.url()).toString();
      // filtra enlaces del buscador y anclas
      if (abs.includes("busquedaAnuncios")) continue;
      if (/^javascript:/i.test(abs)) continue;
      // patrones típicos de detalle
      if (/(con|contenidos)\/anuncio_contratacion|PublicidadWar|expjaso|ver|detalle|expediente|contrato|KPE/i.test(abs)) {
        detailLinks.push(abs);
      }
    }
    // únicos
    detailLinks = Array.from(new Set(detailLinks));
    log.info(`Enlaces de detalle detectados por Fallback: ${detailLinks.length}`);

    if (!detailLinks.length) {
      await Actor.setValue("debug_no_links.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      log.error("No se detectaron enlaces de detalle. Captura guardada (debug_no_links.png).");
      await browser.close();
      return;
    }
  }

  // 6) Visitar cada detalle y extraer TUS CAMPOS ------------------------------
  for (const enlace of detailLinks) {
    log.info(`Procesando → ${enlace}`);
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();
    await scrapeDetail(page, enlace, null);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
