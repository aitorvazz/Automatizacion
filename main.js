import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // 1) Abrir y cookies
  log.info("Abriendo búsqueda…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click(); await waitIdle();
      log.info("Cookies aceptadas");
    }
  } catch {}

  // -------- Helpers filtros (tolerantes a UI RUP / IDs cambiantes) ----------
  async function forceSelectByOptionText(optionTextContains) {
    // Busca cualquier <select> cuyo OPTION visible contenga el texto y lo selecciona
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
  await page.waitForTimeout(1200);

  // 3) Escanear TODOS los anchors y quedarnos con fichas de anuncio
  //    - descartamos cualquier URL que contenga "busquedaAnuncios"
  //    - aceptamos rutas con "PublicidadWar" (ver/detalle/anuncio/expediente/contrato)
  const detailLinks = await page.evaluate((base) => {
    const as = Array.from(document.querySelectorAll("a[href]"));
    const cleaned = as
      .map(a => ({ href: a.getAttribute("href") || "", abs: a.href, text: (a.textContent || "").trim() }))
      .filter(x => x.href && !x.href.startsWith("#"))
      .filter(x => !/^javascript:/i.test(x.href))
      .filter(x => !x.abs.includes("busquedaAnuncios")) // descarta buscador
      .filter(x => /PublicidadWar/i.test(x.abs) || /ac70c/i.test(x.abs))
      .filter(x => /(ver|detalle|anuncio|expediente|contrato|kpe)/i.test(x.href + " " + x.text))
      .map(x => x.abs);
    return Array.from(new Set(cleaned));
  }, START_URL);

  log.info(`Enlaces de detalle detectados: ${detailLinks.length}`);

  if (!detailLinks.length) {
    try {
      await Actor.setValue("debug_links.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      await Actor.setValue("debug_links.html", await page.content(), { contentType: "text/html; charset=utf-8" });
      log.warning("Sin enlaces detectados. Guardados debug_links.png y debug_links.html en el KV store.");
    } catch {}
    await browser.close();
    return;
  }

  // -------- Lectores genéricos en ficha --------
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
    // Busca un <a> cercano al label o por texto clave
    for (const labelText of variants) {
      try {
        // 1) link siguiente al label
        const linkNear = detailPage.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]/following::a[1]`).first();
        if (await linkNear.isVisible().catch(() => false)) {
          const href = await linkNear.getAttribute("href").catch(() => null);
          if (href) return new URL(href, detailPage.url()).toString();
        }
        // 2) anchors por texto típico
        const linkByText = detailPage.locator("a:has-text('licitación electrónica'), a:has-text('presentación electrónica'), a:has-text('oferta electrónica')");
        if (await linkByText.first().isVisible().catch(() => false)) {
          const href = await linkByText.first().getAttribute("href").catch(() => null);
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

  // 4) Visitar cada detalle y extraer TUS CAMPOS
  for (const enlace of detailLinks) {
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const titulo = (await page.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || null;

    // Campos solicitados (con variantes de etiqueta habituales)
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

    // Normalizaciones / picks
    const expediente = expedienteTxt ? (expedienteTxt.match(/expediente[:\s]*([A-Za-z0-9\/\-\._]+)/i)?.[1] || expedienteTxt) : null;
    const fechaPrimeraPublicacion = extractFirstDate(fechaPrimeraTxt);
    const fechaUltimaPublicacion = extractFirstDate(fechaUltimaTxt);
    const tipoContrato = tipoContratoTxt ? tipoContratoTxt.replace(/\s+/g, " ").trim() : null;
    const estadoTramitacion = estadoTramTxt ? estadoTramTxt.replace(/\s+/g, " ").trim() : null;
    const plazoPresentacion = plazoPresentacionTxt ? plazoPresentacionTxt.replace(/\s+/g, " ").trim() : null;
    const fechaLimitePresentacion = extractFirstDate(fechaLimiteTxt);
    const presupuestoSinIVA = presupuestoSinIvaTxt ? ((presupuestoSinIvaTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null,null])[1]) : null;
    const poderAdjudicador = poderAdjudicadorTxt ? poderAdjudicadorTxt.replace(/\s+/g, " ").trim() : null;
    const entidadImpulsora = entidadImpulsoraTxt ? entidadImpulsoraTxt.replace(/\s+/g, " ").trim() : null;
    const direccionLicitacionElectronica = urlLicitacion || null;

    // Empujar con tus claves finales (más título/enlace para contexto)
    await Actor.pushData({
      titulo,
      enlace,
      expediente,
      fechaPrimeraPublicacion,
      fechaUltimaPublicacion,
      tipoContrato,
      estadoTramitacion,
      plazoPresentacion,
      fechaLimitePresentacion,
      presupuestoSinIVA,
      poderAdjudicador,
      entidadImpulsora,
      direccionLicitacionElectronica
    });
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
