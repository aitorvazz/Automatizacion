import { Actor } from "apify";

await Actor.main(async () => {
  console.log("Actor personalizado funcionando 🚀");
  await Actor.pushData({
    mensaje: "Hola Normicriano",
    fecha: new Date().toISOString()
  });
});
