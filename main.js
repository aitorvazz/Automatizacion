import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => {
    try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {}
  };

  // ---------- 1) Abrir y aceptar cookies ----------
  log.info("Abriendo búsqueda…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();

  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click();
      await waitIdle();
      log.info("Cookies aceptadas");
    }
  } catch {}

  // ---------- Helpers de filtros ----------
  async function getCurrentSelectTextById(id) {
    return page.evaluate((id) => {
      const sel = document.getElementById(id);
      if (!sel || sel.tagName !== "SELECT") return null;
      const opt = sel.options[sel.selectedIndex];
      return opt ? (opt.textContent || "").trim() : null;
    }, id);
  }

  async function setSelectByLabelJS(labelText, visibleText) {
    return page.evaluate(({ labelText, visibleText }) => {
      function normalize(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
      function findSelectNearLabel(labelTxt) {
        const L = normalize(labelTxt);
        const labels = Array.from(document.querySelectorAll("label"));
        for (const lb of labels) {
          const t = normalize(lb.textContent || "");
          if (!t.includes(L)) continue;
          const forId = lb.getAttribute("for");
          if (forId) {
            const el = document.getElementById(forId);
            if (el && el.tagName === "SELECT") return el;
          }
          const local = lb.parentElement?.querySelector("select") || lb.nextElementSibling?.querySelector?.("select");
          if (local) return local;
        }
        // Heurística: ids/names frecuentes
        const cands = Array.from(document.querySelectorAll("select"));
        return cands.find(s => /expediente\.tipoContrato|tipoContrato/i.test(s.name||s.id||""))
            || cands.find(s => /expediente\.estado|estado/i.test(s.name||s.id||""))
            || null;
      }
      const sel = findSelectNearLabel(labelText);
      if (!sel) return false;
      const want = normalize(visibleText);
      const opts = Array.from(sel.options);
      const found = opts.find(o => normalize(o.textContent||"") === want || normalize(o.textContent||"").includes(want));
      if (!found) return false;
      sel.value = found.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { labelText, visibleText });
  }

  async function setComboByLabel(label, text) {
    try {
      const combo = page.locator(`xpath=//label[contains(normalize-space(.),'${label}')]/following::*[@role='combobox' or contains(@class,'rup_combo')][1]`).first();
      if (!(await combo.isVisible({ timeout: 2500 }).catch(() => false))) return false;
      await combo.click();
      const inner = combo.locator("input, .ui-autocomplete-input").first();
      if (await inner.isVisible().catch(() => false)) {
        await inner.fill("");
        await inner.type(text, { delay: 40 });
        await page.keyboard.press("Enter");
        return true;
      }
      await page.keyboard.type(text, { delay: 40 });
      await page.keyboard.press("Enter");
      return true;
    } catch { return false; }
  }

  async function setByHeuristicIdOrName(match, visibleText) {
    return page.evaluate(({ match, visibleText }) => {
      function normalize(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
      const all = Array.from(document.querySelectorAll("select"));
      const cand = all.find(s => normalize(s.id||"").includes(match) || normalize(s.name||"").includes(match));
      if (!cand) return false;
      const opts = Array.from(cand.options);
      const want = normalize(visibleText);
      const found = opts.find(o => normalize(o.textContent||"") === want || normalize(o.textContent||"").includes(want));
      if (!found) return false;
      cand.value = found.value;
      cand.dispatchEvent(new Event("input", { bubbles: true }));
      cand.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { match, visibleText });
  }

  async function applyFilter(labelVariants, valueText, idOrNameMatch) {
    // 1) getByLabel
    for (const L of labelVariants) {
      try {
        const ctrl = page.getByLabel(L, { exact: false });
        if (await ctrl.isVisible({ timeout: 600 }).catch(() => false)) {
          await ctrl.selectOption({ label: valueText }, { timeout: 3500 });
          return true;
        }
      } catch {}
    }
    // 2) JS por label
    for (const L of labelVariants) {
      if (await setSelectByLabelJS(L, valueText)) return true;
    }
    // 3) Combo RUP
    for (const L of labelVariants) {
      if (await setComboByLabel(L, valueText)) return true;
    }
    // 4) Heurística por id/name
    if (idOrNameMatch && await setByHeuristicIdOrName(idOrNameMatch, valueText)) return true;

    return false;
  }

  // ---------- 2) Aplicar filtros y verificar ----------
  const okTipo = await applyFilter(["Tipo de contrato"], "Suministros", "tipocontrato");
  const okEstado = await applyFilter(["Estado", "Estado del expediente", "Estado del anuncio"], "Abierto", "estado");
  await waitIdle();

  // Log de verificación (si existen esos ids)
  const selTipo = await getCurrentSelectTextById("tipoContrato").catch(() => null);
  const selEstado = await getCurrentSelectTextById("estado").catch(() => null);
  log.info(`Verificación selects => tipoContrato: ${selTipo || "?"}, estado: ${selEstado || "?"}`);
  log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);

  // ---------- 3) Buscar ----------
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}
  await waitIdle();
  await page.waitForTimeout(800);

  // ---------- 4) Localizar filas y extraer enlaces ----------
  // Estructuras posibles
  const containers = [
    "table tbody tr",
    ".resultado",
    ".filaResultado",
    "[data-anuncio]",
    ".resultados tbody tr",
    ".listado tbody tr"
  ];
  let rows;
  for (const sel of containers) {
    rows = page.locator(sel);
    const n = await rows.count().catch(() => 0);
    if (n) { log.info(`Contenedor detectado: "${sel}" (${n} filas)`); break; }
  }
  const total = rows ? await rows.count().catch(() => 0) : 0;
  log.info(`Filas detectadas: ${total}`);

  // 4.a Recoger anchors de detalle desde filas
  let detailLinks = [];
  if (total) {
    detailLinks = await page.evaluate((base) => {
      const qs = [
        "table tbody tr a[href]",
        ".resultado a[href]",
        ".filaResultado a[href]",
        "[data-anuncio] a[href]"
      ];
      const anchors = qs.flatMap(sel => Array.from(document.querySelectorAll(sel)));
      const cleaned = anchors
        .map(a => ({ href: a.getAttribute("href") || "", abs: a.href, text: (a.textContent || "").trim() }))
        .filter(x => x.href && !x.href.startsWith("#"))
        .filter(x => !/^javascript:/i.test(x.href))
        // mantener solo enlaces que no sean el propio buscador
        .filter(x => !x.abs.startsWith(base))
        // permitir patrones habituales; si es muy estricto, podría dejar enlaces fuera
        .filter(x => /(ver|detalle|anuncio|expediente|contrato|idAnuncio|PublicidadWar|KPE)/i.test(x.href + " " + x.text))
        .map(x => x.abs);
      return Array.from(new Set(cleaned));
    }, START_URL);
  }

  // 4.b Plan B: click controlado por fila para capturar URL real
  if ((!detailLinks || !detailLinks.length) && total) {
    log.info("No se detectaron enlaces por href, probando clic fila por fila…");
    for (let i = 0; i < Math.min(total, 80); i++) {
      const row = rows.nth(i);
      const a = row.locator("a[href]").first();
      if (!(await a.isVisible().catch(() => false))) continue;
      const before = page.url();
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null),
        a.click({ timeout: 8000 })
      ]);
      const after = page.url();
      if (after && after !== before) detailLinks.push(after);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitIdle(6000);
    }
    detailLinks = Array.from(new Set(detailLinks));
  }

  log.info(`Enlaces de detalle detectados: ${detailLinks.length}`);
  if (!detailLinks.length) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      await Actor.setValue("debug_sin_links.png", buf, { contentType: "image/png" });
      log.warning("Sin enlaces detectados. Guardada captura debug_sin_links.png");
    } catch {}
  }

  // ---------- 5) Utilidad lectura por etiqueta ----------
  const readField = async (detailPage, variants) => {
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

  // ---------- 6) Visitar detalles ----------
  for (const enlace of detailLinks) {
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const titulo = (await page.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || null;

    const organoTxt = await readField(page, ["Órgano", "Órgano de contratación"]);
    const procedimientoTxt = await readField(page, ["Procedimiento"]);
    const presupuestoTxt = await readField(page, ["Presupuesto", "Presupuesto base de licitación"]);
    const valorEstimadoTxt = await readField(page, ["Valor estimado"]);
    const presentacionTxt = await readField(page, ["Presentación de ofertas", "Fecha fin de presentación", "Fin de plazo de presentación"]);
    const cpvTxt = await readField(page, ["CPV", "Códigos CPV"]);

    const cpv = cpvTxt ? (cpvTxt.match(/\b\d{8}\b/) || [null])[0] : null;
    const presupuesto = presupuestoTxt ? (presupuestoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const valorEstimado = valorEstimadoTxt ? (valorEstimadoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const fechaLimite = presentacionTxt ? (presentacionTxt.match(/\b\d{2}\/\d{2}\/\d{4}\b/) || [null])[0] : null;

    await Actor.pushData({
      titulo, enlace,
      organo: organoTxt || null,
      procedimiento: procedimientoTxt || null,
      presupuesto,
      valorEstimado,
      fechaLimite,
      cpv
    });
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
