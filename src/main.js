import { Actor } from "apify";

await Actor.main(async () => {
  console.log("Hola desde mi actor en Apify 🚀");
  await Actor.pushData({ mensaje: "Actor funcionando", fecha: new Date().toISOString() });
});
