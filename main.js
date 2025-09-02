import { Actor, log } from "apify";
import { chromium } from "playwright";

const RESULTS_URL = "https://www.contratacion.euskadi.eus/ac70cPublicidadWar/informacionAmpliadaAnuncios/search";

// URLs válidas de detalle (expediente)
const DETAIL_RE = /(\/contenidos\/anuncio_contratacion\/expjaso\d+\/|\/anuncio_contratacion\/expjaso\d+\/|expjaso\d+\/es_doc\/|expjaso\d+\.html)/i;

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const waitIdle = async (ms = 10000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };
  const pause = (ms=400)=>page.waitForTimeout(ms);

  // -------- helpers extracción en detalle --------
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

  const readHrefByLabel = async (ctx, labels)
