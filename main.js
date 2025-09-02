import { Actor, log } from "apify";
import { chromium } from "playwright";

// 👉 Página de resultados con filtros ya aplicados (la que nos pasas)
const RESULTS_URL = "https://www.contratacion.euskadi.eus/ac70cPublicidadWar/informacionAmpliadaAnuncios/search";

// Aceptamos SOLO URLs de expediente/anuncio reales
const DETAIL_RE = /(\/contenidos\/anuncio_contratacion\/expjaso\d+\/|\/anuncio_contratacion\/expjaso\d+\/|expjaso\d+\/es_doc\/|expjaso\d+\.html)/i;

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 10000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };
  const pause = async (ms = 400) => { try { await page.waitForTimeout(ms); } catch {} };

  // ---------- helpers lectura en detalle ----------
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

  // ---------- 1) Abrir DIRECTAMENTE la lista filtrada ----------
  log.info("Abriendo lista filtrada…");
  await page.goto(RESULTS_URL, { waitUntil: "domcontentloaded" });
  await waitIdle(12000);
  await pause(600);

  // ---------- 2) Recolectar enlaces de anuncio en esta página ----------
  const collectDetailLinksFromResults = async (ctx) => {
    return await ctx.evaluate((DETAIL_RE_STR) => {
      const DETAIL_RE = new RegExp(DETAIL_RE_STR, "i");
      const abs = (u) => new URL(u, location.href).toString();

      // contenedores típicos de resultados
      const resultsScope = document.querySelector("#resultados") || document.querySelector("main") || document.body;

      // Preferencia: tarjetas/filas que contengan “Código del expediente” o “Expediente”
      const CAND_LABELS = [/c[oó]digo del expediente/i, /\bexpediente\b/i];
      const cards = Array.from(resultsScope.querySelectorAll("*"))
        .filter(el => CAND_LABELS.some(rx => rx.test(el.textContent || "")));

      const urls = new Set();
      const getCard = (el) => {
        let cur = el, steps = 0;
        while (cur && steps < 4) { 
          if (cur.matches("article, tr, li, .card, .resultado, .filaResultado, .result, .anuncio")) return cur;
          cur = cur.parentElement; steps++;
        }
        return el.parentElement || el;
      };

      for (const el of cards) {
        const card = getCard(el);
        const anchors = Array.from(card.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
          const url = abs(href);
          if (!DETAIL_RE.test(url)) continue;
          urls.add(url);
        }
      }

      // Fallback: anchors de todo el scope filtrados por patrón
      if (urls.size === 0) {
        const anchors = Array.from(resultsScope.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
          const url = abs(href);
          if (!DETAIL_RE.test(url)) continue;
          urls.add(url);
        }
      }

      return Array.from(urls);
    }, DETAIL_RE.source);
  };

  // ---------- 3) Botón “Siguiente” ----------
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
        await pause(400);
        return true;
      }
    }
    return false;
  };

  // ---------- 4) Paginar y extraer ----------
  const visited = new Set();
  let pageIndex = 1;

  while (true) {
    // enlaces en ESTA página (misma lógica también para iframes, por si acaso)
    let links = new Set(await collectDetailLinksFromResults(page));
    for (const fr of page.frames()) {
      try { (await collectDetailLinksFromResults(fr)).forEach(u => links.add(u)); } catch {}
    }

    const list = Array.from(links);
    log.info(`Página ${pageIndex}: anuncios encontrados = ${list.length}`);

    if (pageIndex === 1 && !list.length) {
      await Actor.setValue("debug_first_page.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
      await Actor.setValue("debug_first_page.html", await page.content(), { contentType: "text/html; charset=utf-8" });
      log.error("No se detectaron anuncios en la primera página. Revisa debug_first_page.*");
      break;
    }

    for (const href of list) {
      if (visited.has(href)) continue;
      visited.add(href);
      log.info(`→ Detalle: ${href}`);
      await scrapeDetail(href);
    }

    const hasNext = await gotoNextPage();
    if (!hasNext) break;
    pageIndex++;
  }

  await browser.close();
  log.info(`Hecho. Total anuncios procesados: ${visited.size}`);
});
