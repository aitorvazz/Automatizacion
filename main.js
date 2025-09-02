import { Actor, log } from "apify";
import { chromium } from "playwright";
import { XMLParser } from "fast-xml-parser";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // ----------------------- Utilidades comunes -----------------------
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

  async function scrapeDetail(ctx, enlace, tituloHint) {
    const titulo = (await ctx.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || tituloHint || null;

    const expedienteTxt = await readBlockByLabel(ctx, ["Expediente", "Nº de expediente", "Número de expediente"]);
    const fechaPrimeraTxt = await readBlockByLabel(ctx, ["Fecha primera publicación", "Primera publicación"]);
    const fechaUltimaTxt = await readBlockByLabel(ctx, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
    const tipoContratoTxt = await readBlockByLabel(ctx, ["Tipo de contrato", "Tipo contrato"]);
    const estadoTramTxt = await readBlockByLabel(ctx, ["Estado de la tramitación", "Estado", "Situación"]);
    const plazoPresentacionTxt = await readBlockByLabel(ctx, ["Plazo de presentación", "Plazo presentación"]);
    const fechaLimiteTxt = await readBlockByLabel(ctx, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
    const presupuestoSinIvaTxt = await readBlockByLabel(ctx, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
    const poderAdjudicadorTxt = await readBlockByLabel(ctx, ["Poder adjudicador", "Tipo de poder adjudicador"]);
    const entidadImpulsoraTxt = await readBlockByLabel(ctx, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
    const urlLicitacion = await readHrefByLabel(ctx, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

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

  // ----------------------- 1) Abrir buscador -----------------------
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

  // ----------------------- 2) Aplicar filtros ----------------------
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

  // ----------------------- 3) Disparar "Buscar" robusto --------------
  // 4 intentos: botón accesible, botón CSS, submit() del form, tecla Enter
  let searched = false;
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
      await btn.click(); searched = true;
    }
  } catch {}
  if (!searched) {
    try { await page.click("button[type='submit'], input[type='submit']", { timeout: 1500 }); searched = true; } catch {}
  }
  if (!searched) {
    try {
      await page.evaluate(() => {
        const f = document.querySelector("form");
        if (f) f.requestSubmit ? f.requestSubmit() : f.submit();
      });
      searched = true;
    } catch {}
  }
  if (!searched) {
    try { await page.keyboard.press("Enter"); searched = true; } catch {}
  }

  if (searched) log.info("Buscar disparado");
  await waitIdle(15000);
  await page.waitForTimeout(1000);

  // ----------------------- 4) Encontrar el contexto de resultados ----
  // Puede estar en la propia página o dentro de un iframe.
  async function getResultsContext() {
    // 1) ¿Hay filas en la página principal?
    const selectors = [
      "table.rup_table tbody tr",
      "table tbody tr",
      ".resultados tbody tr",
      ".listado tbody tr",
      ".resultado",
      ".filaResultado",
      "[data-anuncio]"
    ];
    for (const sel of selectors) {
      const cnt = await page.locator(sel).count().catch(() => 0);
      if (cnt > 0) return { ctx: page, selectorUsed: sel, count: cnt };
    }

    // 2) Buscar un iframe con resultados
    const frames = page.frames();
    for (const fr of frames) {
      try {
        const url = fr.url() || "";
        // Heurística: frames de la app (PublicidadWar, KPE, anuncio_contratacion)
        if (!/PublicidadWar|kpeperfi|anuncio_contratacion|ac70c/i.test(url)) continue;
        for (const sel of selectors) {
          const cnt = await fr.locator(sel).count().catch(() => 0);
          if (cnt > 0) return { ctx: fr, selectorUsed: sel, count: cnt };
        }
      } catch {}
    }

    return null;
  }

  const resCtx = await getResultsContext();

  if (!resCtx) {
    // Guardar material de depuración del main y de los frames
    try {
      await Actor.setValue("debug_no_rows_main.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      await Actor.setValue("debug_no_rows_main.html", await page.content(), { contentType: "text/html; charset=utf-8" });
      const frames = page.frames();
      let i = 0;
      for (const fr of frames) {
        try {
          const png = await fr.screenshot({ fullPage: true }).catch(() => null);
          if (png) await Actor.setValue(`debug_frame_${i}.png`, png, { contentType: "image/png" });
          const html = await fr.content().catch(() => null);
          if (html) await Actor.setValue(`debug_frame_${i}.html`, html, { contentType: "text/html; charset=utf-8" });
        } catch {}
        i++;
      }
    } catch {}
    log.error("No se detectaron filas de resultados (ni en la página ni en iframes). Revisa las capturas en el KV store.");
    await browser.close();
    return;
  }

  log.info(`Contenedor detectado: "${resCtx.selectorUsed}" (${resCtx.count} filas)`);

  // ----------------------- 5) Recoger enlaces de detalle ----------------
  let detailLinks = [];
  const maxRows = Math.min(resCtx.count, 200);

  for (let i = 0; i < maxRows; i++) {
    const row = resCtx.ctx.locator(resCtx.selectorUsed).nth(i);
    const a = row.locator("a[href]").first();
    const href = await a.getAttribute("href").catch(() => null);
    if (!href) continue;
    const abs = new URL(href, resCtx.ctx.url()).toString();

    // descartar buscador/anchors/javascript
    if (abs.includes("busquedaAnuncios")) continue;
    if (/^javascript:/i.test(abs)) continue;

    // patrones de detalle de esta plataforma
    if (/(con|contenidos)\/anuncio_contratacion|PublicidadWar|expjaso|ver|detalle|expediente|contrato|KPE/i.test(abs)) {
      detailLinks.push(abs);
    }
  }
  detailLinks = Array.from(new Set(detailLinks));
  log.info(`Enlaces de detalle detectados: ${detailLinks.length}`);

  if (!detailLinks.length) {
    try {
      const png = await resCtx.ctx.screenshot({ fullPage: true }).catch(() => null);
      if (png) await Actor.setValue("debug_no_links_ctx.png", png, { contentType: "image/png" });
      const html = await resCtx.ctx.content().catch(() => null);
      if (html) await Actor.setValue("debug_no_links_ctx.html", html, { contentType: "text/html; charset=utf-8" });
    } catch {}
    log.error("No se detectaron enlaces de detalle en el contenedor detectado. Revisa debug_no_links_ctx.*");
    await browser.close();
    return;
  }

  // ----------------------- 6) Visitar cada detalle y extraer ----------------
  for (const enlace of detailLinks) {
    log.info(`Procesando → ${enlace}`);
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();
    await scrapeDetail(page, enlace, null);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
