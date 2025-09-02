import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // ---- Utilidades genéricas ----
  const extractFirstDate = (txt) => {
    if (!txt) return null;
    const m = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
    return m ? m[0] : null;
  };

  const readBlockByLabel = async (ctx, variants) => {
    for (const labelText of variants) {
      try {
        let node = ctx.locator(`text="${labelText}"`).first();
        if (!(await node.isVisible().catch(() => false))) node = ctx.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]`).first();
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

    const expedienteTxt          = await readBlockByLabel(ctx, ["Expediente", "Nº de expediente", "Número de expediente"]);
    const fechaPrimeraTxt        = await readBlockByLabel(ctx, ["Fecha primera publicación", "Primera publicación"]);
    const fechaUltimaTxt         = await readBlockByLabel(ctx, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
    const tipoContratoTxt        = await readBlockByLabel(ctx, ["Tipo de contrato", "Tipo contrato"]);
    const estadoTramTxt          = await readBlockByLabel(ctx, ["Estado de la tramitación", "Estado", "Situación"]);
    const plazoPresentacionTxt   = await readBlockByLabel(ctx, ["Plazo de presentación", "Plazo presentación"]);
    const fechaLimiteTxt         = await readBlockByLabel(ctx, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
    const presupuestoSinIvaTxt   = await readBlockByLabel(ctx, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
    const poderAdjudicadorTxt    = await readBlockByLabel(ctx, ["Poder adjudicador", "Tipo de poder adjudicador"]);
    const entidadImpulsoraTxt    = await readBlockByLabel(ctx, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
    const urlLicitacion          = await readHrefByLabel(ctx, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

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
  }

  // ---- 1) Abrir buscador + cookies ----
  log.info("Abriendo buscador…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) { await cookiesBtn.click(); await waitIdle(); }
  } catch {}

  // ---- 2) Aplicar filtros (Suministros + Abierto) ----
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

  let okTipo=false, okEstado=false;
  try { const c = page.getByLabel("Tipo de contrato", { exact:false }); if (await c.isVisible({timeout:800}).catch(()=>false)) { await c.selectOption({ label:"Suministros" }, { timeout:3500 }); okTipo=true; } } catch {}
  if (!okTipo) okTipo = await forceSelectByOptionText("Suministros");

  try { const e = page.getByLabel("Estado", { exact:false }); if (await e.isVisible({timeout:800}).catch(()=>false)) { await e.selectOption({ label:"Abierto" }, { timeout:3500 }); okEstado=true; } } catch {}
  if (!okEstado) okEstado = await forceSelectByOptionText("Abierto");

  log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);

  // ---- 3) Disparar Buscar de forma robusta ----
  let searched = false;
  try { const btn = page.getByRole("button", { name:/buscar/i }); if (await btn.isVisible({timeout:1200}).catch(()=>false)) { await btn.click(); searched=true; } } catch {}
  if (!searched) { try { await page.click("button[type='submit'], input[type='submit']", { timeout:1500 }); searched=true; } catch {} }
  if (!searched) { try { await page.evaluate(()=>{ const f=document.querySelector("form"); if (f) f.requestSubmit ? f.requestSubmit() : f.submit(); }); searched=true; } catch {} }
  if (!searched) { try { await page.keyboard.press("Enter"); searched=true; } catch {} }
  if (searched) log.info("Buscar disparado");
  await waitIdle(15000);
  await page.waitForTimeout(1200);

  // ---- 4) Capturar POPUPS (por si abre resultados en nueva ventana) ----
  const popupLinks = new Set();
  page.on("popup", async (pop) => {
    try {
      await pop.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(()=>{});
      popupLinks.add(pop.url());
    } catch {}
  });

  // ---- 5) Escuchar RESPUESTAS de red con URLs interesantes ----
  const netLinks = new Set();
  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      if (/(con|contenidos)\/anuncio_contratacion|PublicidadWar|expjaso|es_doc|ver|detalle/i.test(url)) {
        netLinks.add(url);
      }
    } catch {}
  });

  // ---- 6) Recolectar enlaces de detalle desde página + iframes ----
  async function collectDetailLinksFromContext(ctx) {
    return await ctx.evaluate(() => {
      const abs = (u) => new URL(u, location.href).toString();
      const anchors = Array.from(document.querySelectorAll("a[href]"))
        .map(a => abs(a.getAttribute("href")))
        .filter(u => !!u)
        .filter(u => !u.includes("busquedaAnuncios"))
        .filter(u => !/^javascript:/i.test(u))
        .filter(u => /(con|contenidos)\/anuncio_contratacion|PublicidadWar|expjaso|es_doc|ver|detalle|expediente|contrato|KPE/i.test(u));
      return Array.from(new Set(anchors));
    });
  }

  // scroll para forzar cargas perezosas
  try { await page.mouse.wheel(0, 2000); await page.waitForTimeout(500); await page.mouse.wheel(0, -2000); } catch {}

  let detailLinks = new Set(await collectDetailLinksFromContext(page));

  // iframes
  for (const fr of page.frames()) {
    try {
      const urls = await collectDetailLinksFromContext(fr);
      urls.forEach(u => detailLinks.add(u));
    } catch {}
  }

  // combinar con lo que haya detectado red/popup
  netLinks.forEach(u => detailLinks.add(u));
  popupLinks.forEach(u => detailLinks.add(u));

  const links = Array.from(detailLinks);
  log.info(`Enlaces de detalle detectados (agregados): ${links.length}`);

  if (!links.length) {
    // guardamos material de depuración útil
    try {
      await Actor.setValue("debug_after_search_main.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      await Actor.setValue("debug_after_search_main.html", await page.content(), { contentType: "text/html; charset=utf-8" });
      const frames = page.frames();
      let i = 0;
      for (const fr of frames) {
        try {
          const png = await fr.screenshot({ fullPage: true }).catch(() => null);
          if (png) await Actor.setValue(`debug_after_search_frame_${i}.png`, png, { contentType: "image/png" });
          const html = await fr.content().catch(() => null);
          if (html) await Actor.setValue(`debug_after_search_frame_${i}.html`, html, { contentType: "text/html; charset=utf-8" });
        } catch {}
        i++;
      }
    } catch {}
    log.error("No se detectaron enlaces de detalle. Revisa las capturas/HTML en el Key-Value Store.");
    await browser.close();
    return;
  }

  // ---- 7) Visitar cada detalle y extraer TUS 11 CAMPOS ----
  for (const enlace of links) {
    log.info(`Procesando → ${enlace}`);
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();
    await scrapeDetail(page, enlace, null);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
