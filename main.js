import { Actor, log } from "apify";
import { chromium } from "playwright";
import { XMLParser } from "fast-xml-parser";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // 1) Abrir buscador y aceptar cookies
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

  // -------- Helpers de filtros (tolerantes a UI RUP) ----------
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

  async function applyFilterTipoEstado() {
    // Tipo = Suministros
    let okTipo = false;
    try {
      const ctrl = page.getByLabel("Tipo de contrato", { exact: false });
      if (await ctrl.isVisible({ timeout: 800 }).catch(() => false)) {
        await ctrl.selectOption({ label: "Suministros" }, { timeout: 3500 });
        okTipo = true;
      }
    } catch {}
    if (!okTipo) okTipo = await forceSelectByOptionText("Suministros");

    // Estado = Abierto
    let okEstado = false;
    try {
      const ctrlE = page.getByLabel("Estado", { exact: false });
      if (await ctrlE.isVisible({ timeout: 800 }).catch(() => false)) {
        await ctrlE.selectOption({ label: "Abierto" }, { timeout: 3500 });
        okEstado = true;
      }
    } catch {}
    if (!okEstado) okEstado = await forceSelectByOptionText("Abierto");

    log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);
  }

  await applyFilterTipoEstado();
  await waitIdle();

  // 2) Buscar
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}
  await waitIdle();
  await page.waitForTimeout(1000);

  // 3) Localizar el enlace RSS real de esta búsqueda
  // Intentamos varias ubicaciones: <a href*="rssFeed">, <link type="application/rss+xml">, icono RSS
  let rssUrl = null;
  try {
    // a) <a> con rssFeed
    const a1 = page.locator("a[href*='rssFeed']").first();
    if (await a1.isVisible().catch(() => false)) {
      const href = await a1.getAttribute("href");
      if (href) rssUrl = new URL(href, page.url()).toString();
    }
    // b) <link type="application/rss+xml">
    if (!rssUrl) {
      const href = await page.evaluate(() => {
        const el = document.querySelector('link[type="application/rss+xml"], link[type="application/atom+xml"]');
        return el?.getAttribute("href") || null;
      });
      if (href) rssUrl = new URL(href, page.url()).toString();
    }
    // c) icono con texto
    if (!rssUrl) {
      const a2 = page.locator("a:has-text('RSS'), a[title*='RSS'], a[aria-label*='RSS']").first();
      if (await a2.isVisible().catch(() => false)) {
        const href = await a2.getAttribute("href");
        if (href) rssUrl = new URL(href, page.url()).toString();
      }
    }
  } catch {}

  if (!rssUrl) {
    // Fallback: si no hay RSS visible, guardamos captura y salimos con mensaje claro
    await Actor.setValue("debug_no_rss.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
    log.error("No se encontró el enlace RSS en la página de resultados. Captura guardada como debug_no_rss.png");
    await browser.close();
    return;
  }

  log.info(`RSS detectado: ${rssUrl}`);

  // 4) Descargar y parsear el RSS detectado
  const res = await fetch(rssUrl);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const rss = parser.parse(xml);

  let items = rss?.rss?.channel?.item || [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  log.info(`Items RSS detectados: ${items.length}`);

  // 5) Visitar cada detalle y extraer TUS CAMPOS
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

  const extractFirstDate = (txt) => {
    if (!txt) return null;
    const m = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
    return m ? m[0] : null;
  };

  for (const it of items) {
    const enlace = it.link;
    const titulo = it.title;

    if (!enlace) continue;
    log.info(`Procesando → ${titulo}`);

    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const expedienteTxt = await readBlockByLabel(page, ["Expediente", "Nº de expediente", "Número de expediente"]);
    const fechaPrimeraTxt = await readBlockByLabel(page, ["Fecha primera publicación", "Primera publicación"]);
    const fechaUltimaTxt = await readBlockByLabel(page, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
    const tipoContratoTxt = await readBlockByLabel(page, ["Tipo de contrato", "Tipo contrato"]);
    const estadoTramTxt = await readBlockByLabel(page, ["Estado de la tramitación", "Estado", "Situación"]);
    const plazoPresentacionTxt = await readBlockByLabel(page, ["Plazo de presentación", "Plazo presentación"]);
    const fechaLimiteTxt = await readBlockByLabel(page, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
    const presupuestoSinIvaTxt = await readBlockByLabel(page, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
    const poderAdjudicadorTxt = await readBlockByLabel(page, ["Poder adjudicador", "Tipo de poder adjudicador"]);
    const entidadImpulsoraTxt = await readBlockByLabel(page, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
    const urlLicitacion = await readHrefByLabel(page, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

    const item = {
      titulo,
      enlace,
      expediente: expedienteTxt,
      fechaPrimeraPublicacion: extractFirstDate(fechaPrimeraTxt),
      fechaUltimaPublicacion: extractFirstDate(fechaUltimaTxt),
      tipoContrato: tipoContratoTxt,
      estadoTramitacion: estadoTramTxt,
      plazoPresentacion: plazoPresentacionTxt,
      fechaLimitePresentacion: extractFirstDate(fechaLimiteTxt),
      presupuestoSinIVA: presupuestoSinIvaTxt,
      poderAdjudicador: poderAdjudicadorTxt,
      entidadImpulsora: entidadImpulsoraTxt,
      direccionLicitacionElectronica: urlLicitacion,
    };

    await Actor.pushData(item);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
