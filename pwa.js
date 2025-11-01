// Registra o SW + lida com prompt de instalação
(function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(console.error);
  }

  // Botão opcional: <button id="installPWA">Instalar</button>
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById("installPWA");
    if (btn) btn.style.display = "inline-flex";
  });

  document.getElementById("installPWA")?.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    document.getElementById("installPWA").style.display = "none";
  });

  // iOS dica (Safari não mostra prompt)
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isInStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isIOS && !isInStandalone) {
    console.log("Em iOS, use o botão Compartilhar > Adicionar à Tela de Início para instalar o PWA.");
  }
})();
