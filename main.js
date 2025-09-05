import { Actor, log } from "apify";
import { chromium } from "playwright";

// URL de resultados YA filtrada (la que nos diste)
const RESULTS_URL = "https://www.contratacion.euskadi.eus/ac70cPublicidadWar/informacionAmpliadaAnuncios/search";

// Patrones de destino
const EXPEDIENTE_RE = /(\/contenidos\/anuncio_contratacion\/expjaso\d+\/|\/anuncio_contratacion\/expjaso\d+\/|expjaso\d+\/es_doc\/|expjaso\d+\.html)/i;
const AVISO_RE      = /\/ac70cPublicidadWar\/informacionAmpliadaAnuncios\/ver/i;

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 10000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };
  const pause = (ms = 400) => page.waitForTimeout(ms);

  // ---------- Utilidades ----------
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

  // ---------- Extractores de detalle ----------
  const scrapeExpediente = async (detailUrl) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await p.goto(detailUrl, { waitUntil: "domcontentloaded" });
      await p.waitForLoadState("domcontentloaded").catch(()=>{});
      await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});

      const titulo = (await p.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || null;

      const expedienteTxt        = await readBlockByLabel(p, ["Expediente", "Nº de expediente", "Número de expediente"]);
      const fechaPrimeraTxt      = await readBlockByLabel(p, ["Fecha primera publicación", "Primera publicación"]);
      const fechaUltimaTxt       = await readBlockByLabel(p, ["Fecha última publicación", "Última publicación", "Fecha de la última publicación"]);
      const tipoContratoTxt      = await readBlockByLabel(p, ["Tipo de contrato", "Tipo contrato"]);
      const estadoTramTxt        = await readBlockByLabel(p, ["Estado de la tramitación", "Estado", "Situación"]);
      const plazoPresentacionTxt = await readBlockByLabel(p, ["Plazo de presentación", "Plazo presentación"]);
      const fechaLimiteTxt       = await readBlockByLabel(p, ["Fecha límite de presentación", "Fin de plazo de presentación", "Fecha fin de presentación"]);
      const presupuestoSinIvaTxt = await readBlockByLabel(p, ["Presupuesto del contrato sin IVA", "Presupuesto sin IVA", "Importe sin IVA"]);
      const poderAdjudicadorTxt  = await readBlockByLabel(p, ["Poder adjudicador", "Tipo de poder adjudicador"]);
      const entidadImpulsoraTxt  = await readBlockByLabel(p, ["Entidad Impulsora", "Unidad gestora", "Órgano impulsor"]);
      const urlLicitacion        = await readHrefByLabel(p, ["Dirección web de licitación electrónica", "Licitación electrónica", "Presentación electrónica"]);

      const expediente = expedienteTxt ? (expedienteTxt.match(/expediente[:\s]*([A-Za-z0-9\/\-\._]+)/i)?.[1] || expedienteTxt) : null;

      await Actor.pushData({
        tipoRegistro: "expediente",
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
    } catch (e) {
      log.warning(`Detalle expediente fallo: ${detailUrl} -> ${String(e)}`);
    } finally {
      await p.close().catch(()=>{});
    }
  };

  const scrapeAviso = async (detailUrl) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await p.goto(detailUrl, { waitUntil: "domcontentloaded" });
      await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});

      const titulo = (await p.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || null;

      const fechaTxt = await readBlockByLabel(p, ["Fecha", "Publicación", "Data", "Argitalpena"]);
      const fecha    = extractFirstDate(fechaTxt) || extractFirstDate(await p.locator("body").innerText().catch(()=>null));

      const cuerpo = (await p.locator("article, .contenido, .cuerpo, .content, main").first().innerText().catch(() => ""))
                      .replace(/\s+/g," ").trim().slice(0, 5000) || null;

      const adjuntos = await p.evaluate(() => {
        const abs = (u) => new URL(u, location.href).toString();
        const links = Array.from(document.querySelectorAll("a[href*='.pdf'], a[href*='.doc'], a[href*='.docx'], a[href*='.zip']"));
        return links.map(a => ({ texto: (a.textContent||"").trim(), url: abs(a.getAttribute("href")||"") }));
      });

      await Actor.pushData({
        tipoRegistro: "aviso",
        titulo,
        enlace: detailUrl,
        fechaPublicacion: fecha,
        resumen: cuerpo,
        adjuntos,
      });
    } catch (e) {
      log.warning(`Detalle aviso fallo: ${detailUrl} -> ${String(e)}`);
    } finally {
      await p.close().catch(()=>{});
    }
  };

  // ---------- Abrir lista filtrada ----------
  log.info("Abriendo lista filtrada…");
  await page.goto(RESULTS_URL, { waitUntil: "domcontentloaded" });
  await waitIdle(12000);

  // ---------- Recolector de enlaces en resultados ----------
  const collectLinks = async (ctx) => {
    return await ctx.evaluate((expRx, avisoRx) => {
      const EXP = new RegExp(expRx, "i");
      const AV  = new RegExp(avisoRx, "i");
      const abs = (u) => new URL(u, location.href).toString();

      const scope = document.querySelector("#resultados") || document.querySelector("main") || document.body;
      const out = [];

      // Caso 1: anchors normales
      for (const a of Array.from(scope.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") || "";
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
        const url = abs(href);
        if (EXP.test(url)) out.push({ tipo: "exp", url });
        else if (AV.test(url)) out.push({ tipo: "aviso", url });
      }

      // Caso 2: onclick con URL embebida (a veces usan window.open(...))
      for (const el of Array.from(scope.querySelectorAll("[onclick]"))) {
        const js = el.getAttribute("onclick") || "";
        const m = js.match(/https?:\/\/[^\s'"]+/);
        if (m) {
          const url = m[0];
          if (EXP.test(url)) out.push({ tipo: "exp", url });
          else if (AV.test(url)) out.push({ tipo: "aviso", url });
        }
      }

      // Caso 3: data-url / data-href
      for (const el of Array.from(scope.querySelectorAll("[data-url],[data-href]"))) {
        const href = el.getAttribute("data-url") || el.getAttribute("data-href");
        if (!href) continue;
        const url = abs(href);
        if (EXP.test(url)) out.push({ tipo: "exp", url });
        else if (AV.test(url)) out.push({ tipo: "aviso", url });
      }

      // Unicos
      const seen = new Set();
      return out.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; });
    }, EXPEDIENTE_RE.source, AVISO_RE.source);
  };

  // ---------- Botón “Siguiente” ----------
  const gotoNextPage = async () => {
    const sel = [
      "a[rel='next']:not([aria-disabled='true'])",
      "button[rel='next']:not([disabled])",
      "a[aria-label*='Siguiente']:not(.disabled)",
      "button[aria-label*='Siguiente']:not([disabled])",
      "a:has-text('Siguiente')",
      "a:has-text('Hurrengoa')",
      "li.next:not(.disabled) a",
      "xpath=//a[contains(.,'Siguiente') or contains(.,'Hurrengoa')][not(contains(@class,'disabled'))]"
    ];
    for (const s of sel) {
      const el = page.locator(s).first();
      if (await el.isVisible().catch(()=>false)) {
        await el.click().catch(()=>{});
        await waitIdle(8000);
        await pause(300);
        return true;
      }
    }
    return false;
  };

  // ---------- Recorrido completo ----------
  const vistos = new Set();
  let idx = 1;

  while (true) {
    // recolectar en página + iframes
    let items = await collectLinks(page);
    for (const fr of page.frames()) {
      try { items = items.concat(await collectLinks(fr)); } catch {}
    }

    const expCount   = items.filter(i => i.tipo === "exp").length;
    const avisoCount = items.filter(i => i.tipo === "aviso").length;
    log.info(`Página ${idx}: exp=${expCount}, avisos=${avisoCount}, total=${items.length}`);

    if (idx === 1 && items.length === 0) {
      await Actor.setValue("debug_first_page.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      await Actor.setValue("debug_first_page.html", await page.content(), { contentType: "text/html; charset=utf-8" });
      log.error("No se detectaron entradas en la primera página. Revisa debug_first_page.*");
      break;
    }

    for (const it of items) {
      if (vistos.has(it.url)) continue;
      vistos.add(it.url);

      try {
        if (it.tipo === "exp") await scrapeExpediente(it.url);
        else await scrapeAviso(it.url);
      } catch (e) {
        log.warning(`Fallo procesando ${it.url}: ${String(e)}`);
      }
    }

    const hasNext = await gotoNextPage();
    if (!hasNext) break;
    idx++;
  }

  await browser.close();
  log.info(`Hecho. Total elementos procesados: ${vistos.size}`);
});
